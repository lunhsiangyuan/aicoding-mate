import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertDecisionReadyReport, type AvailabilitySnapshot } from "../src/contracts/index.ts";
import { loadStandardWorkflowConfig } from "../src/config/standard.ts";
import { planStandardWorkflow, routeStandardWorkflow, type StandardWorkflowInput } from "../src/routing/standard.ts";
import { composeStandardDecisionReport } from "../src/report/standard/index.ts";

const availableSnapshot: AvailabilitySnapshot = {
  id: "availability-standard-1",
  capturedAt: "2026-07-30T16:00:00.000Z",
  candidates: [
    {
      alias: "openai-architect",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-architect",
      capabilityTier: "architecture",
      state: "available",
      reason: null,
    },
    {
      alias: "openai-builder",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-builder",
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
      alias: "openai-search",
      provider: "openai",
      family: "openai",
      resolvedModel: "configured-openai-search",
      capabilityTier: "search",
      state: "available",
      reason: null,
    },
  ],
};

describe("standard workflow routing", () => {
  test("default config loads from the package root even when cwd changes", () => {
    const originalCwd = process.cwd();
    const temporaryCwd = mkdtempSync(join(tmpdir(), "standard-cwd-"));
    try {
      process.chdir(temporaryCwd);
      const config = loadStandardWorkflowConfig();
      expect(config.status).toBe("valid");
      expect(config.recipe.stages).toContain("coverage_review");
    } finally {
      process.chdir(originalCwd);
      rmSync(temporaryCwd, { recursive: true, force: true });
    }
  });

  test("same normalized input, config, and availability yields the same recipe and role routing", () => {
    const config = loadStandardWorkflowConfig();
    const input = {
      task: "Add a settings panel with review",
      risk: "medium" as const,
      boundaries: ["no external deployment", "keep scope local"],
    };

    const first = routeStandardWorkflow({ config, input, availability: availableSnapshot });
    const second = routeStandardWorkflow({ config, input, availability: availableSnapshot });

    expect(first.status).toBe("resolved");
    expect(second).toEqual(first);
    if (first.status === "resolved") {
      expect(first.decision.recipeId).toBe("standard");
      expect(first.decision.roleAssignments.map((assignment) => assignment.role)).toEqual([
        "architect",
        "author",
        "reviewer",
        "judge",
        "search",
      ]);
      expect(first.decision.roleAssignments.find((assignment) => assignment.role === "author")?.alias).toBe(
        "openai-builder",
      );
      expect(first.decision.roleAssignments.find((assignment) => assignment.role === "search")?.alias).toBe(
        "openai-search",
      );
    }
  });

  test("same-family same-tier candidates use locale-independent code-unit alias order", () => {
    const config = loadStandardWorkflowConfig();
    const snapshot: AvailabilitySnapshot = {
      ...availableSnapshot,
      candidates: [
        {
          alias: "zeta-architect",
          provider: "openai",
          family: "openai",
          resolvedModel: "configured-zeta-architect",
          capabilityTier: "architecture",
          state: "available",
          reason: null,
        },
        {
          alias: "Alpha-architect",
          provider: "openai",
          family: "openai",
          resolvedModel: "configured-alpha-architect",
          capabilityTier: "architecture",
          state: "available",
          reason: null,
        },
        ...availableSnapshot.candidates.filter((candidate) => candidate.alias !== "openai-architect"),
      ],
    };

    const routed = routeStandardWorkflow({
      config,
      input: { task: "Pick a deterministic architect", risk: "medium" },
      availability: snapshot,
    });

    expect(routed.status).toBe("resolved");
    if (routed.status === "resolved") {
      expect(routed.decision.roleAssignments.find((assignment) => assignment.role === "architect")?.alias).toBe(
        "Alpha-architect",
      );
    }
  });

  test("provider unavailable falls back within capability floor and records trace", () => {
    const config = loadStandardWorkflowConfig();
    const snapshot: AvailabilitySnapshot = {
      ...availableSnapshot,
      candidates: availableSnapshot.candidates.map((candidate) =>
        candidate.alias === "openai-architect"
          ? { ...candidate, state: "unavailable", reason: "provider_down" }
          : candidate,
      ),
    };

    const routed = routeStandardWorkflow({
      config,
      input: { task: "Implement standard workflow", risk: "medium" },
      availability: snapshot,
    });

    expect(routed.status).toBe("resolved");
    if (routed.status === "resolved") {
      const architect = routed.decision.roleAssignments.find((assignment) => assignment.role === "architect");
      expect(architect?.alias).toBe("anthropic-reviewer");
      expect(routed.decision.fallbackTrace).toContainEqual({
        role: "architect",
        rejectedAlias: "openai-architect",
        selectedAlias: "anthropic-reviewer",
        reason: "provider_down",
      });
    }
  });

  test("same-family reviewer fallback is explicit and degraded", () => {
    const config = loadStandardWorkflowConfig();
    const sameFamilyOnly: AvailabilitySnapshot = {
      ...availableSnapshot,
      candidates: availableSnapshot.candidates.filter((candidate) => candidate.family === "openai"),
    };

    const routed = routeStandardWorkflow({
      config,
      input: { task: "Implement with review", risk: "medium" },
      availability: sameFamilyOnly,
    });

    expect(routed.status).toBe("resolved");
    if (routed.status === "resolved") {
      expect(routed.decision.diversityStatus).toBe("degraded_same_family");
      expect(routed.decision.fallbackTrace.some((entry) => entry.reason === "degraded_same_family")).toBe(true);
    }
  });

  test("all architecture candidates below floor asks the user", () => {
    const config = loadStandardWorkflowConfig();
    const belowFloor: AvailabilitySnapshot = {
      ...availableSnapshot,
      candidates: availableSnapshot.candidates.map((candidate) => ({
        ...candidate,
        capabilityTier: "search" as const,
      })),
    };

    const routed = routeStandardWorkflow({
      config,
      input: { task: "Architecture-sensitive work", risk: "medium" },
      availability: belowFloor,
    });

    expect(routed).toEqual({
      status: "ask_user",
      reason: "all_candidates_below_capability_floor",
    });
  });

  test("decision report has concise main layer plus evidence, limits, unknowns, and lineage", () => {
    const plan = planStandardWorkflow({
      input: { task: "Build the standard workflow", risk: "medium" },
      availability: availableSnapshot,
    });

    expect(plan.routing.status).toBe("resolved");
    if (plan.routing.status === "resolved") {
      const report = composeStandardDecisionReport({
        config: plan.config,
        normalizedInput: plan.normalizedInput,
        routingDecision: plan.routing.decision,
        availability: availableSnapshot,
      });

      assertDecisionReadyReport(report);
      expect(report.mainReport.conclusion).toContain("standard");
      expect(report.evidenceLayer.limitations.length).toBeGreaterThan(0);
      expect(report.evidenceLayer.unknowns.length).toBeGreaterThan(0);
      expect(report.evidenceLayer.lineage).toContain(plan.normalizedInput.hash);
    }
  });

  test("invalid config fails closed", () => {
    const config = loadStandardWorkflowConfig({
      workflowsYaml: "version: 1\nrecipes:\n  quick:\n    stages:\n      - classify\n",
    });

    const routed = routeStandardWorkflow({
      config,
      input: { task: "Standard task", risk: "medium" },
      availability: availableSnapshot,
    });

    expect(routed).toEqual({
      status: "failed_closed",
      reason: "invalid_config",
    });
  });

  test("role referencing an unknown model alias makes config invalid and fails closed", () => {
    const invalidConfig = loadStandardWorkflowConfig({
      modelPolicyYaml: configToUnknownArchitectAlias(),
    });

    expect(invalidConfig.status).toBe("invalid");
    expect(invalidConfig.errors).toContain("role_architect_model_alias_unknown_missing_alias");
    expect(
      routeStandardWorkflow({
        config: invalidConfig,
        input: { task: "Standard task", risk: "medium" },
        availability: availableSnapshot,
      }),
    ).toEqual({
      status: "failed_closed",
      reason: "invalid_config",
    });
  });

  test("incomplete standard recipe is invalid and fails closed", () => {
    const invalidConfig = loadStandardWorkflowConfig({
      workflowsYaml: [
        "version: 1",
        "recipes:",
        "  standard:",
        "    stages:",
        "      - classify",
        "      - plan",
        "      - execute",
        "    limits:",
        "      repair_rounds: 2",
      ].join("\n"),
    });

    expect(invalidConfig.status).toBe("invalid");
    expect(invalidConfig.errors).toContain("workflow_standard_stage_missing_coverage_review");
    expect(
      routeStandardWorkflow({
        config: invalidConfig,
        input: { task: "Standard task", risk: "medium" },
        availability: availableSnapshot,
      }),
    ).toEqual({
      status: "failed_closed",
      reason: "invalid_config",
    });
  });

  test("non-medium risk cannot be routed through the Standard API", () => {
    const input = {
      task: "Escalate this work",
      risk: "high",
    } as unknown as StandardWorkflowInput;

    expect(
      routeStandardWorkflow({
        config: loadStandardWorkflowConfig(),
        input,
        availability: availableSnapshot,
      }),
    ).toEqual({
      status: "failed_closed",
      reason: "invalid_config",
    });
  });
});

function configToUnknownArchitectAlias(): string {
  return [
    "version: 1",
    "",
    "model_aliases:",
    "  strongest_reasoning:",
    "    capability_floor: architecture",
    "    preferred_families:",
    "      - openai",
    "      - anthropic",
    "    fallback_behavior: stay_above_floor",
    "  independent_judge:",
    "    capability_floor: architecture",
    "    require_different_family_from_author: true",
    "    fallback_behavior: stay_above_floor",
    "  balanced_builder:",
    "    capability_floor: implementation",
    "    fallback_behavior: automatic",
    "  fast_research:",
    "    capability_floor: search",
    "    fallback_behavior: automatic",
    "",
    "roles:",
    "  architect:",
    "    model_alias: missing_alias",
    "    effort: maximum",
    "  author:",
    "    model_alias: balanced_builder",
    "    effort: high",
    "  reviewer:",
    "    model_alias: strongest_reasoning",
    "    effort: high",
    "    prefer_different_family_from: author",
    "  judge:",
    "    model_alias: independent_judge",
    "    effort: maximum",
    "  search:",
    "    model_alias: fast_research",
    "    effort: low",
  ].join("\n");
}
