import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  parseHerdrBranchContext,
  type BranchFailureReason,
  type ParsedHerdrBranchContext,
} from "../branch/index.ts";
import {
  createReviewCapsule,
  type CodexAppServerReviewPort,
  type ReviewCapsule,
  type ReviewCapsuleFailureReason,
  type ReviewCapsuleInput,
} from "../review/index.ts";
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
  | "app_server_unavailable"
  | "capsule_persist_failed"
  | ReviewCapsuleFailureReason;

export type CodexReviewCommandResult =
  | {
      readonly ok: true;
      readonly capsulePath: string;
      readonly capsule: ReviewCapsule;
      readonly desktopLaunch: CodexReviewDesktopLaunchStatus;
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

  const capsuleInput = reviewCapsuleInput(enriched.value, options.now);
  const appServerOptions = codexAppServerOptions(options);
  const createAppServer =
    ports.createAppServerReviewPort ?? createCodexAppServerReviewPort;
  let appServer: DisposableCodexReviewPort;
  try {
    appServer = createAppServer(appServerOptions);
  } catch {
    return fail("app_server_unavailable");
  }

  try {
    const capsuleResult = await createReviewCapsule(capsuleInput, {
      appServer,
    });
    if (!capsuleResult.ok) return fail(capsuleResult.reason);

    const capsulePath = join(
      stateDir,
      "codex-reviews",
      `${capsuleResult.capsule.capsuleId}.json`,
    );
    try {
      writeJsonAtomic(capsulePath, capsuleResult.capsule);
    } catch {
      return fail("capsule_persist_failed");
    }

    const launchReceipt = await (
      ports.launchDesktop ?? defaultLaunchDesktop
    )({
      url: capsuleResult.capsule.codex.desktopUrl,
      reviewThreadId: capsuleResult.capsule.codex.reviewThreadId,
      cwd: options.cwd,
      env: options.env,
    });

    return {
      ok: true,
      capsulePath,
      capsule: capsuleResult.capsule,
      desktopLaunch: launchReceipt.requested
        ? {
            status: "requested_unverified",
            url: capsuleResult.capsule.codex.desktopUrl,
            reason: null,
          }
        : {
            status: "request_failed",
            url: capsuleResult.capsule.codex.desktopUrl,
            reason: launchReceipt.reason,
          },
    };
  } finally {
    await appServer.dispose();
  }
}

export const runCodexReviewCommand = runCodexReviewFromHerdrSelection;

function reviewCapsuleInput(
  parsed: ParsedHerdrBranchContext,
  now: (() => string) | undefined,
): ReviewCapsuleInput {
  return {
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
): CodexAppServerRuntimeOptions {
  const command = nonEmpty(options.env.ACM_CODEX_APP_SERVER_COMMAND);
  const args = nonEmpty(options.env.ACM_CODEX_APP_SERVER_ARGS);
  return {
    cwd: options.cwd,
    env: options.env,
    model: nonEmpty(options.env.ACM_CODEX_REVIEW_MODEL) ?? "gpt-5.6-sol",
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
  const workspace =
    firstString(
      record.workspace_id,
      record.workspace,
      record.workspace_label,
      record.workspace_cwd,
    ) ?? focusedPaneId;
  const tabId =
    firstString(record.tab_id, record.tabId, record.tab_label) ??
    focusedPaneId;
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

function fail(
  reason: CodexReviewCommandFailureReason,
): CodexReviewCommandResult {
  return { ok: false, status: "failed_closed", reason };
}
