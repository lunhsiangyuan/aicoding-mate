import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  canonicalIdempotencyKey,
  canonicalIntentFingerprint,
  FileRunRegistry,
  type CanonicalRunIntent,
  type FoundReadbackObservation,
  type ReadbackObservation,
  type RegistryLease,
  type RunProjection,
} from "../src/runtime/run-registry.ts";

const baseIntent: CanonicalRunIntent = {
  workflow: "standard",
  projectDir: "/workspace/project",
  task: "Review the architecture boundary.",
  source: {
    taskId: "task-1",
    runId: "source-run-1",
    workspace: "/workspace/project",
    tabId: "tab-1",
    paneId: "pane-1",
  },
  inputs: {
    normalizedPromptHash: "prompt-hash",
    recipe: "standard-v1",
  },
  availabilitySnapshotId: "availability-old",
  routingDecisionVersion: "decision-old",
  decisionVersion: "policy-old",
};

function registryRoot(): string {
  return mkdtempSync(join(tmpdir(), "aicoding-mate-run-registry-"));
}

function createRun(now = "2026-07-30T16:00:00.000Z"): {
  readonly root: string;
  readonly registry: FileRunRegistry;
  readonly run: RunProjection;
  readonly lease: RegistryLease;
} {
  const root = registryRoot();
  const registry = new FileRunRegistry({ rootDir: root });
  const opened = registry.openOrCreateRun({
    intent: baseIntent,
    owner: "test-owner",
    leaseTtlMs: 60_000,
    now,
  });
  expect(opened.kind).toBe("created");
  if (opened.kind !== "created") {
    throw new Error("expected created run");
  }
  return { root, registry, run: opened.run, lease: opened.lease };
}

function foundReadback(
  run: RunProjection,
  artifactHash = "artifact-hash-1",
): FoundReadbackObservation {
  const attempt = run.attempts[run.attempts.length - 1];
  if (attempt === undefined) {
    throw new Error("attempt missing");
  }
  return {
    status: "found",
    runId: run.runId,
    attemptId: attempt.id,
    artifactPath: "/tmp/aicoding-mate/artifact.json",
    artifactHash,
  };
}

describe("filesystem run registry", () => {
  test("canonical intent fingerprint excludes availability and decision versions", () => {
    const changedVolatileFields: CanonicalRunIntent = {
      ...baseIntent,
      availabilitySnapshotId: "availability-new",
      routingDecisionVersion: "decision-new",
      decisionVersion: "policy-new",
    };
    const changedIntent: CanonicalRunIntent = {
      ...baseIntent,
      inputs: { ...baseIntent.inputs, recipe: "standard-v2" },
    };

    expect(canonicalIntentFingerprint(changedVolatileFields)).toBe(
      canonicalIntentFingerprint(baseIntent),
    );
    expect(canonicalIdempotencyKey(baseIntent)).toBe(
      `acm-run-${canonicalIntentFingerprint(baseIntent)}`,
    );
    expect(canonicalIntentFingerprint(changedIntent)).not.toBe(
      canonicalIntentFingerprint(baseIntent),
    );
  });

  test("creates one canonical run and coalesces duplicate active and completed intents", () => {
    const { registry, run } = createRun();

    const duplicateActive = registry.openOrCreateRun({
      intent: {
        ...baseIntent,
        availabilitySnapshotId: "availability-does-not-matter",
      },
      owner: "second-owner",
      leaseTtlMs: 60_000,
      now: "2026-07-30T16:00:01.000Z",
    });
    expect(duplicateActive.kind).toBe("coalesced_active");
    expect(duplicateActive.run.runId).toBe(run.runId);
    expect(duplicateActive.lease).toBeNull();

    const lease = registry.acquireRunLease({
      runId: run.runId,
      owner: "finisher",
      leaseTtlMs: 60_000,
      now: "2026-07-30T16:02:00.000Z",
    });
    expect(lease).not.toBeNull();
    if (lease === null) {
      throw new Error("expected lease");
    }
    const completed = registry.completeAttempt(lease, {
      readback: foundReadback(run),
      now: "2026-07-30T16:02:01.000Z",
    });
    expect(completed.status).toBe("completed");

    const duplicateCompleted = registry.openOrCreateRun({
      intent: baseIntent,
      owner: "third-owner",
      leaseTtlMs: 60_000,
      now: "2026-07-30T16:03:00.000Z",
    });
    expect(duplicateCompleted.kind).toBe("coalesced_completed");
    expect(duplicateCompleted.run.completedArtifact?.hash).toBe(
      "artifact-hash-1",
    );
  });

  test("lease acquisition is exclusive and expired takeover invalidates the old token", () => {
    const { registry, run, lease } = createRun();

    const blocked = registry.acquireRunLease({
      runId: run.runId,
      owner: "blocked-owner",
      leaseTtlMs: 60_000,
      now: "2026-07-30T16:00:30.000Z",
    });
    expect(blocked).toBeNull();

    const takeover = registry.acquireRunLease({
      runId: run.runId,
      owner: "takeover-owner",
      leaseTtlMs: 60_000,
      now: "2026-07-30T16:02:00.000Z",
    });
    expect(takeover).not.toBeNull();
    if (takeover === null) {
      throw new Error("expected takeover lease");
    }
    expect(takeover.token).not.toBe(lease.token);

    expect(() =>
      registry.markRunning(lease, { now: "2026-07-30T16:02:01.000Z" }),
    ).toThrow("lease_not_held");
    expect(
      registry.markRunning(takeover, {
        now: "2026-07-30T16:02:02.000Z",
      }).status,
    ).toBe("running");
  });

  test("rejects duplicate dispatch idempotency keys within one attempt", () => {
    const { registry, lease } = createRun();
    const dispatch = {
      idempotencyKey: "dispatch-once",
      target: "anthropic:fable",
      receiptPath: null,
      accepted: false,
      now: "2026-07-30T16:00:01.000Z",
    };

    registry.recordDispatch(lease, dispatch);

    expect(() =>
      registry.recordDispatch(lease, {
        ...dispatch,
        now: "2026-07-30T16:00:02.000Z",
      })
    ).toThrow("dispatch_idempotency_key_already_recorded");
    expect(
      registry.readRun(lease.runId)?.attempts.at(-1)?.dispatches,
    ).toHaveLength(1);
  });

  test("unknown outcomes only create a retry attempt after not_found read-back", () => {
    const { registry, run, lease } = createRun();
    registry.markRunning(lease, { now: "2026-07-30T16:00:02.000Z" });
    const unknown = registry.markUnknownOutcome(lease, {
      reason: "worker_crashed_before_receipt",
      readback: {
        status: "mismatch",
        checkedAt: "2026-07-30T16:01:00.000Z",
        reason: "artifact_belongs_to_another_attempt",
      },
      now: "2026-07-30T16:01:00.000Z",
    });
    expect(unknown.status).toBe("unknown_outcome");

    expect(() =>
      registry.requestRetryAfterReadbackNotFound(lease, {
        readback: {
          status: "mismatch",
          checkedAt: "2026-07-30T16:01:30.000Z",
          reason: "still_ambiguous",
        },
        now: "2026-07-30T16:01:30.000Z",
      }),
    ).toThrow("retry_requires_readback_not_found");

    const retry = registry.requestRetryAfterReadbackNotFound(lease, {
      readback: {
        status: "not_found",
        checkedAt: "2026-07-30T16:02:00.000Z",
        reason: "firstmate_task_not_found",
      },
      now: "2026-07-30T16:02:00.000Z",
    });
    expect(retry.status).toBe("pending");
    expect(retry.runId).toBe(run.runId);
    expect(retry.attempts).toHaveLength(2);
    expect(retry.attempts[1]?.id).toBe("attempt-2");
  });

  test("strict completion read-back rejects mismatched run or attempt", () => {
    const { registry, run, lease } = createRun();

    expect(() =>
      registry.completeAttempt(lease, {
        readback: {
          ...foundReadback(run),
          runId: "run-not-this-one",
        },
        now: "2026-07-30T16:01:00.000Z",
      }),
    ).toThrow("readback_run_mismatch");

    expect(() =>
      registry.completeAttempt(lease, {
        readback: {
          ...foundReadback(run),
          attemptId: "attempt-99",
        },
        now: "2026-07-30T16:01:01.000Z",
      }),
    ).toThrow("readback_attempt_mismatch");
    expect(registry.readRun(run.runId)?.status).toBe("pending");
  });

  test("completed artifact cannot be shadowed by a later failed attempt", () => {
    const { registry, run, lease } = createRun();
    const completed = registry.completeAttempt(lease, {
      readback: foundReadback(run, "first-completed-artifact"),
      now: "2026-07-30T16:01:00.000Z",
    });
    expect(completed.completedArtifact?.hash).toBe(
      "first-completed-artifact",
    );

    const afterFailure = registry.failAttempt(lease, {
      reason: "late_worker_error_after_artifact",
      now: "2026-07-30T16:02:00.000Z",
    });
    expect(afterFailure.status).toBe("completed");
    expect(afterFailure.completedArtifact?.hash).toBe(
      "first-completed-artifact",
    );
    expect(afterFailure.attempts[0]?.status).toBe("completed");
  });

  test("lineage events are append-only and hash-chained into the projection", () => {
    const { root, registry, run, lease } = createRun();
    const dispatched = registry.recordDispatch(lease, {
      idempotencyKey: run.idempotencyKey,
      target: null,
      receiptPath: null,
      accepted: false,
      now: "2026-07-30T16:01:00.000Z",
    });
    const accepted = registry.acceptDispatch(lease, {
      idempotencyKey: run.idempotencyKey,
      target: "session:pane",
      receiptPath: "/tmp/receipt.json",
      now: "2026-07-30T16:01:15.000Z",
    });
    const running = registry.markRunning(lease, {
      now: "2026-07-30T16:01:30.000Z",
    });
    expect(accepted.attempts[0]?.dispatches).toHaveLength(1);
    expect(accepted.attempts[0]?.dispatches[0]?.status).toBe("accepted");
    expect(running.lineage.eventCount).toBe(4);

    const eventsPath = join(root, "runs", dispatched.runId, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const firstHash = readEventHash(events[0]);
    const secondHash = readEventHash(events[1]);
    const thirdHash = readEventHash(events[2]);
    const fourthHash = readEventHash(events[3]);

    expect(events).toHaveLength(4);
    expect(events[1]?.prevHash).toBe(firstHash);
    expect(events[2]?.prevHash).toBe(secondHash);
    expect(events[3]?.prevHash).toBe(thirdHash);
    expect(running.lineage.headHash).toBe(fourthHash);
  });

  test("read-back rejects a projection whose canonical intent was tampered", () => {
    const { root, registry, run } = createRun();
    const projectionPath = join(root, "runs", run.runId, "projection.json");
    const projection = JSON.parse(
      readFileSync(projectionPath, "utf8"),
    ) as Record<string, unknown>;
    const intent = projection.intent;
    if (typeof intent !== "object" || intent === null || Array.isArray(intent)) {
      throw new Error("intent missing");
    }
    writeFileSync(
      projectionPath,
      `${JSON.stringify({
        ...projection,
        intent: { ...intent, task: "Tampered task" },
      })}\n`,
      "utf8",
    );

    expect(() => registry.readRun(run.runId)).toThrow(
      "intent_fingerprint_mismatch",
    );
  });

  test("read-back rejects a tampered lineage event", () => {
    const { root, registry, run } = createRun();
    const eventsPath = join(root, "runs", run.runId, "events.jsonl");
    const event = JSON.parse(
      readFileSync(eventsPath, "utf8").trim(),
    ) as Record<string, unknown>;
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ ...event, type: "tampered_event" })}\n`,
      "utf8",
    );

    expect(() => registry.readRun(run.runId)).toThrow(
      "lineage_event_hash_mismatch",
    );
  });
});

function readEventHash(event: Record<string, unknown> | undefined): string {
  if (event === undefined || typeof event.hash !== "string") {
    throw new Error("event hash missing");
  }
  return event.hash;
}
