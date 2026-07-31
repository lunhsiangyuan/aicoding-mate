import { createHash } from "node:crypto";

import type {
  AvailabilityCandidate,
  AvailabilitySnapshot,
  CapabilityTier,
  DecisionReadyReport,
  RoleAssignment,
  RoutingDecision,
  RoutingRequest,
  RoutingTerminalState,
} from "../contracts/index.ts";
import { routingDeterminismKey } from "../contracts/index.ts";

export type HighIntensityRole = "search" | "author" | "challenger" | "judge";
export type ResearchCategory = "confirmed" | "candidate" | "inference" | "unknown";
export type HighIntensityStopReason =
  | "judge_accepted"
  | "judge_rejected"
  | "max_rounds_reached";

export interface HighIntensityInput {
  readonly task: string;
  readonly subquestions: readonly string[];
  readonly configVersionHash?: string;
}

export interface DiscoveryObservation {
  readonly id: string;
  readonly subquestion: string;
  readonly statement: string;
  readonly category: ResearchCategory;
  readonly sourceIds: readonly string[];
  readonly lineage: readonly string[];
  readonly counterexample?: boolean;
  readonly limitation?: string;
}

export interface ResearchPartition {
  readonly discoveryDenominator: readonly DiscoveryObservation[];
  readonly confirmed: readonly DiscoveryObservation[];
  readonly candidate: readonly DiscoveryObservation[];
  readonly inference: readonly DiscoveryObservation[];
  readonly unknown: readonly DiscoveryObservation[];
}

export interface CoverageMapping {
  readonly subquestion: string;
  readonly evidenceIds: readonly string[];
  readonly categories: readonly ResearchCategory[];
  readonly gap: string | null;
}

export interface CoverageReview {
  readonly complete: boolean;
  readonly mappings: readonly CoverageMapping[];
  readonly gaps: readonly string[];
}

export interface JudgeRoundDecision {
  readonly accepted: boolean;
  readonly acceptedReasons: readonly string[];
  readonly rejectedReasons: readonly string[];
}

export interface AdversarialRound {
  readonly round: number;
  readonly authorClaim: string;
  readonly challengerCounterexample: string;
  readonly judge: JudgeRoundDecision;
}

export interface AdversarialReviewResult {
  readonly rounds: readonly AdversarialRound[];
  readonly stopReason: HighIntensityStopReason;
  readonly accepted: boolean;
}

export interface HighIntensityReportOptions {
  readonly input: HighIntensityInput;
  readonly routingDecision: RoutingDecision;
  readonly availability: AvailabilitySnapshot;
  readonly research: ResearchPartition;
  readonly coverage: CoverageReview;
  readonly adversarial: AdversarialReviewResult;
}

const tierRank: Record<CapabilityTier, number> = {
  search: 0,
  implementation: 1,
  architecture: 2,
};

const defaultConfigVersionHash = "high-intensity-core-v1";

export function routeHighIntensityWorkflow(
  input: HighIntensityInput,
  availability: AvailabilitySnapshot,
): RoutingTerminalState {
  if (!validInput(input) || !validAvailability(availability)) {
    return { status: "failed_closed", reason: "invalid_availability_snapshot" };
  }

  const search = selectCandidate(availability, "search", [], [], "search");
  if (!search) {
    return { status: "failed_closed", reason: "invalid_availability_snapshot" };
  }
  const author = selectCandidate(availability, "implementation", [], [], "author");
  if (!author) {
    return { status: "failed_closed", reason: "invalid_availability_snapshot" };
  }
  const challenger = selectCandidate(
    availability,
    "implementation",
    [author.family],
    [],
    "challenger",
  );
  if (!challenger) {
    return { status: "failed_closed", reason: "invalid_availability_snapshot" };
  }
  const judge = selectCandidate(
    availability,
    "architecture",
    [],
    [author.alias, challenger.alias],
    "judge",
  );
  if (!judge) {
    return { status: "failed_closed", reason: "invalid_availability_snapshot" };
  }

  const request: RoutingRequest = {
    normalizedInputHash: inputHash(input),
    configVersionHash: input.configVersionHash ?? defaultConfigVersionHash,
    availabilitySnapshot: availability,
  };
  const roleAssignments = [
    assignmentFor("search", search, "recall-first discovery; floor=search"),
    assignmentFor("author", author, "adversarial author; floor=implementation"),
    assignmentFor(
      "challenger",
      challenger,
      `adversarial challenger; floor=implementation; different_family_from=${author.family}`,
    ),
    assignmentFor("judge", judge, "independent judge; floor=architecture"),
  ];
  const decision: RoutingDecision = {
    recipeId: "high_intensity",
    requestKey: routingDeterminismKey(request),
    roleAssignments,
    fallbackTrace: [],
    diversityStatus: "cross_family",
    decidedAt: availability.capturedAt,
  };
  return { status: "resolved", decision };
}

export function partitionRecallFirstResearch(
  observations: readonly DiscoveryObservation[],
): ResearchPartition {
  const denominator = [...observations];
  return {
    discoveryDenominator: denominator,
    confirmed: denominator.filter((item) => item.category === "confirmed"),
    candidate: denominator.filter((item) => item.category === "candidate"),
    inference: denominator.filter((item) => item.category === "inference"),
    unknown: denominator.filter((item) => item.category === "unknown"),
  };
}

export function reviewCoverage(
  subquestions: readonly string[],
  research: ResearchPartition,
): CoverageReview {
  const mappings = subquestions.map((subquestion) => {
    const evidence = research.discoveryDenominator.filter(
      (item) => item.subquestion === subquestion,
    );
    const actionable = evidence.filter((item) => item.category !== "unknown");
    const categories = uniqueSorted(evidence.map((item) => item.category));
    return {
      subquestion,
      evidenceIds: evidence.map((item) => item.id),
      categories,
      gap: actionable.length === 0 ? `coverage_gap:${subquestion}` : null,
    };
  });
  const gaps = mappings.flatMap((mapping) => mapping.gap ? [mapping.gap] : []);
  return {
    complete: gaps.length === 0,
    mappings,
    gaps,
  };
}

export function runAdversarialReview(
  rounds: readonly AdversarialRound[],
  maxRounds = 2,
): AdversarialReviewResult {
  const roundLimit = Math.min(Math.max(maxRounds, 0), 2);
  const executed: AdversarialRound[] = [];
  for (const round of rounds.slice(0, roundLimit)) {
    assertJudgeDecision(round.judge);
    executed.push(round);
    if (round.judge.accepted) {
      return {
        rounds: executed,
        stopReason: "judge_accepted",
        accepted: true,
      };
    }
  }
  if (executed.length < roundLimit) {
    return {
      rounds: executed,
      stopReason: "judge_rejected",
      accepted: false,
    };
  }
  return {
    rounds: executed,
    stopReason: "max_rounds_reached",
    accepted: false,
  };
}

export function composeHighIntensityReport(
  options: HighIntensityReportOptions,
): DecisionReadyReport {
  const counterexamples = options.research.discoveryDenominator
    .filter((item) => item.counterexample)
    .map((item) => `counterexample:${item.id}:${item.statement}`);
  const limits = options.research.discoveryDenominator
    .flatMap((item) => item.limitation ? [`limit:${item.id}:${item.limitation}`] : []);
  const assignmentEntries = options.routingDecision.roleAssignments.map((assignment) =>
    structuredEntry("assignment", {
      role: assignment.role,
      alias: assignment.alias,
      provider: assignment.provider,
      family: assignment.family,
      resolvedModel: assignment.resolvedModel,
      capabilityTier: assignment.capabilityTier,
      reason: assignment.reason,
    }),
  );
  const observationEntries = options.research.discoveryDenominator.map((observation) =>
    structuredEntry("observation", {
      id: observation.id,
      subquestion: observation.subquestion,
      statement: observation.statement,
      category: observation.category,
      sourceIds: [...observation.sourceIds],
      lineage: [...observation.lineage],
      counterexample: observation.counterexample === true,
      limitation: observation.limitation ?? null,
    }),
  );
  const coverageEntries = options.coverage.mappings.map((mapping) =>
    structuredEntry("coverage", {
      subquestion: mapping.subquestion,
      evidenceIds: [...mapping.evidenceIds],
      categories: [...mapping.categories],
      gap: mapping.gap,
    }),
  );
  const judgeRoundEntries = options.adversarial.rounds.map((round) =>
    structuredEntry("judge_round", {
      round: round.round,
      authorClaim: round.authorClaim,
      challengerCounterexample: round.challengerCounterexample,
      accepted: round.judge.accepted,
      acceptedReasons: [...round.judge.acceptedReasons],
      rejectedReasons: [...round.judge.rejectedReasons],
    }),
  );
  const lineage = [
    `input:${inputHash(options.input)}`,
    `routing:${options.routingDecision.requestKey}`,
    `availability:${options.availability.id}`,
    ...assignmentEntries,
    ...observationEntries,
    ...coverageEntries,
    ...judgeRoundEntries,
    `denominator:${options.research.discoveryDenominator.map((item) => item.id).join(",")}`,
    `stop_reason:${options.adversarial.stopReason}`,
  ];
  return {
    schemaVersion: 1,
    mainReport: {
      conclusion: options.adversarial.accepted
        ? `高強度工作流已由獨立評審接受：${options.input.task}`
        : `高強度工作流在對抗審查後仍未完成：${options.input.task}`,
      impact: options.coverage.complete
        ? "所有原始子問題都有非未知類別的支持證據。"
        : `仍有覆蓋缺口：${options.coverage.gaps.join("; ")}`,
      nextAction: options.adversarial.accepted && options.coverage.complete
        ? "可進入根層整合審查。"
        : "整合前需先補齊覆蓋缺口或處理評審拒絕理由。",
    },
    evidenceLayer: {
      configVersionHash: options.input.configVersionHash ?? defaultConfigVersionHash,
      availabilitySnapshotId: options.availability.id,
      routingDecisionKey: options.routingDecision.requestKey,
      lineage,
      limitations: [
        ...counterexamples,
        ...limits,
        ...options.coverage.gaps.map((gap) => `coverage_gap:${gap}`),
        `stop_reason:${options.adversarial.stopReason}`,
      ],
      unknowns: options.research.unknown.map((item) => `unknown:${item.id}:${item.statement}`),
    },
  };
}

function selectCandidate(
  availability: AvailabilitySnapshot,
  floor: CapabilityTier,
  excludedFamilies: readonly string[],
  excludedAliases: readonly string[] = [],
  roleHint = "",
): AvailabilityCandidate | null {
  return sortCandidates(
    availability.candidates.filter(
      (candidate) =>
        candidate.state === "available"
        && tierRank[candidate.capabilityTier] >= tierRank[floor]
        && !excludedFamilies.includes(candidate.family)
        && !excludedAliases.includes(candidate.alias),
    ),
    roleHint,
  )[0] ?? null;
}

function assignmentFor(
  role: HighIntensityRole,
  candidate: AvailabilityCandidate,
  reason: string,
): RoleAssignment {
  return {
    role,
    alias: candidate.alias,
    provider: candidate.provider,
    family: candidate.family,
    resolvedModel: candidate.resolvedModel,
    capabilityTier: candidate.capabilityTier,
    reason,
  };
}

function assertJudgeDecision(judge: JudgeRoundDecision): void {
  if (judge.accepted && judge.acceptedReasons.length === 0) {
    throw new Error("judge_acceptance_requires_reason");
  }
  if (!judge.accepted && judge.rejectedReasons.length === 0) {
    throw new Error("judge_rejection_requires_reason");
  }
}

function validInput(input: HighIntensityInput): boolean {
  return input.task.trim().length > 0
    && input.subquestions.length > 0
    && input.subquestions.every((subquestion) => subquestion.trim().length > 0);
}

function validAvailability(snapshot: AvailabilitySnapshot): boolean {
  if (!snapshot.id.trim() || !snapshot.capturedAt.trim()) return false;
  const aliases = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (!candidate.alias.trim() || aliases.has(candidate.alias)) return false;
    aliases.add(candidate.alias);
    if (!candidate.provider.trim() || !candidate.family.trim()) return false;
    if (!candidate.resolvedModel.trim()) return false;
  }
  return snapshot.candidates.length > 0;
}

function sortCandidates(
  candidates: readonly AvailabilityCandidate[],
  roleHint = "",
): readonly AvailabilityCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftRoleRank = roleHint && left.alias.includes(roleHint) ? 0 : 1;
    const rightRoleRank = roleHint && right.alias.includes(roleHint) ? 0 : 1;
    if (leftRoleRank !== rightRoleRank) return leftRoleRank - rightRoleRank;
    const leftRank = tierRank[left.capabilityTier];
    const rightRank = tierRank[right.capabilityTier];
    if (leftRank !== rightRank) return leftRank - rightRank;
    return compareCodeUnit(left.alias, right.alias);
  });
}

function uniqueSorted(values: readonly ResearchCategory[]): readonly ResearchCategory[] {
  return [...new Set(values)].sort(compareCodeUnit);
}

function compareCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function structuredEntry(prefix: string, value: Record<string, unknown>): string {
  return `${prefix}:${stableStringify(value)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareCodeUnit).map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inputHash(input: HighIntensityInput): string {
  return sha256(JSON.stringify({
    task: input.task.trim().replace(/\s+/g, " "),
    subquestions: input.subquestions.map((subquestion) =>
      subquestion.trim().replace(/\s+/g, " "),
    ),
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
