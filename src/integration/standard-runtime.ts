import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  assertDecisionReadyReport,
  type AvailabilityCandidate,
  type AvailabilitySnapshot,
  type DecisionReadyReport,
  type FirstmateDispatchReceipt,
  type FirstmateDispatchRequest,
  type RoleAssignment,
  type RoutingDecision,
  type SourceLineage,
} from "../contracts/index.ts";
import {
  createQuickRun,
  type QuickResult,
  type QuickRunRecord,
} from "../quick.ts";
import {
  planStandardWorkflow,
  type NormalizedStandardInput,
  type StandardWorkflowInput,
} from "../routing/standard.ts";

export type StandardRuntimeStatus = "blocked" | "completed";

export interface StandardReviewOutcome {
  readonly ok: boolean;
  readonly family: string;
  readonly model: string;
  readonly rawOutput: string;
  readonly error: string | null;
}

export interface StandardDispatchOutcome {
  readonly receipt: FirstmateDispatchReceipt;
  readonly summary: string | null;
  readonly quickRecordPath: string | null;
}

export interface StandardRuntimePorts {
  readonly dispatchAuthor: (
    request: FirstmateDispatchRequest,
  ) => Promise<StandardDispatchOutcome>;
  readonly review: (
    prompt: string,
    assignment: RoleAssignment,
  ) => Promise<StandardReviewOutcome>;
}

export interface StandardRunRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: StandardRuntimeStatus;
  readonly task: string;
  readonly projectDir: string;
  readonly source: SourceLineage;
  readonly availability: AvailabilitySnapshot;
  readonly normalizedInput: NormalizedStandardInput;
  readonly routingDecision: RoutingDecision | null;
  readonly author: StandardDispatchOutcome | null;
  readonly review: StandardReviewOutcome | null;
  readonly report: DecisionReadyReport | null;
  readonly blockers: readonly string[];
  readonly claims: {
    readonly authorCompletedInFirstmate: boolean;
    readonly independentReviewCompleted: boolean;
    readonly reportDecisionReady: boolean;
    readonly reportReadbackMatchesPane: boolean;
  };
  readonly recordPath: string;
}

export interface StandardRunOptions {
  readonly task: string;
  readonly cwd: string;
  readonly projectDir?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly availability?: AvailabilitySnapshot;
  readonly now?: () => string;
  readonly ports?: StandardRuntimePorts;
}

export interface StandardRunResult {
  readonly ok: boolean;
  readonly record: StandardRunRecord;
}

type CompletedFirstmateAuthorRecord = QuickRunRecord & {
  readonly status: "completed";
  readonly result: NonNullable<QuickRunRecord["result"]>;
  readonly worker: QuickRunRecord["worker"] & {
    readonly target: string;
  };
  readonly evidence: NonNullable<QuickRunRecord["evidence"]> & {
    readonly observedAt: string;
  };
  readonly recordPath: string;
};

export function hasFirstmateAuthorReadback(
  record: QuickRunRecord,
): record is CompletedFirstmateAuthorRecord {
  return (
    record.status === "completed"
    && Boolean(record.result?.summary.trim())
    && Boolean(record.result?.readBackAt)
    && Boolean(record.worker.taskId)
    && Boolean(record.worker.target)
    && Boolean(record.recordPath)
    && Boolean(record.evidence?.firstmateMeta)
    && Boolean(record.evidence?.firstmateStatus)
    && Boolean(record.evidence?.scoutReport)
    && Boolean(record.evidence?.observedAt)
    && record.claims.firstmatePrimaryInHerdr
    && record.claims.workerVisible
  );
}

interface ReviewDocument {
  readonly conclusion: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly limitations: readonly string[];
  readonly unknowns: readonly string[];
}

export async function createStandardRun(
  options: StandardRunOptions,
): Promise<StandardRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const id = `standard-${compactTimestamp(createdAt)}`;
  const projectDir = resolve(options.projectDir ?? options.cwd);
  const stateDir = resolveStateDir(options.cwd, options.env);
  const recordPath = join(stateDir, "standard-runs", `${id}.json`);
  const availability =
    options.availability ?? probeStandardAvailability(options.cwd, options.env, now);
  const input: StandardWorkflowInput = {
    task: options.task,
    risk: "medium",
    boundaries: [
      "author result must return through Firstmate on Herdr",
      "reviewer must not modify the workspace",
      "main report must remain concise",
    ],
  };
  const plan = planStandardWorkflow({ input, availability });
  const source = sourceFromEnvironment(id, options.env);
  const base: StandardRunRecord = {
    schemaVersion: 1,
    id,
    createdAt,
    updatedAt: createdAt,
    status: "blocked",
    task: options.task,
    projectDir,
    source,
    availability,
    normalizedInput: plan.normalizedInput,
    routingDecision:
      plan.routing.status === "resolved" ? plan.routing.decision : null,
    author: null,
    review: null,
    report: null,
    blockers: [],
    claims: {
      authorCompletedInFirstmate: false,
      independentReviewCompleted: false,
      reportDecisionReady: false,
      reportReadbackMatchesPane: false,
    },
    recordPath,
  };

  if (!options.task.trim()) {
    return blocked(base, now, "standard_task_empty");
  }
  if (!source.paneId.trim()) {
    return blocked(base, now, "standard_requires_herdr_pane");
  }
  if (!source.workspace.trim() || !source.tabId.trim()) {
    return blocked(base, now, "standard_requires_complete_herdr_lineage");
  }
  if (plan.routing.status !== "resolved") {
    return blocked(
      base,
      now,
      `routing_${plan.routing.status}:${plan.routing.reason}`,
    );
  }

  const ports =
    options.ports ??
    defaultStandardRuntimePorts({
      cwd: options.cwd,
      projectDir,
      env: options.env,
    });
  const dispatchRequest: FirstmateDispatchRequest = {
    idempotencyKey: `${id}:author`,
    workflow: "standard",
    projectDir,
    source,
    task: encodedArchitectureTask(options.task),
    routingDecision: plan.routing.decision,
  };
  const author = await ports.dispatchAuthor(dispatchRequest);
  if (!author.receipt.accepted || author.summary === null) {
    return blocked(
      { ...base, author },
      now,
      author.receipt.reason ?? "firstmate_author_failed",
    );
  }

  const reviewerAssignment = plan.routing.decision.roleAssignments.find(
    (assignment) => assignment.role === "reviewer",
  );
  if (reviewerAssignment === undefined) {
    return blocked({ ...base, author }, now, "reviewer_assignment_missing");
  }
  const review = await ports.review(
    buildReviewPrompt(options.task, author.summary, plan.routing.decision),
    reviewerAssignment,
  );
  if (!review.ok) {
    return blocked(
      { ...base, author, review },
      now,
      review.error ?? "independent_review_failed",
    );
  }
  if (
    review.family !== reviewerAssignment.family ||
    review.model !== reviewerAssignment.resolvedModel
  ) {
    return blocked(
      { ...base, author, review },
      now,
      "review_provenance_mismatch",
    );
  }
  const reviewDocument = parseReviewDocument(review.rawOutput);
  if (reviewDocument === null) {
    return blocked(
      { ...base, author, review },
      now,
      "review_contract_invalid",
    );
  }

  const report = composeRuntimeReport({
    reviewDocument,
    normalizedInput: plan.normalizedInput,
    routingDecision: plan.routing.decision,
    configVersionHash: plan.config.versionHash,
    availability,
    author,
    review,
  });
  try {
    assertDecisionReadyReport(report);
  } catch (error) {
    return blocked(
      { ...base, author, review, report },
      now,
      error instanceof Error ? error.message : "report_contract_invalid",
    );
  }

  const record = writeStandardRecord({
    ...base,
    updatedAt: now(),
    status: "completed",
    author,
    review,
    report,
    claims: {
      ...base.claims,
      authorCompletedInFirstmate: true,
      independentReviewCompleted: true,
      reportDecisionReady: true,
    },
  });
  return { ok: true, record };
}

export function probeStandardAvailability(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: () => string = () => new Date().toISOString(),
): AvailabilitySnapshot {
  const capturedAt = now();
  const codexAvailable =
    commandSucceeds("codex", ["login", "status"], cwd, env);
  const claudeAvailable =
    commandSucceeds("claude", ["auth", "status"], cwd, env);
  const candidates: AvailabilityCandidate[] = [
    candidate(
      "openai-architect",
      "openai",
      "openai",
      env.ACM_CODEX_ARCHITECT_MODEL ?? "codex-session-default",
      "architecture",
      codexAvailable,
    ),
    candidate(
      "openai-builder",
      "openai",
      "openai",
      env.ACM_CODEX_BUILDER_MODEL ?? "codex-session-default",
      "implementation",
      codexAvailable,
    ),
    candidate(
      "openai-search",
      "openai",
      "openai",
      env.ACM_CODEX_SEARCH_MODEL ?? "codex-session-default",
      "search",
      codexAvailable,
    ),
    candidate(
      "anthropic-reviewer",
      "anthropic",
      "anthropic",
      env.ACM_CLAUDE_REVIEW_MODEL ?? "fable",
      "architecture",
      claudeAvailable,
    ),
  ];
  return {
    id: `availability-${compactTimestamp(capturedAt)}`,
    capturedAt,
    candidates,
  };
}

export function renderStandardText(result: StandardRunResult): string {
  if (!result.ok || result.record.report === null) {
    return [
      "AI Coding Mate Standard: BLOCKED",
      ...result.record.blockers.map((blocker) => `- ${blocker}`),
      `evidence: ${result.record.recordPath}`,
      "",
    ].join("\n");
  }
  const report = result.record.report.mainReport;
  return [
    "AI Coding Mate Standard",
    `結論：${report.conclusion}`,
    `影響：${report.impact}`,
    `下一步：${report.nextAction}`,
    `routing: ${result.record.routingDecision?.diversityStatus ?? "unknown"}`,
    `evidence: ${result.record.recordPath}`,
    "",
  ].join("\n");
}

export function readStandardRunRecord(
  path: string,
): StandardRunRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isStandardRunRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function markStandardRunPresented(
  path: string,
  expectedText: string,
  observedPaneText: string,
): StandardRunRecord | undefined {
  const record = readStandardRunRecord(path);
  if (
    record === undefined ||
    !expectedText.trim() ||
    !observedPaneText.includes(expectedText)
  ) {
    return undefined;
  }
  return writeStandardRecord({
    ...record,
    updatedAt: new Date().toISOString(),
    claims: {
      ...record.claims,
      reportReadbackMatchesPane: true,
    },
  });
}

function defaultStandardRuntimePorts(options: {
  readonly cwd: string;
  readonly projectDir: string;
  readonly env: NodeJS.ProcessEnv;
}): StandardRuntimePorts {
  return {
    async dispatchAuthor(request) {
      const authorAssignment = request.routingDecision.roleAssignments.find(
        (assignment) => assignment.role === "author",
      );
      if (authorAssignment?.family !== "openai") {
        return {
          receipt: {
            accepted: false,
            idempotencyStatus: "rejected",
            firstmateTaskId: null,
            workerTarget: null,
            evidencePath: null,
            reason: "firstmate_author_adapter_family_unavailable",
          },
          summary: null,
          quickRecordPath: null,
        };
      }
      const result: QuickResult = createQuickRun({
        task: request.task,
        cwd: options.cwd,
        projectDir: options.projectDir,
        env: options.env,
      });
      if (
        !result.ok ||
        !hasFirstmateAuthorReadback(result.record)
      ) {
        return {
          receipt: {
            accepted: false,
            idempotencyStatus: "rejected",
            firstmateTaskId: null,
            workerTarget: null,
            evidencePath: null,
            reason:
              result.stderr ||
              result.record.blockers.join("; ") ||
              "firstmate_author_failed",
          },
          summary: null,
          quickRecordPath: result.record.recordPath ?? null,
        };
      }
      return {
        receipt: {
          accepted: true,
          idempotencyStatus: "accepted",
          firstmateTaskId: result.record.worker.taskId,
          workerTarget: result.record.worker.target,
          evidencePath: result.record.recordPath,
          reason: null,
        },
        summary: result.record.result.summary,
        quickRecordPath: result.record.recordPath,
      };
    },
    async review(prompt, assignment) {
      return runIndependentReview(
        prompt,
        assignment,
        options.cwd,
        options.env,
      );
    },
  };
}

function runIndependentReview(
  prompt: string,
  assignment: RoleAssignment,
  cwd: string,
  env: NodeJS.ProcessEnv,
): StandardReviewOutcome {
  if (assignment.family === "anthropic") {
    return runClaudeReview(prompt, assignment, cwd, env);
  }
  if (assignment.family === "openai") {
    return runCodexReview(prompt, assignment, cwd, env);
  }
  return {
    ok: false,
    family: assignment.family,
    model: assignment.resolvedModel,
    rawOutput: "",
    error: `review_adapter_family_unsupported:${assignment.family}`,
  };
}

function runClaudeReview(
  prompt: string,
  assignment: RoleAssignment,
  cwd: string,
  env: NodeJS.ProcessEnv,
): StandardReviewOutcome {
  const model =
    env.ACM_CLAUDE_REVIEW_MODEL ?? assignment.resolvedModel ?? "fable";
  const reviewEnv = { ...env };
  delete reviewEnv.CLAUDE_CODE_SPAWN_BACKEND;
  delete reviewEnv.CLAUDE_CODE_WORKFLOWS;
  delete reviewEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      model,
      "--tools",
      "",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
      prompt,
    ],
    {
      cwd,
      env: reviewEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const rawOutput = (result.stdout ?? "").trim();
  return {
    ok: result.status === 0 && rawOutput.length > 0,
    family: "anthropic",
    model,
    rawOutput,
    error:
      result.status === 0 && rawOutput.length > 0
        ? null
        : compactProcessFailure(result.status, result.error, result.stderr),
  };
}

function runCodexReview(
  prompt: string,
  assignment: RoleAssignment,
  cwd: string,
  env: NodeJS.ProcessEnv,
): StandardReviewOutcome {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    'web_search="disabled"',
    "-c",
    "mcp_servers={}",
  ];
  if (
    assignment.resolvedModel &&
    assignment.resolvedModel !== "codex-session-default"
  ) {
    args.push("--model", assignment.resolvedModel);
  }
  args.push(prompt);
  const result = spawnSync("codex", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rawOutput = (result.stdout ?? "").trim();
  return {
    ok: result.status === 0 && rawOutput.length > 0,
    family: "openai",
    model: assignment.resolvedModel,
    rawOutput,
    error:
      result.status === 0 && rawOutput.length > 0
        ? null
        : compactProcessFailure(result.status, result.error, result.stderr),
  };
}

function buildReviewPrompt(
  task: string,
  authorSummary: string,
  decision: RoutingDecision,
): string {
  return [
    "你是 AI Coding Mate 的獨立架構 reviewer。",
    "請用繁體中文，只輸出一個 JSON object，不要 Markdown，不要技術流水帳。",
    'Schema: {"conclusion":"一句可做決策的結論","impact":"一句最重要影響或取捨","nextAction":"一句下一步","limitations":["最多三項"],"unknowns":["最多三項"]}',
    `使用者目標：${task}`,
    `Firstmate/Codex author 結果：${authorSummary}`,
    `routing diversity：${decision.diversityStatus}`,
    "找出 author 遺漏的主要風險，但不要因小概率或非必要項目堆出防禦性清單。",
  ].join("\n");
}

function encodedArchitectureTask(task: string): string {
  const encoded = Buffer.from(task, "utf8").toString("base64url");
  return (
    "唯讀分析本地專案並回覆架構結論、影響與下一步，"
    + `請先理解這份 base64url 目標資料：${encoded}`
  );
}

function parseReviewDocument(rawOutput: string): ReviewDocument | null {
  const start = rawOutput.indexOf("{");
  const end = rawOutput.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(rawOutput.slice(start, end + 1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const conclusion = readBoundedString(record.conclusion, 240);
    const impact = readBoundedString(record.impact, 240);
    const nextAction = readBoundedString(record.nextAction, 240);
    if (conclusion === null || impact === null || nextAction === null) {
      return null;
    }
    return {
      conclusion,
      impact,
      nextAction,
      limitations: readStringArray(record.limitations, 320).slice(0, 3),
      unknowns: readStringArray(record.unknowns, 320).slice(0, 3),
    };
  } catch {
    return null;
  }
}

function composeRuntimeReport(options: {
  readonly reviewDocument: ReviewDocument;
  readonly normalizedInput: NormalizedStandardInput;
  readonly routingDecision: RoutingDecision;
  readonly configVersionHash: string;
  readonly availability: AvailabilitySnapshot;
  readonly author: StandardDispatchOutcome;
  readonly review: StandardReviewOutcome;
}): DecisionReadyReport {
  return {
    schemaVersion: 1,
    mainReport: {
      conclusion: options.reviewDocument.conclusion,
      impact: options.reviewDocument.impact,
      nextAction: options.reviewDocument.nextAction,
    },
    evidenceLayer: {
      configVersionHash: options.configVersionHash,
      availabilitySnapshotId: options.availability.id,
      routingDecisionKey: options.routingDecision.requestKey,
      lineage: [
        options.normalizedInput.hash,
        options.author.receipt.evidencePath ?? "author-evidence-missing",
        `${options.review.family}:${options.review.model}`,
      ],
      limitations: options.reviewDocument.limitations,
      unknowns: options.reviewDocument.unknowns,
    },
  };
}

function sourceFromEnvironment(
  runId: string,
  env: NodeJS.ProcessEnv,
): SourceLineage {
  const paneId = env.HERDR_PANE_ID ?? env.ACM_QUICK_SOURCE_PANE ?? "";
  return {
    taskId: runId,
    runId,
    workspace: env.HERDR_WORKSPACE_ID ?? "",
    tabId: env.HERDR_TAB_ID ?? "",
    paneId,
  };
}

function candidate(
  alias: string,
  provider: string,
  family: string,
  resolvedModel: string,
  capabilityTier: AvailabilityCandidate["capabilityTier"],
  available: boolean,
): AvailabilityCandidate {
  return {
    alias,
    provider,
    family,
    resolvedModel,
    capabilityTier,
    state: available ? "available" : "unavailable",
    reason: available ? null : `${provider}_cli_or_auth_unavailable`,
  };
}

function commandSucceeds(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  return result.status === 0;
}

function blocked(
  record: StandardRunRecord,
  now: () => string,
  blocker: string,
): StandardRunResult {
  return {
    ok: false,
    record: writeStandardRecord({
      ...record,
      updatedAt: now(),
      status: "blocked",
      blockers: [...record.blockers, blocker],
    }),
  };
}

function writeStandardRecord(record: StandardRunRecord): StandardRunRecord {
  mkdirSync(dirname(record.recordPath), { recursive: true });
  const temporary = `${record.recordPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, record.recordPath);
  return record;
}

function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_STATE_DIR ?? join(cwd, "state", "aicoding-mate"));
}

function compactProcessFailure(
  status: number | null,
  error: Error | undefined,
  stderr: string | Buffer | null | undefined,
): string {
  if (error) return error.message;
  const text = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
  return text.trim().split(/\r?\n/)[0] || `process_exit_${status ?? "unknown"}`;
}

function readBoundedString(
  value: unknown,
  maximumCodePoints: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > maximumCodePoints
  ) {
    return null;
  }
  return normalized;
}

function readStringArray(
  value: unknown,
  maximumCodePoints: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(
      (item) =>
        item.length > 0 && Array.from(item).length <= maximumCodePoints,
    );
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "").replace("Z", "z");
}

function isStandardRunRecord(value: unknown): value is StandardRunRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.recordPath === "string" &&
    (record.status === "blocked" || record.status === "completed")
  );
}

export function standardRecordHash(record: StandardRunRecord): string {
  return createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex");
}
