import { describe, expect, test } from "bun:test";

import {
  availabilitySnapshotHash,
  createWorkflowDecisionEnvelope,
  lookupExactStageAssignment,
  readWorkflowDecisionEnvelope,
  workflowDecisionCanonicalJson,
  workflowDecisionHash,
  type AvailabilitySnapshot,
  type SourceLineage,
  type WorkflowDecisionEnvelope,
  type WorkflowDecisionInput,
  type WorkflowRoleAssignment,
} from "../src/contracts/index.ts";

const sourceLineage: SourceLineage = {
  taskId: "firstmate-task-1",
  runId: "run-1",
  workspace: "/tmp/aicoding-mate",
  tabId: "tab-1",
  paneId: "pane-1",
};

const availability: AvailabilitySnapshot = {
  id: "availability-workflow-1",
  capturedAt: "2026-07-30T20:00:00.000Z",
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
      alias: "anthropic-reviewer",
      provider: "anthropic",
      family: "anthropic",
      resolvedModel: "configured-anthropic-reviewer",
      capabilityTier: "architecture",
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

const roleAssignments: readonly WorkflowRoleAssignment[] = [
  role("architect", "anthropic-reviewer", "anthropic", "anthropic", "architecture"),
  role("author", "openai-author", "openai", "openai", "implementation"),
  role("reviewer", "anthropic-reviewer", "anthropic", "anthropic", "architecture"),
  role("judge", "gemini-judge", "google", "gemini", "architecture"),
  role("report_composer", "anthropic-reviewer", "anthropic", "anthropic", "architecture"),
];

describe("Firstmate workflow authority contract", () => {
  test("creates deterministic immutable Firstmate-owned decision envelopes", () => {
    const first = createWorkflowDecisionEnvelope(decisionInput());
    const second = createWorkflowDecisionEnvelope(decisionInput());

    expect(first).toEqual(second);
    expect(first.authority).toBe("firstmate");
    expect(first.fallbackPolicy.behavior).toBe("new_decision_required");
    expect(first.reportComposer).toEqual({
      owner: "firstmate",
      role: "report_composer",
    });
    expect(workflowDecisionHash(first)).toHaveLength(64);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.roleAssignments)).toBe(true);
    expect(() => {
      const mutableAssignments = first.roleAssignments as WorkflowRoleAssignment[];
      mutableAssignments.push(
        role("search", "openai-author", "openai", "openai", "implementation"),
      );
    }).toThrow();
  });

  test("canonical hashing survives JSON key order and rejects tampering", () => {
    const envelope = createWorkflowDecisionEnvelope(decisionInput());
    const reordered = {
      decisionHash: envelope.decisionHash,
      executionPolicy: envelope.executionPolicy,
      fallbackPolicy: envelope.fallbackPolicy,
      stopConditions: envelope.stopConditions,
      stageBarriers: envelope.stageBarriers,
      stageAssignments: envelope.stageAssignments,
      roleAssignments: envelope.roleAssignments,
      sourceLineage: envelope.sourceLineage,
      hashes: envelope.hashes,
      recipe: {
        version: envelope.recipe.version,
        id: envelope.recipe.id,
      },
      authority: envelope.authority,
      workflowDecisionVersion: envelope.workflowDecisionVersion,
      workflowDecisionId: envelope.workflowDecisionId,
      maxRounds: envelope.maxRounds,
      reportComposer: envelope.reportComposer,
    };
    const read = readWorkflowDecisionEnvelope(JSON.stringify(reordered));

    expect(workflowDecisionCanonicalJson(read)).toBe(
      workflowDecisionCanonicalJson(envelope),
    );

    const tampered: WorkflowDecisionEnvelope = {
      ...envelope,
      fallbackPolicy: {
        behavior: "new_decision_required",
        reason: "adapter may silently fallback",
      },
    };
    expect(() => readWorkflowDecisionEnvelope(tampered)).toThrow(
      "workflow_decision_id_mismatch",
    );
  });

  test("exact stage lookup returns the assigned role without selecting a model", () => {
    const envelope = createWorkflowDecisionEnvelope(decisionInput());
    const exact = lookupExactStageAssignment(envelope, "cross_family_review");

    expect(exact.workflowDecisionId).toBe(envelope.workflowDecisionId);
    expect(exact.stage).toEqual({
      stageId: "cross_family_review",
      role: "reviewer",
      barrierId: "review_complete",
    });
    expect(exact.roleAssignment).toEqual(roleAssignments[2]);
    expect(() => lookupExactStageAssignment(envelope, "review")).toThrow(
      "stage_assignment_missing:review",
    );
  });

  test("new availability or routing produces a new decision id and hash", () => {
    const first = createWorkflowDecisionEnvelope(decisionInput());
    const unavailableSnapshot: AvailabilitySnapshot = {
      ...availability,
      candidates: availability.candidates.map((candidate) =>
        candidate.alias === "anthropic-reviewer"
          ? { ...candidate, state: "quota_limited" as const, reason: "quota_low" }
          : candidate,
      ),
    };
    const reroutedAssignments: readonly WorkflowRoleAssignment[] =
      roleAssignments.map((assignment) =>
        assignment.role === "reviewer" || assignment.role === "report_composer"
          ? role(assignment.role, "gemini-judge", "google", "gemini", "architecture")
          : assignment,
      );
    const second = createWorkflowDecisionEnvelope(
      decisionInput({
        hashes: {
          ...decisionInput().hashes,
          availabilityHash: availabilitySnapshotHash(unavailableSnapshot),
        },
        roleAssignments: reroutedAssignments,
      }),
    );

    expect(second.workflowDecisionId).not.toBe(first.workflowDecisionId);
    expect(second.decisionHash).not.toBe(first.decisionHash);
    expect(second.hashes.availabilityHash).not.toBe(first.hashes.availabilityHash);
  });
});

function decisionInput(
  overrides: Partial<WorkflowDecisionInput> = {},
): WorkflowDecisionInput {
  return {
    workflowDecisionVersion: 1,
    recipe: { id: "standard", version: "0.2.0" },
    hashes: {
      intentHash: fixedHash("intent"),
      configHash: fixedHash("config"),
      availabilityHash: availabilitySnapshotHash(availability),
    },
    sourceLineage,
    roleAssignments,
    stageAssignments: [
      { stageId: "plan", role: "architect", barrierId: "plan_complete" },
      { stageId: "execute", role: "author", barrierId: "author_complete" },
      {
        stageId: "cross_family_review",
        role: "reviewer",
        barrierId: "review_complete",
      },
      { stageId: "verify", role: "judge", barrierId: "judge_complete" },
      { stageId: "report", role: "report_composer", barrierId: "report_complete" },
    ],
    stageBarriers: [
      {
        id: "plan_complete",
        afterStageId: "plan",
        requires: ["firstmate_plan_recorded"],
      },
      {
        id: "author_complete",
        afterStageId: "execute",
        requires: ["author_artifact_read_back"],
      },
      {
        id: "review_complete",
        afterStageId: "cross_family_review",
        requires: ["review_artifact_read_back"],
      },
      {
        id: "judge_complete",
        afterStageId: "verify",
        requires: ["judge_acceptance_recorded"],
      },
      {
        id: "report_complete",
        afterStageId: "report",
        requires: ["two_layer_report_composed"],
      },
    ],
    maxRounds: 2,
    stopConditions: ["judge_accepts", "max_rounds_reached", "failed_closed"],
    fallbackPolicy: {
      behavior: "new_decision_required",
      reason: "Adapters only report observations; Firstmate must issue a new decision.",
    },
    executionPolicy: {
      adapterBehavior: "execute_exact_assignment_only",
      namedSkillUnavailable: "equivalent_read_only_review",
      minimumDebuggingHypotheses: 3,
    },
    reportComposer: {
      owner: "firstmate",
      role: "report_composer",
    },
    ...overrides,
  };
}

function role(
  roleName: string,
  alias: string,
  provider: string,
  family: string,
  capabilityTier: WorkflowRoleAssignment["capabilityTier"],
): WorkflowRoleAssignment {
  return {
    role: roleName,
    alias,
    provider,
    family,
    resolvedModel: `configured-${alias}`,
    capabilityTier,
    reason: `firstmate_assignment:${roleName}`,
  };
}

function fixedHash(label: string): string {
  return label === "intent" ? "1".repeat(64) : "2".repeat(64);
}
