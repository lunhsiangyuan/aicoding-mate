import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { FileFirstmateWorkflowAuthority } from "../src/authority/firstmate-workflow-authority.ts";
import { sourceLineageHash } from "../src/contracts/index.ts";
import {
  runCodexReviewFromHerdrSelection,
  type CodexReviewDesktopLaunchRequest,
  type DisposableCodexReviewPort,
} from "../src/integration/codex-review-command.ts";
import type { CodexAppServerRuntimeOptions } from "../src/integration/codex-review-runtime.ts";
import type {
  CodexReviewReadback,
  CodexReviewStartReceipt,
  CodexReviewStartRequest,
} from "../src/review/index.ts";

function invocation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    selected_text: "Review this adapter source.",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    focused_pane_id: "pane-1",
    ...overrides,
  });
}

describe("Codex review command bridge", () => {
  test("resolves a Herdr selection, persists the capsule, and requests an unverified desktop launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    const stateDir = join(root, "state", "aicoding-mate");
    writeRunRecord(stateDir);
    const captured: {
      appServerOptions: CodexAppServerRuntimeOptions | null;
      startRequest: CodexReviewStartRequest | null;
      launchRequest: CodexReviewDesktopLaunchRequest | null;
    } = {
      appServerOptions: null,
      startRequest: null,
      launchRequest: null,
    };
    let disposed = false;

    const result = await runCodexReviewFromHerdrSelection({
      contextJson: invocation(),
      cwd: root,
      env: {},
      now: () => "2026-07-30T21:00:00.000Z",
      ports: {
        createAppServerReviewPort(options) {
          captured.appServerOptions = options;
          return fakeReviewPort({
            onStart(request) {
              captured.startRequest = request;
            },
            onDispose() {
              disposed = true;
            },
          });
        },
        async launchDesktop(request) {
          captured.launchRequest = request;
          return { requested: true, reason: null };
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const capturedOptions = requireValue(
      captured.appServerOptions,
      "appServerOptions",
    );
    expect(capturedOptions.cwd).toBe(root);
    const propagatedEnv = requireValue(
      capturedOptions.env ?? null,
      "appServerEnv",
    );
    const workflowDecisionId = requireValue(
      propagatedEnv.ACM_WORKFLOW_DECISION_ID ?? null,
      "workflowDecisionId",
    );
    const decisionHash = requireValue(
      propagatedEnv.ACM_DECISION_HASH ?? null,
      "decisionHash",
    );
    const idempotencyKey = requireValue(
      propagatedEnv.ACM_IDEMPOTENCY_KEY ?? null,
      "idempotencyKey",
    );
    expect(workflowDecisionId).toMatch(/^wfd_/);
    expect(decisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(propagatedEnv.ACM_STAGE_ID).toBe("reviewer");
    expect(idempotencyKey).toMatch(/^acm-dispatch-/);
    expect(capturedOptions.model).toBe("gpt-5.6-sol");
    expect(capturedOptions.threadConfig).toEqual({
      web_search: "disabled",
      mcp_servers: {},
      model_reasoning_effort: "high",
    });
    expect(capturedOptions.timeoutMs).toBe(600_000);
    expect(typeof capturedOptions.now).toBe("function");
    const capturedStart = requireValue(captured.startRequest, "startRequest");
    expect(capturedStart.source).toEqual({
      taskId: "task-1",
      runId: "run-1",
      firstmateSessionRef: "task-1",
      lineage: {
        taskId: "task-1",
        runId: "run-1",
        workspace: "workspace-1",
        tabId: "tab-1",
        paneId: "pane-1",
      },
    });
    expect(capturedStart.workflowDecisionId).toBe(workflowDecisionId);
    expect(capturedStart.decisionHash).toBe(decisionHash);
    expect(capturedStart.idempotencyKey).toBe(idempotencyKey);
    expect(capturedStart.stageId).toBe("reviewer");
    expect(capturedStart.exactAssignment.resolvedModel).toBe("gpt-5.6-sol");
    expect(capturedStart.selection).toEqual({
      selectedText: "Review this adapter source.",
      sourceArtifact: "herdr-selection",
      file: null,
      startLine: null,
      endLine: null,
    });
    expect(capturedStart.target).toEqual({
      type: "custom",
      instructions: "Review the selected Herdr context.",
    });
    expect(result.capsulePath).toBe(
      join(stateDir, "codex-reviews", `${result.capsule.capsuleId}.json`),
    );
    expect(existsSync(result.capsulePath)).toBe(true);
    expect(readJsonObject(result.capsulePath).codex).toEqual(
      result.capsule.codex,
    );
    expect(result.desktopLaunch).toEqual({
      status: "requested_unverified",
      url: "codex://threads/thread-review-1",
      reason: null,
    });
    expect(requireValue(captured.launchRequest, "launchRequest")).toEqual({
      url: "codex://threads/thread-review-1",
      reviewThreadId: "thread-review-1",
      cwd: root,
      env: {},
    });
    expect(disposed).toBe(true);
    expect(result.dedupeStatus).toBe("new");
  });

  test("forwards upstream-decided env policy without choosing workflow or model itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    const stateDir = join(root, "custom-state");
    writeRunRecord(stateDir);
    const captured: {
      appServerOptions: CodexAppServerRuntimeOptions | null;
    } = { appServerOptions: null };

    const env = {
      ACM_STATE_DIR: stateDir,
      ACM_CODEX_REVIEW_MODEL: "gpt-5.5",
      ACM_CODEX_REVIEW_REASONING_EFFORT: "medium",
      ACM_CODEX_REVIEW_TIMEOUT_MS: "1234",
      ACM_CODEX_APP_SERVER_COMMAND: "/tmp/codex",
      ACM_CODEX_APP_SERVER_ARGS: "app-server --stdio",
    };
    const result = await runCodexReviewFromHerdrSelection({
      contextJson: invocation(),
      cwd: root,
      env,
      ports: {
        createAppServerReviewPort(options) {
          captured.appServerOptions = options;
          return fakeReviewPort();
        },
        launchDesktop: () => ({ requested: true, reason: null }),
      },
    });

    expect(result.ok).toBe(true);
    const capturedOptions = requireValue(
      captured.appServerOptions,
      "appServerOptions",
    );
    expect(capturedOptions).toMatchObject({
      cwd: root,
      model: "gpt-5.5",
      threadConfig: {
        web_search: "disabled",
        mcp_servers: {},
        model_reasoning_effort: "medium",
      },
      timeoutMs: 1234,
      now: undefined,
      command: "/tmp/codex",
      args: ["app-server", "--stdio"],
    });
    const propagatedEnv = requireValue(
      capturedOptions.env ?? null,
      "appServerEnv",
    );
    expect(propagatedEnv).toMatchObject(env);
    expect(propagatedEnv.ACM_WORKFLOW_DECISION_ID).toMatch(/^wfd_/);
    expect(propagatedEnv.ACM_DECISION_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(propagatedEnv.ACM_STAGE_ID).toBe("reviewer");
    expect(propagatedEnv.ACM_IDEMPOTENCY_KEY).toMatch(
      /^acm-dispatch-/,
    );
  });

  test("fails closed before app-server when selection is malformed or source binding is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    let created = 0;
    const malformed = await runCodexReviewFromHerdrSelection({
      contextJson: invocation({ selected_text: "" }),
      cwd: root,
      env: {},
      ports: {
        createAppServerReviewPort() {
          created += 1;
          return fakeReviewPort();
        },
      },
    });
    const missingSource = await runCodexReviewFromHerdrSelection({
      contextJson: invocation(),
      cwd: root,
      env: {},
      ports: {
        createAppServerReviewPort() {
          created += 1;
          return fakeReviewPort();
        },
      },
    });

    expect(malformed).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "selection_empty",
    });
    expect(missingSource).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "firstmate_source_run_not_found",
    });
    expect(created).toBe(0);
  });

  test("rejects workspace and tab labels when exact Herdr IDs are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    let created = 0;
    const result = await runCodexReviewFromHerdrSelection({
      contextJson: invocation({
        workspace_id: undefined,
        tab_id: undefined,
        workspace_label: "workspace-label-only",
        tab_label: "tab-label-only",
      }),
      cwd: root,
      env: {},
      ports: {
        createAppServerReviewPort() {
          created += 1;
          return fakeReviewPort();
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_workspace_missing",
    });
    expect(created).toBe(0);
  });

  test("does not create the app-server when Firstmate decision issuance fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    const stateDir = join(root, "state", "aicoding-mate");
    writeRunRecord(stateDir);
    let appServerCreated = false;

    const result = await runCodexReviewFromHerdrSelection({
      contextJson: invocation(),
      cwd: root,
      env: {},
      workflowAuthority: new FileFirstmateWorkflowAuthority({
        stateDir,
        decisionStore: {
          issueDecision() {
            throw new Error("authority_store_unavailable");
          },
          readDecision() {
            return undefined;
          },
        },
      }),
      ports: {
        createAppServerReviewPort() {
          appServerCreated = true;
          return fakeReviewPort();
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "firstmate_decision_issuance_failed",
    });
    expect(appServerCreated).toBe(false);
  });

  test("fails closed without persistence or desktop launch when capsule verification fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    const stateDir = join(root, "state", "aicoding-mate");
    writeRunRecord(stateDir);
    let launched = false;
    let disposed = false;

    const result = await runCodexReviewFromHerdrSelection({
      contextJson: invocation(),
      cwd: root,
      env: {},
      ports: {
        createAppServerReviewPort() {
          return fakeReviewPort({
            readback: {
              ok: true,
              threadId: "thread-review-1",
              sourceThreadId: "thread-source-1",
              sourceLineageHash: "wrong-lineage",
              summary: "Review completed.",
              decision: null,
              rawReviewText: "Review completed.",
              annotations: [],
              nativeAnnotationExport: "unverifiable",
              eventIds: ["turn-review-1"],
              completedAt: "2026-07-30T21:01:00.000Z",
            },
            onDispose() {
              disposed = true;
            },
          });
        },
        launchDesktop() {
          launched = true;
          return { requested: true, reason: null };
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_lineage_mismatch",
    });
    expect(existsSync(join(stateDir, "codex-reviews"))).toBe(false);
    expect(launched).toBe(false);
    expect(disposed).toBe(true);
  });

  test("keeps completed review success separate from an unverified desktop request failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    writeRunRecord(join(root, "state", "aicoding-mate"));

    const result = await runCodexReviewFromHerdrSelection({
      contextJson: invocation(),
      cwd: root,
      env: {},
      ports: {
        createAppServerReviewPort: () => fakeReviewPort(),
        launchDesktop: () => ({
          requested: false,
          reason: "open exited 1",
        }),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.desktopLaunch).toEqual({
      status: "request_failed",
      url: "codex://threads/thread-review-1",
      reason: "open exited 1",
    });
    expect(existsSync(result.capsulePath)).toBe(true);
  });

  test("reconciles a crash after review/start by reading the same Codex thread without redispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-reconcile-"));
    writeRunRecord(join(root, "state", "aicoding-mate"));
    let factoryCalls = 0;
    let reviewStarts = 0;
    let restores = 0;
    let availabilityObservations = 0;
    const firstStartedRequests: CodexReviewStartRequest[] = [];
    const restoredRequests: CodexReviewStartRequest[] = [];
    const ports = {
      observeAvailability() {
        availabilityObservations += 1;
        return {
          id: `native-review-drift-${availabilityObservations}`,
          capturedAt:
            availabilityObservations === 1
              ? "2026-07-30T21:00:00.000Z"
              : "2026-07-30T21:01:00.000Z",
          candidates: [
            {
              alias: "codex-app-server",
              provider: "openai" as const,
              family: "openai" as const,
              resolvedModel: "firstmate-policy-resolved",
              capabilityTier: "architecture" as const,
              state: "available" as const,
              reason: null,
            },
          ],
        };
      },
      createAppServerReviewPort(options: CodexAppServerRuntimeOptions) {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return {
            async startReview(request: CodexReviewStartRequest) {
              reviewStarts += 1;
              firstStartedRequests.push(request);
              const receipt = {
                sourceThreadId: "thread-source-1",
                reviewThreadId: "thread-review-1",
                delivery: "detached" as const,
                turnId: "turn-review-1",
                eventIds: ["turn-review-1"],
              };
              await options.onReviewStarted?.(request, receipt);
              throw new Error("process_crashed_after_review_start");
            },
            async readReviewThread() {
              throw new Error("first_process_cannot_read");
            },
            async dispose() {},
          };
        }
        let restoredReceipt: {
          readonly sourceThreadId: string;
          readonly reviewThreadId: string;
        } | null = null;
        return {
          async startReview() {
            reviewStarts += 1;
            throw new Error("review_start_must_not_repeat");
          },
          restoreReviewSession(
            request: CodexReviewStartRequest,
            receipt: CodexReviewStartReceipt,
          ) {
            restores += 1;
            restoredRequests.push(request);
            restoredReceipt = receipt;
          },
          async readReviewThread(reviewThreadId: string) {
            const request = requireValue(
              restoredRequests.at(-1) ?? null,
              "restoredRequest",
            );
            const receipt = requireValue(restoredReceipt, "restoredReceipt");
            return {
              ok: true as const,
              threadId: reviewThreadId,
              sourceThreadId: receipt.sourceThreadId,
              sourceLineageHash: sourceLineageHash(request.source.lineage),
              summary: "src/review/index.ts:12 changes requested",
              decision: "changes_requested" as const,
              rawReviewText: "src/review/index.ts:12 changes requested",
              annotations: [],
              nativeAnnotationExport: "unverifiable" as const,
              eventIds: ["turn-review-1"],
              completedAt: "2026-07-30T21:01:00.000Z",
            };
          },
          async dispose() {},
        };
      },
      launchDesktop() {
        return { requested: true as const, reason: null };
      },
    };
    const options = {
      contextJson: invocation(),
      cwd: root,
      env: {},
      now: () => "2026-07-30T21:00:00.000Z",
      ports,
    };

    const crashed = await runCodexReviewFromHerdrSelection(options);
    const reconciled = await runCodexReviewFromHerdrSelection(options);

    expect(crashed).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "app_server_unavailable",
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(reconciled.reason);
    expect(reconciled.dedupeStatus).toBe("reconciled");
    expect(reconciled.capsule.codex.reviewThreadId).toBe("thread-review-1");
    expect(factoryCalls).toBe(2);
    expect(reviewStarts).toBe(1);
    expect(restores).toBe(1);
    expect(restoredRequests.at(-1)?.workflowDecisionId).toBe(
      firstStartedRequests.at(-1)?.workflowDecisionId,
    );
    expect(restoredRequests.at(-1)?.decisionHash).toBe(
      firstStartedRequests.at(-1)?.decisionHash,
    );
    expect(restoredRequests.at(-1)?.idempotencyKey).toBe(
      firstStartedRequests.at(-1)?.idempotencyKey,
    );
  });

  test("coalesces the same completed selection without starting another Codex review", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-review-command-"));
    writeRunRecord(join(root, "state", "aicoding-mate"));
    let created = 0;
    let started = 0;
    let launched = 0;
    const ports = {
      createAppServerReviewPort() {
        created += 1;
        return fakeReviewPort({
          onStart() {
            started += 1;
          },
        });
      },
      launchDesktop() {
        launched += 1;
        return { requested: true as const, reason: null };
      },
    };
    const options = {
      contextJson: invocation(),
      cwd: root,
      env: {},
      now: () => "2026-07-30T21:00:00.000Z",
      ports,
    };

    const first = await runCodexReviewFromHerdrSelection(options);
    const second = await runCodexReviewFromHerdrSelection(options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("review should complete");
    expect(first.dedupeStatus).toBe("new");
    expect(second.dedupeStatus).toBe("coalesced_completed");
    expect(second.capsulePath).toBe(first.capsulePath);
    expect(second.capsule.codex.reviewThreadId).toBe(
      first.capsule.codex.reviewThreadId,
    );
    expect(created).toBe(1);
    expect(started).toBe(1);
    expect(launched).toBe(2);
  });
});

function fakeReviewPort(options: {
  readonly onStart?: (request: CodexReviewStartRequest) => void;
  readonly onDispose?: () => void;
  readonly readback?: CodexReviewReadback;
} = {}): DisposableCodexReviewPort {
  let startRequest: CodexReviewStartRequest | null = null;
  return {
    async startReview(request) {
      startRequest = request;
      options.onStart?.(request);
      return {
        sourceThreadId: "thread-source-1",
        reviewThreadId: "thread-review-1",
        delivery: "detached",
        turnId: "turn-review-1",
        eventIds: ["turn-review-1"],
      };
    },
    async readReviewThread() {
      if (options.readback !== undefined) return options.readback;
      if (startRequest === null) throw new Error("start_missing");
      return {
        ok: true,
        threadId: "thread-review-1",
        sourceThreadId: "thread-source-1",
        sourceLineageHash: sourceLineageHash(startRequest.source.lineage),
        summary: "src/example.ts:12 changes requested",
        decision: "changes_requested",
        rawReviewText: "src/example.ts:12 changes requested",
        annotations: [
          {
            file: "src/example.ts",
            line: 12,
            endLine: 12,
            body: "Risk found.",
            source: "codex_review_text",
          },
        ],
        nativeAnnotationExport: "unverifiable",
        eventIds: ["turn-review-1"],
        completedAt: "2026-07-30T21:01:00.000Z",
      };
    },
    async dispose() {
      options.onDispose?.();
    },
  };
}

function writeRunRecord(stateDir: string): void {
  const runsDir = join(stateDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const recordPath = join(runsDir, "run-1.json");
  writeFileSync(
    recordPath,
    JSON.stringify({
      schemaVersion: 1,
      recipe: "quick",
      id: "run-1",
      createdAt: "2026-07-30T20:00:00.000Z",
      updatedAt: "2026-07-30T20:00:00.000Z",
      task: "Review source",
      status: "completed",
      source: { paneId: "pane-1" },
      firstmateRoot: "/tmp/firstmate",
      fmHome: "/tmp/fm-home",
      herdr: { backend: "herdr", session: "default" },
      worker: {
        taskId: "task-1",
        harness: "codex",
        kind: "scout",
        target: "pane-2",
      },
      controlChannel: {
        outbound: "fm-brief+fm-spawn",
        inbound: "fm-peek+report",
      },
      blockers: [],
      claims: {
        firstmatePrimaryInHerdr: true,
        workerVisible: true,
        resultReturnedToPane: true,
        recordReadbackMatchesPane: true,
      },
      recordPath,
    }),
  );
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json_not_object");
  }
  return parsed as Record<string, unknown>;
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label}_missing`);
  return value;
}
