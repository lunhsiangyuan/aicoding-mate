import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AvailabilitySnapshot } from "../src/contracts/index.ts";
import {
  createHighIntensityRun,
  readHighIntensityRunRecord,
  type HighIntensityModelPort,
  type HighIntensityModelRequest,
} from "../src/integration/high-intensity-runtime.ts";
import type { HighIntensityInput } from "../src/workflows/high-intensity.ts";

const input: HighIntensityInput = {
  task: "Evaluate the high-intensity runtime layer",
  subquestions: [
    "Which evidence is confirmed?",
    "Which candidate counterexample matters?",
    "Which inference is still useful?",
    "What remains unknown?",
  ],
};

const availability: AvailabilitySnapshot = {
  id: "availability-high-runtime-1",
  capturedAt: "2026-07-31T01:00:00.000Z",
  candidates: [
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

describe("high-intensity runtime", () => {
  test("runs research plus two adversarial rounds and writes a durable record", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const port = scriptedPort(requests);

    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: port,
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.record.status).toBe("completed");
    expect(result.record.routingDecision?.recipeId).toBe("high_intensity");
    expect(result.record.calls.map((call) => call.contextId)).toEqual([
      `${result.record.id}:research`,
      `${result.record.id}:round-1:author`,
      `${result.record.id}:round-1:challenger`,
      `${result.record.id}:round-1:judge`,
      `${result.record.id}:round-2:author`,
      `${result.record.id}:round-2:challenger`,
      `${result.record.id}:round-2:judge`,
    ]);
    const authorAssignment = result.record.routingDecision?.roleAssignments.find(
      (assignment) => assignment.role === "author",
    );
    const challengerAssignment = result.record.routingDecision?.roleAssignments.find(
      (assignment) => assignment.role === "challenger",
    );
    const judgeAssignment = result.record.routingDecision?.roleAssignments.find(
      (assignment) => assignment.role === "judge",
    );
    expect(authorAssignment).toBeDefined();
    expect(challengerAssignment).toBeDefined();
    expect(judgeAssignment).toBeDefined();
    if (!authorAssignment || !challengerAssignment || !judgeAssignment) {
      throw new Error("expected complete routing assignments");
    }
    expect(requests[1]?.assignment).toEqual(authorAssignment);
    expect(requests[2]?.assignment).toEqual(challengerAssignment);
    expect(requests[3]?.assignment).toEqual(judgeAssignment);
    expect(requests[6]?.prompt).toContain("second-round revised claim");
    expect(requests[6]?.prompt).toContain("second-round remaining counterexample");
    expect(requests[6]?.prompt).not.toContain("first-round rejected claim");
    expect(requests[6]?.prompt).not.toContain("first-round blocking counterexample");

    expect(result.record.research?.discoveryDenominator.map((item) => item.id)).toEqual([
      "obs-confirmed",
      "obs-candidate",
      "obs-inference",
      "obs-unknown",
    ]);
    expect(result.record.research?.confirmed.map((item) => item.id)).toEqual(["obs-confirmed"]);
    expect(result.record.research?.candidate.map((item) => item.id)).toEqual(["obs-candidate"]);
    expect(result.record.research?.inference.map((item) => item.id)).toEqual(["obs-inference"]);
    expect(result.record.research?.unknown.map((item) => item.id)).toEqual(["obs-unknown"]);
    expect(result.record.coverage?.mappings.length).toBe(4);
    expect(result.record.adversarial?.rounds.map((round) => round.judge.accepted)).toEqual([
      false,
      true,
    ]);
    expect(result.record.adversarial?.rounds[0]?.judge.rejectedReasons).toEqual([
      "first round lacks denominator coverage",
    ]);
    expect(result.record.adversarial?.rounds[1]?.judge.acceptedReasons).toEqual([
      "second round preserves denominator and limitations",
    ]);
    expect(result.record.report?.evidenceLayer.lineage.some((entry) =>
      entry.startsWith("judge_round:") &&
      entry.includes("first round lacks denominator coverage"),
    )).toBe(true);
    expect(result.record.report?.evidenceLayer.limitations).toContain(
      "authority:v0.1 deterministic port-driven core only; unified Workflow Authority and durable Runtime Authority are v0.2 seams",
    );
    expect(result.record.authority.limitation).toContain("v0.2 deferred");
    expect(readHighIntensityRunRecord(result.record.recordPath)?.id).toBe(result.record.id);
  });

  test("fails closed on bad research JSON before adversarial calls", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: {
        async execute(request) {
          requests.push(request);
          return provenance(request, "{not-json");
        },
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("research_json_invalid");
    expect(result.record.calls.map((call) => call.phase)).toEqual(["research"]);
    expect(requests.length).toBe(1);
  });

  test("fixed-clock concurrent runs keep distinct durable lineage", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const now = () => "2026-07-31T01:00:00.000Z";
    const [first, second] = await Promise.all([
      createHighIntensityRun({
        input,
        availability,
        stateDir,
        modelPort: scriptedPort([]),
        now,
      }),
      createHighIntensityRun({
        input,
        availability,
        stateDir,
        modelPort: scriptedPort([]),
        now,
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.record.id).not.toBe(second.record.id);
    expect(first.record.recordPath).not.toBe(second.record.recordPath);
    expect(readHighIntensityRunRecord(first.record.recordPath)?.id).toBe(first.record.id);
    expect(readHighIntensityRunRecord(second.record.recordPath)?.id).toBe(second.record.id);
  });

  test("read-back rejects truncated or path-mismatched records", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: scriptedPort([]),
      now: () => "2026-07-31T01:00:00.000Z",
    });
    const original = readHighIntensityRunRecord(result.record.recordPath);
    expect(original?.id).toBe(result.record.id);

    writeFileSync(result.record.recordPath, JSON.stringify({
      schemaVersion: 1,
      id: result.record.id,
      status: "completed",
      recordPath: result.record.recordPath,
    }));
    expect(readHighIntensityRunRecord(result.record.recordPath)).toBeUndefined();

    writeFileSync(result.record.recordPath, JSON.stringify({
      ...result.record,
      recordPath: join(stateDir, "wrong.json"),
    }));
    expect(readHighIntensityRunRecord(result.record.recordPath)).toBeUndefined();
  });

  test("fails closed with durable record when model port throws", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: {
        async execute() {
          throw new Error("secret provider stack trace");
        },
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe("blocked");
    expect(result.record.blockers).toEqual(["model_execution_failed:research"]);
    expect(result.record.blockers.join("\n")).not.toContain("secret provider stack trace");
    expect(readHighIntensityRunRecord(result.record.recordPath)?.blockers).toEqual([
      "model_execution_failed:research",
    ]);
  });

  test("empty model output fails closed as JSON invalid", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: {
        async execute(request) {
          return provenance(request, "");
        },
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe("blocked");
    expect(result.record.blockers).toContain("research_json_invalid");
    expect(readHighIntensityRunRecord(result.record.recordPath)?.status).toBe("blocked");
  });

  test("fails closed when model provenance differs from routing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: {
        async execute(request) {
          return {
            rawOutput: researchJson(),
            alias: request.assignment.alias,
            family: "wrong-family",
            model: request.assignment.resolvedModel,
          };
        },
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("provenance_mismatch:research");
    expect(result.record.calls).toEqual([]);
  });

  test("fails closed before model calls when judge is below architecture floor", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const lowJudge: AvailabilitySnapshot = {
      ...availability,
      candidates: availability.candidates.map((candidate) =>
        candidate.alias === "gemini-judge"
          ? { ...candidate, capabilityTier: "implementation" as const }
          : candidate,
      ),
    };
    const requests: HighIntensityModelRequest[] = [];

    const result = await createHighIntensityRun({
      input,
      availability: lowJudge,
      stateDir,
      modelPort: {
        async execute(request) {
          requests.push(request);
          return provenance(request, researchJson());
        },
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("routing_failed_closed:invalid_availability_snapshot");
    expect(result.record.routingDecision).toBeNull();
    expect(result.record.calls).toEqual([]);
    expect(requests).toEqual([]);
  });
});

function scriptedPort(requests: HighIntensityModelRequest[]): HighIntensityModelPort {
  return {
    async execute(request) {
      requests.push(request);
      if (request.phase === "research") {
        return provenance(request, researchJson());
      }
      if (request.phase === "author" && request.round === 1) {
        return provenance(request, JSON.stringify({ claim: "first-round rejected claim" }));
      }
      if (request.phase === "challenger" && request.round === 1) {
        return provenance(
          request,
          JSON.stringify({ counterexample: "first-round blocking counterexample" }),
        );
      }
      if (request.phase === "judge" && request.round === 1) {
        return provenance(
          request,
          JSON.stringify({
            accepted: false,
            acceptedReasons: [],
            rejectedReasons: ["first round lacks denominator coverage"],
          }),
        );
      }
      if (request.phase === "author" && request.round === 2) {
        return provenance(request, JSON.stringify({ claim: "second-round revised claim" }));
      }
      if (request.phase === "challenger" && request.round === 2) {
        return provenance(
          request,
          JSON.stringify({ counterexample: "second-round remaining counterexample" }),
        );
      }
      return provenance(
        request,
        JSON.stringify({
          accepted: true,
          acceptedReasons: ["second round preserves denominator and limitations"],
          rejectedReasons: [],
        }),
      );
    },
  };
}

function provenance(
  request: HighIntensityModelRequest,
  rawOutput: string,
) {
  return {
    rawOutput,
    alias: request.assignment.alias,
    family: request.assignment.family,
    model: request.assignment.resolvedModel,
  };
}

function researchJson(): string {
  return JSON.stringify({
    observations: [
      {
        id: "obs-confirmed",
        subquestion: input.subquestions[0],
        statement: "Runtime must write a durable record.",
        category: "confirmed",
        sourceIds: ["runtime-test"],
        lineage: ["tests/high-intensity-runtime.test.ts"],
        counterexample: false,
        limitation: null,
      },
      {
        id: "obs-candidate",
        subquestion: input.subquestions[1],
        statement: "A model can return plausible but unaccepted challenges.",
        category: "candidate",
        sourceIds: ["fake-model"],
        lineage: ["round-1"],
        counterexample: true,
        limitation: null,
      },
      {
        id: "obs-inference",
        subquestion: input.subquestions[2],
        statement: "The judge prompt must be limited to current round context.",
        category: "inference",
        sourceIds: ["prompt-inspection"],
        lineage: ["judge-context"],
        counterexample: false,
        limitation: "Inferred from prompt text inspection.",
      },
      {
        id: "obs-unknown",
        subquestion: input.subquestions[3],
        statement: "Production Firstmate authority remains deferred.",
        category: "unknown",
        sourceIds: [],
        lineage: ["v0.2-authority"],
        counterexample: false,
        limitation: null,
      },
    ],
  });
}
