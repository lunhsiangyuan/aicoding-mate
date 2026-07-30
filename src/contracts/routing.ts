import { createHash } from "node:crypto";

export type CapabilityTier = "search" | "implementation" | "architecture";
export type AvailabilityState =
  | "available"
  | "quota_limited"
  | "unavailable"
  | "unknown";

export interface AvailabilityCandidate {
  readonly alias: string;
  readonly provider: string;
  readonly family: string;
  readonly resolvedModel: string;
  readonly capabilityTier: CapabilityTier;
  readonly state: AvailabilityState;
  readonly reason: string | null;
}

export interface AvailabilitySnapshot {
  readonly id: string;
  readonly capturedAt: string;
  readonly candidates: readonly AvailabilityCandidate[];
}

export interface RoutingRequest {
  readonly normalizedInputHash: string;
  readonly configVersionHash: string;
  readonly availabilitySnapshot: AvailabilitySnapshot;
}

export interface WorkflowStageContract {
  readonly id: string;
  readonly role: string;
  readonly modelAlias: string;
}

export interface WorkflowRecipeContract {
  readonly id: string;
  readonly stages: readonly WorkflowStageContract[];
}

export interface RoleAssignment {
  readonly role: string;
  readonly alias: string;
  readonly provider: string;
  readonly family: string;
  readonly resolvedModel: string;
  readonly capabilityTier: CapabilityTier;
  readonly reason: string;
}

export interface FallbackTraceEntry {
  readonly role: string;
  readonly rejectedAlias: string;
  readonly selectedAlias: string | null;
  readonly reason: string;
}

export type DiversityStatus = "cross_family" | "degraded_same_family";

export interface RoutingDecision {
  readonly recipeId: string;
  readonly requestKey: string;
  readonly roleAssignments: readonly RoleAssignment[];
  readonly fallbackTrace: readonly FallbackTraceEntry[];
  readonly diversityStatus: DiversityStatus;
  readonly decidedAt: string;
}

export type RoutingTerminalState =
  | { readonly status: "resolved"; readonly decision: RoutingDecision }
  | {
      readonly status: "ask_user";
      readonly reason: "all_candidates_below_capability_floor";
    }
  | {
      readonly status: "failed_closed";
      readonly reason: "invalid_config" | "invalid_availability_snapshot";
    };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCandidates(
  candidates: readonly AvailabilityCandidate[],
): readonly Record<string, string | null>[] {
  return [...candidates].sort((left, right) => {
    const leftKey = JSON.stringify([
      left.alias,
      left.provider,
      left.family,
      left.resolvedModel,
      left.capabilityTier,
      left.state,
      left.reason,
    ]);
    const rightKey = JSON.stringify([
      right.alias,
      right.provider,
      right.family,
      right.resolvedModel,
      right.capabilityTier,
      right.state,
      right.reason,
    ]);
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  }).map((candidate) => ({
    alias: candidate.alias,
    provider: candidate.provider,
    family: candidate.family,
    resolvedModel: candidate.resolvedModel,
    capabilityTier: candidate.capabilityTier,
    state: candidate.state,
    reason: candidate.reason,
  }));
}

export function availabilitySnapshotHash(
  snapshot: AvailabilitySnapshot,
): string {
  return sha256(
    JSON.stringify({
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      candidates: canonicalCandidates(snapshot.candidates),
    }),
  );
}

export function routingDeterminismKey(request: RoutingRequest): string {
  return sha256(
    JSON.stringify({
      normalizedInputHash: request.normalizedInputHash,
      configVersionHash: request.configVersionHash,
      availabilitySnapshotHash: availabilitySnapshotHash(
        request.availabilitySnapshot,
      ),
    }),
  );
}
