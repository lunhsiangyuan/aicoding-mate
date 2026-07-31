import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { SourceLineage } from "../contracts/index.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CanonicalRunIntent {
  readonly workflow: string;
  readonly projectDir: string;
  readonly task: string;
  readonly source: SourceLineage;
  readonly inputs?: { readonly [key: string]: JsonValue };
  readonly availabilitySnapshotId?: string;
  readonly routingDecisionVersion?: string;
  readonly decisionVersion?: string;
}

export type RunStatus =
  | "pending"
  | "dispatching"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "unknown_outcome";

export type ReadbackObservation =
  | {
      readonly status: "found";
      readonly runId: string;
      readonly attemptId: string;
      readonly artifactPath: string;
      readonly artifactHash: string;
    }
  | {
      readonly status: "not_found";
      readonly checkedAt: string;
      readonly reason: string;
    }
  | {
      readonly status: "mismatch";
      readonly checkedAt: string;
      readonly reason: string;
    };

export type FoundReadbackObservation = Extract<
  ReadbackObservation,
  { readonly status: "found" }
>;

export interface DispatchRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly dispatchedAt: string;
  readonly status: "dispatching" | "accepted";
  readonly target: string | null;
  readonly receiptPath: string | null;
}

export interface AttemptRecord {
  readonly id: string;
  readonly sequence: number;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatches: readonly DispatchRecord[];
  readonly readback: ReadbackObservation | null;
  readonly artifact: CompletedArtifact | null;
  readonly failureReason: string | null;
}

export interface CompletedArtifact {
  readonly path: string;
  readonly hash: string;
  readonly completedAt: string;
  readonly attemptId: string;
}

export interface RunProjection {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly intentFingerprint: string;
  readonly idempotencyKey: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly intent: CanonicalRunIntent;
  readonly attempts: readonly AttemptRecord[];
  readonly completedArtifact: CompletedArtifact | null;
  readonly lineage: {
    readonly eventCount: number;
    readonly headHash: string;
  };
}

export interface RegistryLease {
  readonly runId: string;
  readonly owner: string;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export type OpenRunResult =
  | {
      readonly kind: "created";
      readonly run: RunProjection;
      readonly lease: RegistryLease;
    }
  | {
      readonly kind: "coalesced_active" | "coalesced_completed" | "opened";
      readonly run: RunProjection;
      readonly lease: null;
    };

interface StoredLineageEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly type: string;
  readonly at: string;
  readonly prevHash: string;
  readonly payload: { readonly [key: string]: JsonValue };
  readonly hash: string;
}

interface LeaseFile {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly owner: string;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

interface LineageFile {
  readonly events: readonly StoredLineageEvent[];
  readonly completeContents: string;
  readonly truncatedTail: string | null;
}

export interface RunRegistryOptions {
  readonly rootDir: string;
}

const ACTIVE_STATUSES: readonly RunStatus[] = [
  "pending",
  "dispatching",
  "accepted",
  "running",
];

const GENESIS_HASH = "0".repeat(64);

export function canonicalIntentFingerprint(
  intent: CanonicalRunIntent,
): string {
  return sha256(
    stableStringify({
      workflow: intent.workflow,
      projectDir: intent.projectDir,
      task: intent.task,
      source: intent.source,
      inputs: intent.inputs ?? {},
    }),
  );
}

export function canonicalIdempotencyKey(intent: CanonicalRunIntent): string {
  return `acm-run-${canonicalIntentFingerprint(intent)}`;
}

export class FileRunRegistry {
  readonly #rootDir: string;

  constructor(options: RunRegistryOptions) {
    this.#rootDir = options.rootDir;
  }

  openOrCreateRun(input: {
    readonly intent: CanonicalRunIntent;
    readonly owner: string;
    readonly leaseTtlMs: number;
    readonly now: string;
  }): OpenRunResult {
    const intentFingerprint = canonicalIntentFingerprint(input.intent);
    const runId = runIdFromFingerprint(intentFingerprint);
    const runDir = this.#runDir(runId);
    mkdirSync(dirname(runDir), { recursive: true });

    if (existsSync(runDir)) {
      if (this.#recoverUnpublishedRunDir(runId)) {
        return this.openOrCreateRun(input);
      }
      return this.#coalescedOrOpened(runId, input.now);
    }

    const stagingDir = join(
      dirname(runDir),
      `.${runId}.staging-${process.pid}-${randomUUID()}`,
    );

    try {
      mkdirSync(stagingDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return this.#coalescedOrOpened(runId, input.now);
      }
      throw error;
    }

    const lease = makeLease(
      runId,
      input.owner,
      input.leaseTtlMs,
      input.now,
    );

    const firstAttempt: AttemptRecord = {
      id: "attempt-1",
      sequence: 1,
      status: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      dispatches: [],
      readback: null,
      artifact: null,
      failureReason: null,
    };
    const event = makeEvent({
      sequence: 1,
      runId,
      attemptId: firstAttempt.id,
      type: "run_created",
      at: input.now,
      prevHash: GENESIS_HASH,
      payload: {
        intentFingerprint,
        idempotencyKey: canonicalIdempotencyKey(input.intent),
      },
    });
    this.#appendEventAt(join(stagingDir, "events.jsonl"), event);

    const run: RunProjection = {
      schemaVersion: 1,
      runId,
      intentFingerprint,
      idempotencyKey: canonicalIdempotencyKey(input.intent),
      status: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      intent: input.intent,
      attempts: [firstAttempt],
      completedArtifact: null,
      lineage: {
        eventCount: 1,
        headHash: event.hash,
      },
    };
    this.#writeProjectionAt(run, stagingDir);
    this.#writeLeaseFileAt(lease, join(stagingDir, "lease"));
    try {
      renameSync(stagingDir, runDir);
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      if (
        isNodeError(error)
        && (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      ) {
        return this.#coalescedOrOpened(runId, input.now);
      }
      throw error;
    }
    return { kind: "created", run, lease };
  }

  readRun(runId: string): RunProjection | null {
    const path = this.#projectionPath(runId);
    if (!existsSync(path)) {
      return null;
    }
    const run = parseRunProjection(readJson(path));
    assertRunProjectionIntegrity(runId, run);
    try {
      assertLineageIntegrity(run, this.#eventsPath(runId));
      return run;
    } catch (error) {
      return this.#recoverReadableRun(run, error);
    }
  }

  acquireRunLease(input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseTtlMs: number;
    readonly now: string;
  }): RegistryLease | null {
    return this.#acquireLeaseForRun(
      input.runId,
      input.owner,
      input.leaseTtlMs,
      input.now,
    );
  }

  renewLease(
    lease: RegistryLease,
    input: {
      readonly leaseTtlMs: number;
      readonly now: string;
    },
  ): RegistryLease {
    const current = this.#assertLease(lease, input.now);
    if (input.leaseTtlMs <= 0) {
      throw new Error("lease_ttl_must_be_positive");
    }
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new Error("invalid_now");
    }
    const renewed: RegistryLease = {
      runId: current.runId,
      owner: current.owner,
      token: current.token,
      acquiredAt: current.acquiredAt,
      expiresAt: new Date(nowMs + input.leaseTtlMs).toISOString(),
    };
    this.#writeLeaseFile(renewed);
    return renewed;
  }

  releaseLease(lease: RegistryLease): void {
    this.#assertLeaseToken(lease);
    rmSync(this.#leasePath(lease.runId), { recursive: true, force: true });
  }

  recordDispatch(
    lease: RegistryLease,
    dispatch: {
      readonly idempotencyKey: string;
      readonly target: string | null;
      readonly receiptPath: string | null;
      readonly accepted: boolean;
      readonly now: string;
    },
  ): RunProjection {
    return this.#mutate(lease, dispatch.now, "dispatch_recorded", {
      dispatchId: `dispatch-${randomUUID()}`,
      idempotencyKey: dispatch.idempotencyKey,
      target: dispatch.target,
      receiptPath: dispatch.receiptPath,
      accepted: dispatch.accepted,
    }, (run, attempt) => {
      if (
        attempt.dispatches.some(
          (existing) =>
            existing.idempotencyKey === dispatch.idempotencyKey,
        )
      ) {
        throw new Error("dispatch_idempotency_key_already_recorded");
      }
      const nextStatus = dispatch.accepted ? "accepted" : "dispatching";
      const nextDispatch: DispatchRecord = {
        id: `dispatch-${attempt.dispatches.length + 1}`,
        idempotencyKey: dispatch.idempotencyKey,
        dispatchedAt: dispatch.now,
        status: nextStatus,
        target: dispatch.target,
        receiptPath: dispatch.receiptPath,
      };
      return updateAttempt(run, {
        ...attempt,
        status: nextStatus,
        updatedAt: dispatch.now,
        dispatches: [...attempt.dispatches, nextDispatch],
      }, nextStatus, dispatch.now);
    });
  }

  acceptDispatch(
    lease: RegistryLease,
    input: {
      readonly idempotencyKey: string;
      readonly target: string | null;
      readonly receiptPath: string | null;
      readonly now: string;
    },
  ): RunProjection {
    return this.#mutate(lease, input.now, "dispatch_accepted", {
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      receiptPath: input.receiptPath,
    }, (run, attempt) => {
      let matchingIndex = -1;
      for (let index = attempt.dispatches.length - 1; index >= 0; index -= 1) {
        if (attempt.dispatches[index]?.idempotencyKey === input.idempotencyKey) {
          matchingIndex = index;
          break;
        }
      }
      if (matchingIndex < 0) {
        throw new Error("dispatch_not_recorded");
      }
      const dispatches = attempt.dispatches.map((dispatch, index) =>
        index === matchingIndex
          ? {
              ...dispatch,
              status: "accepted" as const,
              target: input.target,
              receiptPath: input.receiptPath,
            }
          : dispatch
      );
      return updateAttempt(run, {
        ...attempt,
        status: "accepted",
        updatedAt: input.now,
        dispatches,
      }, "accepted", input.now);
    });
  }

  markRunning(
    lease: RegistryLease,
    input: { readonly now: string },
  ): RunProjection {
    return this.#mutate(lease, input.now, "attempt_running", {}, (run, attempt) =>
      updateAttempt(run, {
        ...attempt,
        status: "running",
        updatedAt: input.now,
      }, "running", input.now)
    );
  }

  completeAttempt(
    lease: RegistryLease,
    input: {
      readonly readback: ReadbackObservation;
      readonly now: string;
    },
  ): RunProjection {
    if (input.readback.status !== "found") {
      throw new Error("completion_requires_found_readback");
    }
    const readback: FoundReadbackObservation = input.readback;
    return this.#mutate(lease, input.now, "attempt_completed", {
      artifactPath: readback.artifactPath,
      artifactHash: readback.artifactHash,
    }, (run, attempt) => {
      if (readback.runId !== run.runId) {
        throw new Error("readback_run_mismatch");
      }
      if (readback.attemptId !== attempt.id) {
        throw new Error("readback_attempt_mismatch");
      }
      const artifact: CompletedArtifact = {
        path: readback.artifactPath,
        hash: readback.artifactHash,
        completedAt: input.now,
        attemptId: attempt.id,
      };
      const completedAttempt: AttemptRecord = {
        ...attempt,
        status: "completed",
        updatedAt: input.now,
        readback,
        artifact,
        failureReason: null,
      };
      const updated = updateAttempt(
        run,
        completedAttempt,
        "completed",
        input.now,
      );
      return {
        ...updated,
        completedArtifact: run.completedArtifact ?? artifact,
      };
    });
  }

  failAttempt(
    lease: RegistryLease,
    input: { readonly reason: string; readonly now: string },
  ): RunProjection {
    return this.#mutate(lease, input.now, "attempt_failed", {
      reason: input.reason,
    }, (run, attempt) => {
      if (run.completedArtifact !== null) {
        return {
          ...run,
          status: "completed",
          updatedAt: input.now,
        };
      }
      return updateAttempt(run, {
        ...attempt,
        status: "failed",
        updatedAt: input.now,
        failureReason: input.reason,
      }, "failed", input.now);
    });
  }

  markUnknownOutcome(
    lease: RegistryLease,
    input: {
      readonly reason: string;
      readonly readback: ReadbackObservation;
      readonly now: string;
    },
  ): RunProjection {
    return this.#mutate(lease, input.now, "attempt_unknown_outcome", {
      reason: input.reason,
      readbackStatus: input.readback.status,
      readback: input.readback,
    }, (run, attempt) => {
      const nextRunStatus = run.completedArtifact === null
        ? "unknown_outcome"
        : "completed";
      return updateAttempt(run, {
        ...attempt,
        status: "unknown_outcome",
        updatedAt: input.now,
        readback: input.readback,
        failureReason: input.reason,
      }, nextRunStatus, input.now);
    });
  }

  requestRetryAfterReadbackNotFound(
    lease: RegistryLease,
    input: { readonly readback: ReadbackObservation; readonly now: string },
  ): RunProjection {
    if (input.readback.status !== "not_found") {
      throw new Error("retry_requires_readback_not_found");
    }
    return this.#mutate(lease, input.now, "retry_attempt_created", {
      readbackStatus: input.readback.status,
      reason: input.readback.reason,
    }, (run) => {
      if (run.completedArtifact !== null) {
        throw new Error("completed_run_cannot_retry");
      }
      if (run.status !== "unknown_outcome") {
        throw new Error("retry_requires_unknown_outcome");
      }
      const nextSequence = run.attempts.length + 1;
      const retryAttempt: AttemptRecord = {
        id: `attempt-${nextSequence}`,
        sequence: nextSequence,
        status: "pending",
        createdAt: input.now,
        updatedAt: input.now,
        dispatches: [],
        readback: null,
        artifact: null,
        failureReason: null,
      };
      return {
        ...run,
        status: "pending",
        updatedAt: input.now,
        attempts: [...run.attempts, retryAttempt],
      };
    });
  }

  #coalescedOrOpened(runId: string, now: string): OpenRunResult {
    const run = this.readRun(runId);
    if (run === null) {
      throw new Error("run_projection_missing");
    }
    if (run.status === "completed") {
      return { kind: "coalesced_completed", run, lease: null };
    }
    if (ACTIVE_STATUSES.includes(run.status)) {
      const lease = this.#readLease(runId);
      if (
        lease === null
        || Date.parse(lease.expiresAt) <= Date.parse(now)
      ) {
        return { kind: "opened", run, lease: null };
      }
      return { kind: "coalesced_active", run, lease: null };
    }
    return { kind: "opened", run, lease: null };
  }

  #mutate(
    lease: RegistryLease,
    at: string,
    eventType: string,
    payload: { readonly [key: string]: JsonValue },
    apply: (run: RunProjection, activeAttempt: AttemptRecord) => RunProjection,
  ): RunProjection {
    this.#assertLease(lease, at);
    const run = this.readRun(lease.runId);
    if (run === null) {
      throw new Error("run_projection_missing");
    }
    const activeAttempt = run.attempts[run.attempts.length - 1];
    if (activeAttempt === undefined) {
      throw new Error("run_attempt_missing");
    }

    const next = apply(run, activeAttempt);
    const event = makeEvent({
      sequence: run.lineage.eventCount + 1,
      runId: run.runId,
      attemptId: next.attempts[next.attempts.length - 1]?.id ?? null,
      type: eventType,
      at,
      prevHash: run.lineage.headHash,
      payload,
    });
    this.#appendEvent(run.runId, event);
    const projected: RunProjection = {
      ...next,
      lineage: {
        eventCount: event.sequence,
        headHash: event.hash,
      },
    };
    this.#writeProjection(projected);
    return projected;
  }

  #acquireLeaseForRun(
    runId: string,
    owner: string,
    leaseTtlMs: number,
    now: string,
  ): RegistryLease | null {
    const leasePath = this.#leasePath(runId);
    mkdirSync(dirname(leasePath), { recursive: true });
    const acquiredAtMs = Date.parse(now);
    const lease = makeLease(runId, owner, leaseTtlMs, now);

    if (tryCreateLeaseDir(leasePath)) {
      this.#writeLeaseFile(lease);
      return lease;
    }

    const current = this.#readLease(runId);
    if (current === null || Date.parse(current.expiresAt) > acquiredAtMs) {
      return null;
    }

    const expiredPath = `${leasePath}.expired-${lease.token}`;
    try {
      renameSync(leasePath, expiredPath);
    } catch {
      return null;
    }

    try {
      mkdirSync(leasePath);
    } catch {
      return null;
    } finally {
      rmSync(expiredPath, { recursive: true, force: true });
    }
    this.#writeLeaseFile(lease);
    return lease;
  }

  #assertLease(lease: RegistryLease, now: string): LeaseFile {
    const current = this.#assertLeaseToken(lease);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new Error("invalid_now");
    }
    if (Date.parse(current.expiresAt) <= nowMs) {
      throw new Error("lease_expired");
    }
    return current;
  }

  #assertLeaseToken(lease: RegistryLease): LeaseFile {
    const current = this.#readLease(lease.runId);
    if (current === null || current.token !== lease.token) {
      throw new Error("lease_not_held");
    }
    return current;
  }

  #readLease(runId: string): LeaseFile | null {
    const path = join(this.#leasePath(runId), "lease.json");
    if (!existsSync(path)) {
      return null;
    }
    return parseLeaseFile(readJson(path));
  }

  #writeLeaseFile(lease: RegistryLease): void {
    this.#writeLeaseFileAt(lease, this.#leasePath(lease.runId));
  }

  #writeLeaseFileAt(lease: RegistryLease, leasePath: string): void {
    const leaseFile: LeaseFile = {
      schemaVersion: 1,
      ...lease,
    };
    const path = join(leasePath, "lease.json");
    atomicWriteJson(path, leaseFile);
    const readback = parseLeaseFile(readJson(path));
    if (readback.token !== lease.token) {
      throw new Error("lease_readback_mismatch");
    }
  }

  #appendEvent(runId: string, event: StoredLineageEvent): void {
    this.#appendEventAt(this.#eventsPath(runId), event);
  }

  #appendEventAt(path: string, event: StoredLineageEvent): void {
    appendFileSync(
      path,
      `${stableStringify(event)}\n`,
      "utf8",
    );
    const last = readLastLineageEvent(path);
    if (last.hash !== event.hash || last.prevHash !== event.prevHash) {
      throw new Error("lineage_readback_mismatch");
    }
  }

  #writeProjection(run: RunProjection): void {
    this.#writeProjectionAt(run, this.#runDir(run.runId));
  }

  #writeProjectionAt(run: RunProjection, runDir: string): void {
    const projectionPath = join(runDir, "projection.json");
    atomicWriteJson(projectionPath, run);
    const readback = parseRunProjection(readJson(projectionPath));
    assertRunProjectionIntegrity(run.runId, readback);
    assertLineageIntegrity(readback, join(runDir, "events.jsonl"));
    if (
      stableStringify(readback) !== stableStringify(run)
    ) {
      throw new Error("projection_readback_mismatch");
    }
  }

  #recoverUnpublishedRunDir(runId: string): boolean {
    const runDir = this.#runDir(runId);
    if (existsSync(this.#projectionPath(runId))) {
      return false;
    }
    if (!isProvablyUnpublishedRunDir(runDir)) {
      return false;
    }
    rmSync(runDir, { recursive: true, force: true });
    return true;
  }

  #recoverReadableRun(run: RunProjection, cause: unknown): RunProjection {
    const eventsPath = this.#eventsPath(run.runId);
    const lineage = readLineageFile(eventsPath);
    if (lineage.truncatedTail !== null) {
      if (lineage.events.length !== run.lineage.eventCount) {
        throw cause;
      }
      assertLineageEventsIntegrity(run, lineage.events);
      writeFileSync(eventsPath, lineage.completeContents, "utf8");
      assertLineageIntegrity(run, eventsPath);
      return run;
    }
    if (lineage.events.length !== run.lineage.eventCount + 1) {
      throw cause;
    }
    const prefix = lineage.events.slice(0, run.lineage.eventCount);
    assertLineageEventsIntegrity(run, prefix);
    const tail = lineage.events[lineage.events.length - 1];
    if (tail === undefined) {
      throw cause;
    }
    assertTailEventFollowsProjection(run, tail);
    const recovered = replayTailEvent(run, tail);
    if (recovered === null) {
      throw cause;
    }
    this.#writeProjection(recovered);
    return recovered;
  }

  #runDir(runId: string): string {
    return join(this.#rootDir, "runs", runId);
  }

  #projectionPath(runId: string): string {
    return join(this.#runDir(runId), "projection.json");
  }

  #eventsPath(runId: string): string {
    return join(this.#runDir(runId), "events.jsonl");
  }

  #leasePath(runId: string): string {
    return join(this.#runDir(runId), "lease");
  }
}

function updateAttempt(
  run: RunProjection,
  attempt: AttemptRecord,
  status: RunStatus,
  updatedAt: string,
): RunProjection {
  return {
    ...run,
    status,
    updatedAt,
    attempts: run.attempts.map((candidate) =>
      candidate.id === attempt.id ? attempt : candidate
    ),
  };
}

function makeEvent(input: {
  readonly sequence: number;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly type: string;
  readonly at: string;
  readonly prevHash: string;
  readonly payload: { readonly [key: string]: JsonValue };
}): StoredLineageEvent {
  const hash = sha256(stableStringify(input));
  return {
    schemaVersion: 1,
    ...input,
    hash,
  };
}

function readLastLineageEvent(path: string): StoredLineageEvent {
  const last = readLineageEvents(path).at(-1);
  if (last === undefined) {
    throw new Error("lineage_empty");
  }
  return last;
}

function readLineageEvents(path: string): readonly StoredLineageEvent[] {
  const lineage = readLineageFile(path);
  if (lineage.truncatedTail !== null) {
    throw new Error("lineage_event_json_invalid");
  }
  return lineage.events;
}

function readLineageFile(path: string): LineageFile {
  if (!existsSync(path)) {
    throw new Error("lineage_missing");
  }
  const contents = readFileSync(path, "utf8");
  if (contents.trim().length === 0) {
    throw new Error("lineage_empty");
  }
  const hasFinalNewline = contents.endsWith("\n");
  const rawLines = hasFinalNewline
    ? contents.slice(0, -1).split("\n")
    : contents.split("\n");
  const events: StoredLineageEvent[] = [];
  for (const [index, line] of rawLines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const isLastLine = index === rawLines.length - 1;
      if (!hasFinalNewline && isLastLine) {
        const completeLines = rawLines.slice(0, -1);
        return {
          events,
          completeContents: completeLines.length === 0
            ? ""
            : `${completeLines.join("\n")}\n`,
          truncatedTail: line,
        };
      }
      throw error;
    }
    events.push(parseLineageEvent(parsed));
  }
  return {
    events,
    completeContents: hasFinalNewline ? contents : `${contents}\n`,
    truncatedTail: null,
  };
}

function assertRunProjectionIntegrity(
  expectedRunId: string,
  run: RunProjection,
): void {
  const fingerprint = canonicalIntentFingerprint(run.intent);
  if (run.runId !== expectedRunId) {
    throw new Error("run_id_mismatch");
  }
  if (run.intentFingerprint !== fingerprint) {
    throw new Error("intent_fingerprint_mismatch");
  }
  if (run.runId !== runIdFromFingerprint(fingerprint)) {
    throw new Error("run_id_mismatch");
  }
  if (run.idempotencyKey !== canonicalIdempotencyKey(run.intent)) {
    throw new Error("idempotency_key_mismatch");
  }
  if (run.attempts.length === 0) {
    throw new Error("run_attempt_missing");
  }
  for (const [index, attempt] of run.attempts.entries()) {
    const sequence = index + 1;
    if (attempt.sequence !== sequence || attempt.id !== `attempt-${sequence}`) {
      throw new Error("attempt_sequence_mismatch");
    }
  }

  const latestAttempt = run.attempts.at(-1);
  if (latestAttempt === undefined) {
    throw new Error("run_attempt_missing");
  }
  if (run.completedArtifact === null) {
    if (run.status !== latestAttempt.status) {
      throw new Error("run_status_mismatch");
    }
    return;
  }
  const completedAttempt = run.attempts.find(
    (attempt) => attempt.id === run.completedArtifact?.attemptId,
  );
  if (
    run.status !== "completed"
    || completedAttempt?.status !== "completed"
    || completedAttempt.artifact === null
    || stableStringify(completedAttempt.artifact)
      !== stableStringify(run.completedArtifact)
  ) {
    throw new Error("completed_artifact_mismatch");
  }
}

function assertLineageIntegrity(
  run: RunProjection,
  eventsPath: string,
): void {
  const events = readLineageEvents(eventsPath);
  assertLineageEventsIntegrity(run, events);
}

function assertLineageEventsIntegrity(
  run: RunProjection,
  events: readonly StoredLineageEvent[],
): void {
  if (events.length !== run.lineage.eventCount) {
    throw new Error("lineage_event_count_mismatch");
  }
  const attemptIds = new Set(run.attempts.map((attempt) => attempt.id));
  let previousHash = GENESIS_HASH;
  for (const [index, event] of events.entries()) {
    const sequence = index + 1;
    if (event.sequence !== sequence || event.runId !== run.runId) {
      throw new Error("lineage_event_identity_mismatch");
    }
    if (event.attemptId !== null && !attemptIds.has(event.attemptId)) {
      throw new Error("lineage_attempt_mismatch");
    }
    if (event.prevHash !== previousHash) {
      throw new Error("lineage_prev_hash_mismatch");
    }
    const expectedHash = makeEvent({
      sequence: event.sequence,
      runId: event.runId,
      attemptId: event.attemptId,
      type: event.type,
      at: event.at,
      prevHash: event.prevHash,
      payload: event.payload,
    }).hash;
    if (event.hash !== expectedHash) {
      throw new Error("lineage_event_hash_mismatch");
    }
    previousHash = event.hash;
  }
  if (run.lineage.headHash !== previousHash) {
    throw new Error("lineage_head_hash_mismatch");
  }
}

function assertTailEventFollowsProjection(
  run: RunProjection,
  event: StoredLineageEvent,
): void {
  if (
    event.sequence !== run.lineage.eventCount + 1 ||
    event.runId !== run.runId ||
    event.prevHash !== run.lineage.headHash
  ) {
    throw new Error("lineage_tail_mismatch");
  }
  const expectedHash = makeEvent({
    sequence: event.sequence,
    runId: event.runId,
    attemptId: event.attemptId,
    type: event.type,
    at: event.at,
    prevHash: event.prevHash,
    payload: event.payload,
  }).hash;
  if (event.hash !== expectedHash) {
    throw new Error("lineage_event_hash_mismatch");
  }
}

function replayTailEvent(
  run: RunProjection,
  event: StoredLineageEvent,
): RunProjection | null {
  const activeAttempt = run.attempts[run.attempts.length - 1];
  if (activeAttempt === undefined) {
    throw new Error("run_attempt_missing");
  }
  let replayed: RunProjection | null = null;
  if (event.type === "dispatch_recorded") {
    const idempotencyKey = readPayloadString(event.payload, "idempotencyKey");
    if (
      activeAttempt.dispatches.some(
        (dispatch) => dispatch.idempotencyKey === idempotencyKey,
      )
    ) {
      throw new Error("dispatch_idempotency_key_already_recorded");
    }
    const accepted = readPayloadBoolean(event.payload, "accepted");
    const nextStatus = accepted ? "accepted" : "dispatching";
    const nextDispatch: DispatchRecord = {
      id: `dispatch-${activeAttempt.dispatches.length + 1}`,
      idempotencyKey,
      dispatchedAt: event.at,
      status: nextStatus,
      target: readPayloadNullableString(event.payload, "target"),
      receiptPath: readPayloadNullableString(event.payload, "receiptPath"),
    };
    replayed = updateAttempt(run, {
      ...activeAttempt,
      status: nextStatus,
      updatedAt: event.at,
      dispatches: [...activeAttempt.dispatches, nextDispatch],
    }, nextStatus, event.at);
  } else if (event.type === "dispatch_accepted") {
    const idempotencyKey = readPayloadString(event.payload, "idempotencyKey");
    let matchingIndex = -1;
    for (
      let index = activeAttempt.dispatches.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (activeAttempt.dispatches[index]?.idempotencyKey === idempotencyKey) {
        matchingIndex = index;
        break;
      }
    }
    if (matchingIndex < 0) {
      throw new Error("dispatch_not_recorded");
    }
    const dispatches = activeAttempt.dispatches.map((dispatch, index) =>
      index === matchingIndex
        ? {
            ...dispatch,
            status: "accepted" as const,
            target: readPayloadNullableString(event.payload, "target"),
            receiptPath: readPayloadNullableString(event.payload, "receiptPath"),
          }
        : dispatch
    );
    replayed = updateAttempt(run, {
      ...activeAttempt,
      status: "accepted",
      updatedAt: event.at,
      dispatches,
    }, "accepted", event.at);
  } else if (event.type === "attempt_running") {
    replayed = updateAttempt(run, {
      ...activeAttempt,
      status: "running",
      updatedAt: event.at,
    }, "running", event.at);
  } else if (event.type === "attempt_completed") {
    if (event.attemptId !== activeAttempt.id) {
      throw new Error("lineage_attempt_mismatch");
    }
    const artifact: CompletedArtifact = {
      path: readPayloadString(event.payload, "artifactPath"),
      hash: readPayloadString(event.payload, "artifactHash"),
      completedAt: event.at,
      attemptId: activeAttempt.id,
    };
    const completedAttempt: AttemptRecord = {
      ...activeAttempt,
      status: "completed",
      updatedAt: event.at,
      readback: {
        status: "found",
        runId: run.runId,
        attemptId: activeAttempt.id,
        artifactPath: artifact.path,
        artifactHash: artifact.hash,
      },
      artifact,
      failureReason: null,
    };
    const updated = updateAttempt(run, completedAttempt, "completed", event.at);
    replayed = {
      ...updated,
      completedArtifact: run.completedArtifact ?? artifact,
    };
  } else if (event.type === "attempt_failed") {
    if (run.completedArtifact !== null) {
      replayed = {
        ...run,
        status: "completed",
        updatedAt: event.at,
      };
    } else {
      replayed = updateAttempt(run, {
        ...activeAttempt,
        status: "failed",
        updatedAt: event.at,
        failureReason: readPayloadString(event.payload, "reason"),
      }, "failed", event.at);
    }
  } else if (event.type === "attempt_unknown_outcome") {
    const readback = readPayloadReadbackObservation(event.payload, "readback");
    const nextRunStatus = run.completedArtifact === null
      ? "unknown_outcome"
      : "completed";
    replayed = updateAttempt(run, {
      ...activeAttempt,
      status: "unknown_outcome",
      updatedAt: event.at,
      readback,
      failureReason: readPayloadString(event.payload, "reason"),
    }, nextRunStatus, event.at);
  } else if (event.type === "retry_attempt_created") {
    if (run.completedArtifact !== null) {
      throw new Error("completed_run_cannot_retry");
    }
    if (run.status !== "unknown_outcome") {
      throw new Error("retry_requires_unknown_outcome");
    }
    if (readPayloadString(event.payload, "readbackStatus") !== "not_found") {
      throw new Error("retry_requires_readback_not_found");
    }
    const nextSequence = run.attempts.length + 1;
    const retryAttempt: AttemptRecord = {
      id: `attempt-${nextSequence}`,
      sequence: nextSequence,
      status: "pending",
      createdAt: event.at,
      updatedAt: event.at,
      dispatches: [],
      readback: null,
      artifact: null,
      failureReason: null,
    };
    replayed = {
      ...run,
      status: "pending",
      updatedAt: event.at,
      attempts: [...run.attempts, retryAttempt],
    };
  }
  if (replayed === null) {
    return null;
  }
  return {
    ...replayed,
    lineage: {
      eventCount: event.sequence,
      headHash: event.hash,
    },
  };
}

function readPayloadString(
  payload: { readonly [key: string]: JsonValue },
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error(`invalid_event_payload:${key}`);
  }
  return value;
}

function readPayloadNullableString(
  payload: { readonly [key: string]: JsonValue },
  key: string,
): string | null {
  const value = payload[key];
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`invalid_event_payload:${key}`);
}

function readPayloadBoolean(
  payload: { readonly [key: string]: JsonValue },
  key: string,
): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw new Error(`invalid_event_payload:${key}`);
  }
  return value;
}

function readPayloadReadbackObservation(
  payload: { readonly [key: string]: JsonValue },
  key: string,
): ReadbackObservation {
  return parseReadbackObservation(payload[key]);
}

function runIdFromFingerprint(fingerprint: string): string {
  return `run-${fingerprint}`;
}

function tryCreateLeaseDir(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function makeLease(
  runId: string,
  owner: string,
  leaseTtlMs: number,
  now: string,
): RegistryLease {
  if (leaseTtlMs <= 0) {
    throw new Error("lease_ttl_must_be_positive");
  }
  const acquiredAtMs = Date.parse(now);
  if (!Number.isFinite(acquiredAtMs)) {
    throw new Error("invalid_now");
  }
  return {
    runId,
    owner,
    token: randomUUID(),
    acquiredAt: now,
    expiresAt: new Date(acquiredAtMs + leaseTtlMs).toISOString(),
  };
}

function isProvablyUnpublishedRunDir(runDir: string): boolean {
  return isProvablyUnpublishedRunDirEntry(runDir, "");
}

function isProvablyUnpublishedRunDirEntry(
  absolutePath: string,
  relativePath: string,
): boolean {
  const stat = statSync(absolutePath);
  if (!stat.isDirectory()) {
    if (relativePath === "events.jsonl") {
      return stat.size === 0;
    }
    return (
      relativePath === "lease/lease.json" ||
      relativePath.startsWith("lease/lease.json.tmp-")
    );
  }
  if (relativePath !== "" && relativePath !== "lease") {
    return false;
  }
  return readdirSync(absolutePath).every((name) => {
    const childRelativePath = relativePath === ""
      ? name
      : `${relativePath}/${name}`;
    return isProvablyUnpublishedRunDirEntry(
      join(absolutePath, name),
      childRelativePath,
    );
  });
}

function atomicWriteJson(path: string, value: JsonValue | RunProjection | LeaseFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${stableStringify(value)}\n`, "utf8");
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function parseRunProjection(value: unknown): RunProjection {
  if (!isRecord(value)) {
    throw new Error("invalid_run_projection");
  }
  const schemaVersion = readLiteral(value, "schemaVersion", 1);
  const runId = readString(value, "runId");
  const intentFingerprint = readString(value, "intentFingerprint");
  const idempotencyKey = readString(value, "idempotencyKey");
  const status = readRunStatus(value, "status");
  const createdAt = readString(value, "createdAt");
  const updatedAt = readString(value, "updatedAt");
  const intent = parseIntent(value.intent);
  const attempts = readArray(value, "attempts").map(parseAttempt);
  const completedArtifact = value.completedArtifact === null
    ? null
    : parseCompletedArtifact(value.completedArtifact);
  const lineage = parseLineage(value.lineage);
  return {
    schemaVersion,
    runId,
    intentFingerprint,
    idempotencyKey,
    status,
    createdAt,
    updatedAt,
    intent,
    attempts,
    completedArtifact,
    lineage,
  };
}

function parseIntent(value: unknown): CanonicalRunIntent {
  if (!isRecord(value)) {
    throw new Error("invalid_intent");
  }
  const intent: CanonicalRunIntent = {
    workflow: readString(value, "workflow"),
    projectDir: readString(value, "projectDir"),
    task: readString(value, "task"),
    source: parseSourceLineage(value.source),
    inputs: value.inputs === undefined
      ? undefined
      : parseJsonObject(value.inputs),
    availabilitySnapshotId: readOptionalString(value, "availabilitySnapshotId"),
    routingDecisionVersion: readOptionalString(value, "routingDecisionVersion"),
    decisionVersion: readOptionalString(value, "decisionVersion"),
  };
  return intent;
}

function parseSourceLineage(value: unknown): SourceLineage {
  if (!isRecord(value)) {
    throw new Error("invalid_source_lineage");
  }
  return {
    taskId: readString(value, "taskId"),
    runId: readString(value, "runId"),
    workspace: readString(value, "workspace"),
    tabId: readString(value, "tabId"),
    paneId: readString(value, "paneId"),
  };
}

function parseAttempt(value: unknown): AttemptRecord {
  if (!isRecord(value)) {
    throw new Error("invalid_attempt");
  }
  return {
    id: readString(value, "id"),
    sequence: readNumber(value, "sequence"),
    status: readRunStatus(value, "status"),
    createdAt: readString(value, "createdAt"),
    updatedAt: readString(value, "updatedAt"),
    dispatches: readArray(value, "dispatches").map(parseDispatch),
    readback: value.readback === null
      ? null
      : parseReadbackObservation(value.readback),
    artifact: value.artifact === null
      ? null
      : parseCompletedArtifact(value.artifact),
    failureReason: value.failureReason === null
      ? null
      : readString(value, "failureReason"),
  };
}

function parseDispatch(value: unknown): DispatchRecord {
  if (!isRecord(value)) {
    throw new Error("invalid_dispatch");
  }
  const status = readString(value, "status");
  if (status !== "dispatching" && status !== "accepted") {
    throw new Error("invalid_dispatch_status");
  }
  return {
    id: readString(value, "id"),
    idempotencyKey: readString(value, "idempotencyKey"),
    dispatchedAt: readString(value, "dispatchedAt"),
    status,
    target: value.target === null ? null : readString(value, "target"),
    receiptPath: value.receiptPath === null ? null : readString(value, "receiptPath"),
  };
}

function parseReadbackObservation(value: unknown): ReadbackObservation {
  if (!isRecord(value)) {
    throw new Error("invalid_readback");
  }
  const status = readString(value, "status");
  if (status === "found") {
    return {
      status,
      runId: readString(value, "runId"),
      attemptId: readString(value, "attemptId"),
      artifactPath: readString(value, "artifactPath"),
      artifactHash: readString(value, "artifactHash"),
    };
  }
  if (status === "not_found" || status === "mismatch") {
    return {
      status,
      checkedAt: readString(value, "checkedAt"),
      reason: readString(value, "reason"),
    };
  }
  throw new Error("invalid_readback_status");
}

function parseCompletedArtifact(value: unknown): CompletedArtifact {
  if (!isRecord(value)) {
    throw new Error("invalid_completed_artifact");
  }
  return {
    path: readString(value, "path"),
    hash: readString(value, "hash"),
    completedAt: readString(value, "completedAt"),
    attemptId: readString(value, "attemptId"),
  };
}

function parseLineage(value: unknown): RunProjection["lineage"] {
  if (!isRecord(value)) {
    throw new Error("invalid_lineage");
  }
  return {
    eventCount: readNumber(value, "eventCount"),
    headHash: readString(value, "headHash"),
  };
}

function parseLeaseFile(value: unknown): LeaseFile {
  if (!isRecord(value)) {
    throw new Error("invalid_lease");
  }
  return {
    schemaVersion: readLiteral(value, "schemaVersion", 1),
    runId: readString(value, "runId"),
    owner: readString(value, "owner"),
    token: readString(value, "token"),
    acquiredAt: readString(value, "acquiredAt"),
    expiresAt: readString(value, "expiresAt"),
  };
}

function parseLineageEvent(value: unknown): StoredLineageEvent {
  if (!isRecord(value)) {
    throw new Error("invalid_lineage_event");
  }
  return {
    schemaVersion: readLiteral(value, "schemaVersion", 1),
    sequence: readNumber(value, "sequence"),
    runId: readString(value, "runId"),
    attemptId: value.attemptId === null ? null : readString(value, "attemptId"),
    type: readString(value, "type"),
    at: readString(value, "at"),
    prevHash: readString(value, "prevHash"),
    payload: parseJsonObject(value.payload),
    hash: readString(value, "hash"),
  };
}

function parseJsonObject(value: unknown): { readonly [key: string]: JsonValue } {
  if (!isRecord(value)) {
    throw new Error("invalid_json_object");
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = parseJsonValue(item);
  }
  return output;
}

function parseJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(parseJsonValue);
  }
  return parseJsonObject(value);
}

function readRunStatus(
  value: Record<string, unknown>,
  key: string,
): RunStatus {
  const status = readString(value, key);
  if (
    status === "pending" ||
    status === "dispatching" ||
    status === "accepted" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "unknown_outcome"
  ) {
    return status;
  }
  throw new Error("invalid_run_status");
}

function readArray(
  value: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const item = value[key];
  if (!Array.isArray(item)) {
    throw new Error(`invalid_array:${key}`);
  }
  return item;
}

function readString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") {
    throw new Error(`invalid_string:${key}`);
  }
  return item;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key];
  if (item === undefined) {
    return undefined;
  }
  if (typeof item !== "string") {
    throw new Error(`invalid_string:${key}`);
  }
  return item;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (typeof item !== "number") {
    throw new Error(`invalid_number:${key}`);
  }
  return item;
}

function readLiteral<T extends string | number | boolean>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (value[key] !== expected) {
    throw new Error(`invalid_literal:${key}`);
  }
  return expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
