import { createHash } from "node:crypto";

import type {
  AvailabilitySnapshot,
  RoutingDecision,
  SourceLineage,
  WorkflowDecisionEnvelope,
  WorkflowRoleAssignment,
} from "../contracts/index.ts";
import {
  lookupExactStageAssignment,
  type ExactWorkflowStageAssignment,
} from "./workflow-authority.ts";
import {
  planStandardWorkflow,
  type NormalizedStandardInput,
  type StandardWorkflowInput,
} from "../routing/standard.ts";
import {
  routeHighIntensityWorkflow,
  type HighIntensityInput,
} from "../workflows/high-intensity.ts";
import { loadNativeReviewModelConfig } from "../config/runtime-models.ts";
import {
  FileFirstmateDecisionAuthority,
  resolveFirstmateAuthorityRoot,
  type FirstmateDecisionAuthorityPort,
  type FirstmateDecisionReceipt,
} from "./firstmate-decision-authority.ts";
import {
  createFirstmateNativeReviewDecision,
  createFirstmateWorkflowDecision,
} from "./firstmate-decisions.ts";

export type FirstmateWorkflowAuthorityFailure = {
  readonly status: "blocked";
  readonly reason: string;
};

export type FirstmateStandardDecisionResult =
  | {
      readonly status: "resolved";
      readonly normalizedInput: NormalizedStandardInput;
      readonly configVersion: string;
      readonly repairRounds: number;
      readonly routingDecision: RoutingDecision;
      readonly workflowDecision: WorkflowDecisionEnvelope;
      readonly receipt: FirstmateDecisionReceipt;
    }
  | (FirstmateWorkflowAuthorityFailure & {
      readonly normalizedInput: NormalizedStandardInput;
      readonly routingDecision: RoutingDecision | null;
    });

export type FirstmateHighIntensityDecisionResult =
  | {
      readonly status: "resolved";
      readonly routingDecision: RoutingDecision;
      readonly workflowDecision: WorkflowDecisionEnvelope;
      readonly receipt: FirstmateDecisionReceipt;
    }
  | (FirstmateWorkflowAuthorityFailure & {
      readonly routingDecision: RoutingDecision | null;
    });

export type FirstmateNativeReviewDecisionResult =
  | {
      readonly status: "resolved";
      readonly reviewer: WorkflowRoleAssignment;
      readonly workflowDecision: WorkflowDecisionEnvelope;
      readonly receipt: FirstmateDecisionReceipt;
    }
  | FirstmateWorkflowAuthorityFailure;

export interface FirstmateWorkflowAuthorityPort {
  decideStandard(input: {
    readonly workflowInput: StandardWorkflowInput;
    readonly availability: AvailabilitySnapshot;
    readonly source: SourceLineage;
  }): FirstmateStandardDecisionResult;
  decideHighIntensity(input: {
    readonly workflowInput: HighIntensityInput;
    readonly availability: AvailabilitySnapshot;
    readonly source: SourceLineage;
    readonly recipe: "adversarial" | "research";
  }): FirstmateHighIntensityDecisionResult;
  decideNativeReview(input: {
    readonly intentHash: string;
    readonly availability: AvailabilitySnapshot;
    readonly source: SourceLineage;
  }): FirstmateNativeReviewDecisionResult;
  authorizeStage(input: {
    readonly workflowDecision: WorkflowDecisionEnvelope;
    readonly receipt: FirstmateDecisionReceipt;
    readonly stageId: string;
  }): ExactWorkflowStageAssignment;
}

export interface FileFirstmateWorkflowAuthorityOptions {
  readonly stateDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly decisionStore?: FirstmateDecisionAuthorityPort;
}

export class FileFirstmateWorkflowAuthority
  implements FirstmateWorkflowAuthorityPort
{
  readonly #store: FirstmateDecisionAuthorityPort;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: FileFirstmateWorkflowAuthorityOptions) {
    this.#env = options.env ?? {};
    this.#store = options.decisionStore
      ?? new FileFirstmateDecisionAuthority({
        rootDir: resolveFirstmateAuthorityRoot(
          options.stateDir,
          this.#env,
        ),
        now: options.now,
      });
  }

  decideStandard(input: {
    readonly workflowInput: StandardWorkflowInput;
    readonly availability: AvailabilitySnapshot;
    readonly source: SourceLineage;
  }): FirstmateStandardDecisionResult {
    const plan = planStandardWorkflow({
      input: input.workflowInput,
      availability: input.availability,
    });
    if (plan.routing.status !== "resolved") {
      return {
        status: "blocked",
        reason: `routing_${plan.routing.status}:${plan.routing.reason}`,
        normalizedInput: plan.normalizedInput,
        routingDecision: null,
      };
    }
    const decision = createFirstmateWorkflowDecision({
      recipe: "standard",
      intentHash: plan.normalizedInput.hash,
      configVersion: plan.config.versionHash,
      availability: input.availability,
      routingDecision: plan.routing.decision,
      source: input.source,
    });
    const issued = this.#issue(decision);
    if (issued.status === "blocked") {
      return {
        ...issued,
        normalizedInput: plan.normalizedInput,
        routingDecision: plan.routing.decision,
      };
    }
    return {
      status: "resolved",
      normalizedInput: plan.normalizedInput,
      configVersion: plan.config.versionHash,
      repairRounds: plan.config.recipe.repairRounds,
      routingDecision: plan.routing.decision,
      workflowDecision: decision,
      receipt: issued.receipt,
    };
  }

  decideHighIntensity(input: {
    readonly workflowInput: HighIntensityInput;
    readonly availability: AvailabilitySnapshot;
    readonly source: SourceLineage;
    readonly recipe: "adversarial" | "research";
  }): FirstmateHighIntensityDecisionResult {
    const routed = routeHighIntensityWorkflow(
      input.workflowInput,
      input.availability,
    );
    if (routed.status !== "resolved") {
      return {
        status: "blocked",
        reason: `routing_${routed.status}:${routed.reason}`,
        routingDecision: null,
      };
    }
    const decision = createFirstmateWorkflowDecision({
      recipe: input.recipe,
      intentHash: highIntensityInputHash(input.workflowInput),
      configVersion:
        input.workflowInput.configVersionHash
        ?? `${input.recipe}-high-intensity-v0.2`,
      availability: input.availability,
      routingDecision: routed.decision,
      source: input.source,
    });
    const issued = this.#issue(decision);
    if (issued.status === "blocked") {
      return {
        ...issued,
        routingDecision: routed.decision,
      };
    }
    return {
      status: "resolved",
      routingDecision: routed.decision,
      workflowDecision: decision,
      receipt: issued.receipt,
    };
  }

  decideNativeReview(input: {
    readonly intentHash: string;
    readonly availability: AvailabilitySnapshot;
    readonly source: SourceLineage;
  }): FirstmateNativeReviewDecisionResult {
    if (
      !input.availability.candidates.some(
        (candidate) => candidate.state === "available",
      )
    ) {
      return {
        status: "blocked",
        reason: "native_review_unavailable:no_available_app_server",
      };
    }
    let configured;
    try {
      configured = loadNativeReviewModelConfig(this.#env);
    } catch (error) {
      return {
        status: "blocked",
        reason: `model_policy_invalid:${compactError(error)}`,
      };
    }
    const reviewer: WorkflowRoleAssignment = {
      role: "reviewer",
      alias: configured.alias,
      provider: configured.family,
      family: configured.family,
      resolvedModel:
        nonEmpty(this.#env.ACM_CODEX_REVIEW_MODEL) ?? configured.model,
      capabilityTier: "architecture",
      reason:
        "Firstmate assigns Codex native review so the adapter only executes an exact reviewer assignment.",
    };
    const decision = createFirstmateNativeReviewDecision({
      intentHash: input.intentHash,
      configVersion: "native-review-v0.2",
      availability: input.availability,
      source: input.source,
      reviewer,
    });
    const issued = this.#issue(decision);
    if (issued.status === "blocked") return issued;
    return {
      status: "resolved",
      reviewer,
      workflowDecision: decision,
      receipt: issued.receipt,
    };
  }

  authorizeStage(input: {
    readonly workflowDecision: WorkflowDecisionEnvelope;
    readonly receipt: FirstmateDecisionReceipt;
    readonly stageId: string;
  }): ExactWorkflowStageAssignment {
    if (
      this.#store.readDecision(
        input.workflowDecision,
        input.receipt.receiptPath,
      ) === undefined
    ) {
      throw new Error("firstmate_stage_authorization_readback_failed");
    }
    return lookupExactStageAssignment(
      input.workflowDecision,
      input.stageId,
    );
  }

  #issue(
    decision: WorkflowDecisionEnvelope,
  ):
    | { readonly status: "resolved"; readonly receipt: FirstmateDecisionReceipt }
    | FirstmateWorkflowAuthorityFailure {
    try {
      const receipt = this.#store.issueDecision(decision);
      if (this.#store.readDecision(decision, receipt.receiptPath) === undefined) {
        throw new Error("firstmate_decision_receipt_readback_failed");
      }
      return { status: "resolved", receipt };
    } catch (error) {
      return {
        status: "blocked",
        reason: `firstmate_decision_issuance_failed:${compactError(error)}`,
      };
    }
  }
}

function highIntensityInputHash(input: HighIntensityInput): string {
  return createHash("sha256").update(JSON.stringify({
    task: input.task.trim().replace(/\s+/g, " "),
    subquestions: input.subquestions.map((subquestion) =>
      subquestion.trim().replace(/\s+/g, " ")
    ),
  })).digest("hex");
}

function compactError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").trim()
    : "unknown_error";
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
