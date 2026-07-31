import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  assertDecisionReadyReport,
  assertWorkflowDecisionEnvelope,
  type AvailabilitySnapshot,
  type DecisionReadyReport,
  type RoleAssignment,
  type RoutingDecision,
  type SourceLineage,
  type WorkflowDecisionEnvelope,
} from "../contracts/index.ts";
import {
  workflowDispatchIdempotencyKey,
} from "../authority/firstmate-decisions.ts";
import {
  isFirstmateDecisionReceipt,
  resolveFirstmateAuthorityRoot,
  verifyFirstmateDecisionReceipt,
  type FirstmateDecisionReceipt,
} from "../authority/firstmate-decision-authority.ts";
import {
  FileFirstmateWorkflowAuthority,
  type FirstmateWorkflowAuthorityPort,
} from "../authority/firstmate-workflow-authority.ts";
import {
  FileRunRegistry,
  type RegistryLease,
  type ReadbackObservation,
  type RunProjection,
} from "../runtime/run-registry.ts";
import {
  readModelDispatchReceipt,
  type ModelDispatchIdentity,
} from "../runtime/model-dispatch-receipt.ts";
import {
  composeHighIntensityReport,
  partitionRecallFirstResearch,
  reviewCoverage,
  runAdversarialReview,
  type AdversarialReviewResult,
  type AdversarialRound,
  type CoverageReview,
  type DiscoveryObservation,
  type HighIntensityInput,
  type JudgeRoundDecision,
  type ResearchPartition,
} from "../workflows/high-intensity.ts";

export type HighIntensityRunStatus = "blocked" | "completed";
export type HighIntensityCallPhase =
  | "research"
  | "author"
  | "challenger"
  | "judge";

export interface HighIntensityModelRequest {
  readonly assignment: RoleAssignment;
  readonly prompt: string;
  readonly contextId: string;
  readonly phase: HighIntensityCallPhase;
  readonly round: number | null;
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly stageId: HighIntensityCallPhase;
  readonly idempotencyKey: string;
}

export interface HighIntensityModelResult {
  readonly rawOutput: string;
  readonly alias: string;
  readonly family: string;
  readonly model: string;
  readonly receiptPath: string;
}

export type HighIntensityModelReadback =
  | {
      readonly status: "found";
      readonly result: HighIntensityModelResult;
    }
  | Extract<
      ReadbackObservation,
      { readonly status: "not_found" | "mismatch" }
    >;

export interface HighIntensityModelPort {
  readonly execute: (
    request: HighIntensityModelRequest,
  ) => Promise<HighIntensityModelResult>;
  readonly readBack: (
    request: HighIntensityModelRequest,
  ) => Promise<HighIntensityModelReadback>;
}

export interface HighIntensityCallRecord {
  readonly phase: HighIntensityCallPhase;
  readonly round: number | null;
  readonly contextId: string;
  readonly alias: string;
  readonly family: string;
  readonly model: string;
  readonly prompt: string;
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly idempotencyKey: string;
  readonly receiptPath: string;
}

export interface HighIntensityRunRecord {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: HighIntensityRunStatus;
  readonly input: HighIntensityInput;
  readonly inputHash: string;
  readonly availability: AvailabilitySnapshot;
  readonly routingDecision: RoutingDecision | null;
  readonly workflowDecision: WorkflowDecisionEnvelope | null;
  readonly workflowDecisionReceipt: FirstmateDecisionReceipt | null;
  readonly calls: readonly HighIntensityCallRecord[];
  readonly research: ResearchPartition | null;
  readonly coverage: CoverageReview | null;
  readonly adversarial: AdversarialReviewResult | null;
  readonly report: DecisionReadyReport | null;
  readonly blockers: readonly string[];
  readonly authority: {
    readonly workflowAuthority: "unverified" | "firstmate_verified";
    readonly runtimeAuthority:
      | "unverified"
      | "canonical_run_registry_verified";
    readonly canonicalRunId: string | null;
    readonly idempotencyKey: string | null;
  };
  readonly recordPath: string;
}

export interface HighIntensityRunOptions {
  readonly input: HighIntensityInput;
  readonly availability: AvailabilitySnapshot;
  readonly stateDir: string;
  readonly projectDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly modelPort: HighIntensityModelPort;
  readonly recipe?: "adversarial" | "research";
  readonly source?: SourceLineage;
  readonly now?: () => string;
  readonly workflowAuthority?: FirstmateWorkflowAuthorityPort;
}

export interface HighIntensityRunResult {
  readonly ok: boolean;
  readonly record: HighIntensityRunRecord;
  readonly dedupeStatus:
    | "new"
    | "reconciled"
    | "coalesced_active"
    | "coalesced_completed"
    | "reconciliation_required";
}

interface AuthorDocument {
  readonly claim: string;
}

interface ChallengerDocument {
  readonly counterexample: string;
}

interface ResearchDocument {
  readonly observations: readonly DiscoveryObservation[];
}

export async function createHighIntensityRun(
  options: HighIntensityRunOptions,
): Promise<HighIntensityRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const stateDir = resolve(options.stateDir);
  const trustedAuthorityRoot = resolveFirstmateAuthorityRoot(
    stateDir,
    options.env,
  );
  const provisionalId =
    `high-intensity-invalid-${compactTimestamp(createdAt)}-${randomUUID()}`;
  const provisional: HighIntensityRunRecord = {
    schemaVersion: 2,
    id: provisionalId,
    createdAt,
    updatedAt: createdAt,
    status: "blocked",
    input: options.input,
    inputHash: inputHash(options.input),
    availability: options.availability,
    routingDecision: null,
    workflowDecision: null,
    workflowDecisionReceipt: null,
    calls: [],
    research: null,
    coverage: null,
    adversarial: null,
    report: null,
    blockers: [],
    authority: {
      workflowAuthority: "unverified",
      runtimeAuthority: "unverified",
      canonicalRunId: null,
      idempotencyKey: null,
    },
    recordPath: join(
      stateDir,
      "high-intensity-runs",
      `${provisionalId}.json`,
    ),
  };

  const recipe = options.recipe ?? "adversarial";
  const source = options.source;
  if (!isCompleteSourceLineage(source)) {
    return blocked(provisional, now, "source_lineage_incomplete");
  }
  const workflowAuthority =
    options.workflowAuthority
    ?? new FileFirstmateWorkflowAuthority({
      stateDir,
      env: options.env,
      now,
    });
  const decided = workflowAuthority.decideHighIntensity({
    workflowInput: options.input,
    availability: options.availability,
    source,
    recipe,
  });
  if (decided.status !== "resolved") {
    return blocked(
      {
        ...provisional,
        routingDecision: decided.routingDecision,
      },
      now,
      decided.reason,
    );
  }
  const routingDecision = decided.routingDecision;
  const workflowDecision = decided.workflowDecision;
  const workflowDecisionReceipt = decided.receipt;
  const registry = new FileRunRegistry({
    rootDir: join(stateDir, "run-registry"),
  });
  const opened = registry.openOrCreateRun({
    intent: {
      workflow: recipe,
      projectDir: resolve(options.projectDir ?? stateDir),
      task: normalizeText(options.input.task),
      source,
      inputs: {
        subquestions: options.input.subquestions.map(normalizeText),
        recipe,
      },
      availabilitySnapshotId: options.availability.id,
      routingDecisionVersion: routingDecision.requestKey,
      decisionVersion: workflowDecision.workflowDecisionId,
    },
    owner: `high-intensity:${process.pid}:${randomUUID()}`,
    leaseTtlMs: 900_000,
    now: createdAt,
  });
  const id = `high-intensity-${opened.run.runId.slice(4)}`;
  const recordPath = join(stateDir, "high-intensity-runs", `${id}.json`);
  const base: HighIntensityRunRecord = {
    ...provisional,
    id,
    routingDecision,
    workflowDecision,
    workflowDecisionReceipt,
    recordPath,
    authority: {
      workflowAuthority: "firstmate_verified",
      runtimeAuthority: "canonical_run_registry_verified",
      canonicalRunId: opened.run.runId,
      idempotencyKey: opened.run.idempotencyKey,
    },
  };

  let lease: RegistryLease | null = null;
  if (opened.kind !== "created") {
    const existing = readHighIntensityRunRecord(
      recordPath,
      trustedAuthorityRoot,
    );
    if (
      opened.kind === "coalesced_completed"
      && existing !== undefined
      && opened.run.completedArtifact?.path === recordPath
      && opened.run.completedArtifact.hash === fileSha256(recordPath)
    ) {
      return {
        ok: existing.status === "completed",
        record: existing,
        dedupeStatus: "coalesced_completed",
      };
    }
    if (
      opened.kind !== "opened"
      || (
        opened.run.status !== "unknown_outcome"
        && opened.run.status !== "pending"
        && opened.run.status !== "dispatching"
        && opened.run.status !== "accepted"
        && opened.run.status !== "running"
      )
    ) {
      return {
        ok: false,
        record: existing ?? {
          ...base,
          blockers: [
            opened.kind === "coalesced_active"
              ? "canonical_run_active"
              : "canonical_run_requires_reconciliation",
          ],
        },
        dedupeStatus:
          opened.kind === "coalesced_active"
            ? "coalesced_active"
            : "reconciliation_required",
      };
    }
    lease = registry.acquireRunLease({
      runId: opened.run.runId,
      owner: `high-intensity-reconcile:${process.pid}:${randomUUID()}`,
      leaseTtlMs: 900_000,
      now: createdAt,
    });
    if (lease === null) {
      return {
        ok: false,
        record: existing ?? base,
        dedupeStatus: "coalesced_active",
      };
    }
    if (opened.run.status !== "unknown_outcome") {
      registry.markUnknownOutcome(lease, {
        reason: "stale_lease_requires_downstream_readback",
        readback: {
          status: "mismatch",
          checkedAt: now(),
          reason: "previous_owner_lease_expired",
        },
        now: now(),
      });
    }
  } else {
    lease = opened.lease;
    writeHighIntensityRunRecord(base, trustedAuthorityRoot);
  }

  if (lease === null) throw new Error("registry_lease_missing");
  const stageAssignment = (stageId: HighIntensityCallPhase): RoleAssignment =>
    workflowAuthority.authorizeStage({
      workflowDecision,
      receipt: workflowDecisionReceipt,
      stageId,
    }).roleAssignment;
  const calls: HighIntensityCallRecord[] = [];
  try {
    const researchResult = await executeModel({
      port: options.modelPort,
      assignment: stageAssignment("research"),
      prompt: buildResearchPrompt(options.input),
      contextId: `${id}:research`,
      phase: "research",
      round: null,
      calls,
      registry,
      lease,
      run: opened.run,
      workflowDecision,
      now,
    });
    if (!researchResult.ok) {
      return blockedRegistered(
        { ...base, calls },
        now,
        researchResult.reason,
        registry,
        lease,
        researchResult.registryStatus,
      );
    }
    const researchDocument = parseResearchDocument(researchResult.rawOutput);
    if (!researchDocument) {
      return blockedRegistered(
        { ...base, calls },
        now,
        "research_json_invalid",
        registry,
        lease,
        "failed",
      );
    }
    const research = partitionRecallFirstResearch(
      researchDocument.observations,
    );
    const coverage = reviewCoverage(options.input.subquestions, research);

    const rounds: AdversarialRound[] = [];
    for (const round of [1, 2]) {
      const authorResult = await executeModel({
        port: options.modelPort,
        assignment: stageAssignment("author"),
        prompt: buildAuthorPrompt(options.input, research, coverage, round),
        contextId: `${id}:round-${round}:author`,
        phase: "author",
        round,
        calls,
        registry,
        lease,
        run: opened.run,
        workflowDecision,
        now,
      });
      if (!authorResult.ok) {
        return blockedRegistered(
          { ...base, calls, research, coverage },
          now,
          authorResult.reason,
          registry,
          lease,
          authorResult.registryStatus,
        );
      }
      const authorDocument = parseAuthorDocument(authorResult.rawOutput);
      if (!authorDocument) {
        return blockedRegistered(
          { ...base, calls, research, coverage },
          now,
          "author_json_invalid",
          registry,
          lease,
          "failed",
        );
      }

      const challengerResult = await executeModel({
        port: options.modelPort,
        assignment: stageAssignment("challenger"),
        prompt: buildChallengerPrompt(
          options.input,
          research,
          coverage,
          round,
          authorDocument.claim,
        ),
        contextId: `${id}:round-${round}:challenger`,
        phase: "challenger",
        round,
        calls,
        registry,
        lease,
        run: opened.run,
        workflowDecision,
        now,
      });
      if (!challengerResult.ok) {
        return blockedRegistered(
          { ...base, calls, research, coverage },
          now,
          challengerResult.reason,
          registry,
          lease,
          challengerResult.registryStatus,
        );
      }
      const challengerDocument = parseChallengerDocument(
        challengerResult.rawOutput,
      );
      if (!challengerDocument) {
        return blockedRegistered(
          { ...base, calls, research, coverage },
          now,
          "challenger_json_invalid",
          registry,
          lease,
          "failed",
        );
      }

      const judgeResult = await executeModel({
        port: options.modelPort,
        assignment: stageAssignment("judge"),
        prompt: buildJudgePrompt(
          options.input,
          research,
          coverage,
          round,
          authorDocument.claim,
          challengerDocument.counterexample,
        ),
        contextId: `${id}:round-${round}:judge`,
        phase: "judge",
        round,
        calls,
        registry,
        lease,
        run: opened.run,
        workflowDecision,
        now,
      });
      if (!judgeResult.ok) {
        return blockedRegistered(
          { ...base, calls, research, coverage },
          now,
          judgeResult.reason,
          registry,
          lease,
          judgeResult.registryStatus,
        );
      }
      const judgeDocument = parseJudgeDocument(judgeResult.rawOutput);
      if (!judgeDocument) {
        return blockedRegistered(
          { ...base, calls, research, coverage },
          now,
          "judge_json_invalid",
          registry,
          lease,
          "failed",
        );
      }

      rounds.push({
        round,
        authorClaim: authorDocument.claim,
        challengerCounterexample: challengerDocument.counterexample,
        judge: judgeDocument,
      });
      if (judgeDocument.accepted) break;
    }

    let adversarial: AdversarialReviewResult;
    try {
      adversarial = runAdversarialReview(rounds, 2);
    } catch (error) {
      return blockedRegistered(
        { ...base, calls, research, coverage },
        now,
        error instanceof Error
          ? error.message
          : "adversarial_round_invalid",
        registry,
        lease,
        "failed",
      );
    }

    const reportAssignment = workflowAuthority.authorizeStage({
      workflowDecision,
      receipt: workflowDecisionReceipt,
      stageId: "report",
    }).roleAssignment;
    if (
      reportAssignment.role !== "report_composer"
      || reportAssignment.provider !== "firstmate"
    ) {
      return blockedRegistered(
        { ...base, calls, research, coverage, adversarial },
        now,
        "report_composer_assignment_invalid",
        registry,
        lease,
        "failed",
      );
    }
    const composed = composeHighIntensityReport({
      input: options.input,
      routingDecision,
      availability: options.availability,
      research,
      coverage,
      adversarial,
    });
    const report: DecisionReadyReport = {
      ...composed,
      evidenceLayer: {
        ...composed.evidenceLayer,
        lineage: [
          `workflow_decision:${workflowDecision.workflowDecisionId}`,
          `decision_hash:${workflowDecision.decisionHash}`,
          `report_composer:${reportAssignment.alias}:${reportAssignment.resolvedModel}`,
          ...composed.evidenceLayer.lineage,
        ],
      },
    };
    try {
      assertDecisionReadyReport(report);
    } catch (error) {
      return blockedRegistered(
        { ...base, calls, research, coverage, adversarial, report },
        now,
        error instanceof Error ? error.message : "report_contract_invalid",
        registry,
        lease,
        "failed",
      );
    }

    const record = writeHighIntensityRunRecord({
      ...base,
      updatedAt: now(),
      status: "completed",
      calls,
      research,
      coverage,
      adversarial,
      report,
    }, trustedAuthorityRoot);
    registry.completeAttempt(lease, {
      readback: {
        status: "found",
        runId: opened.run.runId,
        attemptId: activeAttemptId(
          registry.readRun(opened.run.runId) ?? opened.run,
        ),
        artifactPath: record.recordPath,
        artifactHash: fileSha256(record.recordPath),
      },
      now: now(),
    });
    return {
      ok: true,
      record,
      dedupeStatus: opened.kind === "created" ? "new" : "reconciled",
    };
  } finally {
    releaseLeaseIfHeld(registry, lease);
  }
}

export function readHighIntensityRunRecord(
  path: string,
  trustedAuthorityRoot = inferFirstmateAuthorityRootFromRecordPath(path),
): HighIntensityRunRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHighIntensityRunRecord(value, path, trustedAuthorityRoot)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function executeModel(options: {
  readonly port: HighIntensityModelPort;
  readonly assignment: RoleAssignment;
  readonly prompt: string;
  readonly contextId: string;
  readonly phase: HighIntensityCallPhase;
  readonly round: number | null;
  readonly calls: HighIntensityCallRecord[];
  readonly registry: FileRunRegistry;
  readonly lease: RegistryLease;
  readonly run: RunProjection;
  readonly workflowDecision: WorkflowDecisionEnvelope;
  readonly now: () => string;
}): Promise<
  | { readonly ok: true; readonly rawOutput: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly registryStatus: "failed" | "unknown_outcome";
    }
> {
  const idempotencyKey = workflowDispatchIdempotencyKey(
    options.run.runId,
    options.workflowDecision.decisionHash,
    options.phase,
    options.round,
  );
  const request: HighIntensityModelRequest = {
    assignment: options.assignment,
    prompt: options.prompt,
    contextId: options.contextId,
    phase: options.phase,
    round: options.round,
    workflowDecisionId: options.workflowDecision.workflowDecisionId,
    decisionHash: options.workflowDecision.decisionHash,
    stageId: options.phase,
    idempotencyKey,
  };
  const current = options.registry.readRun(options.run.runId);
  if (current === null) {
    throw new Error("canonical_run_missing_during_dispatch");
  }
  const existingDispatch = current.attempts.at(-1)?.dispatches.find(
    (dispatch) => dispatch.idempotencyKey === idempotencyKey,
  );
  let result: HighIntensityModelResult;
  if (existingDispatch !== undefined) {
    let readback: HighIntensityModelReadback;
    try {
      readback = await options.port.readBack(request);
    } catch {
      return markModelUnknownOutcome(
        options,
        `model_readback_unknown_outcome:${options.phase}`,
        {
          status: "mismatch",
          checkedAt: options.now(),
          reason: "adapter_readback_threw_without_verified_observation",
        },
      );
    }
    if (readback.status === "found") {
      result = readback.result;
    } else if (readback.status === "not_found") {
      const beforeRetry = options.registry.readRun(options.run.runId);
      if (beforeRetry?.status !== "unknown_outcome") {
        options.registry.markUnknownOutcome(options.lease, {
          reason: `model_readback_not_found:${options.phase}`,
          readback,
          now: options.now(),
        });
      }
      options.registry.requestRetryAfterReadbackNotFound(options.lease, {
        readback,
        now: options.now(),
      });
      options.registry.recordDispatch(options.lease, {
        idempotencyKey,
        target: options.assignment.alias,
        receiptPath: null,
        accepted: false,
        now: options.now(),
      });
      try {
        result = await options.port.execute(request);
      } catch {
        return markModelUnknownOutcome(
          options,
          `model_execution_unknown_outcome:${options.phase}`,
          {
            status: "mismatch",
            checkedAt: options.now(),
            reason: "adapter_execute_returned_without_verified_readback",
          },
        );
      }
    } else {
      return markModelUnknownOutcome(
        options,
        `model_readback_mismatch:${options.phase}`,
        readback,
      );
    }
  } else {
    options.registry.recordDispatch(options.lease, {
      idempotencyKey,
      target: options.assignment.alias,
      receiptPath: null,
      accepted: false,
      now: options.now(),
    });
    try {
      result = await options.port.execute(request);
    } catch {
      return markModelUnknownOutcome(
        options,
        `model_execution_unknown_outcome:${options.phase}`,
        {
          status: "mismatch",
          checkedAt: options.now(),
          reason: "dispatch_threw_before_verified_downstream_readback",
        },
      );
    }
  }
  if (
    result.alias !== options.assignment.alias ||
    result.family !== options.assignment.family ||
    result.model !== options.assignment.resolvedModel
  ) {
    return markModelUnknownOutcome(
      options,
      `provenance_mismatch:${options.phase}`,
      {
        status: "mismatch",
        checkedAt: options.now(),
        reason: "model_returned_with_unverified_assignment_provenance",
      },
    );
  }
  const receiptIdentity: ModelDispatchIdentity = {
    idempotencyKey,
    workflowDecisionId: options.workflowDecision.workflowDecisionId,
    decisionHash: options.workflowDecision.decisionHash,
    stageId: options.phase,
    assignment: options.assignment,
  };
  const receiptReadback = readModelDispatchReceipt(
    result.receiptPath,
    receiptIdentity,
  );
  if (
    receiptReadback === undefined
    || receiptReadback.rawOutput !== result.rawOutput
  ) {
    return markModelUnknownOutcome(
      options,
      `model_receipt_readback_failed:${options.phase}`,
      {
        status: "mismatch",
        checkedAt: options.now(),
        reason: "model_returned_without_matching_durable_receipt",
      },
    );
  }
  options.registry.acceptDispatch(options.lease, {
    idempotencyKey,
    target: `${result.family}:${result.model}`,
    receiptPath: result.receiptPath,
    now: options.now(),
  });
  options.registry.markRunning(options.lease, { now: options.now() });
  options.calls.push({
    phase: options.phase,
    round: options.round,
    contextId: options.contextId,
    alias: result.alias,
    family: result.family,
    model: result.model,
    prompt: options.prompt,
    workflowDecisionId: options.workflowDecision.workflowDecisionId,
    decisionHash: options.workflowDecision.decisionHash,
    idempotencyKey,
    receiptPath: result.receiptPath,
  });
  return { ok: true, rawOutput: result.rawOutput };
}

function markModelUnknownOutcome(
  options: {
    readonly registry: FileRunRegistry;
    readonly lease: RegistryLease;
    readonly now: () => string;
  },
  reason: string,
  readback: Extract<
    ReadbackObservation,
    { readonly status: "not_found" | "mismatch" }
  >,
): {
  readonly ok: false;
  readonly reason: string;
  readonly registryStatus: "unknown_outcome";
} {
  const checkedAt = options.now();
  options.registry.markUnknownOutcome(options.lease, {
    reason,
    readback,
    now: checkedAt,
  });
  return {
    ok: false,
    reason,
    registryStatus: "unknown_outcome",
  };
}

function buildResearchPrompt(input: HighIntensityInput): string {
  return [
    "你是高強度工作流的 research discovery executor。",
    "只輸出 JSON，不要 Markdown。",
    'Schema: {"observations":[{"id":"string","subquestion":"string","statement":"string","category":"confirmed|candidate|inference|unknown","sourceIds":["string"],"lineage":["string"],"counterexample":false,"limitation":null}]}',
    `Task: ${input.task}`,
    `Subquestions: ${JSON.stringify(input.subquestions)}`,
    "Preserve the full discovery denominator; do not collapse categories.",
  ].join("\n");
}

function buildAuthorPrompt(
  input: HighIntensityInput,
  research: ResearchPartition,
  coverage: CoverageReview,
  round: number,
): string {
  return [
    `Context: high-intensity-round-${round}:author`,
    "只輸出 JSON。",
    'Schema: {"claim":"string"}',
    `Task: ${input.task}`,
    `Evidence: ${researchSummary(research)}`,
    `Coverage: ${JSON.stringify(coverage.mappings)}`,
  ].join("\n");
}

function buildChallengerPrompt(
  input: HighIntensityInput,
  research: ResearchPartition,
  coverage: CoverageReview,
  round: number,
  claim: string,
): string {
  return [
    `Context: high-intensity-round-${round}:challenger`,
    "只輸出 JSON。",
    'Schema: {"counterexample":"string"}',
    `Task: ${input.task}`,
    `Evidence: ${researchSummary(research)}`,
    `Coverage: ${JSON.stringify(coverage.mappings)}`,
    `Current claim: ${claim}`,
  ].join("\n");
}

function buildJudgePrompt(
  input: HighIntensityInput,
  research: ResearchPartition,
  coverage: CoverageReview,
  round: number,
  claim: string,
  counterexample: string,
): string {
  return [
    `Context: high-intensity-round-${round}:judge`,
    "只輸出 JSON。",
    'Schema: {"accepted":boolean,"acceptedReasons":["string"],"rejectedReasons":["string"]}',
    "Judge context is intentionally limited to task, evidence, current claim, and current counterexample.",
    `Task: ${input.task}`,
    `Evidence: ${researchSummary(research)}`,
    `Coverage: ${JSON.stringify(coverage.mappings)}`,
    `Current claim: ${claim}`,
    `Current counterexample: ${counterexample}`,
  ].join("\n");
}

function researchSummary(research: ResearchPartition): string {
  return JSON.stringify({
    denominator: research.discoveryDenominator.map((item) => ({
      id: item.id,
      subquestion: item.subquestion,
      statement: item.statement,
      category: item.category,
      sourceIds: item.sourceIds,
      lineage: item.lineage,
    })),
  });
}

function parseResearchDocument(rawOutput: string): ResearchDocument | null {
  const record = parseObject(rawOutput);
  if (!record) return null;
  const values = record.observations;
  if (!Array.isArray(values)) return null;
  const observations: DiscoveryObservation[] = [];
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const item = value as Record<string, unknown>;
    const id = readString(item.id, 120);
    const subquestion = readString(item.subquestion, 500);
    const statement = readString(item.statement, 1_200);
    const category = readCategory(item.category);
    const sourceIds = readStringArray(item.sourceIds, 240);
    const lineage = readStringArray(item.lineage, 500);
    if (!id || !subquestion || !statement || !category || !sourceIds || !lineage) {
      return null;
    }
    observations.push({
      id,
      subquestion,
      statement,
      category,
      sourceIds,
      lineage,
      counterexample: item.counterexample === true,
      limitation: typeof item.limitation === "string" ? item.limitation : undefined,
    });
  }
  return { observations };
}

function parseAuthorDocument(rawOutput: string): AuthorDocument | null {
  const record = parseObject(rawOutput);
  const claim = record ? readString(record.claim, 2_000) : null;
  return claim ? { claim } : null;
}

function parseChallengerDocument(rawOutput: string): ChallengerDocument | null {
  const record = parseObject(rawOutput);
  const counterexample = record ? readString(record.counterexample, 2_000) : null;
  return counterexample ? { counterexample } : null;
}

function parseJudgeDocument(rawOutput: string): JudgeRoundDecision | null {
  const record = parseObject(rawOutput);
  if (!record || typeof record.accepted !== "boolean") return null;
  const acceptedReasons = readStringArray(record.acceptedReasons, 500);
  const rejectedReasons = readStringArray(record.rejectedReasons, 500);
  if (!acceptedReasons || !rejectedReasons) return null;
  if (record.accepted && acceptedReasons.length === 0) return null;
  if (!record.accepted && rejectedReasons.length === 0) return null;
  return {
    accepted: record.accepted,
    acceptedReasons,
    rejectedReasons,
  };
}

function parseObject(rawOutput: string): Record<string, unknown> | null {
  const start = rawOutput.indexOf("{");
  const end = rawOutput.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(rawOutput.slice(start, end + 1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function readStringArray(
  value: unknown,
  maxItemLength: number,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    const text = readString(item, maxItemLength);
    if (!text) return null;
    result.push(text);
  }
  return result;
}

function readCategory(value: unknown): DiscoveryObservation["category"] | null {
  return value === "confirmed" ||
    value === "candidate" ||
    value === "inference" ||
    value === "unknown"
    ? value
    : null;
}

function blocked(
  record: HighIntensityRunRecord,
  now: () => string,
  blocker: string,
): HighIntensityRunResult {
  return {
    ok: false,
    record: writeHighIntensityRunRecord({
      ...record,
      updatedAt: now(),
      status: "blocked",
      blockers: [...record.blockers, blocker],
    }),
    dedupeStatus: "new",
  };
}

function blockedRegistered(
  record: HighIntensityRunRecord,
  now: () => string,
  blocker: string,
  registry: FileRunRegistry,
  lease: RegistryLease,
  registryStatus: "failed" | "unknown_outcome",
): HighIntensityRunResult {
  if (registryStatus === "failed") {
    registry.failAttempt(lease, { reason: blocker, now: now() });
  }
  return blocked(record, now, blocker);
}

function writeHighIntensityRunRecord(
  record: HighIntensityRunRecord,
  trustedAuthorityRoot = inferFirstmateAuthorityRootFromRecordPath(
    record.recordPath,
  ),
): HighIntensityRunRecord {
  mkdirSync(dirname(record.recordPath), { recursive: true });
  const temporary = `${record.recordPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, record.recordPath);
  const readBack = readHighIntensityRunRecord(
    record.recordPath,
    trustedAuthorityRoot,
  );
  if (
    readBack === undefined
    || JSON.stringify(readBack) !== JSON.stringify(record)
  ) {
    throw new Error("high_intensity_record_readback_failed");
  }
  return readBack;
}

function isHighIntensityRunRecord(
  value: unknown,
  expectedPath: string,
  trustedAuthorityRoot: string,
): value is HighIntensityRunRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 2
    || typeof record.id !== "string"
    || !record.id.startsWith("high-intensity-")
    || (record.status !== "blocked" && record.status !== "completed")
    || typeof record.recordPath !== "string"
    || resolve(record.recordPath) !== resolve(expectedPath)
    || basename(record.recordPath) !== `${record.id}.json`
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || !isHighIntensityInput(record.input)
    || typeof record.inputHash !== "string"
    || record.inputHash !== inputHash(record.input)
    || !isAvailabilitySnapshot(record.availability)
    || !Array.isArray(record.calls)
    || !record.calls.every(isHighIntensityCallRecord)
    || !Array.isArray(record.blockers)
    || !record.blockers.every((item) => typeof item === "string")
    || !isAuthorityRecord(record.authority)
  ) {
    return false;
  }
  if (record.workflowDecision !== null) {
    try {
      assertWorkflowDecisionEnvelope(record.workflowDecision);
    } catch {
      return false;
    }
    if (
      !isFirstmateDecisionReceipt(record.workflowDecisionReceipt)
      || !verifyFirstmateDecisionReceipt(
        record.workflowDecision,
        record.workflowDecisionReceipt,
        trustedAuthorityRoot,
      )
      || record.authority.workflowAuthority !== "firstmate_verified"
    ) {
      return false;
    }
  } else if (
    record.workflowDecisionReceipt !== null
    || (
      isAuthorityRecord(record.authority)
      && record.authority.workflowAuthority !== "unverified"
    )
  ) {
    return false;
  }
  if (record.status === "completed") {
    if (
      record.routingDecision === null
      || record.workflowDecision === null
      || record.research === null
      || record.coverage === null
      || record.adversarial === null
      || !isDecisionReadyReportCandidate(record.report)
    ) {
      return false;
    }
    try {
      assertDecisionReadyReport(record.report);
    } catch {
      return false;
    }
  }
  return true;
}

function isHighIntensityInput(value: unknown): value is HighIntensityInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.task === "string"
    && input.task.trim().length > 0
    && Array.isArray(input.subquestions)
    && input.subquestions.length > 0
    && input.subquestions.every(
      (item) => typeof item === "string" && item.trim().length > 0,
    );
}

function isAvailabilitySnapshot(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.id === "string"
    && snapshot.id.trim().length > 0
    && typeof snapshot.capturedAt === "string"
    && snapshot.capturedAt.trim().length > 0
    && Array.isArray(snapshot.candidates);
}

function isHighIntensityCallRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  return (call.phase === "research"
      || call.phase === "author"
      || call.phase === "challenger"
      || call.phase === "judge")
    && (call.round === null || call.round === 1 || call.round === 2)
    && typeof call.contextId === "string"
    && typeof call.alias === "string"
    && typeof call.family === "string"
    && typeof call.model === "string"
    && typeof call.prompt === "string"
    && typeof call.workflowDecisionId === "string"
    && typeof call.decisionHash === "string"
    && typeof call.idempotencyKey === "string";
}

function isAuthorityRecord(
  value: unknown,
): value is HighIntensityRunRecord["authority"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  const hasCanonicalIdentity =
    typeof authority.canonicalRunId === "string"
    && authority.canonicalRunId.length > 0
    && typeof authority.idempotencyKey === "string"
    && authority.idempotencyKey.length > 0;
  const notReached =
    authority.canonicalRunId === null
    && authority.idempotencyKey === null;
  return (
    authority.workflowAuthority === "unverified"
      || authority.workflowAuthority === "firstmate_verified"
  )
    && (
      authority.runtimeAuthority === "unverified"
      || authority.runtimeAuthority === "canonical_run_registry_verified"
    )
    && (hasCanonicalIdentity || notReached);
}

function isDecisionReadyReportCandidate(
  value: unknown,
): value is DecisionReadyReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (report.schemaVersion !== 1) return false;
  const mainReport = report.mainReport;
  const evidenceLayer = report.evidenceLayer;
  if (
    mainReport === null
    || typeof mainReport !== "object"
    || Array.isArray(mainReport)
    || evidenceLayer === null
    || typeof evidenceLayer !== "object"
    || Array.isArray(evidenceLayer)
  ) {
    return false;
  }
  const main = mainReport as Record<string, unknown>;
  const evidence = evidenceLayer as Record<string, unknown>;
  return typeof main.conclusion === "string"
    && typeof main.impact === "string"
    && typeof main.nextAction === "string"
    && typeof evidence.configVersionHash === "string"
    && typeof evidence.availabilitySnapshotId === "string"
    && typeof evidence.routingDecisionKey === "string"
    && Array.isArray(evidence.lineage)
    && Array.isArray(evidence.limitations)
    && Array.isArray(evidence.unknowns);
}

function inputHash(input: HighIntensityInput): string {
  return sha256(JSON.stringify({
    task: input.task.trim().replace(/\s+/g, " "),
    subquestions: input.subquestions.map((subquestion) =>
      subquestion.trim().replace(/\s+/g, " "),
    ),
  }));
}

function compactTimestamp(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 17);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCompleteSourceLineage(
  value: SourceLineage | undefined,
): value is SourceLineage {
  return value !== undefined
    && value.taskId.trim().length > 0
    && value.runId.trim().length > 0
    && value.workspace.trim().length > 0
    && value.tabId.trim().length > 0
    && value.paneId.trim().length > 0;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function activeAttemptId(run: RunProjection): string {
  const attempt = run.attempts.at(-1);
  if (!attempt) throw new Error("run_attempt_missing");
  return attempt.id;
}

function releaseLeaseIfHeld(
  registry: FileRunRegistry,
  lease: RegistryLease,
): void {
  try {
    registry.releaseLease(lease);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "lease_not_held") {
      throw error;
    }
  }
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inferFirstmateAuthorityRootFromRecordPath(path: string): string {
  return resolveFirstmateAuthorityRoot(dirname(dirname(resolve(path))));
}
