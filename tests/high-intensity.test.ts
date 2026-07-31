import { describe, expect, test } from "bun:test";

import { assertDecisionReadyReport, type AvailabilitySnapshot } from "../src/contracts/index.ts";
import {
  composeHighIntensityReport,
  partitionRecallFirstResearch,
  reviewCoverage,
  routeHighIntensityWorkflow,
  runAdversarialReview,
  type AdversarialRound,
  type DiscoveryObservation,
  type HighIntensityInput,
} from "../src/workflows/high-intensity.ts";

const input: HighIntensityInput = {
  task: "Evaluate a high-intensity architecture decision",
  subquestions: [
    "What should the author build?",
    "What counterexample challenges the design?",
    "What evidence remains unknown?",
  ],
};

const availability: AvailabilitySnapshot = {
  id: "availability-high-intensity-1",
  capturedAt: "2026-07-30T18:00:00.000Z",
  candidates: [
    {
      alias: "openai-search",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-search",
      capabilityTier: "search",
      state: "available",
      reason: null,
    },
    {
      alias: "openai-author",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-author",
      capabilityTier: "implementation",
      state: "available",
      reason: null,
    },
    {
      alias: "anthropic-challenger",
      provider: "anthropic",
      family: "anthropic",
      resolvedModel: "configured-anthropic-challenger",
      capabilityTier: "implementation",
      state: "available",
      reason: null,
    },
    {
      alias: "gemini-judge",
      provider: "google",
      family: "gemini",
      resolvedModel: "configured-gemini-judge",
      capabilityTier: "architecture",
      state: "available",
      reason: null,
    },
  ],
};

const denominator: readonly DiscoveryObservation[] = [
  {
    id: "obs-confirmed",
    subquestion: input.subquestions[0],
    statement: "The author needs a pure core before runtime wiring.",
    category: "confirmed",
    sourceIds: ["contract-routing"],
    lineage: ["src/contracts/routing.ts"],
  },
  {
    id: "obs-candidate",
    subquestion: input.subquestions[1],
    statement: "A two-family adversarial pair may expose provider-specific assumptions.",
    category: "candidate",
    sourceIds: ["model-policy"],
    lineage: ["config/model-policy.example.yaml"],
    counterexample: true,
  },
  {
    id: "obs-inference",
    subquestion: input.subquestions[0],
    statement: "Coverage review should run after research partitioning.",
    category: "inference",
    sourceIds: ["workflow-recipe"],
    lineage: ["config/workflows.example.yaml"],
    limitation: "Inferred from stage order rather than runtime output.",
  },
  {
    id: "obs-unknown",
    subquestion: input.subquestions[2],
    statement: "External model availability is not proven by this core.",
    category: "unknown",
    sourceIds: [],
    lineage: ["availability-snapshot"],
  },
];

describe("high-intensity workflow core", () => {
  test("routes adversarial author and challenger across model families with an independent judge", () => {
    const routed = routeHighIntensityWorkflow(input, availability);

    expect(routed.status).toBe("resolved");
    if (routed.status !== "resolved") throw new Error("expected resolved route");

    const author = routed.decision.roleAssignments.find((assignment) => assignment.role === "author");
    const search = routed.decision.roleAssignments.find((assignment) => assignment.role === "search");
    const challenger = routed.decision.roleAssignments.find((assignment) => assignment.role === "challenger");
    const judge = routed.decision.roleAssignments.find((assignment) => assignment.role === "judge");

    expect(search?.capabilityTier).toBe("search");
    expect(search?.resolvedModel).toBe("configured-openai-search");
    expect(author?.family).toBe("openai");
    expect(challenger?.family).toBe("anthropic");
    expect(challenger?.family).not.toBe(author?.family);
    expect(judge?.family).toBe("gemini");
    expect(judge?.capabilityTier).toBe("architecture");
    expect(routed.decision.diversityStatus).toBe("cross_family");
  });

  test("fails closed when no architecture-floor judge is available", () => {
    const noJudge: AvailabilitySnapshot = {
      ...availability,
      candidates: availability.candidates.map((candidate) =>
        candidate.alias === "gemini-judge"
          ? { ...candidate, capabilityTier: "implementation" as const }
          : candidate,
      ),
    };

    expect(routeHighIntensityWorkflow(input, noJudge)).toEqual({
      status: "failed_closed",
      reason: "invalid_availability_snapshot",
    });
  });

  test("stops after at most two adversarial rounds and preserves judge reasons", () => {
    const rounds: readonly AdversarialRound[] = [
      {
        round: 1,
        authorClaim: "The core can proceed.",
        challengerCounterexample: "The denominator may be dropped.",
        judge: {
          accepted: false,
          acceptedReasons: [],
          rejectedReasons: ["denominator preservation not yet shown"],
        },
      },
      {
        round: 2,
        authorClaim: "The core now preserves denominator.",
        challengerCounterexample: "Coverage gaps may still be hidden.",
        judge: {
          accepted: false,
          acceptedReasons: [],
          rejectedReasons: ["coverage gap disclosure not yet shown"],
        },
      },
      {
        round: 3,
        authorClaim: "This round must not execute.",
        challengerCounterexample: "Max round limit exceeded.",
        judge: {
          accepted: true,
          acceptedReasons: ["ignored by max-round gate"],
          rejectedReasons: [],
        },
      },
    ];

    const result = runAdversarialReview(rounds, 4);

    expect(result.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(result.stopReason).toBe("max_rounds_reached");
    expect(result.accepted).toBe(false);
    expect(result.rounds[0]?.judge.rejectedReasons).toContain(
      "denominator preservation not yet shown",
    );
  });

  test("recall-first research preserves denominator and partitions all four categories", () => {
    const partition = partitionRecallFirstResearch(denominator);

    expect(partition.discoveryDenominator.map((item) => item.id)).toEqual([
      "obs-confirmed",
      "obs-candidate",
      "obs-inference",
      "obs-unknown",
    ]);
    expect(partition.confirmed.map((item) => item.id)).toEqual(["obs-confirmed"]);
    expect(partition.candidate.map((item) => item.id)).toEqual(["obs-candidate"]);
    expect(partition.inference.map((item) => item.id)).toEqual(["obs-inference"]);
    expect(partition.unknown.map((item) => item.id)).toEqual(["obs-unknown"]);
  });

  test("coverage reviewer maps every original subquestion and reports unknown-only gaps", () => {
    const partition = partitionRecallFirstResearch(denominator);
    const coverage = reviewCoverage(input.subquestions, partition);

    expect(coverage.mappings.map((mapping) => mapping.subquestion)).toEqual([
      ...input.subquestions,
    ]);
    expect(coverage.gaps).toEqual([`coverage_gap:${input.subquestions[2]}`]);
    expect(coverage.complete).toBe(false);
    expect(coverage.mappings[0]?.evidenceIds).toEqual(["obs-confirmed", "obs-inference"]);
  });

  test("two-layer report includes evidence, counterexamples, limits, lineage, and stop reason", () => {
    const routed = routeHighIntensityWorkflow(input, availability);
    expect(routed.status).toBe("resolved");
    if (routed.status !== "resolved") throw new Error("expected resolved route");

    const research = partitionRecallFirstResearch(denominator);
    const coverage = reviewCoverage(input.subquestions, research);
    const adversarial = runAdversarialReview([
      {
        round: 1,
        authorClaim: "The core is ready with explicit limitations.",
        challengerCounterexample: "External availability remains unknown.",
        judge: {
          accepted: false,
          acceptedReasons: [],
          rejectedReasons: ["unknown availability must remain explicit"],
        },
      },
      {
        round: 2,
        authorClaim: "The core preserves all evidence after revision.",
        challengerCounterexample: "Coverage for the unknown subquestion remains a gap.",
        judge: {
          accepted: true,
          acceptedReasons: ["denominator, coverage, and limits are explicit"],
          rejectedReasons: ["coverage gap remains documented"],
        },
      },
    ]);

    const report = composeHighIntensityReport({
      input,
      routingDecision: routed.decision,
      availability,
      research,
      coverage,
      adversarial,
    });

    assertDecisionReadyReport(report);
    expect(report.mainReport.conclusion).toBe(
      "高強度工作流已由獨立評審接受：Evaluate a high-intensity architecture decision",
    );
    expect(report.mainReport.impact).toBe(
      "仍有覆蓋缺口：coverage_gap:What evidence remains unknown?",
    );
    expect(report.mainReport.nextAction).toBe(
      "整合前需先補齊覆蓋缺口或處理評審拒絕理由。",
    );
    expect(report.evidenceLayer.limitations.some((item) =>
      item.includes("v0.2 seams")
    )).toBe(false);
    expect(report.evidenceLayer.limitations).toContain(
      "counterexample:obs-candidate:A two-family adversarial pair may expose provider-specific assumptions.",
    );
    expect(report.evidenceLayer.limitations).toContain(
      "limit:obs-inference:Inferred from stage order rather than runtime output.",
    );
    expect(report.evidenceLayer.limitations).toContain(
      "coverage_gap:coverage_gap:What evidence remains unknown?",
    );
    expect(report.evidenceLayer.limitations).toContain("stop_reason:judge_accepted");
    expect(report.evidenceLayer.unknowns).toEqual([
      "unknown:obs-unknown:External model availability is not proven by this core.",
    ]);
    expect(report.evidenceLayer.lineage).toContain("availability:availability-high-intensity-1");
    expect(report.evidenceLayer.lineage).toContain(
      'assignment:{"alias":"openai-author","capabilityTier":"implementation","family":"openai","provider":"openai","reason":"adversarial author; floor=implementation","resolvedModel":"configured-openai-author","role":"author"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'assignment:{"alias":"anthropic-challenger","capabilityTier":"implementation","family":"anthropic","provider":"anthropic","reason":"adversarial challenger; floor=implementation; different_family_from=openai","resolvedModel":"configured-anthropic-challenger","role":"challenger"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'assignment:{"alias":"gemini-judge","capabilityTier":"architecture","family":"gemini","provider":"google","reason":"independent judge; floor=architecture","resolvedModel":"configured-gemini-judge","role":"judge"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'observation:{"category":"candidate","counterexample":true,"id":"obs-candidate","limitation":null,"lineage":["config/model-policy.example.yaml"],"sourceIds":["model-policy"],"statement":"A two-family adversarial pair may expose provider-specific assumptions.","subquestion":"What counterexample challenges the design?"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'observation:{"category":"unknown","counterexample":false,"id":"obs-unknown","limitation":null,"lineage":["availability-snapshot"],"sourceIds":[],"statement":"External model availability is not proven by this core.","subquestion":"What evidence remains unknown?"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'coverage:{"categories":["confirmed","inference"],"evidenceIds":["obs-confirmed","obs-inference"],"gap":null,"subquestion":"What should the author build?"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'coverage:{"categories":["unknown"],"evidenceIds":["obs-unknown"],"gap":"coverage_gap:What evidence remains unknown?","subquestion":"What evidence remains unknown?"}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'judge_round:{"accepted":false,"acceptedReasons":[],"authorClaim":"The core is ready with explicit limitations.","challengerCounterexample":"External availability remains unknown.","rejectedReasons":["unknown availability must remain explicit"],"round":1}',
    );
    expect(report.evidenceLayer.lineage).toContain(
      'judge_round:{"accepted":true,"acceptedReasons":["denominator, coverage, and limits are explicit"],"authorClaim":"The core preserves all evidence after revision.","challengerCounterexample":"Coverage for the unknown subquestion remains a gap.","rejectedReasons":["coverage gap remains documented"],"round":2}',
    );

    const completeInput: HighIntensityInput = {
      ...input,
      subquestions: [input.subquestions[0]],
    };
    const completeReport = composeHighIntensityReport({
      input: completeInput,
      routingDecision: routed.decision,
      availability,
      research,
      coverage: reviewCoverage(completeInput.subquestions, research),
      adversarial,
    });
    expect(completeReport.mainReport.impact).toBe(
      "所有原始子問題都有非未知類別的支持證據。",
    );
  });
});
