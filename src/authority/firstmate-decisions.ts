import { createHash } from "node:crypto";

import {
  availabilitySnapshotHash,
  type AvailabilitySnapshot,
  type RoleAssignment,
  type RoutingDecision,
  type SourceLineage,
} from "../contracts/index.ts";
import {
  createWorkflowDecisionEnvelope,
  type WorkflowDecisionEnvelope,
  type WorkflowRoleAssignment,
} from "./workflow-authority.ts";

export interface FirstmateDecisionOptions {
  readonly recipe: "standard" | "adversarial" | "research";
  readonly intentHash: string;
  readonly configVersion: string;
  readonly availability: AvailabilitySnapshot;
  readonly routingDecision: RoutingDecision;
  readonly source: SourceLineage;
}

export interface FirstmateNativeReviewDecisionOptions {
  readonly intentHash: string;
  readonly configVersion: string;
  readonly source: SourceLineage;
  readonly reviewer: WorkflowRoleAssignment;
}

const reportComposerAssignment: WorkflowRoleAssignment = {
  role: "report_composer",
  alias: "firstmate-report-composer",
  provider: "firstmate",
  family: "firstmate",
  resolvedModel: "deterministic-two-layer-v0.2",
  capabilityTier: "architecture",
  reason: "Firstmate owns two-layer report composition and coverage gating.",
};

export function createFirstmateWorkflowDecision(
  options: FirstmateDecisionOptions,
): WorkflowDecisionEnvelope {
  const roleAssignments = [
    ...options.routingDecision.roleAssignments.map(toWorkflowAssignment),
    reportComposerAssignment,
  ];
  const highIntensity =
    options.recipe === "adversarial" || options.recipe === "research";

  return createWorkflowDecisionEnvelope({
    workflowDecisionVersion: 1,
    recipe: {
      id: options.recipe,
      version: "0.2.0",
    },
    hashes: {
      intentHash: options.intentHash,
      configHash: sha256(options.configVersion),
      availabilityHash: availabilitySnapshotHash(options.availability),
    },
    sourceLineage: options.source,
    roleAssignments,
    stageAssignments: highIntensity
      ? [
          { stageId: "research", role: "search", barrierId: "research_complete" },
          { stageId: "author", role: "author", barrierId: "author_complete" },
          {
            stageId: "challenger",
            role: "challenger",
            barrierId: "challenge_complete",
          },
          { stageId: "judge", role: "judge", barrierId: "judge_complete" },
          {
            stageId: "report",
            role: "report_composer",
            barrierId: "report_complete",
          },
        ]
      : [
          { stageId: "author", role: "author", barrierId: "author_complete" },
          {
            stageId: "reviewer",
            role: "reviewer",
            barrierId: "review_complete",
          },
          {
            stageId: "report",
            role: "report_composer",
            barrierId: "report_complete",
          },
        ],
    stageBarriers: highIntensity
      ? [
          {
            id: "research_complete",
            afterStageId: "research",
            requires: ["research_artifact_read_back"],
          },
          {
            id: "author_complete",
            afterStageId: "author",
            requires: ["author_artifact_read_back"],
          },
          {
            id: "challenge_complete",
            afterStageId: "challenger",
            requires: ["challenger_artifact_read_back"],
          },
          {
            id: "judge_complete",
            afterStageId: "judge",
            requires: ["judge_decision_read_back"],
          },
          {
            id: "report_complete",
            afterStageId: "report",
            requires: ["two_layer_report_read_back"],
          },
        ]
      : [
          {
            id: "author_complete",
            afterStageId: "author",
            requires: ["firstmate_author_artifact_read_back"],
          },
          {
            id: "review_complete",
            afterStageId: "reviewer",
            requires: ["review_artifact_read_back"],
          },
          {
            id: "report_complete",
            afterStageId: "report",
            requires: ["two_layer_report_read_back"],
          },
        ],
    maxRounds: highIntensity ? 2 : 1,
    stopConditions: highIntensity
      ? ["judge_accepts", "max_rounds_reached", "failed_closed"]
      : ["review_contract_accepts", "failed_closed"],
    fallbackPolicy: {
      behavior: "new_decision_required",
      reason:
        "Adapters only report availability or execution observations; Firstmate must issue a new decision before fallback.",
    },
    executionPolicy: {
      adapterBehavior: "execute_exact_assignment_only",
      namedSkillUnavailable: highIntensity
        ? "fail_closed"
        : "equivalent_read_only_review",
      minimumDebuggingHypotheses: highIntensity ? 0 : 3,
    },
    reportComposer: {
      owner: "firstmate",
      role: "report_composer",
    },
  });
}

export function createFirstmateNativeReviewDecision(
  options: FirstmateNativeReviewDecisionOptions,
): WorkflowDecisionEnvelope {
  return createWorkflowDecisionEnvelope({
    workflowDecisionVersion: 1,
    recipe: {
      id: "native-review",
      version: "0.2.0",
    },
    hashes: {
      intentHash: options.intentHash,
      configHash: sha256(options.configVersion),
      availabilityHash: sha256(JSON.stringify(options.reviewer)),
    },
    sourceLineage: options.source,
    roleAssignments: [options.reviewer, reportComposerAssignment],
    stageAssignments: [
      {
        stageId: "reviewer",
        role: options.reviewer.role,
        barrierId: "review_complete",
      },
      {
        stageId: "report",
        role: "report_composer",
        barrierId: "report_complete",
      },
    ],
    stageBarriers: [
      {
        id: "review_complete",
        afterStageId: "reviewer",
        requires: ["codex_review_thread_read_back"],
      },
      {
        id: "report_complete",
        afterStageId: "report",
        requires: ["review_capsule_read_back"],
      },
    ],
    maxRounds: 1,
    stopConditions: ["review_completed", "failed_closed"],
    fallbackPolicy: {
      behavior: "new_decision_required",
      reason:
        "Codex review adapter may report execution failure, but only Firstmate may issue a different reviewer assignment.",
    },
    executionPolicy: {
      adapterBehavior: "execute_exact_assignment_only",
      namedSkillUnavailable: "fail_closed",
      minimumDebuggingHypotheses: 0,
    },
    reportComposer: {
      owner: "firstmate",
      role: "report_composer",
    },
  });
}

export function workflowDispatchIdempotencyKey(
  canonicalRunId: string,
  decisionHash: string,
  stageId: string,
  round: number | null,
): string {
  return `acm-dispatch-${sha256(JSON.stringify({
    canonicalRunId,
    decisionHash,
    stageId,
    round,
  }))}`;
}

function toWorkflowAssignment(
  assignment: RoleAssignment,
): WorkflowRoleAssignment {
  return {
    role: assignment.role,
    alias: assignment.alias,
    provider: assignment.provider,
    family: assignment.family,
    resolvedModel: assignment.resolvedModel,
    capabilityTier: assignment.capabilityTier,
    reason: assignment.reason,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
