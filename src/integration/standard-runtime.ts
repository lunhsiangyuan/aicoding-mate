import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  assertDecisionReadyReport,
  assertWorkflowDecisionEnvelope,
  lookupExactStageAssignment,
  type AvailabilityCandidate,
  type AvailabilitySnapshot,
  type DecisionReadyReport,
  type FirstmateDispatchReceipt,
  type FirstmateDispatchRequest,
  type RoleAssignment,
  type RoutingDecision,
  type SourceLineage,
  type WorkflowDecisionEnvelope,
} from "../contracts/index.ts";
import {
  createFirstmateWorkflowDecision,
  workflowDispatchIdempotencyKey,
} from "../authority/firstmate-decisions.ts";
import {
  FileFirstmateDecisionAuthority,
  isFirstmateDecisionReceipt,
  resolveFirstmateAuthorityRoot,
  verifyFirstmateDecisionReceipt,
  type FirstmateDecisionAuthorityPort,
  type FirstmateDecisionReceipt,
} from "../authority/firstmate-decision-authority.ts";
import {
  createQuickRun,
  quickWorkflowExecutionMatches,
  quickRunIdForIdempotencyKey,
  readRunRecord,
  validateQuickTaskScope,
  wrapStandardReadOnlyTask,
  type QuickResult,
  type QuickRunRecord,
  type QuickWorkflowExecution,
} from "../quick.ts";
import {
  planStandardWorkflow,
  type NormalizedStandardInput,
  type StandardWorkflowInput,
} from "../routing/standard.ts";
import {
  FileRunRegistry,
  type RegistryLease,
  type RunProjection,
} from "../runtime/run-registry.ts";
import {
  modelDispatchReceiptPath,
  persistModelDispatchReceipt,
  readModelDispatchReceipt,
  type ModelDispatchIdentity,
} from "../runtime/model-dispatch-receipt.ts";

export type StandardRuntimeStatus = "blocked" | "completed";

export interface StandardReviewOutcome {
  readonly ok: boolean;
  readonly family: string;
  readonly model: string;
  readonly rawOutput: string;
  readonly receiptPath: string | null;
  readonly error: string | null;
}

export interface StandardDispatchOutcome {
  readonly receipt: FirstmateDispatchReceipt;
  readonly summary: string | null;
  readonly quickRecordPath: string | null;
}

export interface StandardReviewExecution {
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly stageId: "reviewer";
  readonly idempotencyKey: string;
}

export interface StandardRuntimePorts {
  readonly dispatchAuthor: (
    request: FirstmateDispatchRequest,
  ) => Promise<StandardDispatchOutcome>;
  readonly review: (
    prompt: string,
    assignment: RoleAssignment,
    execution: StandardReviewExecution,
  ) => Promise<StandardReviewOutcome>;
  readonly readBackAuthor?: (
    request: FirstmateDispatchRequest,
  ) => Promise<
    | {
        readonly status: "found";
        readonly outcome: StandardDispatchOutcome;
      }
    | {
        readonly status: "not_found" | "mismatch";
        readonly checkedAt: string;
        readonly reason: string;
      }
  >;
  readonly readBackReview?: (
    assignment: RoleAssignment,
    execution: StandardReviewExecution,
  ) => Promise<
    | {
        readonly status: "found";
        readonly outcome: StandardReviewOutcome;
      }
    | {
        readonly status: "not_found" | "mismatch";
        readonly checkedAt: string;
        readonly reason: string;
      }
  >;
}

export interface StandardRunRecord {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: StandardRuntimeStatus;
  readonly task: string;
  readonly projectDir: string;
  readonly source: SourceLineage;
  readonly availability: AvailabilitySnapshot;
  readonly normalizedInput: NormalizedStandardInput;
  readonly routingDecision: RoutingDecision | null;
  readonly workflowDecision: WorkflowDecisionEnvelope | null;
  readonly workflowDecisionReceipt: FirstmateDecisionReceipt | null;
  readonly author: StandardDispatchOutcome | null;
  readonly review: StandardReviewOutcome | null;
  readonly reviewAttempts: readonly StandardReviewOutcome[];
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
  readonly claims: {
    readonly authorCompletedInFirstmate: boolean;
    readonly independentReviewCompleted: boolean;
    readonly reportDecisionReady: boolean;
    readonly reportReadbackMatchesPane: boolean;
  };
  readonly recordPath: string;
}

export interface StandardRunOptions {
  readonly task: string;
  readonly cwd: string;
  readonly projectDir?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly availability?: AvailabilitySnapshot;
  readonly now?: () => string;
  readonly ports?: StandardRuntimePorts;
  readonly decisionAuthority?: FirstmateDecisionAuthorityPort;
}

export interface StandardRunResult {
  readonly ok: boolean;
  readonly record: StandardRunRecord;
  readonly dedupeStatus:
    | "new"
    | "coalesced_active"
    | "coalesced_completed"
    | "reconciliation_required";
}

type CompletedFirstmateAuthorRecord = QuickRunRecord & {
  readonly status: "completed";
  readonly result: NonNullable<QuickRunRecord["result"]>;
  readonly worker: QuickRunRecord["worker"] & {
    readonly target: string;
  };
  readonly evidence: NonNullable<QuickRunRecord["evidence"]> & {
    readonly observedAt: string;
  };
  readonly recordPath: string;
};

export function hasFirstmateAuthorReadback(
  record: QuickRunRecord,
): record is CompletedFirstmateAuthorRecord {
  return (
    record.status === "completed"
    && Boolean(record.result?.summary.trim())
    && Boolean(record.result?.readBackAt)
    && Boolean(record.worker.taskId)
    && Boolean(record.worker.target)
    && Boolean(record.recordPath)
    && Boolean(record.evidence?.firstmateMeta)
    && Boolean(record.evidence?.firstmateStatus)
    && Boolean(record.evidence?.scoutReport)
    && Boolean(record.evidence?.observedAt)
    && record.claims.firstmatePrimaryInHerdr
    && record.claims.workerVisible
  );
}

interface ReviewDocument {
  readonly conclusion: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly limitations: readonly string[];
  readonly unknowns: readonly string[];
}

export async function createStandardRun(
  options: StandardRunOptions,
): Promise<StandardRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const projectDir = resolve(options.projectDir ?? options.cwd);
  const stateDir = resolveStateDir(options.cwd, options.env);
  const availability =
    options.availability ?? probeStandardAvailability(options.cwd, options.env, now);
  const input: StandardWorkflowInput = {
    task: options.task,
    risk: "medium",
    boundaries: [
      "author result must return through Firstmate on Herdr",
      "reviewer must not modify the workspace",
      "main report must remain concise",
    ],
  };
  const plan = planStandardWorkflow({ input, availability });
  const source = sourceFromEnvironment(options.env);
  const provisionalId =
    `standard-invalid-${compactTimestamp(createdAt)}-${randomUUID()}`;
  const provisionalPath = join(
    stateDir,
    "standard-runs",
    `${provisionalId}.json`,
  );
  const provisional: StandardRunRecord = {
    schemaVersion: 2,
    id: provisionalId,
    createdAt,
    updatedAt: createdAt,
    status: "blocked",
    task: options.task,
    projectDir,
    source,
    availability,
    normalizedInput: plan.normalizedInput,
    routingDecision:
      plan.routing.status === "resolved" ? plan.routing.decision : null,
    workflowDecision: null,
    workflowDecisionReceipt: null,
    author: null,
    review: null,
    reviewAttempts: [],
    report: null,
    blockers: [],
    authority: {
      workflowAuthority: "unverified",
      runtimeAuthority: "unverified",
      canonicalRunId: null,
      idempotencyKey: null,
    },
    claims: {
      authorCompletedInFirstmate: false,
      independentReviewCompleted: false,
      reportDecisionReady: false,
      reportReadbackMatchesPane: false,
    },
    recordPath: provisionalPath,
  };

  if (!options.task.trim()) {
    return blocked(provisional, now, "standard_task_empty");
  }
  if (!source.paneId.trim()) {
    return blocked(provisional, now, "standard_requires_herdr_pane");
  }
  if (!source.workspace.trim() || !source.tabId.trim()) {
    return blocked(
      provisional,
      now,
      "standard_requires_complete_herdr_lineage",
    );
  }
  if (plan.routing.status !== "resolved") {
    return blocked(
      provisional,
      now,
      `routing_${plan.routing.status}:${plan.routing.reason}`,
    );
  }
  const workflowDecision = createFirstmateWorkflowDecision({
    recipe: "standard",
    intentHash: plan.normalizedInput.hash,
    configVersion: plan.config.versionHash,
    availability,
    routingDecision: plan.routing.decision,
    source,
  });
  const authorTask = architectureTask(options.task, workflowDecision);
  const authorScopeBlocker = validateQuickTaskScope(authorTask, projectDir);
  if (authorScopeBlocker !== undefined) {
    return blocked(
      { ...provisional, workflowDecision },
      now,
      `author_scope_invalid:${authorScopeBlocker}`,
    );
  }
  const decisionAuthority =
    options.decisionAuthority
    ?? new FileFirstmateDecisionAuthority({
      rootDir: resolveFirstmateAuthorityRoot(stateDir, options.env),
      now,
    });
  let workflowDecisionReceipt: FirstmateDecisionReceipt;
  try {
    workflowDecisionReceipt = decisionAuthority.issueDecision(workflowDecision);
    if (
      decisionAuthority.readDecision(
        workflowDecision,
        workflowDecisionReceipt.receiptPath,
      ) === undefined
    ) {
      throw new Error("firstmate_decision_receipt_readback_failed");
    }
  } catch (error) {
    return blocked(
      { ...provisional, workflowDecision },
      now,
      `firstmate_decision_issuance_failed:${compactError(error)}`,
    );
  }
  const registry = new FileRunRegistry({
    rootDir: join(stateDir, "run-registry"),
  });
  const opened = registry.openOrCreateRun({
    intent: {
      workflow: "standard",
      projectDir,
      task: plan.normalizedInput.task,
      source,
      inputs: {
        normalizedInputHash: plan.normalizedInput.hash,
        risk: plan.normalizedInput.risk,
        boundaries: plan.normalizedInput.boundaries,
      },
      availabilitySnapshotId: availability.id,
      routingDecisionVersion: plan.routing.decision.requestKey,
      decisionVersion: workflowDecision.workflowDecisionId,
    },
    owner: `standard:${process.pid}:${randomUUID()}`,
    leaseTtlMs: leaseTtlMs(options.env),
    now: createdAt,
  });
  const id = `standard-${opened.run.runId.slice(4)}`;
  const recordPath = join(stateDir, "standard-runs", `${id}.json`);
  const base: StandardRunRecord = {
    ...provisional,
    id,
    recordPath,
    routingDecision: plan.routing.decision,
    workflowDecision,
    workflowDecisionReceipt,
    authority: {
      workflowAuthority: "firstmate_verified",
      runtimeAuthority: "canonical_run_registry_verified",
      canonicalRunId: opened.run.runId,
      idempotencyKey: opened.run.idempotencyKey,
    },
  };
  const ports =
    options.ports ??
    defaultStandardRuntimePorts({
      cwd: options.cwd,
      projectDir,
      env: options.env,
    });
  const authorStage = lookupExactStageAssignment(workflowDecision, "author");
  const authorDispatchKey = workflowDispatchIdempotencyKey(
    opened.run.runId,
    workflowDecision.decisionHash,
    "author",
    null,
  );
  const dispatchRequest: FirstmateDispatchRequest = {
    idempotencyKey: authorDispatchKey,
    workflow: "standard",
    workflowDecisionId: workflowDecision.workflowDecisionId,
    decisionHash: workflowDecision.decisionHash,
    stageId: "author",
    exactAssignment: authorStage.roleAssignment,
    projectDir,
    source,
    task: authorTask,
  };
  const reviewerStage = lookupExactStageAssignment(
    workflowDecision,
    "reviewer",
  );
  const reviewerAssignment = reviewerStage.roleAssignment;
  const reviewDispatchKey = workflowDispatchIdempotencyKey(
    opened.run.runId,
    workflowDecision.decisionHash,
    "reviewer",
    null,
  );
  const reviewExecution: StandardReviewExecution = {
    workflowDecisionId: workflowDecision.workflowDecisionId,
    decisionHash: workflowDecision.decisionHash,
    stageId: "reviewer",
    idempotencyKey: reviewDispatchKey,
  };
  const repairDispatchKey = workflowDispatchIdempotencyKey(
    opened.run.runId,
    workflowDecision.decisionHash,
    "reviewer",
    1,
  );
  const repairExecution: StandardReviewExecution = {
    workflowDecisionId: workflowDecision.workflowDecisionId,
    decisionHash: workflowDecision.decisionHash,
    stageId: "reviewer",
    idempotencyKey: repairDispatchKey,
  };
  let lease: RegistryLease | null = null;
  let reconciledAuthor: StandardDispatchOutcome | null = null;
  let reconciledReview: StandardReviewOutcome | null = null;
  let reconciledRepair: StandardReviewOutcome | null = null;

  if (opened.kind !== "created") {
    const existing = readStandardRunRecord(recordPath);
    if (
      opened.kind === "coalesced_completed"
      && existing !== undefined
      && opened.run.completedArtifact?.path === recordPath
      && opened.run.completedArtifact.hash === standardRecordHash(existing)
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
      || ports.readBackAuthor === undefined
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
      owner: `standard-reconcile:${process.pid}:${randomUUID()}`,
      leaseTtlMs: leaseTtlMs(options.env),
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
    const readBack = await ports.readBackAuthor(dispatchRequest);
    if (readBack.status === "found") {
      reconciledAuthor = readBack.outcome;
      registry.acceptDispatch(lease, {
        idempotencyKey: authorDispatchKey,
        target: readBack.outcome.receipt.workerTarget,
        receiptPath: readBack.outcome.receipt.evidencePath,
        now: now(),
      });
      registry.markRunning(lease, { now: now() });
    } else if (readBack.status === "not_found") {
      registry.requestRetryAfterReadbackNotFound(lease, {
        readback: readBack,
        now: now(),
      });
      writeStandardRecord(base);
    } else {
      releaseLeaseIfHeld(registry, lease);
      return {
        ok: false,
        record: existing ?? base,
        dedupeStatus: "reconciliation_required",
      };
    }
    const latestAttempt = opened.run.attempts.at(-1);
    if (
      latestAttempt?.dispatches.some(
        (dispatch) => dispatch.idempotencyKey === reviewDispatchKey,
      )
    ) {
      if (ports.readBackReview === undefined) {
        registry.markUnknownOutcome(lease, {
          reason: "independent_review_requires_readback_port",
          readback: {
            status: "mismatch",
            checkedAt: now(),
            reason: "review_readback_port_unavailable",
          },
          now: now(),
        });
        releaseLeaseIfHeld(registry, lease);
        return {
          ok: false,
          record: existing ?? base,
          dedupeStatus: "reconciliation_required",
        };
      }
      const reviewReadback = await ports.readBackReview(
        reviewerAssignment,
        reviewExecution,
      );
      if (
        reviewReadback.status !== "found"
        || !standardReviewReceiptMatches(
          reviewReadback.outcome,
          reviewerAssignment,
          reviewExecution,
        )
      ) {
        registry.markUnknownOutcome(lease, {
          reason: "independent_review_requires_reconciliation",
          readback:
            reviewReadback.status === "found"
              ? {
                  status: "mismatch",
                  checkedAt: now(),
                  reason: "review_receipt_identity_or_output_mismatch",
                }
              : reviewReadback,
          now: now(),
        });
        releaseLeaseIfHeld(registry, lease);
        return {
          ok: false,
          record: existing ?? base,
          dedupeStatus: "reconciliation_required",
        };
      }
      reconciledReview = reviewReadback.outcome;
      registry.acceptDispatch(lease, {
        idempotencyKey: reviewDispatchKey,
        target:
          `${reviewReadback.outcome.family}:${reviewReadback.outcome.model}`,
        receiptPath: reviewReadback.outcome.receiptPath,
        now: now(),
      });
      registry.markRunning(lease, { now: now() });
    }
    if (
      latestAttempt?.dispatches.some(
        (dispatch) => dispatch.idempotencyKey === repairDispatchKey,
      )
    ) {
      if (ports.readBackReview === undefined) {
        registry.markUnknownOutcome(lease, {
          reason: "review_repair_requires_readback_port",
          readback: {
            status: "mismatch",
            checkedAt: now(),
            reason: "review_repair_readback_port_unavailable",
          },
          now: now(),
        });
        releaseLeaseIfHeld(registry, lease);
        return {
          ok: false,
          record: existing ?? base,
          dedupeStatus: "reconciliation_required",
        };
      }
      const repairReadback = await ports.readBackReview(
        reviewerAssignment,
        repairExecution,
      );
      if (
        repairReadback.status !== "found"
        || !standardReviewReceiptMatches(
          repairReadback.outcome,
          reviewerAssignment,
          repairExecution,
        )
      ) {
        registry.markUnknownOutcome(lease, {
          reason: "review_repair_requires_reconciliation",
          readback:
            repairReadback.status === "found"
              ? {
                  status: "mismatch",
                  checkedAt: now(),
                  reason: "review_repair_receipt_identity_or_output_mismatch",
                }
              : repairReadback,
          now: now(),
        });
        releaseLeaseIfHeld(registry, lease);
        return {
          ok: false,
          record: existing ?? base,
          dedupeStatus: "reconciliation_required",
        };
      }
      reconciledRepair = repairReadback.outcome;
      registry.acceptDispatch(lease, {
        idempotencyKey: repairDispatchKey,
        target:
          `${repairReadback.outcome.family}:${repairReadback.outcome.model}`,
        receiptPath: repairReadback.outcome.receiptPath,
        now: now(),
      });
      registry.markRunning(lease, { now: now() });
    }
  } else {
    lease = opened.lease;
    writeStandardRecord(base);
  }

  if (lease === null) throw new Error("registry_lease_missing");
  try {
    const authorWasReconciled = reconciledAuthor !== null;
    let author = reconciledAuthor;
    if (author === null) {
      registry.recordDispatch(lease, {
        idempotencyKey: authorDispatchKey,
        target: null,
        receiptPath: null,
        accepted: false,
        now: now(),
      });
      try {
        author = await ports.dispatchAuthor(dispatchRequest);
      } catch {
        registry.markUnknownOutcome(lease, {
          reason: "firstmate_author_unknown_outcome",
          readback: {
            status: "mismatch",
            checkedAt: now(),
            reason: "dispatch_threw_before_receipt_readback",
          },
          now: now(),
        });
        return blocked(
          base,
          now,
          "firstmate_author_unknown_outcome",
        );
      }
    }
    if (!author.receipt.accepted || author.summary === null) {
      registry.failAttempt(lease, {
        reason: author.receipt.reason ?? "firstmate_author_failed",
        now: now(),
      });
      return blocked(
        { ...base, author },
        now,
        author.receipt.reason ?? "firstmate_author_failed",
      );
    }
    if (!authorWasReconciled) {
      registry.acceptDispatch(lease, {
        idempotencyKey: authorDispatchKey,
        target: author.receipt.workerTarget,
        receiptPath: author.receipt.evidencePath,
        now: now(),
      });
      registry.markRunning(lease, { now: now() });
    }

    const reviewAttempts: StandardReviewOutcome[] = [];
    const reviewWasReconciled = reconciledReview !== null;
    let review = reconciledReview;
    if (review === null) {
      registry.recordDispatch(lease, {
        idempotencyKey: reviewDispatchKey,
        target: reviewerAssignment.alias,
        receiptPath: null,
        accepted: false,
        now: now(),
      });
      try {
        review = await ports.review(
          buildReviewPrompt(options.task, author.summary, plan.routing.decision),
          reviewerAssignment,
          reviewExecution,
        );
      } catch {
        registry.markUnknownOutcome(lease, {
          reason: "independent_review_unknown_outcome",
          readback: {
            status: "mismatch",
            checkedAt: now(),
            reason: "review_dispatch_threw_before_receipt_readback",
          },
          now: now(),
        });
        return blocked(
          { ...base, author },
          now,
          "independent_review_unknown_outcome",
        );
      }
    }
    if (!review.ok) {
      reviewAttempts.push(review);
      registry.failAttempt(lease, {
        reason: review.error ?? "independent_review_failed",
        now: now(),
      });
      return blocked(
        { ...base, author, review, reviewAttempts },
        now,
        review.error ?? "independent_review_failed",
      );
    }
    if (
      review.family !== reviewerAssignment.family ||
      review.model !== reviewerAssignment.resolvedModel
    ) {
      reviewAttempts.push(review);
      registry.failAttempt(lease, {
        reason: "review_provenance_mismatch",
        now: now(),
      });
      return blocked(
        { ...base, author, review, reviewAttempts },
        now,
        "review_provenance_mismatch",
      );
    }
    if (
      !standardReviewReceiptMatches(
        review,
        reviewerAssignment,
        reviewExecution,
      )
    ) {
      reviewAttempts.push(review);
      registry.failAttempt(lease, {
        reason: "review_receipt_readback_failed",
        now: now(),
      });
      return blocked(
        { ...base, author, review, reviewAttempts },
        now,
        "review_receipt_readback_failed",
      );
    }
    if (!reviewWasReconciled) {
      registry.acceptDispatch(lease, {
        idempotencyKey: reviewDispatchKey,
        target: `${review.family}:${review.model}`,
        receiptPath: review.receiptPath,
        now: now(),
      });
      registry.markRunning(lease, { now: now() });
    }
    reviewAttempts.push(review);

    let reviewDocument = parseReviewDocument(review.rawOutput);
    if (reviewDocument === null && plan.config.recipe.repairRounds > 0) {
      const repairWasReconciled = reconciledRepair !== null;
      let repairedReview = reconciledRepair;
      if (repairedReview === null) {
        registry.recordDispatch(lease, {
          idempotencyKey: repairDispatchKey,
          target: reviewerAssignment.alias,
          receiptPath: null,
          accepted: false,
          now: now(),
        });
        try {
          repairedReview = await ports.review(
            buildReviewRepairPrompt(review.rawOutput),
            reviewerAssignment,
            repairExecution,
          );
        } catch {
          registry.markUnknownOutcome(lease, {
            reason: "review_repair_unknown_outcome",
            readback: {
              status: "mismatch",
              checkedAt: now(),
              reason: "repair_dispatch_threw_before_receipt_readback",
            },
            now: now(),
          });
          return blocked(
            { ...base, author, review, reviewAttempts },
            now,
            "review_repair_unknown_outcome",
          );
        }
      }
      reviewAttempts.push(repairedReview);
      if (!repairedReview.ok) {
        registry.failAttempt(lease, {
          reason: repairedReview.error ?? "review_repair_failed",
          now: now(),
        });
        return blocked(
          {
            ...base,
            author,
            review: repairedReview,
            reviewAttempts,
          },
          now,
          repairedReview.error ?? "review_repair_failed",
        );
      }
      if (
        repairedReview.family !== reviewerAssignment.family
        || repairedReview.model !== reviewerAssignment.resolvedModel
      ) {
        registry.failAttempt(lease, {
          reason: "review_repair_provenance_mismatch",
          now: now(),
        });
        return blocked(
          {
            ...base,
            author,
            review: repairedReview,
            reviewAttempts,
          },
          now,
          "review_repair_provenance_mismatch",
        );
      }
      if (
        !standardReviewReceiptMatches(
          repairedReview,
          reviewerAssignment,
          repairExecution,
        )
      ) {
        registry.failAttempt(lease, {
          reason: "review_repair_receipt_readback_failed",
          now: now(),
        });
        return blocked(
          {
            ...base,
            author,
            review: repairedReview,
            reviewAttempts,
          },
          now,
          "review_repair_receipt_readback_failed",
        );
      }
      if (!repairWasReconciled) {
        registry.acceptDispatch(lease, {
          idempotencyKey: repairDispatchKey,
          target: `${repairedReview.family}:${repairedReview.model}`,
          receiptPath: repairedReview.receiptPath,
          now: now(),
        });
        registry.markRunning(lease, { now: now() });
      }
      review = repairedReview;
      reviewDocument = parseReviewDocument(repairedReview.rawOutput);
    }
    if (reviewDocument === null) {
      registry.failAttempt(lease, {
        reason: "review_contract_invalid",
        now: now(),
      });
      return blocked(
        { ...base, author, review, reviewAttempts },
        now,
        "review_contract_invalid",
      );
    }

    const report = composeRuntimeReport({
      reviewDocument,
      normalizedInput: plan.normalizedInput,
      routingDecision: plan.routing.decision,
      workflowDecision,
      configVersionHash: plan.config.versionHash,
      availability,
      author,
      review,
    });
    try {
      assertDecisionReadyReport(report);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "report_contract_invalid";
      registry.failAttempt(lease, { reason, now: now() });
      return blocked(
        { ...base, author, review, report },
        now,
        reason,
      );
    }

    const record = writeStandardRecord({
      ...base,
      updatedAt: now(),
      status: "completed",
      author,
      review,
      reviewAttempts,
      report,
      claims: {
        ...base.claims,
        authorCompletedInFirstmate: true,
        independentReviewCompleted: true,
        reportDecisionReady: true,
      },
    });
    registry.completeAttempt(lease, {
      readback: {
        status: "found",
        runId: opened.run.runId,
        attemptId: currentAttemptId(registry, opened.run.runId),
        artifactPath: record.recordPath,
        artifactHash: standardRecordHash(record),
      },
      now: now(),
    });
    return { ok: true, record, dedupeStatus: "new" };
  } finally {
    releaseLeaseIfHeld(registry, lease);
  }
}

export function probeStandardAvailability(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: () => string = () => new Date().toISOString(),
): AvailabilitySnapshot {
  const capturedAt = now();
  const codexAvailable =
    commandSucceeds("codex", ["login", "status"], cwd, env);
  const claudeReviewDisabled = env.ACM_CLAUDE_REVIEW_DISABLED === "1";
  const claudeAvailable =
    !claudeReviewDisabled &&
    commandSucceeds("claude", ["auth", "status"], cwd, env);
  const candidates: AvailabilityCandidate[] = [
    candidate(
      "openai-architect",
      "openai",
      "openai",
      env.ACM_CODEX_ARCHITECT_MODEL ?? "codex-session-default",
      "architecture",
      codexAvailable,
    ),
    candidate(
      "openai-builder",
      "openai",
      "openai",
      env.ACM_CODEX_BUILDER_MODEL ?? "codex-session-default",
      "implementation",
      codexAvailable,
    ),
    candidate(
      "openai-search",
      "openai",
      "openai",
      env.ACM_CODEX_SEARCH_MODEL ?? "codex-session-default",
      "search",
      codexAvailable,
    ),
    candidate(
      "anthropic-reviewer",
      "anthropic",
      "anthropic",
      env.ACM_CLAUDE_REVIEW_MODEL ?? "fable",
      "architecture",
      claudeAvailable,
      claudeReviewDisabled ? "claude_review_disabled_by_env" : undefined,
    ),
  ];
  return {
    id: `availability-${compactTimestamp(capturedAt)}`,
    capturedAt,
    candidates,
  };
}

export function renderStandardText(result: StandardRunResult): string {
  if (!result.ok || result.record.report === null) {
    return [
      "AI Coding Mate Standard: BLOCKED",
      ...result.record.blockers.map((blocker) => `- ${blocker}`),
      `evidence: ${result.record.recordPath}`,
      "",
    ].join("\n");
  }
  const report = result.record.report.mainReport;
  return [
    "AI Coding Mate Standard",
    `結論：${report.conclusion}`,
    `影響：${report.impact}`,
    `下一步：${report.nextAction}`,
    `routing: ${result.record.routingDecision?.diversityStatus ?? "unknown"}`,
    `evidence: ${result.record.recordPath}`,
    "",
  ].join("\n");
}

export function readStandardRunRecord(
  path: string,
): StandardRunRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isStandardRunRecord(value, path) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function markStandardRunPresented(
  path: string,
  expectedText: string,
  observedPaneText: string,
): StandardRunRecord | undefined {
  const record = readStandardRunRecord(path);
  if (
    record === undefined ||
    !expectedText.trim() ||
    !observedPaneText.includes(expectedText)
  ) {
    return undefined;
  }
  return writeStandardRecord({
    ...record,
    updatedAt: new Date().toISOString(),
    claims: {
      ...record.claims,
      reportReadbackMatchesPane: true,
    },
  });
}

export function defaultStandardRuntimePorts(options: {
  readonly cwd: string;
  readonly projectDir: string;
  readonly env: NodeJS.ProcessEnv;
}): StandardRuntimePorts {
  return {
    async dispatchAuthor(request) {
      if (
        request.stageId !== "author"
        || request.exactAssignment.role !== "author"
        || request.exactAssignment.family !== "openai"
      ) {
        return {
          receipt: {
            accepted: false,
            idempotencyStatus: "rejected",
            firstmateTaskId: null,
            workerTarget: null,
            evidencePath: null,
            reason: "firstmate_author_adapter_family_unavailable",
          },
          summary: null,
          quickRecordPath: null,
        };
      }
      const workflowExecution: QuickWorkflowExecution = {
        workflowDecisionId: request.workflowDecisionId,
        decisionHash: request.decisionHash,
        stageId: request.stageId,
        exactAssignment: request.exactAssignment,
      };
      const result: QuickResult = createQuickRun({
        task: request.task,
        cwd: options.cwd,
        projectDir: options.projectDir,
        env: options.env,
        idempotencyKey: request.idempotencyKey,
        workflowExecution,
      });
      if (
        !result.ok ||
        !hasFirstmateAuthorReadback(result.record) ||
        !quickWorkflowExecutionMatches(result.record, workflowExecution)
      ) {
        return {
          receipt: {
            accepted: false,
            idempotencyStatus: "rejected",
            firstmateTaskId: null,
            workerTarget: null,
            evidencePath: null,
            reason:
              result.stderr ||
              result.record.blockers.join("; ") ||
              "firstmate_author_failed",
          },
          summary: null,
          quickRecordPath: result.record.recordPath ?? null,
        };
      }
      return {
        receipt: {
          accepted: true,
          idempotencyStatus: "accepted",
          firstmateTaskId: result.record.worker.taskId,
          workerTarget: result.record.worker.target,
          evidencePath: result.record.recordPath,
          reason: null,
        },
        summary: result.record.result.summary,
        quickRecordPath: result.record.recordPath,
      };
    },
    async readBackAuthor(request) {
      const stateDir = resolveStateDir(options.cwd, options.env);
      const recordPath = join(
        stateDir,
        "runs",
        `${quickRunIdForIdempotencyKey(request.idempotencyKey)}.json`,
      );
      const record = readRunRecord(recordPath);
      const checkedAt = new Date().toISOString();
      if (record === undefined) {
        return {
          status: "not_found",
          checkedAt,
          reason: "firstmate_quick_record_not_found",
        };
      }
      if (!hasFirstmateAuthorReadback(record)) {
        return {
          status: "mismatch",
          checkedAt,
          reason: `firstmate_quick_record_${record.status}`,
        };
      }
      if (
        !quickWorkflowExecutionMatches(record, {
          workflowDecisionId: request.workflowDecisionId,
          decisionHash: request.decisionHash,
          stageId: request.stageId,
          exactAssignment: request.exactAssignment,
        })
      ) {
        return {
          status: "mismatch",
          checkedAt,
          reason: "firstmate_quick_record_exact_assignment_mismatch",
        };
      }
      return {
        status: "found",
        outcome: {
          receipt: {
            accepted: true,
            idempotencyStatus: "duplicate",
            firstmateTaskId: record.worker.taskId,
            workerTarget: record.worker.target,
            evidencePath: record.recordPath,
            reason: null,
          },
          summary: record.result.summary,
          quickRecordPath: record.recordPath,
        },
      };
    },
    async review(prompt, assignment, execution) {
      return runIndependentReview(
        prompt,
        assignment,
        execution,
        options.cwd,
        options.env,
      );
    },
    async readBackReview(assignment, execution) {
      const checkedAt = new Date().toISOString();
      const receiptPath = modelDispatchReceiptPath(
        join(resolveStateDir(options.cwd, options.env), "model-dispatches"),
        execution.idempotencyKey,
      );
      const readback = readModelDispatchReceipt(
        receiptPath,
        standardReviewIdentity(assignment, execution),
      );
      if (readback === undefined) {
        return {
          status: "not_found",
          checkedAt,
          reason: "review_dispatch_receipt_not_found",
        };
      }
      return {
        status: "found",
        outcome: {
          ok: true,
          family: assignment.family,
          model: assignment.resolvedModel,
          rawOutput: readback.rawOutput,
          receiptPath: readback.receipt.receiptPath,
          error: null,
        },
      };
    },
  };
}

function runIndependentReview(
  prompt: string,
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
  cwd: string,
  env: NodeJS.ProcessEnv,
): StandardReviewOutcome {
  if (assignment.family === "anthropic") {
    return runClaudeReview(prompt, assignment, execution, cwd, env);
  }
  if (assignment.family === "openai") {
    return runCodexReview(prompt, assignment, execution, cwd, env);
  }
  return {
    ok: false,
    family: assignment.family,
    model: assignment.resolvedModel,
    rawOutput: "",
    receiptPath: null,
    error: `review_adapter_family_unsupported:${assignment.family}`,
  };
}

function runClaudeReview(
  prompt: string,
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
  cwd: string,
  env: NodeJS.ProcessEnv,
): StandardReviewOutcome {
  const model = assignment.resolvedModel;
  const reviewEnv: NodeJS.ProcessEnv = {
    ...env,
    ACM_IDEMPOTENCY_KEY: execution.idempotencyKey,
    ACM_WORKFLOW_DECISION_ID: execution.workflowDecisionId,
    ACM_DECISION_HASH: execution.decisionHash,
    ACM_STAGE_ID: execution.stageId,
  };
  delete reviewEnv.CLAUDE_CODE_SPAWN_BACKEND;
  delete reviewEnv.CLAUDE_CODE_WORKFLOWS;
  delete reviewEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      model,
      "--tools",
      "",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
      prompt,
    ],
    {
      cwd,
      env: reviewEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const rawOutput = (result.stdout ?? "").trim();
  const succeeded = result.status === 0 && rawOutput.length > 0;
  let receiptPath: string | null = null;
  let receiptError: string | null = null;
  if (succeeded) {
    try {
      receiptPath = persistStandardReviewReceipt(
        cwd,
        env,
        assignment,
        execution,
        rawOutput,
      );
    } catch {
      receiptError = "review_receipt_persist_failed";
    }
  }
  return {
    ok: succeeded && receiptPath !== null,
    family: "anthropic",
    model,
    rawOutput,
    receiptPath,
    error:
      succeeded
        ? receiptError
        : compactProcessFailure(result.status, result.error, result.stderr),
  };
}

function runCodexReview(
  prompt: string,
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
  cwd: string,
  env: NodeJS.ProcessEnv,
): StandardReviewOutcome {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    'web_search="disabled"',
    "-c",
    "mcp_servers={}",
  ];
  if (
    assignment.resolvedModel &&
    assignment.resolvedModel !== "codex-session-default"
  ) {
    args.push("--model", assignment.resolvedModel);
  }
  args.push(prompt);
  const result = spawnSync("codex", args, {
    cwd,
    env: {
      ...env,
      ACM_IDEMPOTENCY_KEY: execution.idempotencyKey,
      ACM_WORKFLOW_DECISION_ID: execution.workflowDecisionId,
      ACM_DECISION_HASH: execution.decisionHash,
      ACM_STAGE_ID: execution.stageId,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rawOutput = (result.stdout ?? "").trim();
  const succeeded = result.status === 0 && rawOutput.length > 0;
  let receiptPath: string | null = null;
  let receiptError: string | null = null;
  if (succeeded) {
    try {
      receiptPath = persistStandardReviewReceipt(
        cwd,
        env,
        assignment,
        execution,
        rawOutput,
      );
    } catch {
      receiptError = "review_receipt_persist_failed";
    }
  }
  return {
    ok: succeeded && receiptPath !== null,
    family: "openai",
    model: assignment.resolvedModel,
    rawOutput,
    receiptPath,
    error:
      succeeded
        ? receiptError
        : compactProcessFailure(result.status, result.error, result.stderr),
  };
}

function persistStandardReviewReceipt(
  cwd: string,
  env: NodeJS.ProcessEnv,
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
  rawOutput: string,
): string {
  return persistModelDispatchReceipt({
    rootDir: join(resolveStateDir(cwd, env), "model-dispatches"),
    identity: standardReviewIdentity(assignment, execution),
    rawOutput,
    completedAt: new Date().toISOString(),
  }).receipt.receiptPath;
}

function standardReviewIdentity(
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
): ModelDispatchIdentity {
  return {
    idempotencyKey: execution.idempotencyKey,
    workflowDecisionId: execution.workflowDecisionId,
    decisionHash: execution.decisionHash,
    stageId: execution.stageId,
    assignment,
  };
}

function standardReviewReceiptMatches(
  outcome: StandardReviewOutcome,
  assignment: RoleAssignment,
  execution: StandardReviewExecution,
): boolean {
  if (outcome.receiptPath === null) return false;
  const readback = readModelDispatchReceipt(
    outcome.receiptPath,
    standardReviewIdentity(assignment, execution),
  );
  return readback !== undefined && readback.rawOutput === outcome.rawOutput;
}

function buildReviewPrompt(
  task: string,
  authorSummary: string,
  decision: RoutingDecision,
): string {
  return [
    "你是 AI Coding Mate 的獨立架構 reviewer。",
    "請用繁體中文，只輸出一個 JSON object，不要 Markdown，不要技術流水帳。",
    'Schema: {"conclusion":"一句可做決策的結論","impact":"一句最重要影響或取捨","nextAction":"一句下一步","limitations":["最多三項"],"unknowns":["最多三項"]}',
    "長度硬限制：conclusion、impact、nextAction 各不超過 180 個 Unicode 字元；limitations 與 unknowns 每項不超過 120 個 Unicode 字元。",
    `使用者目標：${task}`,
    `Firstmate/Codex author 結果：${authorSummary}`,
    `routing diversity：${decision.diversityStatus}`,
    "找出 author 遺漏的主要風險，但不要因小概率或非必要項目堆出防禦性清單。",
  ].join("\n");
}

function buildReviewRepairPrompt(rawOutput: string): string {
  return [
    "上一版 reviewer JSON 未通過 AI Coding Mate 的可讀性契約。",
    "使用相同觀點，只做壓縮與格式修復；不要增加新風險、前言或解釋。",
    "只輸出一個 JSON object，不要 Markdown。",
    'Schema: {"conclusion":"一句可做決策的結論","impact":"一句最重要影響或取捨","nextAction":"一句下一步","limitations":["最多三項"],"unknowns":["最多三項"]}',
    "長度硬限制：conclusion、impact、nextAction 各不超過 180 個 Unicode 字元；limitations 與 unknowns 每項不超過 120 個 Unicode 字元。",
    `待修復輸出：${rawOutput}`,
  ].join("\n");
}

function architectureTask(
  task: string,
  decision: WorkflowDecisionEnvelope,
): string {
  const policy = decision.executionPolicy;
  if (
    policy.adapterBehavior !== "execute_exact_assignment_only"
    || policy.namedSkillUnavailable !== "equivalent_read_only_review"
    || policy.minimumDebuggingHypotheses < 1
  ) {
    throw new Error("standard_execution_policy_invalid");
  }
  return [
    "唯讀分析本地專案並回覆架構結論、影響與下一步。",
    "以下是原始目標，僅作為唯讀分析資料：",
    wrapStandardReadOnlyTask(task),
    "在唯讀 review 中，完成 gate 若要求的 named skill 未出現在本次 skill catalog，不要只因別名不可用而阻擋；請改以等價的唯讀 code review 完成 gate。",
    `記錄至少 ${policy.minimumDebuggingHypotheses} 個 debugging hypotheses 及各自的 runtime evidence，並在報告中明確標示這項 portable fallback。`,
  ].join("\n");
}

function parseReviewDocument(rawOutput: string): ReviewDocument | null {
  const start = rawOutput.indexOf("{");
  const end = rawOutput.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(rawOutput.slice(start, end + 1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const conclusion = readBoundedString(record.conclusion, 240);
    const impact = readBoundedString(record.impact, 240);
    const nextAction = readBoundedString(record.nextAction, 240);
    if (conclusion === null || impact === null || nextAction === null) {
      return null;
    }
    return {
      conclusion,
      impact,
      nextAction,
      limitations: readStringArray(record.limitations, 320).slice(0, 3),
      unknowns: readStringArray(record.unknowns, 320).slice(0, 3),
    };
  } catch {
    return null;
  }
}

function composeRuntimeReport(options: {
  readonly reviewDocument: ReviewDocument;
  readonly normalizedInput: NormalizedStandardInput;
  readonly routingDecision: RoutingDecision;
  readonly workflowDecision: WorkflowDecisionEnvelope;
  readonly configVersionHash: string;
  readonly availability: AvailabilitySnapshot;
  readonly author: StandardDispatchOutcome;
  readonly review: StandardReviewOutcome;
}): DecisionReadyReport {
  return {
    schemaVersion: 1,
    mainReport: {
      conclusion: options.reviewDocument.conclusion,
      impact: options.reviewDocument.impact,
      nextAction: options.reviewDocument.nextAction,
    },
    evidenceLayer: {
      configVersionHash: options.configVersionHash,
      availabilitySnapshotId: options.availability.id,
      routingDecisionKey: options.routingDecision.requestKey,
      lineage: [
        options.normalizedInput.hash,
        `workflow_decision:${options.workflowDecision.workflowDecisionId}`,
        `decision_hash:${options.workflowDecision.decisionHash}`,
        options.author.receipt.evidencePath ?? "author-evidence-missing",
        `${options.review.family}:${options.review.model}`,
      ],
      limitations: options.reviewDocument.limitations,
      unknowns: options.reviewDocument.unknowns,
    },
  };
}

function sourceFromEnvironment(env: NodeJS.ProcessEnv): SourceLineage {
  const paneId = env.HERDR_PANE_ID ?? env.ACM_QUICK_SOURCE_PANE ?? "";
  const workspace = env.HERDR_WORKSPACE_ID ?? "";
  const tabId = env.HERDR_TAB_ID ?? "";
  const stableSource = [workspace, tabId, paneId].filter(Boolean).join(":");
  return {
    taskId: env.ACM_SOURCE_TASK_ID ?? stableSource,
    runId: env.ACM_SOURCE_RUN_ID ?? stableSource,
    workspace,
    tabId,
    paneId,
  };
}

function candidate(
  alias: string,
  provider: string,
  family: string,
  resolvedModel: string,
  capabilityTier: AvailabilityCandidate["capabilityTier"],
  available: boolean,
  unavailableReason?: string,
): AvailabilityCandidate {
  return {
    alias,
    provider,
    family,
    resolvedModel,
    capabilityTier,
    state: available ? "available" : "unavailable",
    reason:
      available ? null : unavailableReason ?? `${provider}_cli_or_auth_unavailable`,
  };
}

function commandSucceeds(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  return result.status === 0;
}

function blocked(
  record: StandardRunRecord,
  now: () => string,
  blocker: string,
): StandardRunResult {
  return {
    ok: false,
    record: writeStandardRecord({
      ...record,
      updatedAt: now(),
      status: "blocked",
      blockers: [...record.blockers, blocker],
    }),
    dedupeStatus: "new",
  };
}

function writeStandardRecord(record: StandardRunRecord): StandardRunRecord {
  mkdirSync(dirname(record.recordPath), { recursive: true });
  const temporary = `${record.recordPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, record.recordPath);
  return record;
}

function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_STATE_DIR ?? join(cwd, "state", "aicoding-mate"));
}

function compactProcessFailure(
  status: number | null,
  error: Error | undefined,
  stderr: string | Buffer | null | undefined,
): string {
  if (error) return error.message;
  const text = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
  return text.trim().split(/\r?\n/)[0] || `process_exit_${status ?? "unknown"}`;
}

function readBoundedString(
  value: unknown,
  maximumCodePoints: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > maximumCodePoints
  ) {
    return null;
  }
  return normalized;
}

function readStringArray(
  value: unknown,
  maximumCodePoints: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(
      (item) =>
        item.length > 0 && Array.from(item).length <= maximumCodePoints,
    );
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "").replace("Z", "z");
}

function isStandardRunRecord(
  value: unknown,
  expectedPath: string,
): value is StandardRunRecord {
  if (!isRecordValue(value)) {
    return false;
  }
  const record = value;
  if (
    record.schemaVersion !== 2
    || typeof record.id !== "string"
    || !record.id.startsWith("standard-")
    || typeof record.recordPath !== "string"
    || resolve(record.recordPath) !== resolve(expectedPath)
    || basename(record.recordPath) !== `${record.id}.json`
    || (record.status !== "blocked" && record.status !== "completed")
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || typeof record.task !== "string"
    || typeof record.projectDir !== "string"
    || !isSourceLineage(record.source)
    || !isRecordValue(record.normalizedInput)
    || !isRecordValue(record.availability)
    || !Array.isArray(record.reviewAttempts)
    || !record.reviewAttempts.every(isStandardReviewOutcome)
    || !Array.isArray(record.blockers)
    || !record.blockers.every((item) => typeof item === "string")
    || !isStandardAuthority(record.authority)
    || !isStandardClaims(record.claims)
  ) {
    return false;
  }
  if (record.workflowDecision !== null) {
    try {
      assertWorkflowDecisionEnvelope(record.workflowDecision);
    } catch {
      return false;
    }
    if (!sameSourceLineage(record.source, record.workflowDecision.sourceLineage)) {
      return false;
    }
    if (
      !isFirstmateDecisionReceipt(record.workflowDecisionReceipt)
      || !verifyFirstmateDecisionReceipt(
        record.workflowDecision,
        record.workflowDecisionReceipt,
      )
      || record.authority.workflowAuthority !== "firstmate_verified"
    ) {
      return false;
    }
  } else if (
    record.workflowDecisionReceipt !== null
    || record.authority.workflowAuthority !== "unverified"
  ) {
    return false;
  }
  if (record.status === "completed") {
    if (
      record.routingDecision === null
      || record.workflowDecision === null
      || !isRecordValue(record.author)
      || !isRecordValue(record.review)
      || !isDecisionReadyReportCandidate(record.report)
      || record.blockers.length !== 0
      || typeof record.authority.canonicalRunId !== "string"
      || typeof record.authority.idempotencyKey !== "string"
      || record.claims.authorCompletedInFirstmate !== true
      || record.claims.independentReviewCompleted !== true
      || record.claims.reportDecisionReady !== true
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStandardReviewOutcome(value: unknown): value is StandardReviewOutcome {
  return isRecordValue(value)
    && typeof value.ok === "boolean"
    && typeof value.family === "string"
    && typeof value.model === "string"
    && typeof value.rawOutput === "string"
    && (value.error === null || typeof value.error === "string");
}

function isSourceLineage(value: unknown): value is SourceLineage {
  return isRecordValue(value)
    && typeof value.taskId === "string"
    && typeof value.runId === "string"
    && typeof value.workspace === "string"
    && typeof value.tabId === "string"
    && typeof value.paneId === "string";
}

function sameSourceLineage(left: SourceLineage, right: SourceLineage): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.workspace === right.workspace
    && left.tabId === right.tabId
    && left.paneId === right.paneId;
}

function isStandardAuthority(value: unknown): value is StandardRunRecord["authority"] {
  if (!isRecordValue(value)) return false;
  const canonicalRunId = value.canonicalRunId;
  const idempotencyKey = value.idempotencyKey;
  const workflowAuthority = value.workflowAuthority;
  const runtimeAuthority = value.runtimeAuthority;
  return (
    workflowAuthority === "unverified"
      || workflowAuthority === "firstmate_verified"
  )
    && (
      runtimeAuthority === "unverified"
      || runtimeAuthority === "canonical_run_registry_verified"
    )
    && (canonicalRunId === null || typeof canonicalRunId === "string")
    && (idempotencyKey === null || typeof idempotencyKey === "string")
    && (canonicalRunId === null) === (idempotencyKey === null);
}

function compactError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim()
    : "unknown_error";
}

function isStandardClaims(value: unknown): value is StandardRunRecord["claims"] {
  return isRecordValue(value)
    && typeof value.authorCompletedInFirstmate === "boolean"
    && typeof value.independentReviewCompleted === "boolean"
    && typeof value.reportDecisionReady === "boolean"
    && typeof value.reportReadbackMatchesPane === "boolean";
}

function isDecisionReadyReportCandidate(
  value: unknown,
): value is DecisionReadyReport {
  if (!isRecordValue(value) || value.schemaVersion !== 1) return false;
  const main = value.mainReport;
  const evidence = value.evidenceLayer;
  return isRecordValue(main)
    && isRecordValue(evidence)
    && typeof main.conclusion === "string"
    && typeof main.impact === "string"
    && typeof main.nextAction === "string"
    && typeof evidence.configVersionHash === "string"
    && typeof evidence.availabilitySnapshotId === "string"
    && typeof evidence.routingDecisionKey === "string"
    && Array.isArray(evidence.lineage)
    && Array.isArray(evidence.limitations)
    && Array.isArray(evidence.unknowns);
}

export function standardRecordHash(record: StandardRunRecord): string {
  const canonical = {
    ...record,
    updatedAt: record.createdAt,
    claims: {
      ...record.claims,
      reportReadbackMatchesPane: false,
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function leaseTtlMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.ACM_RUN_LEASE_TTL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 900_000;
}

function activeAttemptId(run: RunProjection): string {
  const attempt = run.attempts.at(-1);
  if (!attempt) throw new Error("run_attempt_missing");
  return attempt.id;
}

function currentAttemptId(
  registry: FileRunRegistry,
  runId: string,
): string {
  const run = registry.readRun(runId);
  if (!run) throw new Error("run_projection_missing");
  return activeAttemptId(run);
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
