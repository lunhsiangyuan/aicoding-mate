import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  workflowDispatchIdempotencyKey,
} from "../authority/firstmate-decisions.ts";
import {
  isFirstmateDecisionReceipt,
  verifyFirstmateDecisionReceipt,
  type FirstmateDecisionReceipt,
} from "../authority/firstmate-decision-authority.ts";
import {
  FileFirstmateWorkflowAuthority,
  type FirstmateWorkflowAuthorityPort,
} from "../authority/firstmate-workflow-authority.ts";
import {
  parseHerdrBranchContext,
  type BranchFailureReason,
  type ParsedHerdrBranchContext,
} from "../branch/index.ts";
import {
  assertWorkflowDecisionEnvelope,
  type WorkflowDecisionEnvelope,
} from "../contracts/index.ts";
import {
  createReviewCapsule,
  type CodexAppServerReviewPort,
  type ReviewCapsule,
  type ReviewCapsuleFailureReason,
  type ReviewCapsuleInput,
} from "../review/index.ts";
import { FileRunRegistry, type RegistryLease } from "../runtime/run-registry.ts";
import {
  createCodexAppServerReviewPort,
  type CodexAppServerRuntimeOptions,
} from "./codex-review-runtime.ts";
import {
  resolveFirstmateSourceBinding,
  type FirstmateSourceBinding,
} from "./context-branch-runtime.ts";

export interface CodexReviewCommandOptions {
  readonly contextJson: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly ports?: CodexReviewCommandPorts;
  readonly workflowAuthority?: FirstmateWorkflowAuthorityPort;
}

export interface CodexReviewCommandPorts {
  readonly resolveSource?: (
    stateDir: string,
    focusedPaneId: string,
  ) => FirstmateSourceBinding | null;
  readonly createAppServerReviewPort?: (
    options: CodexAppServerRuntimeOptions,
  ) => DisposableCodexReviewPort;
  readonly launchDesktop?: CodexReviewDesktopLaunchRunner;
}

export type DisposableCodexReviewPort = CodexAppServerReviewPort & {
  dispose(): Promise<void>;
};

export type CodexReviewDesktopLaunchRunner = (
  request: CodexReviewDesktopLaunchRequest,
) =>
  | CodexReviewDesktopLaunchReceipt
  | Promise<CodexReviewDesktopLaunchReceipt>;

export interface CodexReviewDesktopLaunchRequest {
  readonly url: string;
  readonly reviewThreadId: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type CodexReviewDesktopLaunchReceipt =
  | {
      readonly requested: true;
      readonly reason: null;
    }
  | {
      readonly requested: false;
      readonly reason: string;
    };

export type CodexReviewDesktopLaunchStatus =
  | {
      readonly status: "requested_unverified";
      readonly url: string;
      readonly reason: null;
    }
  | {
      readonly status: "request_failed";
      readonly url: string;
      readonly reason: string;
    };

export type CodexReviewCommandFailureReason =
  | BranchFailureReason
  | "invalid_context_json"
  | "context_not_object"
  | "firstmate_source_run_not_found"
  | "firstmate_decision_issuance_failed"
  | "app_server_unavailable"
  | "capsule_persist_failed"
  | "canonical_review_active"
  | "canonical_review_requires_reconciliation"
  | ReviewCapsuleFailureReason;

export type CodexReviewCommandResult =
  | {
      readonly ok: true;
      readonly capsulePath: string;
      readonly capsule: ReviewCapsule;
      readonly desktopLaunch: CodexReviewDesktopLaunchStatus;
      readonly dedupeStatus: "new" | "coalesced_completed";
    }
  | {
      readonly ok: false;
      readonly status: "failed_closed";
      readonly reason: CodexReviewCommandFailureReason;
    };

interface BasicHerdrSelection {
  readonly selectedText: string;
  readonly workspace: string;
  readonly tabId: string;
  readonly focusedPaneId: string;
}

export async function runCodexReviewFromHerdrSelection(
  options: CodexReviewCommandOptions,
): Promise<CodexReviewCommandResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const stateDir = resolveStateDir(options.cwd, options.env);
  const basic = parseBasicHerdrSelection(options.contextJson);
  if (!basic.ok) return fail(basic.reason);

  const ports = options.ports ?? {};
  const resolveSource =
    ports.resolveSource ??
    ((dir: string, focusedPaneId: string) =>
      resolveFirstmateSourceBinding(dir, focusedPaneId));
  const binding = resolveSource(stateDir, basic.value.focusedPaneId);
  if (binding === null) return fail("firstmate_source_run_not_found");

  const enriched = parseHerdrBranchContext(
    JSON.stringify({
      selected_text: basic.value.selectedText,
      workspace_id: basic.value.workspace,
      tab_id: basic.value.tabId,
      focused_pane_id: basic.value.focusedPaneId,
      source_task_id: binding.taskId,
      source_run_id: binding.runId,
      firstmate_session_ref: binding.firstmateSessionRef,
    }),
  );
  if (!enriched.ok) return fail(enriched.reason);

  const intentHash = sha256(JSON.stringify({
    source: enriched.value.source,
    selectedText: enriched.value.selectedText,
    target: "herdr-selection",
  }));
  const workflowAuthority =
    options.workflowAuthority
    ?? new FileFirstmateWorkflowAuthority({
      stateDir,
      env: options.env,
      now,
    });
  const decided = workflowAuthority.decideNativeReview({
    intentHash,
    source: enriched.value.source,
  });
  if (decided.status !== "resolved") {
    return fail("firstmate_decision_issuance_failed");
  }
  const workflowDecision = decided.workflowDecision;
  const workflowDecisionReceipt = decided.receipt;
  const reviewer = workflowAuthority.authorizeStage({
    workflowDecision,
    receipt: workflowDecisionReceipt,
    stageId: "reviewer",
  }).roleAssignment;
  const reportComposer = workflowAuthority.authorizeStage({
    workflowDecision,
    receipt: workflowDecisionReceipt,
    stageId: "report",
  }).roleAssignment;
  if (
    reportComposer.role !== "report_composer"
    || reportComposer.provider !== "firstmate"
  ) {
    return fail("firstmate_decision_issuance_failed");
  }
  const model = reviewer.resolvedModel;
  const registry = new FileRunRegistry({
    rootDir: join(stateDir, "run-registry"),
  });
  const opened = registry.openOrCreateRun({
    intent: {
      workflow: "native-review",
      projectDir: resolve(options.cwd),
      task: "Review the selected Herdr context.",
      source: enriched.value.source,
      inputs: {
        intentHash,
        selectedTextHash: sha256(enriched.value.selectedText),
      },
      decisionVersion: workflowDecision.workflowDecisionId,
    },
    owner: `native-review:${process.pid}:${randomUUID()}`,
    leaseTtlMs: parsePositiveInteger(
      options.env.ACM_RUN_LEASE_TTL_MS,
      900_000,
    ),
    now: now(),
  });
  const dispatchKey = workflowDispatchIdempotencyKey(
    opened.run.runId,
    workflowDecision.decisionHash,
    "reviewer",
    null,
  );
  const capsuleInput = reviewCapsuleInput(
    enriched.value,
    workflowDecision,
    workflowDecisionReceipt,
    opened.run.runId,
    dispatchKey,
    now,
  );
  if (opened.kind === "coalesced_completed") {
    const artifact = opened.run.completedArtifact;
    if (artifact === null) {
      return fail("canonical_review_requires_reconciliation");
    }
    const capsule = readCompletedCapsule(
      artifact.path,
      artifact.hash,
      opened.run.runId,
      dispatchKey,
    );
    if (capsule === null) {
      return fail("canonical_review_requires_reconciliation");
    }
    const desktopLaunch = await launchReviewDesktop(
      capsule,
      options,
      ports.launchDesktop,
    );
    return {
      ok: true,
      capsulePath: artifact.path,
      capsule,
      desktopLaunch,
      dedupeStatus: "coalesced_completed",
    };
  }
  if (opened.kind !== "created") {
    return fail(
      opened.kind === "coalesced_active"
        ? "canonical_review_active"
        : "canonical_review_requires_reconciliation",
    );
  }
  const lease = opened.lease;
  registry.recordDispatch(lease, {
    idempotencyKey: dispatchKey,
    target: reviewer.resolvedModel,
    receiptPath: null,
    accepted: false,
    now: now(),
  });
  const appServerOptions = codexAppServerOptions(
    options,
    workflowDecision,
    dispatchKey,
  );
  const createAppServer =
    ports.createAppServerReviewPort ?? createCodexAppServerReviewPort;
  let appServer: DisposableCodexReviewPort;
  try {
    appServer = createAppServer(appServerOptions);
  } catch {
    markReviewUnknown(registry, lease, now, "app_server_constructor_failed");
    releaseReviewLease(registry, lease);
    return fail("app_server_unavailable");
  }

  try {
    const capsuleResult = await createReviewCapsule(capsuleInput, {
      appServer,
    });
    if (!capsuleResult.ok) {
      markReviewUnknown(
        registry,
        lease,
        now,
        `codex_review_${capsuleResult.reason}`,
      );
      return fail(capsuleResult.reason);
    }
    registry.acceptDispatch(lease, {
      idempotencyKey: dispatchKey,
      target: capsuleResult.capsule.codex.reviewThreadId,
      receiptPath: null,
      now: now(),
    });
    registry.markRunning(lease, { now: now() });

    const capsulePath = join(
      stateDir,
      "codex-reviews",
      `${capsuleResult.capsule.capsuleId}.json`,
    );
    try {
      writeJsonAtomic(capsulePath, capsuleResult.capsule);
    } catch {
      markReviewUnknown(registry, lease, now, "capsule_persist_failed");
      return fail("capsule_persist_failed");
    }
    const capsuleHash = sha256(readFileSync(capsulePath, "utf8"));
    const capsuleReadBack = readCompletedCapsule(
      capsulePath,
      capsuleHash,
      opened.run.runId,
      dispatchKey,
    );
    if (
      capsuleReadBack === null
      || capsuleReadBack.capsuleId !== capsuleResult.capsule.capsuleId
    ) {
      markReviewUnknown(registry, lease, now, "capsule_readback_failed");
      return fail("capsule_persist_failed");
    }
    const current = registry.readRun(opened.run.runId);
    const attempt = current?.attempts.at(-1);
    if (attempt === undefined) {
      markReviewUnknown(registry, lease, now, "registry_attempt_missing");
      return fail("canonical_review_requires_reconciliation");
    }
    registry.completeAttempt(lease, {
      readback: {
        status: "found",
        runId: opened.run.runId,
        attemptId: attempt.id,
        artifactPath: capsulePath,
        artifactHash: capsuleHash,
      },
      now: now(),
    });

    return {
      ok: true,
      capsulePath,
      capsule: capsuleResult.capsule,
      desktopLaunch: await launchReviewDesktop(
        capsuleResult.capsule,
        options,
        ports.launchDesktop,
      ),
      dedupeStatus: "new",
    };
  } finally {
    await appServer.dispose();
    releaseReviewLease(registry, lease);
  }
}

export const runCodexReviewCommand = runCodexReviewFromHerdrSelection;

function reviewCapsuleInput(
  parsed: ParsedHerdrBranchContext,
  workflowDecision: WorkflowDecisionEnvelope,
  workflowDecisionReceipt: FirstmateDecisionReceipt,
  canonicalRunId: string,
  idempotencyKey: string,
  now: () => string,
): ReviewCapsuleInput {
  return {
    workflowDecision,
    workflowDecisionReceipt,
    canonicalRunId,
    idempotencyKey,
    source: {
      taskId: parsed.source.taskId,
      runId: parsed.source.runId,
      firstmateSessionRef: parsed.firstmateSessionRef,
      lineage: parsed.source,
    },
    target: {
      type: "custom",
      instructions: "Review the selected Herdr context.",
    },
    selection: {
      selectedText: parsed.selectedText,
      sourceArtifact: "herdr-selection",
      file: null,
      startLine: null,
      endLine: null,
    },
    prompt: {
      text: [
        "Review this Herdr selection for correctness, missing verification, handoff blockers, and implementation risk.",
        "Use concise findings and include file:line references when the selected context provides them.",
      ].join("\n"),
    },
    delivery: "detached",
    parentThreadReadState: "complete",
    now,
  };
}

function codexAppServerOptions(
  options: CodexReviewCommandOptions,
  workflowDecision: WorkflowDecisionEnvelope,
  idempotencyKey: string,
): CodexAppServerRuntimeOptions {
  const command = nonEmpty(options.env.ACM_CODEX_APP_SERVER_COMMAND);
  const args = nonEmpty(options.env.ACM_CODEX_APP_SERVER_ARGS);
  return {
    cwd: options.cwd,
    env: {
      ...options.env,
      ACM_WORKFLOW_DECISION_ID: workflowDecision.workflowDecisionId,
      ACM_DECISION_HASH: workflowDecision.decisionHash,
      ACM_STAGE_ID: "reviewer",
      ACM_IDEMPOTENCY_KEY: idempotencyKey,
    },
    model: workflowDecision.roleAssignments.find(
      (assignment) => assignment.role === "reviewer",
    )?.resolvedModel ?? "",
    threadConfig: {
      web_search: "disabled",
      mcp_servers: {},
      model_reasoning_effort:
        nonEmpty(options.env.ACM_CODEX_REVIEW_REASONING_EFFORT) ?? "high",
    },
    timeoutMs: parsePositiveInteger(
      options.env.ACM_CODEX_REVIEW_TIMEOUT_MS,
      600_000,
    ),
    now: options.now,
    ...(command === null ? {} : { command }),
    ...(args === null ? {} : { args: splitArgs(args) }),
  };
}

async function launchReviewDesktop(
  capsule: ReviewCapsule,
  options: CodexReviewCommandOptions,
  runner: CodexReviewDesktopLaunchRunner | undefined,
): Promise<CodexReviewDesktopLaunchStatus> {
  const launchReceipt = await (runner ?? defaultLaunchDesktop)({
    url: capsule.codex.desktopUrl,
    reviewThreadId: capsule.codex.reviewThreadId,
    cwd: options.cwd,
    env: options.env,
  });
  return launchReceipt.requested
    ? {
        status: "requested_unverified",
        url: capsule.codex.desktopUrl,
        reason: null,
      }
    : {
        status: "request_failed",
        url: capsule.codex.desktopUrl,
        reason: launchReceipt.reason,
      };
}

function markReviewUnknown(
  registry: FileRunRegistry,
  lease: RegistryLease,
  now: () => string,
  reason: string,
): void {
  registry.markUnknownOutcome(lease, {
    reason,
    readback: {
      status: "mismatch",
      checkedAt: now(),
      reason: "review_thread_identity_or_artifact_not_fully_read_back",
    },
    now: now(),
  });
}

function releaseReviewLease(
  registry: FileRunRegistry,
  lease: RegistryLease,
): void {
  try {
    registry.releaseLease(lease);
  } catch {
  }
}

function readCompletedCapsule(
  path: string,
  expectedHash: string,
  expectedRunId: string,
  expectedIdempotencyKey: string,
): ReviewCapsule | null {
  try {
    const contents = readFileSync(path, "utf8");
    if (sha256(contents) !== expectedHash) return null;
    const value: unknown = JSON.parse(contents);
    if (!isReviewCapsule(value)) return null;
    if (
      value.authority.canonicalRunId !== expectedRunId
      || value.authority.idempotencyKey !== expectedIdempotencyKey
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isReviewCapsule(value: unknown): value is ReviewCapsule {
  if (!isRecord(value)) return false;
  if (
    value.capsuleVersion !== 1
    || typeof value.capsuleId !== "string"
    || !isRecord(value.codex)
    || typeof value.codex.reviewThreadId !== "string"
    || typeof value.codex.desktopUrl !== "string"
    || !isRecord(value.authority)
    || value.authority.workflowAuthority !== "firstmate_verified"
    || value.authority.runtimeAuthority
      !== "canonical_run_registry_verified"
    || typeof value.authority.canonicalRunId !== "string"
    || typeof value.authority.idempotencyKey !== "string"
    || !isFirstmateDecisionReceipt(value.workflowDecisionReceipt)
  ) {
    return false;
  }
  try {
    assertWorkflowDecisionEnvelope(value.workflowDecision);
    if (
      !verifyFirstmateDecisionReceipt(
        value.workflowDecision,
        value.workflowDecisionReceipt,
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBasicHerdrSelection(
  contextJson: string,
):
  | { readonly ok: true; readonly value: BasicHerdrSelection }
  | {
      readonly ok: false;
      readonly reason: CodexReviewCommandFailureReason;
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson);
  } catch {
    return { ok: false, reason: "invalid_context_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "context_not_object" };
  }
  const record = parsed as Record<string, unknown>;
  const selectedText = firstString(record.selected_text, record.selectedText);
  if (selectedText === null || selectedText.trim().length === 0) {
    return { ok: false, reason: "selection_empty" };
  }
  const focusedPaneId = firstString(record.focused_pane_id, record.pane_id);
  if (focusedPaneId === null || focusedPaneId.trim().length === 0) {
    return { ok: false, reason: "source_pane_missing" };
  }
  const workspace = firstString(record.workspace_id);
  if (workspace === null || workspace.trim().length === 0) {
    return { ok: false, reason: "source_workspace_missing" };
  }
  const tabId = firstString(record.tab_id);
  if (tabId === null || tabId.trim().length === 0) {
    return { ok: false, reason: "source_tab_missing" };
  }
  return {
    ok: true,
    value: {
      selectedText,
      workspace,
      tabId,
      focusedPaneId,
    },
  };
}

function defaultLaunchDesktop(
  request: CodexReviewDesktopLaunchRequest,
): CodexReviewDesktopLaunchReceipt {
  const result = spawnSync("open", [request.url], {
    cwd: request.cwd,
    env: request.env,
    stdio: "ignore",
  });
  if (result.status === 0) return { requested: true, reason: null };
  return {
    requested: false,
    reason: result.error?.message ?? `open exited ${String(result.status)}`,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_STATE_DIR ?? join(cwd, "state", "aicoding-mate"));
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitArgs(value: string): readonly string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(
  reason: CodexReviewCommandFailureReason,
): CodexReviewCommandResult {
  return { ok: false, status: "failed_closed", reason };
}
