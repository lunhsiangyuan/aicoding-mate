import { describe, expect, test } from "bun:test";

import {
  briefContextBranch,
  chooseDeeperResearch,
  confirmBranchRecitation,
  createContextBranch,
  parseHerdrBranchContext,
  projectMainTranscript,
  reciteBranchReturn,
  sendConfirmedBranchCapsule,
  toConfirmedCapsule,
  type BranchTaskRunRecord,
  type BranchTaskRunRegistryPort,
  type ContextBranchSession,
} from "../src/branch/index.ts";
import type {
  AtomicFirstmateCapsuleInjectionPort,
  SourceLineage,
} from "../src/contracts/index.ts";
import { sourceLineageHash } from "../src/contracts/index.ts";

const now = () => "2026-07-30T20:00:00.000Z";

const source: SourceLineage = {
  taskId: "task-1",
  runId: "run-1",
  workspace: "w1K",
  tabId: "w1K:t1",
  paneId: "w1K:p1",
};

function contextJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    selected_text: "把這段解釋帶回主對話，新增一個 follow-up 任務。",
    workspace_id: source.workspace,
    tab_id: source.tabId,
    focused_pane_id: source.paneId,
    source_task_id: source.taskId,
    source_run_id: source.runId,
    firstmate_session_ref: "firstmate-session-1",
    ...overrides,
  });
}

function createBriefedBranch(): ContextBranchSession {
  const parsed = parseHerdrBranchContext(contextJson());
  if (!parsed.ok) throw new Error(parsed.reason);
  return briefContextBranch(
    createContextBranch(parsed.value, {
      now,
      branchId: "branch-1",
    }),
    now,
  );
}

function registry(
  session: ContextBranchSession,
  overrides: Partial<BranchTaskRunRecord> = {},
): BranchTaskRunRegistryPort {
  return {
    lookup() {
      return {
        taskId: source.taskId,
        runId: source.runId,
        firstmateSessionRef: session.firstmateSessionRef,
        sourceLineageHash: session.sourceLineageHash,
        consumedLineageIntentIds: [],
        ...overrides,
      };
    },
  };
}

function acceptingInjectionPort(): AtomicFirstmateCapsuleInjectionPort {
  return {
    async revalidateAndInject(request) {
      return {
        accepted: true,
        observedLineage: request.capsule.source,
        targetSessionRef: request.capsule.firstmateSessionRef,
        injectedTextHash: request.capsule.selectedTextHash,
        idempotencyStatus: "accepted",
        reason: null,
      };
    },
  };
}

describe("context branch core", () => {
  test("parses selected text and explicit Herdr/source context", () => {
    const parsed = parseHerdrBranchContext(contextJson());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.selectedText).toContain("follow-up");
    expect(parsed.value.source).toEqual(source);
    expect(parsed.value.firstmateSessionRef).toBe("firstmate-session-1");
    expect(parsed.value.selectedTextHash).toHaveLength(64);
  });

  test("fails closed on invalid, empty, missing source, or oversized selection without truncation", () => {
    const invalid = parseHerdrBranchContext("{nope");
    const empty = parseHerdrBranchContext(contextJson({ selected_text: "   " }));
    const missingPane = parseHerdrBranchContext(contextJson({ focused_pane_id: "" }));
    const oversizedText = "😀".repeat(8_001);
    const oversized = parseHerdrBranchContext(
      contextJson({ selected_text: oversizedText }),
    );

    expect(invalid).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "invalid_context_json",
    });
    expect(empty).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "selection_empty",
      charLength: 3,
    });
    expect(missingPane).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_pane_missing",
    });
    expect(oversized).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "selection_too_large",
      charLength: 8_001,
    });
  });

  test("runs the happy state flow through one-time capsule send", async () => {
    const briefed = createBriefedBranch();
    const researched = chooseDeeperResearch(
      briefed,
      "deeper",
      () => ({ summary: "深入研究只留在 branch state", evidence: ["branch-note"] }),
      now,
    );
    expect(researched.ok).toBe(true);
    if (!researched.ok) throw new Error(researched.reason);

    const recited = reciteBranchReturn(
      researched.value,
      registry(researched.value),
      () => "new_task",
      now,
    );
    expect(recited.ok).toBe(true);
    if (!recited.ok) throw new Error(recited.reason);

    const confirmed = confirmBranchRecitation(
      recited.value,
      { confirmed: true, confirmationId: "confirm-1" },
      now,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error(confirmed.reason);

    const capsule = toConfirmedCapsule(confirmed.value);
    expect(capsule.ok).toBe(true);
    if (!capsule.ok) throw new Error(capsule.reason);
    expect(capsule.value.capsuleId).toBe(confirmed.value.lineageIntentId);
    expect(capsule.value.firstmateSessionRef).toBe("firstmate-session-1");
    expect(capsule.value.mutationIntent).toBe("new_task");

    const sent = await sendConfirmedBranchCapsule(
      confirmed.value,
      acceptingInjectionPort(),
      now,
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.reason);
    expect(sent.value.status).toBe("sent");

    const reused = await sendConfirmedBranchCapsule(
      sent.value,
      acceptingInjectionPort(),
      now,
    );
    expect(reused).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "branch_already_sent",
    });
  });

  test("does not allow brief to roll a later lifecycle state backward", () => {
    const branch = createBriefedBranch();
    const recited = reciteBranchReturn(
      branch,
      registry(branch),
      () => "modify_task",
      now,
    );
    expect(recited.ok).toBe(true);
    if (!recited.ok) throw new Error(recited.reason);
    const confirmed = confirmBranchRecitation(
      recited.value,
      { confirmed: true, confirmationId: "confirm-1" },
      now,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error(confirmed.reason);

    const rolledBack = briefContextBranch(confirmed.value, now);

    expect(rolledBack.status).toBe("failed_closed");
    expect(rolledBack.failureReason).toBe("invalid_lifecycle_transition");
    expect(rolledBack.confirmationId).toBe("confirm-1");
  });

  test("keeps research out of the main transcript projection", () => {
    const briefed = createBriefedBranch();
    const researched = chooseDeeperResearch(
      briefed,
      "deeper",
      () => ({ summary: "private research", evidence: ["hidden"] }),
      now,
    );
    expect(researched.ok).toBe(true);
    if (!researched.ok) throw new Error(researched.reason);
    const recited = reciteBranchReturn(
      researched.value,
      registry(researched.value),
      () => "modify_task",
      now,
    );
    expect(recited.ok).toBe(true);
    if (!recited.ok) throw new Error(recited.reason);
    const confirmed = confirmBranchRecitation(
      recited.value,
      { confirmed: true, confirmationId: "confirm-1" },
      now,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error(confirmed.reason);

    expect(confirmed.value.privateResearch).toHaveLength(1);
    expect(projectMainTranscript(confirmed.value).map((entry) => entry.kind)).toEqual([
      "brief",
      "recitation",
      "confirmation_result",
    ]);
  });

  test("requires explicit confirmation before capsule conversion or send", async () => {
    const briefed = createBriefedBranch();
    const recited = reciteBranchReturn(
      briefed,
      registry(briefed),
      () => "modify_task",
      now,
    );
    expect(recited.ok).toBe(true);
    if (!recited.ok) throw new Error(recited.reason);

    expect(toConfirmedCapsule(recited.value)).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "branch_not_confirmed",
    });

    const declined = confirmBranchRecitation(
      recited.value,
      { confirmed: false, confirmationId: "confirm-no" },
      now,
    );
    expect(declined.ok).toBe(true);
    if (!declined.ok) throw new Error(declined.reason);
    expect(declined.value.status).toBe("failed_closed");
    expect(projectMainTranscript(declined.value).at(-1)?.kind).toBe(
      "confirmation_result",
    );
  });

  test("rejects blank confirmation ids", () => {
    const briefed = createBriefedBranch();
    const recited = reciteBranchReturn(
      briefed,
      registry(briefed),
      () => "modify_task",
      now,
    );
    expect(recited.ok).toBe(true);
    if (!recited.ok) throw new Error(recited.reason);

    expect(
      confirmBranchRecitation(
        recited.value,
        { confirmed: true, confirmationId: "   " },
        now,
      ),
    ).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "confirmation_id_missing",
    });
  });

  test("fails closed when source task is missing", () => {
    const branch = createBriefedBranch();
    const result = reciteBranchReturn(
      branch,
      { lookup: () => null },
      () => "new_task",
      now,
    );

    expect(result).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_task_missing",
    });
  });

  test("fails closed on stale lineage or reused lineage intent", () => {
    const branch = createBriefedBranch();
    const stale = reciteBranchReturn(
      branch,
      registry(branch, {
        sourceLineageHash: sourceLineageHash({ ...source, runId: "run-2" }),
      }),
      () => "modify_task",
      now,
    );
    const reused = reciteBranchReturn(
      branch,
      registry(branch, {
        consumedLineageIntentIds: [branch.lineageIntentId],
      }),
      () => "modify_task",
      now,
    );

    expect(stale).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_lineage_changed",
    });
    expect(reused).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "lineage_intent_reused",
    });
  });
});
