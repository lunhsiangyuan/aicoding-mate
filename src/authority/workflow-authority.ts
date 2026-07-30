import { createHash } from "node:crypto";

import type { CapabilityTier } from "../contracts/routing.ts";
import type { SourceLineage } from "../contracts/ports.ts";

export type WorkflowAuthority = "firstmate";
export type WorkflowFallbackBehavior = "new_decision_required";
export type ReportComposerOwner = "firstmate";

export interface WorkflowRecipeIdentity {
  readonly id: string;
  readonly version: string;
}

export interface WorkflowDecisionHashes {
  readonly intentHash: string;
  readonly configHash: string;
  readonly availabilityHash: string;
}

export interface WorkflowRoleAssignment {
  readonly role: string;
  readonly alias: string;
  readonly provider: string;
  readonly family: string;
  readonly resolvedModel: string;
  readonly capabilityTier: CapabilityTier;
  readonly reason: string;
}

export interface WorkflowStageAssignment {
  readonly stageId: string;
  readonly role: string;
  readonly barrierId: string;
}

export interface WorkflowStageBarrier {
  readonly id: string;
  readonly afterStageId: string;
  readonly requires: readonly string[];
}

export interface WorkflowFallbackPolicy {
  readonly behavior: WorkflowFallbackBehavior;
  readonly reason: string;
}

export interface WorkflowReportComposer {
  readonly owner: ReportComposerOwner;
  readonly role: "report_composer";
}

export interface WorkflowDecisionEnvelope {
  readonly workflowDecisionId: string;
  readonly workflowDecisionVersion: number;
  readonly authority: WorkflowAuthority;
  readonly recipe: WorkflowRecipeIdentity;
  readonly hashes: WorkflowDecisionHashes;
  readonly sourceLineage: SourceLineage;
  readonly roleAssignments: readonly WorkflowRoleAssignment[];
  readonly stageAssignments: readonly WorkflowStageAssignment[];
  readonly stageBarriers: readonly WorkflowStageBarrier[];
  readonly maxRounds: number;
  readonly stopConditions: readonly string[];
  readonly fallbackPolicy: WorkflowFallbackPolicy;
  readonly reportComposer: WorkflowReportComposer;
  readonly decisionHash: string;
}

export interface WorkflowDecisionInput {
  readonly workflowDecisionVersion: number;
  readonly recipe: WorkflowRecipeIdentity;
  readonly hashes: WorkflowDecisionHashes;
  readonly sourceLineage: SourceLineage;
  readonly roleAssignments: readonly WorkflowRoleAssignment[];
  readonly stageAssignments: readonly WorkflowStageAssignment[];
  readonly stageBarriers: readonly WorkflowStageBarrier[];
  readonly maxRounds: number;
  readonly stopConditions: readonly string[];
  readonly fallbackPolicy: WorkflowFallbackPolicy;
  readonly reportComposer: WorkflowReportComposer;
}

export interface ExactWorkflowStageAssignment {
  readonly workflowDecisionId: string;
  readonly workflowDecisionVersion: number;
  readonly decisionHash: string;
  readonly stage: WorkflowStageAssignment;
  readonly roleAssignment: WorkflowRoleAssignment;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type WorkflowDecisionPreimage = Omit<
  WorkflowDecisionEnvelope,
  "workflowDecisionId" | "decisionHash"
>;

export function createWorkflowDecisionEnvelope(
  input: WorkflowDecisionInput,
): WorkflowDecisionEnvelope {
  const preimage = freezeWorkflowPreimage({
    workflowDecisionVersion: input.workflowDecisionVersion,
    authority: "firstmate",
    recipe: {
      id: input.recipe.id,
      version: input.recipe.version,
    },
    hashes: {
      intentHash: input.hashes.intentHash,
      configHash: input.hashes.configHash,
      availabilityHash: input.hashes.availabilityHash,
    },
    sourceLineage: {
      taskId: input.sourceLineage.taskId,
      runId: input.sourceLineage.runId,
      workspace: input.sourceLineage.workspace,
      tabId: input.sourceLineage.tabId,
      paneId: input.sourceLineage.paneId,
    },
    roleAssignments: input.roleAssignments.map((assignment) => ({
      role: assignment.role,
      alias: assignment.alias,
      provider: assignment.provider,
      family: assignment.family,
      resolvedModel: assignment.resolvedModel,
      capabilityTier: assignment.capabilityTier,
      reason: assignment.reason,
    })),
    stageAssignments: input.stageAssignments.map((assignment) => ({
      stageId: assignment.stageId,
      role: assignment.role,
      barrierId: assignment.barrierId,
    })),
    stageBarriers: input.stageBarriers.map((barrier) => ({
      id: barrier.id,
      afterStageId: barrier.afterStageId,
      requires: [...barrier.requires],
    })),
    maxRounds: input.maxRounds,
    stopConditions: [...input.stopConditions],
    fallbackPolicy: {
      behavior: input.fallbackPolicy.behavior,
      reason: input.fallbackPolicy.reason,
    },
    reportComposer: {
      owner: input.reportComposer.owner,
      role: input.reportComposer.role,
    },
  });
  const workflowDecisionId = workflowDecisionIdFor(preimage);
  const envelopeWithoutHash = {
    workflowDecisionId,
    ...preimage,
  };
  const decisionHash = hashCanonical(envelopeWithoutHash);
  const envelope: WorkflowDecisionEnvelope = {
    ...envelopeWithoutHash,
    decisionHash,
  };

  assertWorkflowDecisionEnvelope(envelope);
  return deepFreeze(envelope);
}

export function readWorkflowDecisionEnvelope(
  serializedOrValue: string | unknown,
): WorkflowDecisionEnvelope {
  const value: unknown =
    typeof serializedOrValue === "string"
      ? JSON.parse(serializedOrValue)
      : serializedOrValue;
  assertWorkflowDecisionEnvelope(value);
  return deepFreeze(value);
}

export function assertWorkflowDecisionEnvelope(
  value: unknown,
): asserts value is WorkflowDecisionEnvelope {
  const envelope = requireObject(value, "workflow_decision_envelope_invalid");
  const workflowDecisionId = requireString(
    envelope.workflowDecisionId,
    "workflow_decision_id_missing",
  );
  const workflowDecisionVersion = requireNumber(
    envelope.workflowDecisionVersion,
    "workflow_decision_version_missing",
  );
  if (workflowDecisionVersion < 1) {
    throw new Error("workflow_decision_version_invalid");
  }
  if (envelope.authority !== "firstmate") {
    throw new Error("workflow_authority_not_firstmate");
  }
  assertRecipe(envelope.recipe);
  assertHashes(envelope.hashes);
  assertSourceLineage(envelope.sourceLineage);
  const roleAssignments = assertRoleAssignments(envelope.roleAssignments);
  const stageAssignments = assertStageAssignments(
    envelope.stageAssignments,
    roleAssignments,
  );
  const stageBarriers = assertStageBarriers(
    envelope.stageBarriers,
    stageAssignments,
  );
  const maxRounds = assertPositiveInteger(
    envelope.maxRounds,
    "max_rounds_invalid",
  );
  const stopConditions = assertNonEmptyStringArray(
    envelope.stopConditions,
    "stop_conditions_missing",
  );
  assertFallbackPolicy(envelope.fallbackPolicy);
  assertReportComposer(envelope.reportComposer, roleAssignments);
  const expectedWorkflowDecisionId = workflowDecisionIdFor({
    workflowDecisionVersion,
    authority: "firstmate",
    recipe: envelope.recipe,
    hashes: envelope.hashes,
    sourceLineage: envelope.sourceLineage,
    roleAssignments,
    stageAssignments,
    stageBarriers,
    maxRounds,
    stopConditions,
    fallbackPolicy: envelope.fallbackPolicy,
    reportComposer: envelope.reportComposer,
  });
  if (workflowDecisionId !== expectedWorkflowDecisionId) {
    throw new Error("workflow_decision_id_mismatch");
  }
  const expectedDecisionHash = hashCanonical({
    workflowDecisionId,
    workflowDecisionVersion,
    authority: "firstmate",
    recipe: envelope.recipe,
    hashes: envelope.hashes,
    sourceLineage: envelope.sourceLineage,
    roleAssignments,
    stageAssignments,
    stageBarriers,
    maxRounds,
    stopConditions,
    fallbackPolicy: envelope.fallbackPolicy,
    reportComposer: envelope.reportComposer,
  });
  if (envelope.decisionHash !== expectedDecisionHash) {
    throw new Error("workflow_decision_hash_mismatch");
  }
}

export function lookupExactStageAssignment(
  envelope: WorkflowDecisionEnvelope,
  stageId: string,
): ExactWorkflowStageAssignment {
  assertWorkflowDecisionEnvelope(envelope);
  const stage = envelope.stageAssignments.find(
    (assignment) => assignment.stageId === stageId,
  );
  if (!stage) {
    throw new Error(`stage_assignment_missing:${stageId}`);
  }
  const roleAssignment = envelope.roleAssignments.find(
    (assignment) => assignment.role === stage.role,
  );
  if (!roleAssignment) {
    throw new Error(`stage_role_assignment_missing:${stage.role}`);
  }
  return deepFreeze({
    workflowDecisionId: envelope.workflowDecisionId,
    workflowDecisionVersion: envelope.workflowDecisionVersion,
    decisionHash: envelope.decisionHash,
    stage,
    roleAssignment,
  });
}

export function workflowDecisionHash(
  envelope: WorkflowDecisionEnvelope,
): string {
  assertWorkflowDecisionEnvelope(envelope);
  return envelope.decisionHash;
}

export function workflowDecisionCanonicalJson(
  envelope: WorkflowDecisionEnvelope,
): string {
  assertWorkflowDecisionEnvelope(envelope);
  return canonicalJson(envelope);
}

function assertRecipe(value: unknown): asserts value is WorkflowRecipeIdentity {
  const recipe = requireObject(value, "recipe_missing");
  requireString(recipe.id, "recipe_id_missing");
  requireString(recipe.version, "recipe_version_missing");
}

function assertHashes(value: unknown): asserts value is WorkflowDecisionHashes {
  const hashes = requireObject(value, "decision_hash_inputs_missing");
  assertSha256(hashes.intentHash, "intent_hash_invalid");
  assertSha256(hashes.configHash, "config_hash_invalid");
  assertSha256(hashes.availabilityHash, "availability_hash_invalid");
}

function assertSourceLineage(value: unknown): asserts value is SourceLineage {
  const source = requireObject(value, "source_lineage_missing");
  requireString(source.taskId, "source_task_id_missing");
  requireString(source.runId, "source_run_id_missing");
  requireString(source.workspace, "source_workspace_missing");
  requireString(source.tabId, "source_tab_id_missing");
  requireString(source.paneId, "source_pane_id_missing");
}

function assertRoleAssignments(
  value: unknown,
): readonly WorkflowRoleAssignment[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("role_assignments_missing");
  }
  const roles = new Set<string>();
  for (const item of value) {
    const assignment = requireObject(item, "role_assignment_invalid");
    const role = requireString(assignment.role, "role_missing");
    if (roles.has(role)) {
      throw new Error(`role_assignment_duplicate:${role}`);
    }
    roles.add(role);
    requireString(assignment.alias, "role_alias_missing");
    requireString(assignment.provider, "role_provider_missing");
    requireString(assignment.family, "role_family_missing");
    requireString(assignment.resolvedModel, "role_resolved_model_missing");
    assertCapabilityTier(assignment.capabilityTier);
    requireString(assignment.reason, "role_reason_missing");
  }
  return value;
}

function assertStageAssignments(
  value: unknown,
  roleAssignments: readonly WorkflowRoleAssignment[],
): readonly WorkflowStageAssignment[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("stage_assignments_missing");
  }
  const stageIds = new Set<string>();
  const roles = new Set(roleAssignments.map((assignment) => assignment.role));
  for (const item of value) {
    const assignment = requireObject(item, "stage_assignment_invalid");
    const stageId = requireString(assignment.stageId, "stage_id_missing");
    if (stageIds.has(stageId)) {
      throw new Error(`stage_assignment_duplicate:${stageId}`);
    }
    stageIds.add(stageId);
    const role = requireString(assignment.role, "stage_role_missing");
    if (!roles.has(role)) {
      throw new Error(`stage_role_assignment_missing:${role}`);
    }
    requireString(assignment.barrierId, "stage_barrier_id_missing");
  }
  return value;
}

function assertStageBarriers(
  value: unknown,
  stageAssignments: readonly WorkflowStageAssignment[],
): readonly WorkflowStageBarrier[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("stage_barriers_missing");
  }
  const stageIds = new Set(
    stageAssignments.map((assignment) => assignment.stageId),
  );
  const barrierIds = new Set<string>();
  for (const item of value) {
    const barrier = requireObject(item, "stage_barrier_invalid");
    const id = requireString(barrier.id, "stage_barrier_id_missing");
    if (barrierIds.has(id)) {
      throw new Error(`stage_barrier_duplicate:${id}`);
    }
    barrierIds.add(id);
    const afterStageId = requireString(
      barrier.afterStageId,
      "stage_barrier_after_stage_missing",
    );
    if (!stageIds.has(afterStageId)) {
      throw new Error(`stage_barrier_after_stage_unknown:${afterStageId}`);
    }
    assertNonEmptyStringArray(
      barrier.requires,
      `stage_barrier_requires_missing:${id}`,
    );
  }
  return value;
}

function assertFallbackPolicy(
  value: unknown,
): asserts value is WorkflowFallbackPolicy {
  const policy = requireObject(value, "fallback_policy_missing");
  if (policy.behavior !== "new_decision_required") {
    throw new Error("fallback_policy_not_new_decision_required");
  }
  requireString(policy.reason, "fallback_policy_reason_missing");
}

function assertReportComposer(
  value: unknown,
  roleAssignments: readonly WorkflowRoleAssignment[],
): asserts value is WorkflowReportComposer {
  const composer = requireObject(value, "report_composer_missing");
  if (composer.owner !== "firstmate") {
    throw new Error("report_composer_not_firstmate_owned");
  }
  if (composer.role !== "report_composer") {
    throw new Error("report_composer_role_invalid");
  }
  if (!roleAssignments.some((assignment) => assignment.role === composer.role)) {
    throw new Error("report_composer_assignment_missing");
  }
}

function assertPositiveInteger(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(reason);
  }
  return value;
}

function assertNonEmptyStringArray(
  value: unknown,
  reason: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(reason);
  }
  for (const item of value) {
    requireString(item, reason);
  }
  return value;
}

function assertSha256(value: unknown, reason: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(reason);
  }
}

function assertCapabilityTier(value: unknown): asserts value is CapabilityTier {
  if (
    value !== "search" &&
    value !== "implementation" &&
    value !== "architecture"
  ) {
    throw new Error("role_capability_tier_invalid");
  }
}

function requireObject(
  value: unknown,
  reason: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(reason);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(reason);
  }
  return value;
}

function requireNumber(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(reason);
  }
  return value;
}

function workflowDecisionIdFor(preimage: WorkflowDecisionPreimage): string {
  return `wfd_${hashCanonical(preimage).slice(0, 32)}`;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  const record = requireObject(value, "canonical_json_object_invalid");
  const canonical: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) {
      canonical[key] = toJsonValue(item);
    }
  }
  return canonical;
}

function freezeWorkflowPreimage(
  value: WorkflowDecisionPreimage,
): WorkflowDecisionPreimage {
  return deepFreeze(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const property of Object.values(value)) {
    deepFreeze(property);
  }
  return value;
}
