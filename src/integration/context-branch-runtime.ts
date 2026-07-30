import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  briefContextBranch,
  createContextBranch,
  expireBranch,
  parseHerdrBranchContext,
  type BranchClassifierPort,
  type BranchResearcherPort,
  type BranchTaskRunRegistryPort,
  type ContextBranchSession,
} from "../branch/index.ts";
import {
  selectedTextHash,
  sourceLineageHash,
  type AtomicFirstmateCapsuleInjectionPort,
  type AtomicCapsuleInjectionRequest,
  type CapsuleInjectionReceipt,
} from "../contracts/index.ts";
import { readRunRecord, type QuickRunRecord } from "../quick.ts";

export interface FirstmateSourceBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly firstmateSessionRef: string;
  readonly sourcePaneId: string;
  readonly quickRecordPath: string;
  readonly firstmateRoot: string;
  readonly fmHome: string;
  readonly herdrSession: string;
  readonly workerTarget: string;
}

export interface ContextBranchStartPorts {
  readonly resolveSource: (
    focusedPaneId: string,
  ) => FirstmateSourceBinding | null;
  readonly openBranchPane: (
    branchPath: string,
  ) => { readonly ok: boolean; readonly error: string | null };
}

export interface ContextBranchStartOptions {
  readonly contextJson: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly ports?: ContextBranchStartPorts;
}

export type ContextBranchStartResult =
  | {
      readonly ok: true;
      readonly branchPath: string;
      readonly session: ContextBranchSession;
    }
  | { readonly ok: false; readonly reason: string };

interface BasicInvocationContext {
  readonly selectedText: string;
  readonly workspace: string;
  readonly tabId: string;
  readonly focusedPaneId: string;
}

export function startContextBranch(
  options: ContextBranchStartOptions,
): ContextBranchStartResult {
  const now = options.now ?? (() => new Date().toISOString());
  const basic = parseBasicInvocationContext(options.contextJson);
  if (!basic.ok) return basic;
  const stateDir = resolveStateDir(options.cwd, options.env);
  const ports =
    options.ports ??
    defaultStartPorts(options.cwd, options.env, stateDir);
  const binding = ports.resolveSource(basic.value.focusedPaneId);
  if (binding === null) {
    return { ok: false, reason: "firstmate_source_run_not_found" };
  }
  const enriched = JSON.stringify({
    selected_text: basic.value.selectedText,
    workspace_id: basic.value.workspace,
    tab_id: basic.value.tabId,
    focused_pane_id: basic.value.focusedPaneId,
    source_task_id: binding.taskId,
    source_run_id: binding.runId,
    firstmate_session_ref: binding.firstmateSessionRef,
  });
  const parsed = parseHerdrBranchContext(enriched);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const branch = briefContextBranch(
    createContextBranch(parsed.value, {
      branchId: `branch-${parsed.value.contextHash.slice(0, 12)}-${randomUUID()}`,
      now,
    }),
    now,
  );
  if (branch.status === "failed_closed") {
    return {
      ok: false,
      reason: branch.failureReason ?? "branch_brief_failed",
    };
  }
  const branchPath = join(
    stateDir,
    "branches",
    `${branch.branchId}.json`,
  );
  writeBranchSession(branchPath, branch);
  const opened = ports.openBranchPane(branchPath);
  if (!opened.ok) {
    writeBranchSession(branchPath, expireBranch(branch, now));
    return {
      ok: false,
      reason: opened.error ?? "branch_pane_open_failed",
    };
  }
  return { ok: true, branchPath, session: branch };
}

export function readBranchSession(
  path: string,
): ContextBranchSession | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isContextBranchSession(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeBranchSession(
  path: string,
  session: ContextBranchSession,
): ContextBranchSession {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`);
  renameSync(temporary, path);
  return session;
}

export function createDefaultBranchRegistry(
  session: ContextBranchSession,
  cwd: string,
  env: NodeJS.ProcessEnv,
): BranchTaskRunRegistryPort {
  const stateDir = resolveStateDir(cwd, env);
  return {
    lookup(source) {
      const binding = findBindingByRun(
        stateDir,
        source.runId,
        source.taskId,
      );
      if (
        binding === null ||
        binding.firstmateSessionRef !== session.firstmateSessionRef ||
        !bindingOwnsPane(binding, source.paneId) ||
        !herdrHasPane(source.paneId, cwd, env)
      ) {
        return null;
      }
      return {
        taskId: binding.taskId,
        runId: binding.runId,
        firstmateSessionRef: binding.firstmateSessionRef,
        sourceLineageHash: sourceLineageHash(source),
        consumedLineageIntentIds: consumedIntentIds(stateDir),
      };
    },
  };
}

export function createDefaultBranchClassifier(
  cwd: string,
  env: NodeJS.ProcessEnv,
): BranchClassifierPort {
  return (input) => {
    const output = runClaudeText(
      [
        "只輸出 new_task 或 modify_task，不要其他文字。",
        "若內容要求延伸出獨立工作，選 new_task；若要求改動來源工作，選 modify_task。",
        `選取內容：${input.selectedText}`,
        `簡介：${input.brief}`,
      ].join("\n"),
      cwd,
      env,
    );
    if (output === "new_task" || output === "modify_task") return output;
    throw new Error("branch_classifier_contract_invalid");
  };
}

export function createDefaultBranchResearcher(
  cwd: string,
  env: NodeJS.ProcessEnv,
): BranchResearcherPort {
  return (input) => {
    const output = runClaudeText(
      [
        "請用繁體中文簡介這段內容需要理解的技術概念。",
        "先說架構與用途，再說最多三個需要知道的細節；不要輸出實作流水帳。",
        `內容：${input.selectedText}`,
        `現有簡介：${input.brief}`,
      ].join("\n"),
      cwd,
      env,
    );
    if (!output) throw new Error("branch_research_contract_invalid");
    return {
      summary: output,
      evidence: [`claude:${env.ACM_CLAUDE_REVIEW_MODEL ?? "fable"}`],
    };
  };
}

export function createDefaultCapsuleInjectionPort(
  cwd: string,
  env: NodeJS.ProcessEnv,
): AtomicFirstmateCapsuleInjectionPort {
  const stateDir = resolveStateDir(cwd, env);
  return {
    async revalidateAndInject(
      request: AtomicCapsuleInjectionRequest,
    ): Promise<CapsuleInjectionReceipt> {
      const receiptPath = join(
        stateDir,
        "branches",
        "receipts",
        `${request.capsule.capsuleId}.json`,
      );
      if (existsSync(receiptPath)) {
        return {
          accepted: true,
          observedLineage: request.capsule.source,
          targetSessionRef: request.capsule.firstmateSessionRef,
          injectedTextHash: request.capsule.selectedTextHash,
          idempotencyStatus: "duplicate",
          reason: null,
        };
      }
      const lockPath = `${receiptPath}.lock`;
      mkdirSync(dirname(receiptPath), { recursive: true });
      try {
        mkdirSync(lockPath);
      } catch {
        return rejectedInjection("capsule_injection_in_progress");
      }
      try {
        const binding = findBindingByRun(
          stateDir,
          request.capsule.source.runId,
          request.capsule.source.taskId,
        );
        if (
          binding === null ||
          binding.firstmateSessionRef !==
            request.capsule.firstmateSessionRef ||
          !bindingOwnsPane(binding, request.capsule.source.paneId) ||
          sourceLineageHash(request.capsule.source) !==
            request.expectedLineageHash ||
          !herdrHasPane(request.capsule.source.paneId, cwd, env)
        ) {
          return rejectedInjection("source_lineage_changed");
        }
        const marker = `ACM_CAPSULE_HASH=${request.capsule.selectedTextHash}`;
        const message = [
          "[AI Coding Mate Context Capsule]",
          `Intent: ${request.capsule.mutationIntent}`,
          `Confirmed recitation: ${request.capsule.recitation}`,
          "Selected context:",
          request.capsule.selectedText,
          marker,
          "Please apply this as a new task or modification, then report the resulting task state.",
        ].join("\n");
        const runtimeEnv = {
          ...env,
          FM_HOME: binding.fmHome,
          FIRSTMATE_ROOT: binding.firstmateRoot,
          HERDR_SESSION: binding.herdrSession,
        };
        const sent = run(
          join(binding.firstmateRoot, "bin", "fm-send.sh"),
          [binding.taskId, message],
          binding.firstmateRoot,
          runtimeEnv,
          30_000,
        );
        if (sent.status !== 0) {
          return rejectedInjection(
            compactFailure("fm_send_failed", sent.stderr),
          );
        }
        const peeked = run(
          join(binding.firstmateRoot, "bin", "fm-peek.sh"),
          [binding.taskId, "160"],
          binding.firstmateRoot,
          runtimeEnv,
          30_000,
        );
        if (peeked.status !== 0 || !peeked.stdout.includes(marker)) {
          return rejectedInjection("capsule_injection_readback_failed");
        }
        const receipt: CapsuleInjectionReceipt = {
          accepted: true,
          observedLineage: request.capsule.source,
          targetSessionRef: request.capsule.firstmateSessionRef,
          injectedTextHash: request.capsule.selectedTextHash,
          idempotencyStatus: "accepted",
          reason: null,
        };
        const temporary = `${receiptPath}.tmp-${process.pid}`;
        writeFileSync(
          temporary,
          `${JSON.stringify(
            {
              capsuleId: request.capsule.capsuleId,
              lineageIntentId: request.capsule.capsuleId,
              receipt,
            },
            null,
            2,
          )}\n`,
        );
        renameSync(temporary, receiptPath);
        return receipt;
      } finally {
        if (existsSync(lockPath)) rmdirSync(lockPath);
      }
    },
  };
}

export function resolveFirstmateSourceBinding(
  stateDir: string,
  focusedPaneId: string,
): FirstmateSourceBinding | null {
  const runsDir = join(stateDir, "runs");
  if (!existsSync(runsDir)) return null;
  const records = readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRunRecord(join(runsDir, name)))
    .filter((record): record is QuickRunRecord => record !== undefined)
    .filter(
      (record) =>
        record.source.paneId === focusedPaneId ||
        record.worker.target === focusedPaneId,
    )
    .sort((left, right) =>
      left.updatedAt < right.updatedAt
        ? 1
        : left.updatedAt > right.updatedAt
          ? -1
          : 0,
    );
  const record = records[0];
  if (
    record === undefined ||
    record.source.paneId === undefined ||
    record.worker.target === undefined ||
    record.recordPath === undefined
  ) {
    return null;
  }
  return {
    taskId: record.worker.taskId,
    runId: record.id,
    firstmateSessionRef: record.worker.taskId,
    sourcePaneId: record.source.paneId,
    quickRecordPath: record.recordPath,
    firstmateRoot: record.firstmateRoot,
    fmHome: record.fmHome,
    herdrSession: record.herdr.session,
    workerTarget: record.worker.target,
  };
}

function defaultStartPorts(
  cwd: string,
  env: NodeJS.ProcessEnv,
  stateDir: string,
): ContextBranchStartPorts {
  return {
    resolveSource: (focusedPaneId) =>
      resolveFirstmateSourceBinding(stateDir, focusedPaneId),
    openBranchPane(branchPath) {
      const result = run(
        env.HERDR_BIN_PATH || "herdr",
        [
          "plugin",
          "pane",
          "open",
          "--plugin",
          "ai-coding-mate",
          "--entrypoint",
          "context-branch",
          "--placement",
          "tab",
          "--env",
          `ACM_BRANCH_PATH=${branchPath}`,
          "--focus",
        ],
        cwd,
        env,
        15_000,
      );
      return {
        ok: result.status === 0,
        error:
          result.status === 0
            ? null
            : compactFailure("branch_pane_open_failed", result.stderr),
      };
    },
  };
}

function findBindingByRun(
  stateDir: string,
  runId: string,
  taskId: string,
): FirstmateSourceBinding | null {
  const record = readRunRecord(join(stateDir, "runs", `${runId}.json`));
  if (
    record === undefined ||
    record.worker.taskId !== taskId ||
    record.source.paneId === undefined ||
    record.worker.target === undefined ||
    record.recordPath === undefined
  ) {
    return null;
  }
  return {
    taskId,
    runId,
    firstmateSessionRef: taskId,
    sourcePaneId: record.source.paneId,
    quickRecordPath: record.recordPath,
    firstmateRoot: record.firstmateRoot,
    fmHome: record.fmHome,
    herdrSession: record.herdr.session,
    workerTarget: record.worker.target,
  };
}

function consumedIntentIds(stateDir: string): string[] {
  const receiptDir = join(stateDir, "branches", "receipts");
  if (!existsSync(receiptDir)) return [];
  return readdirSync(receiptDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        const value: unknown = JSON.parse(
          readFileSync(join(receiptDir, name), "utf8"),
        );
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return null;
        }
        const lineageIntentId = (value as Record<string, unknown>)
          .lineageIntentId;
        return typeof lineageIntentId === "string" && lineageIntentId
          ? lineageIntentId
          : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null);
}

function bindingOwnsPane(
  binding: FirstmateSourceBinding,
  paneId: string,
): boolean {
  return binding.sourcePaneId === paneId || binding.workerTarget === paneId;
}

function parseBasicInvocationContext(
  contextJson: string,
):
  | { readonly ok: true; readonly value: BasicInvocationContext }
  | { readonly ok: false; readonly reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(contextJson);
  } catch {
    return { ok: false, reason: "invalid_context_json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "context_not_object" };
  }
  const record = value as Record<string, unknown>;
  const selectedText = firstString(
    record.selected_text,
    record.selectedText,
  );
  if (selectedText === null || !selectedText.trim()) {
    return { ok: false, reason: "selection_empty" };
  }
  const focusedPaneId = firstString(
    record.focused_pane_id,
    record.pane_id,
  );
  if (focusedPaneId === null || !focusedPaneId.trim()) {
    return { ok: false, reason: "source_pane_missing" };
  }
  const workspace =
    firstString(
      record.workspace_id,
      record.workspace_label,
      record.workspace_cwd,
    ) ?? focusedPaneId;
  const tabId =
    firstString(record.tab_id, record.tab_label) ?? focusedPaneId;
  return {
    ok: true,
    value: { selectedText, workspace, tabId, focusedPaneId },
  };
}

function runClaudeText(
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const model = env.ACM_CLAUDE_REVIEW_MODEL ?? "fable";
  const runtimeEnv = { ...env };
  delete runtimeEnv.CLAUDE_CODE_SPAWN_BACKEND;
  delete runtimeEnv.CLAUDE_CODE_WORKFLOWS;
  delete runtimeEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const result = run(
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
    cwd,
    runtimeEnv,
    240_000,
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(compactFailure("claude_branch_failed", result.stderr));
  }
  return result.stdout.trim();
}

function herdrHasPane(
  paneId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const snapshot = run(
    env.HERDR_BIN_PATH || "herdr",
    ["api", "snapshot"],
    cwd,
    env,
    10_000,
  );
  if (snapshot.status !== 0) return false;
  try {
    const value: unknown = JSON.parse(snapshot.stdout);
    return collectPaneIds(value).includes(paneId);
  } catch {
    return false;
  }
}

function collectPaneIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPaneIds);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own =
    typeof record.pane_id === "string" ? [record.pane_id] : [];
  return [
    ...own,
    ...Object.values(record).flatMap(collectPaneIds),
  ];
}

function rejectedInjection(reason: string): CapsuleInjectionReceipt {
  return {
    accepted: false,
    observedLineage: null,
    targetSessionRef: null,
    injectedTextHash: null,
    idempotencyStatus: "rejected",
    reason,
  };
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(command, [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function compactFailure(prefix: string, stderr: string): string {
  const detail = stderr.trim().split(/\r?\n/)[0];
  return detail ? `${prefix}:${detail}` : prefix;
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_STATE_DIR ?? join(cwd, "state", "aicoding-mate"));
}

function isContextBranchSession(
  value: unknown,
): value is ContextBranchSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.branchId === "string" &&
    typeof record.status === "string" &&
    typeof record.selectedTextHash === "string" &&
    typeof record.sourceLineageHash === "string"
  );
}

export function branchBindingHash(binding: FirstmateSourceBinding): string {
  return selectedTextHash(JSON.stringify(binding));
}
