import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  AvailabilitySnapshot,
  FirstmateDispatchRequest,
} from "../src/contracts/index.ts";
import {
  createStandardRun,
  markStandardRunPresented,
  readStandardRunRecord,
  renderStandardText,
  type StandardRuntimePorts,
} from "../src/integration/standard-runtime.ts";

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

function successfulPorts(
  observeRequest?: (request: FirstmateDispatchRequest) => void,
): StandardRuntimePorts {
  return {
    async dispatchAuthor(request) {
      observeRequest?.(request);
      return {
        receipt: {
          accepted: true,
          idempotencyStatus: "accepted",
          firstmateTaskId: "quick-author-1",
          workerTarget: "w1:p2",
          evidencePath: "/tmp/quick-author-1.json",
          reason: null,
        },
        summary: "Codex author 建議保留薄 adapter 與固定 workflow。",
        quickRecordPath: "/tmp/quick-author-1.json",
      };
    },
    async review() {
      return {
        ok: true,
        family: "anthropic",
        model: "fable",
        rawOutput: JSON.stringify({
          conclusion: "採用薄 adapter，先完成 Standard 與 Context Branch。",
          impact: "能保留 Firstmate 更新能力，同時把防禦性細節留在證據層。",
          nextAction: "從 Herdr 跑一次 Standard 實機 read-back。",
          limitations: ["尚未驗證 Codex native annotation export。"],
          unknowns: ["Claude quota 會影響 fallback。"],
        }),
        error: null,
      };
    },
  };
}

describe("standard runtime integration", () => {
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
    expect(observedRequest?.workflow).toBe("standard");
    expect(observedRequest?.task).not.toContain("薄 adapter");
    expect(observedRequest?.routingDecision.diversityStatus).toBe(
      "cross_family",
    );
    expect(result.record.claims).toEqual({
      authorCompletedInFirstmate: true,
      independentReviewCompleted: true,
      reportDecisionReady: true,
      reportReadbackMatchesPane: false,
    });
    expect(result.record.report?.mainReport.conclusion).toContain("薄 adapter");
    expect(readStandardRunRecord(result.record.recordPath)?.id).toBe(
      result.record.id,
    );
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
        async review() {
          return {
            ok: true,
            family: "anthropic",
            model: "fable",
            rawOutput: "這是一段沒有 JSON contract 的長報告。",
            error: null,
          };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("review_contract_invalid");
    expect(result.record.claims.reportDecisionReady).toBe(false);
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
        async review() {
          return {
            ok: true,
            family: "anthropic",
            model: "fable",
            rawOutput: JSON.stringify({
              conclusion: "長".repeat(241),
              impact: "影響",
              nextAction: "下一步",
              limitations: [],
              unknowns: [],
            }),
            error: null,
          };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("review_contract_invalid");
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
});
