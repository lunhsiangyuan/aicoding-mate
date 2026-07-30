import { describe, expect, test } from "bun:test";

import { createFirstmateNativeReviewDecision } from "../src/authority/firstmate-decisions.ts";
import { sourceLineageHash, type SourceLineage } from "../src/contracts/index.ts";
import {
  codexThreadUrl,
  createReviewCapsule,
  openCodexDesktopThread,
  type CodexAppServerReviewPort,
  type CodexReviewReadback,
  type CodexReviewStartReceipt,
  type ReviewCapsuleInput,
} from "../src/review/index.ts";

const lineage: SourceLineage = {
  taskId: "task-1",
  runId: "run-1",
  workspace: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
};

const workflowDecision = createFirstmateNativeReviewDecision({
  intentHash: "1".repeat(64),
  configVersion: "native-review-v0.2",
  source: lineage,
  reviewer: {
    role: "reviewer",
    alias: "openai-native-reviewer",
    provider: "openai",
    family: "openai",
    resolvedModel: "gpt-5.6-sol",
    capabilityTier: "architecture",
    reason: "test reviewer",
  },
});

const baseInput: ReviewCapsuleInput = {
  workflowDecision,
  canonicalRunId: "run-canonical-review",
  idempotencyKey: "dispatch-native-review",
  source: {
    taskId: "task-1",
    runId: "run-1",
    firstmateSessionRef: "firstmate-main-1",
    lineage,
  },
  target: { type: "custom", instructions: "Review selected context." },
  selection: {
    selectedText: "請 review 這段 adapter 設計。",
    sourceArtifact: "branch-1",
    file: "src/example.ts",
    startLine: 12,
    endLine: 18,
  },
  prompt: { text: "Find correctness and handoff risks." },
  delivery: "detached",
  parentThreadReadState: "complete",
  now: () => "2026-07-30T20:00:00.000Z",
};

function startReceipt(
  overrides: Partial<CodexReviewStartReceipt> = {},
): CodexReviewStartReceipt {
  return {
    sourceThreadId: "thread-source-1",
    reviewThreadId: "thread-review-1",
    delivery: "detached",
    turnId: "turn-review-1",
    eventIds: ["review-started"],
    ...overrides,
  };
}

function readback(
  overrides: Partial<Extract<CodexReviewReadback, { ok: true }>> = {},
): CodexReviewReadback {
  return {
    ok: true,
    threadId: "thread-review-1",
    sourceThreadId: "thread-source-1",
    sourceLineageHash: sourceLineageHash(lineage),
    summary: "Review completed with one finding.",
    decision: "changes_requested",
    rawReviewText: "src/example.ts:12 should fail closed on bad ids.",
    annotations: [
      {
        file: "src/example.ts",
        line: 12,
        endLine: 12,
        body: "Bad thread ids must not produce a capsule.",
        source: "codex_review_text",
      },
    ],
    nativeAnnotationExport: "unverifiable",
    eventIds: ["review-completed"],
    completedAt: "2026-07-30T20:01:00.000Z",
    ...overrides,
  };
}

function port(options: {
  readonly start?: Partial<CodexReviewStartReceipt>;
  readonly read?: CodexReviewReadback;
  readonly throwOnStart?: boolean;
  readonly throwOnRead?: boolean;
  readonly counters?: { start: number; read: number };
} = {}): CodexAppServerReviewPort {
  return {
    async startReview() {
      options.counters && (options.counters.start += 1);
      if (options.throwOnStart) throw new Error("app server unavailable");
      return startReceipt(options.start);
    },
    async readReviewThread() {
      options.counters && (options.counters.read += 1);
      if (options.throwOnRead) throw new Error("read failed");
      return options.read ?? readback();
    },
  };
}

describe("Codex Review Capsule core", () => {
  test("creates a text capsule after detached review read-back and exact deep-link construction", async () => {
    const result = await createReviewCapsule(baseInput, {
      appServer: port(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.capsule.codex.reviewThreadId).toBe("thread-review-1");
    expect(result.capsule.codex.desktopUrl).toBe(
      "codex://threads/thread-review-1",
    );
    expect(result.capsule.review.decision).toBe("changes_requested");
    expect(result.capsule.review.annotations).toHaveLength(1);
    expect(result.capsule.verification.threadReadBack).toBe("confirmed");
    expect(result.capsule.verification.sourceLineage).toBe("confirmed");
    expect(result.capsule.verification.nativeAnnotationExport).toBe(
      "unverifiable",
    );
    expect(result.capsule.source.sourceLineageHash).toBe(
      sourceLineageHash(lineage),
    );
    expect(result.capsule.authority).toEqual({
      bridgeMode: "port_driven_lineage_verified",
      workflowAuthority: "firstmate_verified",
      runtimeAuthority: "canonical_run_registry_verified",
      canonicalRunId: "run-canonical-review",
      idempotencyKey: "dispatch-native-review",
      codexReviewOwnership: "firstmate_decision_codex_thread",
    });
    expect(result.capsule.limitations).toContain(
      "native_annotation_export_unverifiable",
    );
  });

  test("preserves confirmed native annotations without requiring them for text round-trip", async () => {
    const result = await createReviewCapsule(baseInput, {
      appServer: port({
        read: readback({
          decision: null,
          nativeAnnotationExport: "confirmed",
          annotations: [
            {
              file: "src/native.ts",
              line: 4,
              endLine: 6,
              body: "User asked for a tighter guard.",
              source: "native_annotation",
            },
          ],
        }),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.capsule.review.decision).toBe("unverifiable");
    expect(result.capsule.review.annotations[0]).toEqual({
      file: "src/native.ts",
      line: 4,
      endLine: 6,
      body: "User asked for a tighter guard.",
      source: "native_annotation",
    });
    expect(result.capsule.verification.nativeAnnotationExport).toBe(
      "confirmed",
    );
    expect(result.capsule.limitations).not.toContain(
      "native_annotation_export_unverifiable",
    );
    expect(result.capsule.limitations).toEqual([]);
  });

  test("fails closed before app-server calls when parent thread state is paginated or ambiguous", async () => {
    const paginatedCounters = { start: 0, read: 0 };
    const paginated = await createReviewCapsule(
      { ...baseInput, parentThreadReadState: "paginated" },
      { appServer: port({ counters: paginatedCounters }) },
    );
    const unknownCounters = { start: 0, read: 0 };
    const unknown = await createReviewCapsule(
      { ...baseInput, parentThreadReadState: "unknown" },
      { appServer: port({ counters: unknownCounters }) },
    );

    expect(paginated).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "parent_thread_paginated",
    });
    expect(unknown).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "parent_thread_ambiguous",
    });
    expect(paginatedCounters).toEqual({ start: 0, read: 0 });
    expect(unknownCounters).toEqual({ start: 0, read: 0 });
  });

  test("fails closed before app-server calls when source ids do not match lineage ids", async () => {
    const taskMismatchCounters = { start: 0, read: 0 };
    const taskMismatch = await createReviewCapsule(
      {
        ...baseInput,
        source: { ...baseInput.source, taskId: "task-other" },
      },
      { appServer: port({ counters: taskMismatchCounters }) },
    );
    const runMismatchCounters = { start: 0, read: 0 };
    const runMismatch = await createReviewCapsule(
      {
        ...baseInput,
        source: { ...baseInput.source, runId: "run-other" },
      },
      { appServer: port({ counters: runMismatchCounters }) },
    );

    expect(taskMismatch).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_task_lineage_mismatch",
    });
    expect(runMismatch).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_run_lineage_mismatch",
    });
    expect(taskMismatchCounters).toEqual({ start: 0, read: 0 });
    expect(runMismatchCounters).toEqual({ start: 0, read: 0 });
  });

  test("fails closed on bad review ids and app-server read failures", async () => {
    const badId = await createReviewCapsule(baseInput, {
      appServer: port({ start: { reviewThreadId: "thread/review?bad" } }),
    });
    const missing = await createReviewCapsule(baseInput, {
      appServer: port({
        read: { ok: false, reason: "thread_not_found" },
      }),
    });
    const unavailable = await createReviewCapsule(baseInput, {
      appServer: port({ throwOnStart: true }),
    });

    expect(badId).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "bad_review_thread_id",
    });
    expect(missing).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "thread_not_found",
    });
    expect(unavailable).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "app_server_unavailable",
    });
  });

  test("fails closed on empty or malformed source thread ids before read-back", async () => {
    const emptyCounters = { start: 0, read: 0 };
    const emptySourceThread = await createReviewCapsule(baseInput, {
      appServer: port({
        start: { sourceThreadId: "" },
        read: readback({ sourceThreadId: "" }),
        counters: emptyCounters,
      }),
    });
    const malformedCounters = { start: 0, read: 0 };
    const malformedSourceThread = await createReviewCapsule(baseInput, {
      appServer: port({
        start: { sourceThreadId: "thread/source?bad" },
        read: readback({ sourceThreadId: "thread/source?bad" }),
        counters: malformedCounters,
      }),
    });

    expect(emptySourceThread).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_thread_id_missing",
    });
    expect(malformedSourceThread).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "bad_source_thread_id",
    });
    expect(emptyCounters).toEqual({ start: 1, read: 0 });
    expect(malformedCounters).toEqual({ start: 1, read: 0 });
  });

  test("requires read-back thread, source thread, and source lineage to match before return", async () => {
    const wrongReviewThread = await createReviewCapsule(baseInput, {
      appServer: port({ read: readback({ threadId: "thread-other" }) }),
    });
    const wrongSourceThread = await createReviewCapsule(baseInput, {
      appServer: port({ read: readback({ sourceThreadId: "thread-source-2" }) }),
    });
    const wrongLineage = await createReviewCapsule(baseInput, {
      appServer: port({
        read: readback({ sourceLineageHash: sourceLineageHash({ ...lineage, runId: "run-2" }) }),
      }),
    });

    expect(wrongReviewThread).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "review_thread_mismatch",
    });
    expect(wrongSourceThread).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_thread_mismatch",
    });
    expect(wrongLineage).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "source_lineage_mismatch",
    });
  });

  test("validates URL construction and refuses non-stable thread ids", () => {
    expect(codexThreadUrl("019fb1b5-a319-7c10-a128-dd1f446d53b8")).toBe(
      "codex://threads/019fb1b5-a319-7c10-a128-dd1f446d53b8",
    );
    expect(() => codexThreadUrl("bad/thread")).toThrow(
      "bad_review_thread_id",
    );
    expect(() => codexThreadUrl("")).toThrow("bad_review_thread_id");
  });

  test("desktop open port requires observed thread id to match exact review id", async () => {
    const opened = await openCodexDesktopThread(
      {
        async openThread(request) {
          return {
            opened: true,
            observedThreadId: request.reviewThreadId,
            reason: null,
          };
        },
      },
      "thread-review-1",
    );
    const wrongThread = await openCodexDesktopThread(
      {
        async openThread() {
          return {
            opened: true,
            observedThreadId: "thread-other",
            reason: null,
          };
        },
      },
      "thread-review-1",
    );
    const failedOpen = await openCodexDesktopThread(
      {
        async openThread() {
          return {
            opened: false,
            observedThreadId: null,
            reason: "open command failed",
          };
        },
      },
      "thread-review-1",
    );

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.request.url).toBe("codex://threads/thread-review-1");
    expect(wrongThread).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "desktop_thread_mismatch",
    });
    expect(failedOpen).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "desktop_open_failed",
    });
  });
});
