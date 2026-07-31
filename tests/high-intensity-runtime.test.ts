import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { FileFirstmateWorkflowAuthority } from "../src/authority/firstmate-workflow-authority.ts";
import type {
  AvailabilitySnapshot,
  SourceLineage,
} from "../src/contracts/index.ts";
import {
  createHighIntensityRun,
  readHighIntensityRunRecord,
  type HighIntensityModelReadback,
  type HighIntensityModelPort,
  type HighIntensityModelRequest,
} from "../src/integration/high-intensity-runtime.ts";
import { persistModelDispatchReceipt } from "../src/runtime/model-dispatch-receipt.ts";
import { FileRunRegistry } from "../src/runtime/run-registry.ts";
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

const source: SourceLineage = {
  taskId: "task-high-runtime-1",
  runId: "run-high-runtime-1",
  workspace: "workspace-high-runtime-1",
  tabId: "tab-high-runtime-1",
  paneId: "pane-high-runtime-1",
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
      source,
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
    expect(requests[0]?.assignment.role).toBe("search");
    expect(requests[0]?.assignment.capabilityTier).toBe("search");
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
    expect(result.record.workflowDecision?.authority).toBe("firstmate");
    expect(result.record.authority).toMatchObject({
      workflowAuthority: "firstmate_verified",
      runtimeAuthority: "canonical_run_registry_verified",
    });
    expect(result.record.calls.every((call) =>
      call.workflowDecisionId ===
        result.record.workflowDecision?.workflowDecisionId
    )).toBe(true);
    expect(readHighIntensityRunRecord(
      result.record.recordPath,
      authorityRootForRecord(result.record.recordPath),
    )?.id).toBe(result.record.id);
  });

  test("emits observable progress around every model stage", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-progress-"));
    const progress: Array<{
      status: "started" | "completed";
      phase: "research" | "author" | "challenger" | "judge";
      round: number | null;
      completedSteps: number;
      totalSteps: number;
      model: string;
    }> = [];

    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: scriptedPort([]),
      now: () => "2026-07-31T01:00:00.000Z",
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result.ok).toBe(true);
    expect(progress).toHaveLength(14);
    expect(progress[0]).toEqual({
      status: "started",
      phase: "research",
      round: null,
      completedSteps: 0,
      totalSteps: 7,
      model: "configured-openai-search",
    });
    expect(progress[1]).toEqual({
      status: "completed",
      phase: "research",
      round: null,
      completedSteps: 1,
      totalSteps: 7,
      model: "configured-openai-search",
    });
    expect(progress.at(-1)).toEqual({
      status: "completed",
      phase: "judge",
      round: 2,
      completedSteps: 7,
      totalSteps: 7,
      model: "configured-gemini-judge",
    });
  });

  test("fails closed on bad research JSON before adversarial calls", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: {
        async execute(request) {
          requests.push(request);
          return provenance(request, "{not-json");
        },
        readBack: readBackNotFound,
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("research_json_invalid");
    expect(result.record.calls.map((call) => call.phase)).toEqual(["research"]);
    expect(requests.length).toBe(1);
  });

  test("concurrent duplicate intents coalesce into one canonical run", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const now = () => "2026-07-31T01:00:00.000Z";
    const [first, second] = await Promise.all([
      createHighIntensityRun({
        input,
        availability,
        stateDir,
        source,
        modelPort: scriptedPort([]),
        now,
      }),
      createHighIntensityRun({
        input,
        availability,
        stateDir,
        source,
        modelPort: scriptedPort([]),
        now,
      }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first.dedupeStatus, second.dedupeStatus]).toContain(
      "coalesced_active",
    );
    expect(first.record.id).toBe(second.record.id);
    expect(first.record.recordPath).toBe(second.record.recordPath);
    expect(readHighIntensityRunRecord(
      first.record.recordPath,
      authorityRootForRecord(first.record.recordPath),
    )?.id).toBe(
      first.record.id,
    );
  });

  test("read-back rejects truncated or path-mismatched records", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: scriptedPort([]),
      now: () => "2026-07-31T01:00:00.000Z",
    });
    const original = readHighIntensityRunRecord(
      result.record.recordPath,
      authorityRootForRecord(result.record.recordPath),
    );
    expect(original?.id).toBe(result.record.id);

    writeFileSync(result.record.recordPath, JSON.stringify({
      schemaVersion: 1,
      id: result.record.id,
      status: "completed",
      recordPath: result.record.recordPath,
    }));
    expect(readHighIntensityRunRecord(
      result.record.recordPath,
      authorityRootForRecord(result.record.recordPath),
    )).toBeUndefined();

    writeFileSync(result.record.recordPath, JSON.stringify({
      ...result.record,
      recordPath: join(stateDir, "wrong.json"),
    }));
    expect(readHighIntensityRunRecord(
      result.record.recordPath,
      authorityRootForRecord(result.record.recordPath),
    )).toBeUndefined();
  });

  test("fails closed with durable record when model port throws", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: {
        async execute() {
          throw new Error("secret provider stack trace");
        },
        readBack: readBackNotFound,
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe("blocked");
    expect(result.record.blockers).toEqual([
      "model_execution_unknown_outcome:research",
    ]);
    expect(result.record.blockers.join("\n")).not.toContain("secret provider stack trace");
    expect(readHighIntensityRunRecord(
      result.record.recordPath,
      authorityRootForRecord(result.record.recordPath),
    )?.blockers).toEqual([
      "model_execution_unknown_outcome:research",
    ]);
  });

  test("reconciles an unknown model outcome by receipt read-back without redispatch", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const basePort = scriptedPort(requests);
    let lostResearchResult: Awaited<ReturnType<typeof basePort.execute>> | null =
      null;
    let readBacks = 0;
    const port: HighIntensityModelPort = {
      async execute(request) {
        const result = await basePort.execute(request);
        if (request.phase === "research" && lostResearchResult === null) {
          lostResearchResult = result;
          throw new Error("response_lost_after_receipt_persisted");
        }
        return result;
      },
      async readBack(request) {
        readBacks += 1;
        if (request.phase === "research" && lostResearchResult !== null) {
          return { status: "found", result: lostResearchResult };
        }
        return readBackNotFound();
      },
    };

    const first = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: port,
      now: () => "2026-07-31T01:00:00.000Z",
    });
    expect(first.ok).toBe(false);
    expect(first.record.blockers).toContain(
      "model_execution_unknown_outcome:research",
    );

    const recovered = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: port,
      now: () => "2026-07-31T01:01:00.000Z",
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.dedupeStatus).toBe("reconciled");
    expect(readBacks).toBe(1);
    expect(requests.filter((request) => request.phase === "research")).toHaveLength(
      1,
    );
  });

  test("reconciles an unknown model outcome with the original decision after availability changes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const driftedAvailability: AvailabilitySnapshot = {
      ...availability,
      id: "availability-high-runtime-2",
      capturedAt: "2026-07-31T01:01:00.000Z",
    };
    const requests: HighIntensityModelRequest[] = [];
    const basePort = scriptedPort(requests);
    let lostResearchResult: Awaited<ReturnType<typeof basePort.execute>> | null =
      null;
    const readBackDecisionHashes: string[] = [];
    const port: HighIntensityModelPort = {
      async execute(request) {
        const result = await basePort.execute(request);
        if (request.phase === "research" && lostResearchResult === null) {
          lostResearchResult = result;
          throw new Error("response_lost_after_receipt_persisted");
        }
        return result;
      },
      async readBack(request) {
        readBackDecisionHashes.push(request.decisionHash);
        if (request.phase === "research" && lostResearchResult !== null) {
          return { status: "found", result: lostResearchResult };
        }
        return readBackNotFound();
      },
    };

    const interrupted = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: port,
      now: () => "2026-07-31T01:00:00.000Z",
    });
    const recovered = await createHighIntensityRun({
      input,
      availability: driftedAvailability,
      stateDir,
      source,
      modelPort: port,
      now: () => "2026-07-31T01:01:00.000Z",
    });

    expect(interrupted.ok).toBe(false);
    expect(recovered.ok).toBe(true);
    expect(recovered.dedupeStatus).toBe("reconciled");
    expect(requests.filter((request) => request.phase === "research")).toHaveLength(
      1,
    );
    expect(recovered.record.workflowDecision?.workflowDecisionId).toBe(
      interrupted.record.workflowDecision?.workflowDecisionId,
    );
    expect(recovered.record.availability.id).toBe(availability.id);
    expect(readBackDecisionHashes.at(-1)).toBe(
      interrupted.record.workflowDecision?.decisionHash,
    );
  });

  test("creates a retry attempt only after a later stage read-back proves not found", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const basePort = scriptedPort(requests);
    const durableResults = new Map<
      string,
      Awaited<ReturnType<typeof basePort.execute>>
    >();
    let failFirstAuthor = true;
    let authorExecutions = 0;
    const port: HighIntensityModelPort = {
      async execute(request) {
        if (request.phase === "author" && request.round === 1) {
          authorExecutions += 1;
          if (failFirstAuthor) {
            failFirstAuthor = false;
            throw new Error("author_response_lost_without_receipt");
          }
        }
        const result = await basePort.execute(request);
        durableResults.set(request.idempotencyKey, result);
        return result;
      },
      async readBack(request) {
        const result = durableResults.get(request.idempotencyKey);
        return result === undefined
          ? readBackNotFound()
          : { status: "found", result };
      },
    };

    const first = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: port,
      now: () => "2026-07-31T01:00:00.000Z",
    });
    expect(first.ok).toBe(false);
    expect(first.record.blockers).toContain(
      "model_execution_unknown_outcome:author",
    );

    const recovered = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: port,
      now: () => "2026-07-31T01:01:00.000Z",
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.dedupeStatus).toBe("reconciled");
    expect(authorExecutions).toBe(2);
    const runId = recovered.record.authority.canonicalRunId;
    if (runId === null) throw new Error("canonical run id missing");
    const projection = new FileRunRegistry({
      rootDir: join(stateDir, "run-registry"),
    }).readRun(runId);
    expect(projection?.attempts).toHaveLength(2);
    expect(projection?.attempts[0]?.status).toBe("unknown_outcome");
    expect(projection?.attempts[1]?.status).toBe("completed");
  });

  test("empty model output cannot form a receipt and remains an unknown outcome", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: {
        async execute(request) {
          return provenance(request, "");
        },
        readBack: readBackNotFound,
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe("blocked");
    expect(result.record.blockers).toContain(
      "model_execution_unknown_outcome:research",
    );
    expect(readHighIntensityRunRecord(
      result.record.recordPath,
      authorityRootForRecord(result.record.recordPath),
    )?.status).toBe("blocked");
  });

  test("fails closed when model provenance differs from routing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: {
        async execute(request) {
          return {
            ...provenance(request, researchJson()),
            family: "wrong-family",
          };
        },
        readBack: readBackNotFound,
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("provenance_mismatch:research");
    expect(result.record.calls).toEqual([]);

    const repeated = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: scriptedPort([]),
      now: () => "2026-07-31T01:01:00.000Z",
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.dedupeStatus).toBe("reconciled");
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
      source,
      modelPort: {
        async execute(request) {
          requests.push(request);
          return provenance(request, researchJson());
        },
        readBack: readBackNotFound,
      },
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.blockers).toContain("routing_failed_closed:invalid_availability_snapshot");
    expect(result.record.routingDecision).toBeNull();
    expect(result.record.calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("does not call any model when Firstmate decision issuance fails", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      source,
      modelPort: scriptedPort(requests),
      now: () => "2026-07-31T01:00:00.000Z",
      workflowAuthority: new FileFirstmateWorkflowAuthority({
        stateDir,
        decisionStore: {
          issueDecision() {
            throw new Error("authority_store_unavailable");
          },
          readDecision() {
            return undefined;
          },
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.record.authority.workflowAuthority).toBe("unverified");
    expect(result.record.authority.runtimeAuthority).toBe("unverified");
    expect(result.record.blockers).toContain(
      "firstmate_decision_issuance_failed:authority_store_unavailable",
    );
  });

  test("blocks before decision issuance when exact source lineage is missing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const requests: HighIntensityModelRequest[] = [];
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      modelPort: scriptedPort(requests),
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.record.workflowDecision).toBeNull();
    expect(result.record.blockers).toEqual(["source_lineage_incomplete"]);
    expect(requests).toEqual([]);
  });

  test("uses FM_HOME as the Firstmate authority trust anchor", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-high-runtime-"));
    const stateDir = join(root, "state");
    const fmHome = join(root, "firstmate-home");
    const result = await createHighIntensityRun({
      input,
      availability,
      stateDir,
      env: { FM_HOME: fmHome },
      source,
      modelPort: scriptedPort([]),
      now: () => "2026-07-31T01:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.record.workflowDecisionReceipt?.receiptPath.startsWith(
      join(fmHome, "aicoding-mate-authority"),
    )).toBe(true);
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
    readBack: readBackNotFound,
  };
}

async function readBackNotFound(): Promise<HighIntensityModelReadback> {
  return {
    status: "not_found",
    checkedAt: "2026-07-31T01:00:00.000Z",
    reason: "test_receipt_not_found",
  };
}

function provenance(
  request: HighIntensityModelRequest,
  rawOutput: string,
) {
  const readback = persistModelDispatchReceipt({
    rootDir: mkdtempSync(
      join(tmpdir(), "aicoding-mate-high-receipt-"),
    ),
    identity: {
      idempotencyKey: request.idempotencyKey,
      workflowDecisionId: request.workflowDecisionId,
      decisionHash: request.decisionHash,
      stageId: request.stageId,
      assignment: request.assignment,
    },
    rawOutput,
    completedAt: "2026-07-31T01:00:00.000Z",
  });
  return {
    rawOutput,
    alias: request.assignment.alias,
    family: request.assignment.family,
    model: request.assignment.resolvedModel,
    receiptPath: readback.receipt.receiptPath,
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

function authorityRootForRecord(recordPath: string): string {
  return join(dirname(dirname(recordPath)), "firstmate-authority");
}
