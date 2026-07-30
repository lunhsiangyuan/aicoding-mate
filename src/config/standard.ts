import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CapabilityTier } from "../contracts/routing.ts";

export type StandardConfigStatus = "valid" | "invalid";
export type StandardRole = "architect" | "author" | "reviewer" | "judge" | "search";

export interface StandardRoleConfig {
  readonly role: StandardRole;
  readonly modelAlias: string;
  readonly capabilityFloor: CapabilityTier;
  readonly effort: string;
  readonly preferDifferentFamilyFrom?: StandardRole;
}

export interface StandardWorkflowConfig {
  readonly status: StandardConfigStatus;
  readonly versionHash: string;
  readonly errors: readonly string[];
  readonly language: "zh-TW";
  readonly recipe: {
    readonly id: "standard";
    readonly stages: readonly string[];
    readonly repairRounds: number;
  };
  readonly roles: readonly StandardRoleConfig[];
  readonly modelAliases: readonly {
    readonly id: string;
    readonly capabilityFloor: CapabilityTier;
    readonly preferredFamilies: readonly string[];
  }[];
  readonly adapters: readonly {
    readonly id: string;
    readonly readiness: string;
  }[];
}

export interface StandardConfigSource {
  readonly captainPreferenceYaml?: string;
  readonly decisionPolicyYaml?: string;
  readonly modelPolicyYaml?: string;
  readonly workflowsYaml?: string;
  readonly adaptersYaml?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const defaultPaths = {
  captainPreferenceYaml: "config/captain-preference.example.yaml",
  decisionPolicyYaml: "config/decision-policy.example.yaml",
  modelPolicyYaml: "config/model-policy.example.yaml",
  workflowsYaml: "config/workflows.example.yaml",
  adaptersYaml: "config/adapters.example.yaml",
} as const;

export function loadStandardWorkflowConfig(
  source: StandardConfigSource = {},
): StandardWorkflowConfig {
  const yamls = {
    captainPreferenceYaml:
      source.captainPreferenceYaml ?? readDefault(defaultPaths.captainPreferenceYaml),
    decisionPolicyYaml:
      source.decisionPolicyYaml ?? readDefault(defaultPaths.decisionPolicyYaml),
    modelPolicyYaml:
      source.modelPolicyYaml ?? readDefault(defaultPaths.modelPolicyYaml),
    workflowsYaml: source.workflowsYaml ?? readDefault(defaultPaths.workflowsYaml),
    adaptersYaml: source.adaptersYaml ?? readDefault(defaultPaths.adaptersYaml),
  };

  const modelAliases = parseModelAliases(yamls.modelPolicyYaml);
  const roles = parseRoles(yamls.modelPolicyYaml, modelAliases);
  const recipe = parseStandardRecipe(yamls.workflowsYaml);
  const adapters = parseAdapters(yamls.adaptersYaml);
  const errors = [
    ...validateCaptain(yamls.captainPreferenceYaml),
    ...validateDecisionPolicy(yamls.decisionPolicyYaml),
    ...(recipe ? [] : ["workflow_standard_missing"]),
    ...validateStandardRecipe(recipe),
    ...validateRoles(roles, modelAliases),
    ...validateAdapters(adapters),
  ];

  return {
    status: errors.length === 0 ? "valid" : "invalid",
    versionHash: sha256(JSON.stringify(yamls)),
    errors,
    language: "zh-TW",
    recipe: recipe ?? { id: "standard", stages: [], repairRounds: 0 },
    roles,
    modelAliases,
    adapters,
  };
}

function readDefault(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function parseStandardRecipe(yaml: string): StandardWorkflowConfig["recipe"] | undefined {
  const block = blockUntilNextHeader(yaml, "  standard:", 2);
  if (!block) return undefined;
  const stagesBlock = indentedBlock(block, "    stages:");
  const stages = stagesBlock
    ? stagesBlock
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim())
    : [];
  const repairRoundsMatch = block.match(/repair_rounds:\s*(\d+)/);
  return {
    id: "standard",
    stages,
    repairRounds: repairRoundsMatch ? Number(repairRoundsMatch[1]) : 0,
  };
}

function parseModelAliases(yaml: string): StandardWorkflowConfig["modelAliases"] {
  const aliasesBlock = indentedBlock(yaml, "model_aliases:");
  if (!aliasesBlock) return [];
  const aliases: StandardWorkflowConfig["modelAliases"][number][] = [];
  for (const entry of entriesAtIndent(aliasesBlock, 2)) {
    const id = entry.id;
    const body = entry.body;
    const floor = body.match(/capability_floor:\s*([a-z_]+)/)?.[1];
    if (!isCapabilityTier(floor)) continue;
    const families = listUnder(body, "preferred_families");
    aliases.push({ id, capabilityFloor: floor, preferredFamilies: families });
  }
  return aliases;
}

function parseRoles(
  yaml: string,
  aliases: StandardWorkflowConfig["modelAliases"],
): readonly StandardRoleConfig[] {
  const rolesBlock = indentedBlock(yaml, "roles:");
  if (!rolesBlock) return [];
  const roles: StandardRoleConfig[] = [];
  for (const entry of entriesAtIndent(rolesBlock, 2)) {
    const role = entry.id;
    if (!isStandardRole(role)) continue;
    const body = entry.body;
    const modelAlias = body.match(/model_alias:\s*([a-z_]+)/)?.[1] ?? "";
    const alias = aliases.find((candidate) => candidate.id === modelAlias);
    roles.push({
      role,
      modelAlias,
      capabilityFloor: alias?.capabilityFloor ?? "search",
      effort: body.match(/effort:\s*([a-z_]+)/)?.[1] ?? "medium",
      preferDifferentFamilyFrom: parseRoleReference(
        body.match(/prefer_different_family_from:\s*([a-z_]+)/)?.[1],
      ),
    });
  }
  return roles.filter((role) =>
    ["architect", "author", "reviewer", "judge", "search"].includes(role.role),
  );
}

function parseAdapters(yaml: string): StandardWorkflowConfig["adapters"] {
  const adaptersBlock = indentedBlock(yaml, "adapters:");
  if (!adaptersBlock) return [];
  const adapters: StandardWorkflowConfig["adapters"][number][] = [];
  for (const entry of entriesAtIndent(adaptersBlock, 2)) {
    const id = entry.id;
    const readiness = entry.body.match(/readiness:\s*([a-z_0-9]+)/)?.[1] ?? "unknown";
    adapters.push({ id, readiness });
  }
  return adapters;
}

function validateCaptain(yaml: string): string[] {
  const errors: string[] = [];
  if (!yaml.includes("language: zh-TW")) errors.push("captain_language_not_zh_tw");
  if (!yaml.includes("coverage_review: required")) errors.push("captain_coverage_review_not_required");
  return errors;
}

function validateDecisionPolicy(yaml: string): string[] {
  const errors: string[] = [];
  if (!/medium:\n\s+workflow:\s+standard/.test(yaml)) errors.push("decision_medium_not_standard");
  if (!yaml.includes("model_fallback_within_capability_floor")) errors.push("decision_fallback_policy_missing");
  return errors;
}

function validateStandardRecipe(
  recipe: StandardWorkflowConfig["recipe"] | undefined,
): string[] {
  if (!recipe) return [];
  const requiredStages = [
    "classify",
    "plan",
    "execute",
    "cross_family_review",
    "verify",
    "coverage_review",
    "report",
  ];
  return requiredStages
    .filter((stage) => !recipe.stages.includes(stage))
    .map((stage) => `workflow_standard_stage_missing_${stage}`);
}

function validateRoles(
  roles: readonly StandardRoleConfig[],
  modelAliases: StandardWorkflowConfig["modelAliases"],
): string[] {
  const required: StandardRole[] = ["architect", "author", "reviewer", "judge", "search"];
  const errors: string[] = [];
  const aliasIds = new Set(modelAliases.map((alias) => alias.id));
  for (const role of required) {
    const found = roles.find((candidate) => candidate.role === role);
    if (!found?.modelAlias) {
      errors.push(`role_missing_${role}`);
      continue;
    }
    if (!aliasIds.has(found.modelAlias)) {
      errors.push(`role_${role}_model_alias_unknown_${found.modelAlias}`);
    }
  }
  return errors;
}

function validateAdapters(adapters: StandardWorkflowConfig["adapters"]): string[] {
  const ids = adapters.map((adapter) => adapter.id);
  const errors: string[] = [];
  if (!ids.includes("codex")) errors.push("adapter_codex_missing");
  if (!ids.includes("claude")) errors.push("adapter_claude_missing");
  return errors;
}

function indentedBlock(yaml: string, header: string): string | undefined {
  const start = yaml.indexOf(header);
  if (start < 0) return undefined;
  const after = yaml.slice(start + header.length);
  const nextTopLevel = after.search(/\n\S/);
  return nextTopLevel >= 0 ? after.slice(0, nextTopLevel) : after;
}

function blockUntilNextHeader(yaml: string, header: string, indent: number): string | undefined {
  const start = yaml.indexOf(header);
  if (start < 0) return undefined;
  const after = yaml.slice(start + header.length);
  const pattern = new RegExp(`\\n {${indent}}[A-Za-z0-9_-]+:`);
  const next = after.search(pattern);
  return next >= 0 ? after.slice(0, next) : after;
}

function entriesAtIndent(block: string, indent: number): readonly { readonly id: string; readonly body: string }[] {
  const lines = block.split(/\r?\n/);
  const entries: { id: string; body: string }[] = [];
  let current: { id: string; bodyLines: string[] } | undefined;
  const headerPattern = new RegExp(`^ {${indent}}([A-Za-z0-9_\\-]+):\\s*$`);
  for (const line of lines) {
    const match = line.match(headerPattern);
    if (match) {
      if (current) entries.push({ id: current.id, body: current.bodyLines.join("\n") });
      current = { id: match[1], bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) entries.push({ id: current.id, body: current.bodyLines.join("\n") });
  return entries;
}

function listUnder(block: string, key: string): string[] {
  const start = block.indexOf(`${key}:`);
  if (start < 0) return [];
  const after = block.slice(start + key.length + 1);
  const nextPeer = after.search(/\n\s{4}[a-z_]+:/);
  const listBlock = nextPeer >= 0 ? after.slice(0, nextPeer) : after;
  return listBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function parseRoleReference(value: string | undefined): StandardRole | undefined {
  return isStandardRole(value) ? value : undefined;
}

function isStandardRole(value: string | undefined): value is StandardRole {
  return value === "architect" || value === "author" || value === "reviewer" || value === "judge" || value === "search";
}

function isCapabilityTier(value: string | undefined): value is CapabilityTier {
  return value === "search" || value === "implementation" || value === "architecture";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
