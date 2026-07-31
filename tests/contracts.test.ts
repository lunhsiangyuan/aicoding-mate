import { describe, expect, test } from "bun:test";

import {
  CONTEXT_SELECTION_MAX_CHARS,
  assertDecisionReadyReport,
  availabilitySnapshotHash,
  firstmateDispatchIdentity,
  firstmateDispatchReceiptMatches,
  injectConfirmedCapsule,
  isAllowedBranchTranscriptEntryKind,
  routingDeterminismKey,
  selectedTextHash,
  sourceLineageHash,
  validateContextSelection,
  type AtomicFirstmateCapsuleInjectionPort,
  type AvailabilitySnapshot,
  type ConfirmedContextCapsule,
  type ContextCapsule,
  type DecisionReadyReport,
  type FirstmateDispatchRequest,
  type SourceLineage,
} from "../src/contracts/index.ts";

const source: SourceLineage = {
  taskId: "task-1",
  runId: "run-1",
  workspace: "/tmp/example",
  tabId: "w1K",
  paneId: "pJ",
};

function capsule(
  overrides: Partial<ConfirmedContextCapsule> = {},
): ConfirmedContextCapsule {
  const selectedText = "把這段內容變成新的修改任務";
  return {
    capsuleId: "capsule-1",
    selectedText,
    selectedTextHash: selectedTextHash(selectedText),
    source,
    firstmateSessionRef: "herdr-session-1",
    status: "confirmed",
    recitation: "將選取內容帶回原任務，建立一項修改。",
    confirmationId: "confirm-1",
    confirmedAt: "2026-07-30T14:00:00.000Z",
    mutationIntent: "modify",
    ...overrides,
  };
}

function acceptingPort(
  overrides: Partial<
    Awaited<ReturnType<AtomicFirstmateCapsuleInjectionPort["revalidateAndInject"]>>
  > = {},
): AtomicFirstmateCapsuleInjectionPort {
  return {
    async revalidateAndInject(request) {
      return {
        accepted: true,
        observedLineage: request.capsule.source,
        targetSessionRef: request.capsule.firstmateSessionRef,
        injectedTextHash: request.capsule.selectedTextHash,
        idempotencyStatus: "accepted",
        reason: null,
        ...overrides,
      };
    },
  };
}

describe("shared contracts", () => {
  test("matches a Firstmate dispatch identity independent of JSON key order", () => {
    const request: FirstmateDispatchRequest = {
      idempotencyKey: "acm-dispatch-order-independent",
      workflow: "standard",
      workflowDecisionId: "wfd_order_independent",
      decisionHash: "1".repeat(64),
      stageId: "author",
      exactAssignment: {
        role: "author",
        alias: "openai-builder",
        provider: "openai",
        family: "openai",
        resolvedModel: "configured-openai-builder",
        capabilityTier: "implementation",
        reason: "Firstmate exact assignment",
      },
      projectDir: "/tmp/project",
      source,
      task: "唯讀驗證 decision identity",
    };
    const identity = firstmateDispatchIdentity(request);

    expect(
      firstmateDispatchReceiptMatches(request, {
        accepted: true,
        idempotencyStatus: "accepted",
        identity: {
          exactAssignmentHash: identity.exactAssignmentHash,
          stageId: identity.stageId,
          decisionHash: identity.decisionHash,
          workflowDecisionId: identity.workflowDecisionId,
          idempotencyKey: identity.idempotencyKey,
        },
        firstmateTaskId: "quick-order-independent",
        workerTarget: "w1:p2",
        evidencePath: "/tmp/quick-order-independent.json",
        reason: null,
      }),
    ).toBe(true);
  });

  test("routing key includes the full availability snapshot", () => {
    const snapshot: AvailabilitySnapshot = {
      id: "availability-1",
      capturedAt: "2026-07-30T14:00:00.000Z",
      candidates: [
        {
          alias: "independent_judge",
          provider: "claude",
          family: "claude",
          resolvedModel: "configured-review-model",
          capabilityTier: "architecture",
          state: "available",
          reason: null,
        },
      ],
    };
    const request = {
      normalizedInputHash: "input-hash",
      configVersionHash: "config-hash",
      availabilitySnapshot: snapshot,
    };

    expect(routingDeterminismKey(request)).toBe(
      routingDeterminismKey(request),
    );
    expect(
      routingDeterminismKey({
        ...request,
        availabilitySnapshot: {
          ...snapshot,
          candidates: snapshot.candidates.map((candidate) => ({
            ...candidate,
            state: "quota_limited" as const,
          })),
        },
      }),
    ).not.toBe(routingDeterminismKey(request));
    expect(availabilitySnapshotHash(snapshot)).toHaveLength(64);
    const reorderedSnapshot: AvailabilitySnapshot = {
      candidates: [
        {
          reason: null,
          state: "available",
          capabilityTier: "architecture",
          resolvedModel: "configured-review-model",
          family: "claude",
          provider: "claude",
          alias: "independent_judge",
        },
      ],
      capturedAt: snapshot.capturedAt,
      id: snapshot.id,
    };
    expect(availabilitySnapshotHash(reorderedSnapshot)).toBe(
      availabilitySnapshotHash(snapshot),
    );
    const sameAliasDifferentState = [
      snapshot.candidates[0],
      {
        ...snapshot.candidates[0],
        state: "quota_limited" as const,
        reason: "quota_low",
      },
    ];
    expect(
      availabilitySnapshotHash({
        ...snapshot,
        candidates: sameAliasDifferentState,
      }),
    ).toBe(
      availabilitySnapshotHash({
        ...snapshot,
        candidates: [...sameAliasDifferentState].reverse(),
      }),
    );
  });

  test("decision-ready report requires both readable and evidence layers", () => {
    const report: DecisionReadyReport = {
      schemaVersion: 1,
      mainReport: {
        conclusion: "採用跨模型 review。",
        impact: "增加獨立檢查，但會提高延遲。",
        nextAction: "確認後派工。",
      },
      evidenceLayer: {
        configVersionHash: "config-hash",
        availabilitySnapshotId: "availability-1",
        routingDecisionKey: "routing-key",
        lineage: ["run-1"],
        limitations: [],
        unknowns: [],
      },
    };

    expect(() => assertDecisionReadyReport(report)).not.toThrow();
    expect(() =>
      assertDecisionReadyReport({
        ...report,
        mainReport: { ...report.mainReport, conclusion: "" },
      }),
    ).toThrow("main_report_incomplete");
    expect(() =>
      assertDecisionReadyReport({
        ...report,
        evidenceLayer: { ...report.evidenceLayer, lineage: [] },
      }),
    ).toThrow("evidence_lineage_missing");
  });

  test("only summary lifecycle entries may enter the main transcript", () => {
    expect(isAllowedBranchTranscriptEntryKind("brief")).toBe(true);
    expect(isAllowedBranchTranscriptEntryKind("recitation")).toBe(true);
    expect(
      isAllowedBranchTranscriptEntryKind("confirmation_result"),
    ).toBe(true);
    expect(isAllowedBranchTranscriptEntryKind("research")).toBe(false);
  });

  test("confirmed capsule injection succeeds after atomic lineage readback", async () => {
    const result = await injectConfirmedCapsule(
      acceptingPort(),
      capsule(),
    );

    expect(result.ok).toBe(true);
    expect(sourceLineageHash(source)).toHaveLength(64);
  });

  test("capsule injection fails closed when a pane is reused", async () => {
    const result = await injectConfirmedCapsule(
      acceptingPort({
        observedLineage: { ...source, runId: "run-2" },
      }),
      capsule(),
    );

    expect(result).toEqual({
      ok: false,
      reason: "source_lineage_changed",
    });
  });

  test("capsule injection rejects unconfirmed, oversized, or reused capsules", async () => {
    const unconfirmedCapsule: ContextCapsule = {
      ...capsule(),
      status: "recited",
      confirmationId: null,
      confirmedAt: null,
    };
    const unconfirmed = await injectConfirmedCapsule(
      acceptingPort(),
      unconfirmedCapsule,
    );
    const oversizedText = "x".repeat(CONTEXT_SELECTION_MAX_CHARS + 1);
    const oversized = await injectConfirmedCapsule(
      acceptingPort(),
      capsule({
        selectedText: oversizedText,
        selectedTextHash: selectedTextHash(oversizedText),
      }),
    );
    const reused = await injectConfirmedCapsule(
      acceptingPort({ idempotencyStatus: "duplicate" }),
      capsule(),
    );

    expect(unconfirmed).toEqual({
      ok: false,
      reason: "capsule_not_confirmed",
    });
    expect(oversized).toEqual({
      ok: false,
      reason: "selection_too_large",
    });
    expect(reused).toEqual({
      ok: false,
      reason: "capsule_already_used",
    });
  });

  test("selection validation defines Unicode code points and never truncates", () => {
    expect(validateContextSelection("😀")).toEqual({
      ok: true,
      charLength: 1,
      selectedTextHash: selectedTextHash("😀"),
    });
    expect(
      validateContextSelection(
        "😀".repeat(CONTEXT_SELECTION_MAX_CHARS + 1),
      ),
    ).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "selection_too_large",
      charLength: CONTEXT_SELECTION_MAX_CHARS + 1,
    });
  });
});
