import { createHash } from "node:crypto";

import type { StandardWorkflowConfig, StandardRoleConfig } from "../config/standard.ts";
import { loadStandardWorkflowConfig } from "../config/standard.ts";
import {
  routingDeterminismKey,
  type AvailabilityCandidate,
  type AvailabilitySnapshot,
  type CapabilityTier,
  type DiversityStatus,
  type FallbackTraceEntry,
  type RoleAssignment,
  type RoutingDecision,
  type RoutingRequest,
  type RoutingTerminalState,
} from "../contracts/routing.ts";

export type StandardRisk = "medium";

export interface StandardWorkflowInput {
  readonly task: string;
  readonly risk: StandardRisk;
  readonly boundaries?: readonly string[];
}

export interface NormalizedStandardInput {
  readonly task: string;
  readonly risk: StandardRisk;
  readonly boundaries: readonly string[];
  readonly hash: string;
}

export interface StandardRouteOptions {
  readonly config: StandardWorkflowConfig;
  readonly input: StandardWorkflowInput;
  readonly availability: AvailabilitySnapshot;
}

export interface StandardPlanOptions {
  readonly input: StandardWorkflowInput;
  readonly availability: AvailabilitySnapshot;
  readonly config?: StandardWorkflowConfig;
}

export interface StandardWorkflowPlan {
  readonly config: StandardWorkflowConfig;
  readonly normalizedInput: NormalizedStandardInput;
  readonly request: RoutingRequest;
  readonly routing: RoutingTerminalState;
}

const tierRank: Record<CapabilityTier, number> = {
  search: 0,
  implementation: 1,
  architecture: 2,
};

export function normalizeStandardInput(input: StandardWorkflowInput): NormalizedStandardInput {
  const task = input.task.trim().replace(/\s+/g, " ");
  const boundaries = [...(input.boundaries ?? [])]
    .map((boundary) => boundary.trim().replace(/\s+/g, " "))
    .filter((boundary) => boundary.length > 0)
    .sort(compareCodeUnit);
  const normalized = {
    task,
    risk: input.risk,
    boundaries,
  };
  return {
    ...normalized,
    hash: sha256(JSON.stringify(normalized)),
  };
}

export function planStandardWorkflow(options: StandardPlanOptions): StandardWorkflowPlan {
  const config = options.config ?? loadStandardWorkflowConfig();
  const normalizedInput = normalizeStandardInput(options.input);
  const request = {
    normalizedInputHash: normalizedInput.hash,
    configVersionHash: config.versionHash,
    availabilitySnapshot: options.availability,
  };
  return {
    config,
    normalizedInput,
    request,
    routing: routeStandardWorkflow({
      config,
      input: options.input,
      availability: options.availability,
    }),
  };
}

export function routeStandardWorkflow(options: StandardRouteOptions): RoutingTerminalState {
  const normalizedInput = normalizeStandardInput(options.input);
  if (options.input.risk !== "medium") {
    return { status: "failed_closed", reason: "invalid_config" };
  }
  if (options.config.status !== "valid" || options.config.recipe.id !== "standard") {
    return { status: "failed_closed", reason: "invalid_config" };
  }
  if (!validAvailability(options.availability)) {
    return { status: "failed_closed", reason: "invalid_availability_snapshot" };
  }

  const authorConfig = roleConfig(options.config, "author");
  const author = selectForRole(authorConfig, options.availability, options.config, undefined);
  if (!author.assignment) {
    return { status: "ask_user", reason: "all_candidates_below_capability_floor" };
  }

  const assignments: RoleAssignment[] = [];
  const fallbackTrace: FallbackTraceEntry[] = [...author.trace];
  let diversityStatus: DiversityStatus = "cross_family";

  for (const role of ["architect", "reviewer", "judge", "search"] as const) {
    const config = roleConfig(options.config, role);
    const preferredDifferentFamily = config.preferDifferentFamilyFrom === "author" || role === "judge";
    const selected = selectForRole(
      config,
      options.availability,
      options.config,
      preferredDifferentFamily ? author.assignment.family : undefined,
    );
    if (!selected.assignment) {
      return { status: "ask_user", reason: "all_candidates_below_capability_floor" };
    }
    fallbackTrace.push(...selected.trace);
    if (selected.degradedSameFamily) diversityStatus = "degraded_same_family";
    if (role === "architect") assignments.unshift(selected.assignment);
    else assignments.push(selected.assignment);
  }

  assignments.splice(1, 0, author.assignment);
  const request: RoutingRequest = {
    normalizedInputHash: normalizedInput.hash,
    configVersionHash: options.config.versionHash,
    availabilitySnapshot: options.availability,
  };
  const requestKey = routingDeterminismKey(request);
  const decision: RoutingDecision = {
    recipeId: "standard",
    requestKey,
    roleAssignments: assignments,
    fallbackTrace,
    diversityStatus,
    decidedAt: options.availability.capturedAt,
  };
  return { status: "resolved", decision };
}

function selectForRole(
  config: StandardRoleConfig,
  snapshot: AvailabilitySnapshot,
  workflowConfig: StandardWorkflowConfig,
  differentFamilyFrom: string | undefined,
): {
  readonly assignment: RoleAssignment | null;
  readonly trace: readonly FallbackTraceEntry[];
  readonly degradedSameFamily: boolean;
} {
  const modelAlias = workflowConfig.modelAliases.find((alias) => alias.id === config.modelAlias);
  const candidatesAtFloor = sortCandidates(
    snapshot.candidates.filter((candidate) => tierRank[candidate.capabilityTier] >= tierRank[config.capabilityFloor]),
    modelAlias?.preferredFamilies ?? [],
  );
  const available = candidatesAtFloor.filter((candidate) => candidate.state === "available");
  const trace: FallbackTraceEntry[] = [];
  const firstRejected = candidatesAtFloor.find((candidate) => candidate.state !== "available");
  const crossFamily = differentFamilyFrom
    ? available.find((candidate) => candidate.family !== differentFamilyFrom)
    : available[0];
  const selected = crossFamily ?? available[0] ?? null;
  if (!selected) return { assignment: null, trace, degradedSameFamily: false };

  if (firstRejected && firstRejected.alias !== selected.alias) {
    trace.push({
      role: config.role,
      rejectedAlias: firstRejected.alias,
      selectedAlias: selected.alias,
      reason: firstRejected.reason ?? firstRejected.state,
    });
  }

  const degradedSameFamily = Boolean(differentFamilyFrom && selected.family === differentFamilyFrom);
  if (degradedSameFamily) {
    const rejectedAlias = available.find((candidate) => candidate.family !== selected.family)?.alias ?? selected.alias;
    trace.push({
      role: config.role,
      rejectedAlias,
      selectedAlias: selected.alias,
      reason: "degraded_same_family",
    });
  }

  return {
    assignment: {
      role: config.role,
      alias: selected.alias,
      provider: selected.provider,
      family: selected.family,
      resolvedModel: selected.resolvedModel,
      capabilityTier: selected.capabilityTier,
      reason: `role=${config.role}; model_alias=${config.modelAlias}; floor=${config.capabilityFloor}`,
    },
    trace,
    degradedSameFamily,
  };
}

function roleConfig(config: StandardWorkflowConfig, role: StandardRoleConfig["role"]): StandardRoleConfig {
  const found = config.roles.find((candidate) => candidate.role === role);
  if (!found) {
    return {
      role,
      modelAlias: "missing",
      capabilityFloor: "architecture",
      effort: "missing",
    };
  }
  return found;
}

function sortCandidates(
  candidates: readonly AvailabilityCandidate[],
  preferredFamilies: readonly string[],
): readonly AvailabilityCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftFamily = preferredFamilies.indexOf(left.family);
    const rightFamily = preferredFamilies.indexOf(right.family);
    const leftFamilyRank = leftFamily >= 0 ? leftFamily : preferredFamilies.length;
    const rightFamilyRank = rightFamily >= 0 ? rightFamily : preferredFamilies.length;
    if (leftFamilyRank !== rightFamilyRank) return leftFamilyRank - rightFamilyRank;
    if (tierRank[left.capabilityTier] !== tierRank[right.capabilityTier]) {
      return tierRank[left.capabilityTier] - tierRank[right.capabilityTier];
    }
    return compareCodeUnit(left.alias, right.alias);
  });
}

function compareCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validAvailability(snapshot: AvailabilitySnapshot): boolean {
  if (!snapshot.id.trim() || !snapshot.capturedAt.trim()) return false;
  const aliases = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (!candidate.alias.trim() || aliases.has(candidate.alias)) return false;
    aliases.add(candidate.alias);
    if (!candidate.provider.trim() || !candidate.family.trim() || !candidate.resolvedModel.trim()) return false;
  }
  return snapshot.candidates.length > 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
