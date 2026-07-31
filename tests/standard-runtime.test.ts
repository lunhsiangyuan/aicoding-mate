import {
  chmodSync,
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
import type {
  AvailabilitySnapshot,
  FirstmateDispatchRequest,
  RoleAssignment,
} from "../src/contracts/index.ts";
import { firstmateDispatchIdentity } from "../src/contracts/index.ts";
import {
  createStandardRun,
  defaultStandardRuntimePorts,
  hasFirstmateAuthorReadback,
  markStandardRunPresented,
  probeStandardAvailability,
  readStandardRunRecord,
  renderStandardText,
  type StandardReviewExecution,
  type StandardReviewOutcome,
  type StandardRuntimePorts,
} from "../src/integration/standard-runtime.ts";
import type { QuickRunRecord } from "../src/quick.ts";
import { persistModelDispatchReceipt } from "../src/runtime/model-dispatch-receipt.ts";

const availability: AvailabilitySnapshot = {
  id: "availability-runtime-1",
  capturedAt: "2026-07-30T15:00:00.000Z",
  candidates: [
    {
      alias: "openai-architect",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-architect",
      capabilityTier: "architecture",
      state: "available",
      reason: null,
    },
    {
      alias: "openai-builder",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-builder",
      capabilityTier: "implementation",
      state: "available",
      reason: null,
    },
    {
      alias: "openai-search",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-search",
      capabilityTier: "search",
      state: "available",
      reason: null,
    },
    {
      alias: "anthropic-reviewer",
      provider: "anthropic",
      family: "anthropic",
      resolvedModel: "fable",
      capabilityTier: "architecture",
      state: "available",
      reason: null,
    },
  ],
};

function durableReview(
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
  rawOutput: string,
): StandardReviewOutcome {
  const rootDir = mkdtempSync(
    join(tmpdir(), "aicoding-mate-review-receipt-"),
  );
  const readback = persistModelDispatchReceipt({
    rootDir,
    identity: {
      idempotencyKey: execution.idempotencyKey,
      workflowDecisionId: execution.workflowDecisionId,
      decisionHash: execution.decisionHash,
      stageId: execution.stageId,
      assignment,
    },
    rawOutput,
    completedAt: "2026-07-30T15:00:00.000Z",
  });
  return {
    ok: true,
    family: assignment.family,
    model: assignment.resolvedModel,
    rawOutput,
    receiptPath: readback.receipt.receiptPath,
    error: null,
  };
}

function successfulPorts(
  observeRequest?: (request: FirstmateDispatchRequest) => void,
): StandardRuntimePorts {
  const authorOutcome = (request: FirstmateDispatchRequest) => ({
    receipt: {
      accepted: true as const,
      idempotencyStatus: "accepted" as const,
      identity: firstmateDispatchIdentity(request),
      firstmateTaskId: "quick-author-1",
      workerTarget: "w1:p2",
      evidencePath: "/tmp/quick-author-1.json",
      reason: null,
    },
    summary: "Codex author 建議保留薄 adapter 與固定 workflow。",
    quickRecordPath: "/tmp/quick-author-1.json",
  });
  return {
    async dispatchAuthor(request) {
      observeRequest?.(request);
      return authorOutcome(request);
    },
    async readBackAuthor(request) {
      return {
        status: "found" as const,
        outcome: authorOutcome(request),
      };
    },
    async review(_prompt, assignment, execution) {
      return durableReview(
        assignment,
        execution,
        JSON.stringify({
          conclusion: "採用薄 adapter，先完成 Standard 與 Context Branch。",
          impact: "能保留 Firstmate 更新能力，同時把防禦性細節留在證據層。",
          nextAction: "從 Herdr 跑一次 Standard 實機 read-back。",
          limitations: ["尚未驗證 Codex native annotation export。"],
          unknowns: ["Claude quota 會影響 fallback。"],
        }),
      );
    },
  };
}

describe("standard runtime integration", () => {
  test("accepts durable Firstmate author read-back before the reviewed report reaches the pane", () => {
    const record: QuickRunRecord = {
      schemaVersion: 1,
      id: "quick-author-1",
      createdAt: "2026-07-30T15:00:00.000Z",
      updatedAt: "2026-07-30T15:01:00.000Z",
      task: "唯讀架構分析",
      recipe: "quick",
      status: "completed",
      source: { paneId: "w1:p1" },
      firstmateRoot: "/tmp/firstmate",
      fmHome: "/tmp/fm-home",
      herdr: {
        backend: "herdr",
        session: "default",
        primaryPaneId: "w1:p1",
      },
      worker: {
        taskId: "quick-author-1",
        harness: "codex",
        kind: "scout",
        paneId: "w1:p2",
        target: "default:w1:p2",
      },
      controlChannel: {
        outbound: "fm-brief+fm-spawn",
        inbound: "fm-peek+report",
        sourcePaneId: "w1:p1",
        workerTarget: "default:w1:p2",
      },
      result: {
        summary: "Firstmate author report",
        readBackAt: "2026-07-30T15:01:00.000Z",
      },
      blockers: [],
      evidence: {
        brief: "/tmp/brief.md",
        firstmateMeta: "/tmp/quick-author-1.meta",
        firstmateStatus: "/tmp/quick-author-1.status",
        scoutReport: "/tmp/report.md",
        herdrPaneId: "w1:p2",
        observedAt: "2026-07-30T15:01:00.000Z",
      },
      claims: {
        firstmatePrimaryInHerdr: true,
        workerVisible: true,
        resultReturnedToPane: false,
        recordReadbackMatchesPane: false,
      },
      recordPath: "/tmp/quick-author-1.json",
    };

    expect(hasFirstmateAuthorReadback(record)).toBe(true);
    expect(
      hasFirstmateAuthorReadback({
        ...record,
        evidence: {
          ...record.evidence!,
          observedAt: undefined,
        },
      }),
    ).toBe(false);
  });

  test("dispatches author through Firstmate and produces reviewed two-layer report", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    let observedRequest: FirstmateDispatchRequest | undefined;
    const result = await createStandardRun({
      task: "分析 Firstmate 的薄 adapter 架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts((request) => {
        observedRequest = request;
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.dedupeStatus).toBe("new");
    expect(observedRequest?.workflow).toBe("standard");
    expect(observedRequest?.task).toContain("薄 adapter");
    expect(observedRequest?.task).toContain(
      "至少 3 個 debugging hypotheses",
    );
    expect(
      result.record.workflowDecision?.executionPolicy,
    ).toEqual({
      adapterBehavior: "execute_exact_assignment_only",
      namedSkillUnavailable: "equivalent_read_only_review",
      minimumDebuggingHypotheses: 3,
    });
    expect(observedRequest?.exactAssignment.role).toBe("author");
    expect(observedRequest?.workflowDecisionId).toBe(
      result.record.workflowDecision?.workflowDecisionId,
    );
    expect(result.record.claims).toEqual({
      authorCompletedInFirstmate: true,
      independentReviewCompleted: true,
      reportDecisionReady: true,
      reportReadbackMatchesPane: false,
    });
    expect(result.record.report?.mainReport.conclusion).toContain("薄 adapter");
    expect(result.record.workflowDecision?.authority).toBe("firstmate");
    expect(result.record.authority).toMatchObject({
      workflowAuthority: "firstmate_verified",
      runtimeAuthority: "canonical_run_registry_verified",
    });
    expect(readStandardRunRecord(result.record.recordPath)?.id).toBe(
      result.record.id,
    );
  });

  test("coalesces a completed duplicate Standard intent without a second dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    let authorDispatches = 0;
    let reviewDispatches = 0;
    const basePorts = successfulPorts();
    const ports: StandardRuntimePorts = {
      async dispatchAuthor(request) {
        authorDispatches += 1;
        return basePorts.dispatchAuthor(request);
      },
      readBackAuthor: basePorts.readBackAuthor,
      async review(prompt, assignment, execution) {
        reviewDispatches += 1;
        return basePorts.review(prompt, assignment, execution);
      },
    };
    const options = {
      task: "同一個 Standard intent 只能派一次",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports,
    };

    const first = await createStandardRun(options);
    const second = await createStandardRun(options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.dedupeStatus).toBe("coalesced_completed");
    expect(second.record.id).toBe(first.record.id);
    expect(authorDispatches).toBe(1);
    expect(reviewDispatches).toBe(1);

    const author = first.record.author;
    if (author === null || !author.receipt.accepted) {
      throw new Error("completed author receipt missing");
    }
    writeFileSync(
      first.record.recordPath,
      `${JSON.stringify({
        ...first.record,
        author: {
          ...author,
          receipt: {
            ...author.receipt,
            identity: {
              ...author.receipt.identity,
              decisionHash: "0".repeat(64),
            },
          },
        },
      }, null, 2)}\n`,
    );
    expect(readStandardRunRecord(first.record.recordPath)).toBeUndefined();
  });

  test("coalesces an active duplicate before the first Firstmate receipt returns", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const basePorts = successfulPorts();
    let authorDispatches = 0;
    let releaseAuthor: (() => void) | undefined;
    const authorGate = new Promise<void>((resolve) => {
      releaseAuthor = resolve;
    });
    const ports: StandardRuntimePorts = {
      async dispatchAuthor(request) {
        authorDispatches += 1;
        await authorGate;
        return basePorts.dispatchAuthor(request);
      },
      readBackAuthor: basePorts.readBackAuthor,
      review: basePorts.review,
    };
    const options = {
      task: "快速重送仍只建立一個 canonical run",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports,
    };

    const firstPromise = createStandardRun(options);
    while (authorDispatches === 0) {
      await Promise.resolve();
    }
    const duplicate = await createStandardRun(options);
    releaseAuthor?.();
    const first = await firstPromise;

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.dedupeStatus).toBe("coalesced_active");
    expect(duplicate.record.id).toBe(first.record.id);
    expect(authorDispatches).toBe(1);
  });

  test("reconciles an unknown Firstmate outcome by read-back without redispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const basePorts = successfulPorts();
    let authorDispatches = 0;
    let reviewDispatches = 0;
    const ports: StandardRuntimePorts = {
      async dispatchAuthor() {
        authorDispatches += 1;
        throw new Error("crash_after_downstream_accept");
      },
      async readBackAuthor(request) {
        return {
          status: "found",
          outcome: await basePorts.dispatchAuthor(request),
        };
      },
      async review(prompt, assignment, execution) {
        reviewDispatches += 1;
        return basePorts.review(prompt, assignment, execution);
      },
    };
    const options = {
      task: "receipt 寫入前中斷必須先 read back",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports,
    };

    const interrupted = await createStandardRun(options);
    const reconciled = await createStandardRun(options);

    expect(interrupted.ok).toBe(false);
    expect(interrupted.record.blockers).toContain(
      "firstmate_author_unknown_outcome",
    );
    expect(reconciled.ok).toBe(true);
    expect(authorDispatches).toBe(1);
    expect(reviewDispatches).toBe(1);
    expect(reconciled.record.id).toBe(interrupted.record.id);
  });

  test("reconciles an unknown Firstmate outcome with the original decision after availability changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const driftedAvailability: AvailabilitySnapshot = {
      ...availability,
      id: "availability-runtime-2",
      capturedAt: "2026-07-30T15:01:00.000Z",
    };
    const basePorts = successfulPorts();
    let authorDispatches = 0;
    let recoveredAuthor:
      | Awaited<ReturnType<StandardRuntimePorts["dispatchAuthor"]>>
      | null = null;
    const readBackDecisionHashes: string[] = [];
    const ports: StandardRuntimePorts = {
      async dispatchAuthor(request) {
        authorDispatches += 1;
        recoveredAuthor = await basePorts.dispatchAuthor(request);
        throw new Error("crash_after_downstream_accept");
      },
      async readBackAuthor(request) {
        readBackDecisionHashes.push(request.decisionHash);
        return recoveredAuthor === null
          ? {
              status: "not_found" as const,
              checkedAt: "2026-07-30T15:01:00.000Z",
              reason: "author_receipt_missing",
            }
          : {
              status: "found" as const,
              outcome: recoveredAuthor,
            };
      },
      review: basePorts.review,
    };
    const env = {
      ACM_STATE_DIR: join(root, "state"),
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
    };

    const interrupted = await createStandardRun({
      task: "availability 變動也只能 read back 原 canonical decision",
      cwd: root,
      env,
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports,
    });
    const reconciled = await createStandardRun({
      task: "availability 變動也只能 read back 原 canonical decision",
      cwd: root,
      env,
      availability: driftedAvailability,
      now: () => "2026-07-30T15:01:00.000Z",
      ports,
    });

    expect(interrupted.ok).toBe(false);
    expect(reconciled.ok).toBe(true);
    expect(authorDispatches).toBe(1);
    expect(reconciled.record.id).toBe(interrupted.record.id);
    expect(reconciled.record.workflowDecision?.workflowDecisionId).toBe(
      interrupted.record.workflowDecision?.workflowDecisionId,
    );
    expect(readBackDecisionHashes.at(-1)).toBe(
      interrupted.record.workflowDecision?.decisionHash,
    );
  });

  test("keeps the canonical run unknown when author read-back identity differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const basePorts = successfulPorts();
    let reviewDispatches = 0;
    const ports: StandardRuntimePorts = {
      dispatchAuthor: basePorts.dispatchAuthor,
      async readBackAuthor(request) {
        const outcome = await basePorts.dispatchAuthor(request);
        if (!outcome.receipt.accepted) {
          throw new Error("fixture author was unexpectedly rejected");
        }
        return {
          status: "found",
          outcome: {
            ...outcome,
            receipt: {
              ...outcome.receipt,
              identity: {
                ...outcome.receipt.identity,
                decisionHash: "0".repeat(64),
              },
            },
          },
        };
      },
      async review(prompt, assignment, execution) {
        reviewDispatches += 1;
        return basePorts.review(prompt, assignment, execution);
      },
    };

    const result = await createStandardRun({
      task: "Author receipt identity 不一致時不得形成報告",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports,
    });

    const canonicalRunId = result.record.authority.canonicalRunId;
    expect(canonicalRunId).not.toBeNull();
    if (canonicalRunId === null) {
      throw new Error("canonical run id missing");
    }
    const projection = JSON.parse(
      readFileSync(
        join(
          root,
          "state",
          "run-registry",
          "runs",
          canonicalRunId,
          "projection.json",
        ),
        "utf8",
      ),
    ) as { readonly status: string };

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain(
      "firstmate_author_requires_durable_readback",
    );
    expect(result.record.report).toBeNull();
    expect(reviewDispatches).toBe(0);
    expect(projection.status).toBe("unknown_outcome");
  });

  test("reconciles a durable reviewer receipt after a crash without redispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const basePorts = successfulPorts();
    let reviewDispatches = 0;
    let recoveredReview: StandardReviewOutcome | undefined;
    const ports: StandardRuntimePorts = {
      dispatchAuthor: basePorts.dispatchAuthor,
      async readBackAuthor(request) {
        return {
          status: "found",
          outcome: await basePorts.dispatchAuthor(request),
        };
      },
      async review(prompt, assignment, execution) {
        reviewDispatches += 1;
        recoveredReview = await basePorts.review(
          prompt,
          assignment,
          execution,
        );
        throw new Error("crash_after_review_receipt");
      },
      async readBackReview() {
        if (recoveredReview === undefined) {
          return {
            status: "not_found",
            checkedAt: "2026-07-30T15:00:00.000Z",
            reason: "review_receipt_not_written",
          };
        }
        return { status: "found", outcome: recoveredReview };
      },
    };
    const options = {
      task: "Reviewer receipt 寫完後 crash 不可重複派工",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports,
    };

    const interrupted = await createStandardRun(options);
    const reconciled = await createStandardRun(options);

    expect(interrupted.ok).toBe(false);
    expect(interrupted.record.blockers).toContain(
      "independent_review_unknown_outcome",
    );
    expect(reconciled.ok).toBe(true);
    expect(reviewDispatches).toBe(1);
    expect(reconciled.record.review?.receiptPath).toBe(
      recoveredReview?.receiptPath,
    );
  });

  test("env override disables Claude reviewer before probe and routes to degraded same-family fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const bin = join(root, "bin");
    const claudeMarker = join(root, "claude-called");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\ntouch "${claudeMarker}"\nexit 0\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);

    const env = {
      ACM_CLAUDE_REVIEW_DISABLED: "1",
      ACM_STATE_DIR: join(root, "state"),
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      PATH: bin,
    };
    const probed = probeStandardAvailability(
      root,
      env,
      () => "2026-07-30T15:00:00.000Z",
    );
    const anthropicReviewer = probed.candidates.find(
      (candidate) => candidate.alias === "anthropic-reviewer",
    );

    expect(anthropicReviewer).toBeDefined();
    if (anthropicReviewer === undefined) {
      throw new Error("anthropic reviewer candidate missing");
    }
    expect(anthropicReviewer?.state).toBe("unavailable");
    expect(anthropicReviewer?.reason).toBe("claude_review_disabled_by_env");
    expect(existsSync(claudeMarker)).toBe(false);

    const result = await createStandardRun({
      task: "分析 Standard fallback",
      cwd: root,
      env,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: {
        async dispatchAuthor(request) {
          return {
            receipt: {
              accepted: true,
              idempotencyStatus: "accepted",
              identity: firstmateDispatchIdentity(request),
              firstmateTaskId: "quick-author-1",
              workerTarget: "w1:p2",
              evidencePath: "/tmp/quick-author-1.json",
              reason: null,
            },
            summary: `author=${request.exactAssignment.family}`,
            quickRecordPath: "/tmp/quick-author-1.json",
          };
        },
        async readBackAuthor(request) {
          return {
            status: "found" as const,
            outcome: {
              receipt: {
                accepted: true as const,
                idempotencyStatus: "duplicate" as const,
                identity: firstmateDispatchIdentity(request),
                firstmateTaskId: "quick-author-1",
                workerTarget: "w1:p2",
                evidencePath: "/tmp/quick-author-1.json",
                reason: null,
              },
              summary: `author=${request.exactAssignment.family}`,
              quickRecordPath: "/tmp/quick-author-1.json",
            },
          };
        },
        async review(_prompt, assignment, execution) {
          expect(assignment.role).toBe("reviewer");
          expect(assignment.family).toBe("openai");
          return durableReview(
            assignment,
            execution,
            JSON.stringify({
              conclusion: "採用 same-family degraded fallback。",
              impact: "Claude review 已由 explicit override 關閉，routing 在執行前保守降級。",
              nextAction: "解除 override 後再恢復跨 family review。",
              limitations: ["目前沒有使用 Anthropic reviewer。"],
              unknowns: [],
            }),
          );
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.record.availability.candidates).toContainEqual(
      anthropicReviewer,
    );
    expect(result.record.routingDecision?.diversityStatus).toBe(
      "degraded_same_family",
    );
    expect(
      result.record.routingDecision?.fallbackTrace.some(
        (entry) => entry.reason === "degraded_same_family",
      ),
    ).toBe(true);
    expect(result.record.review?.family).toBe("openai");
  });

  test("fails closed when reviewer output does not satisfy report contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const ports = successfulPorts();
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: {
        ...ports,
        async review(_prompt, assignment, execution) {
          return durableReview(
            assignment,
            execution,
            "這是一段沒有 JSON contract 的長報告。",
          );
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("review_contract_invalid");
    expect(result.record.claims.reportDecisionReady).toBe(false);
  });

  test("repairs one overlong reviewer response without changing its exact assignment", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const ports = successfulPorts();
    const idempotencyKeys: string[] = [];
    let reviewCalls = 0;
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: {
        ...ports,
        async review(prompt, assignment, execution) {
          reviewCalls += 1;
          idempotencyKeys.push(execution.idempotencyKey);
          expect(assignment.family).toBe("anthropic");
          if (reviewCalls === 1) {
            expect(prompt).toContain("各不超過 180 個 Unicode 字元");
            return durableReview(
              assignment,
              execution,
              JSON.stringify({
                conclusion: "採用單一 authority。",
                impact: "長".repeat(241),
                nextAction: "執行 v0.2 gate。",
                limitations: [],
                unknowns: [],
              }),
            );
          }
          expect(prompt).toContain("只做壓縮與格式修復");
          return durableReview(
            assignment,
            execution,
            JSON.stringify({
              conclusion: "採用單一 authority。",
              impact: "Adapter 不再形成第二個決策真相。",
              nextAction: "執行 v0.2 gate。",
              limitations: [],
              unknowns: [],
            }),
          );
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(reviewCalls).toBe(2);
    expect(new Set(idempotencyKeys).size).toBe(2);
    expect(result.record.reviewAttempts).toHaveLength(2);
    expect(result.record.report?.mainReport.impact).toBe(
      "Adapter 不再形成第二個決策真相。",
    );
  });

  test("rejects a verbose reviewer main report instead of silently truncating", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const ports = successfulPorts();
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: {
        ...ports,
        async review(_prompt, assignment, execution) {
          return durableReview(
            assignment,
            execution,
            JSON.stringify({
              conclusion: "長".repeat(241),
              impact: "影響",
              nextAction: "下一步",
              limitations: [],
              unknowns: [],
            }),
          );
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("review_contract_invalid");
    expect(result.record.reviewAttempts).toHaveLength(2);
  });

  test("fails before dispatch without a Herdr source pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    let dispatched = false;
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: { ACM_STATE_DIR: join(root, "state") },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts(() => {
        dispatched = true;
      }),
    });

    expect(result.ok).toBe(false);
    expect(dispatched).toBe(false);
    expect(result.record.blockers).toContain("standard_requires_herdr_pane");
  });

  test("rejects an unsafe raw author intent before even a fake dispatch port", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    let dispatched = false;
    const result = await createStandardRun({
      task: "分析架構，然後修改檔案並推送到遠端",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts(() => {
        dispatched = true;
      }),
    });

    expect(result.ok).toBe(false);
    expect(dispatched).toBe(false);
    expect(result.record.blockers[0]).toContain("author_scope_invalid:");
    expect(result.record.blockers[0]).toContain("修改");
  });

  test("does not dispatch when Firstmate decision issuance cannot be read back", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    let dispatched = false;
    const result = await createStandardRun({
      task: "分析 decision authority",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts(() => {
        dispatched = true;
      }),
      workflowAuthority: new FileFirstmateWorkflowAuthority({
        stateDir: join(root, "state"),
        decisionStore: {
          issueDecision() {
            throw new Error("authority_store_unavailable");
          },
          readDecision() {
            return undefined;
          },
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(dispatched).toBe(false);
    expect(result.record.authority.workflowAuthority).toBe("unverified");
    expect(result.record.authority.runtimeAuthority).toBe("unverified");
    expect(result.record.blockers).toContain(
      "firstmate_decision_issuance_failed:authority_store_unavailable",
    );
  });

  test("Claude adapter executes the exact assigned model despite an env override", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const bin = join(root, "bin");
    const argsPath = join(root, "claude-args");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > "${argsPath}"`,
        "printf '%s\\n' '{\"conclusion\":\"ok\",\"impact\":\"ok\",\"nextAction\":\"ok\",\"limitations\":[],\"unknowns\":[]}'",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    const ports = defaultStandardRuntimePorts({
      cwd: root,
      projectDir: root,
      env: {
        ACM_CLAUDE_REVIEW_MODEL: "adapter-must-not-use-this",
        PATH: bin,
      },
    });

    const outcome = await ports.review(
      "review",
      {
        role: "reviewer",
        alias: "anthropic-reviewer",
        provider: "anthropic",
        family: "anthropic",
        resolvedModel: "fable",
        capabilityTier: "architecture",
        reason: "Firstmate exact assignment",
      },
      {
        workflowDecisionId: "wfd_test",
        decisionHash: "1".repeat(64),
        stageId: "reviewer",
        idempotencyKey: "review-test",
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.model).toBe("fable");
    expect(readFileSync(argsPath, "utf8")).toContain("fable");
    expect(readFileSync(argsPath, "utf8")).not.toContain(
      "adapter-must-not-use-this",
    );
  });

  test("does not treat a Herdr workspace label as a lineage id", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    let dispatched = false;
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_LABEL: "same-name-workspace",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts(() => {
        dispatched = true;
      }),
    });

    expect(result.ok).toBe(false);
    expect(dispatched).toBe(false);
    expect(result.record.blockers).toContain(
      "standard_requires_complete_herdr_lineage",
    );
  });

  test("rejects a reviewer whose provenance differs from routing", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const ports = successfulPorts();
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: {
        ...ports,
        async review() {
          const outcome = await ports.review("", {
            role: "reviewer",
            alias: "anthropic-reviewer",
            provider: "anthropic",
            family: "anthropic",
            resolvedModel: "fable",
            capabilityTier: "architecture",
            reason: "test reviewer assignment",
          }, {
            workflowDecisionId: "wfd_test",
            decisionHash: "1".repeat(64),
            stageId: "reviewer",
            idempotencyKey: "review-test",
          });
          return { ...outcome, family: "openai" };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("review_provenance_mismatch");
    expect(result.record.claims.independentReviewCompleted).toBe(false);
  });

  test("rejects a reviewer model that differs from routing", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const ports = successfulPorts();
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: {
        ...ports,
        async review() {
          const outcome = await ports.review("", {
            role: "reviewer",
            alias: "anthropic-reviewer",
            provider: "anthropic",
            family: "anthropic",
            resolvedModel: "fable",
            capabilityTier: "architecture",
            reason: "test reviewer assignment",
          }, {
            workflowDecisionId: "wfd_test",
            decisionHash: "1".repeat(64),
            stageId: "reviewer",
            idempotencyKey: "review-test",
          });
          return { ...outcome, model: "different-model" };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("review_provenance_mismatch");
    expect(result.record.claims.independentReviewCompleted).toBe(false);
  });

  test("marks pane read-back only when main report text is observed", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts(),
    });
    const rendered = renderStandardText(result);
    const conclusion = result.record.report?.mainReport.conclusion ?? "";

    expect(
      markStandardRunPresented(
        result.record.recordPath,
        conclusion,
        "unrelated pane output",
      ),
    ).toBeUndefined();
    const marked = markStandardRunPresented(
      result.record.recordPath,
      conclusion,
      rendered,
    );
    expect(marked?.claims.reportReadbackMatchesPane).toBe(true);
  });

  test("read-back rejects a tampered Firstmate workflow decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-standard-"));
    const result = await createStandardRun({
      task: "分析架構",
      cwd: root,
      env: {
        ACM_STATE_DIR: join(root, "state"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
      },
      availability,
      now: () => "2026-07-30T15:00:00.000Z",
      ports: successfulPorts(),
    });
    const stored = JSON.parse(
      readFileSync(result.record.recordPath, "utf8"),
    ) as Record<string, unknown>;
    const decision = stored.workflowDecision;
    if (!isObject(decision)) {
      throw new Error("workflow decision missing");
    }
    writeFileSync(
      result.record.recordPath,
      `${JSON.stringify({
        ...stored,
        workflowDecision: {
          ...decision,
          decisionHash: "0".repeat(64),
        },
      })}\n`,
      "utf8",
    );

    expect(readStandardRunRecord(result.record.recordPath)).toBeUndefined();
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
