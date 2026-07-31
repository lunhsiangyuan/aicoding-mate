import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HighIntensityConfiguredRole =
  | "search"
  | "author"
  | "challenger"
  | "judge";

export interface HighIntensityConfiguredModel {
  readonly role: HighIntensityConfiguredRole;
  readonly alias: string;
  readonly model: string;
  readonly family: string;
}

export interface NativeReviewConfiguredModel {
  readonly alias: string;
  readonly model: string;
  readonly family: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requiredRoles: readonly HighIntensityConfiguredRole[] = [
  "search",
  "author",
  "challenger",
  "judge",
];

export function loadHighIntensityModelConfig(
  env: NodeJS.ProcessEnv = {},
): readonly HighIntensityConfiguredModel[] {
  const yaml = loadRuntimeModelPolicy(env);
  const highIntensity = indentedBlock(yaml, "high_intensity:");
  if (highIntensity === null) {
    throw new Error("high_intensity_model_config_missing");
  }
  const entries = entriesAtIndent(highIntensity, 2);
  return requiredRoles.map((role) => {
    const entry = entries.find((candidate) => candidate.id === role);
    if (entry === undefined) {
      throw new Error(`high_intensity_model_role_missing:${role}`);
    }
    const alias = scalar(entry.body, "alias");
    const model = scalar(entry.body, "model");
    const family = scalar(entry.body, "family");
    if (!alias || !model || !family) {
      throw new Error(`high_intensity_model_role_invalid:${role}`);
    }
    return { role, alias, model, family };
  });
}

export function loadNativeReviewModelConfig(
  env: NodeJS.ProcessEnv = {},
): NativeReviewConfiguredModel {
  const yaml = loadRuntimeModelPolicy(env);
  const nativeReview = indentedBlock(yaml, "native_review:");
  if (nativeReview === null) {
    throw new Error("native_review_model_config_missing");
  }
  const alias = scalar(nativeReview, "alias");
  const model = scalar(nativeReview, "model");
  const family = scalar(nativeReview, "family");
  if (!alias || !model || !family) {
    throw new Error("native_review_model_config_invalid");
  }
  return { alias, model, family };
}

function loadRuntimeModelPolicy(env: NodeJS.ProcessEnv): string {
  const path = resolve(
    env.ACM_RUNTIME_MODEL_CONFIG
      ?? resolve(repoRoot, "config/runtime-models.example.yaml"),
  );
  return readFileSync(path, "utf8");
}

function indentedBlock(yaml: string, header: string): string | null {
  const start = yaml.indexOf(header);
  if (start < 0) return null;
  const after = yaml.slice(start + header.length);
  const nextTopLevel = after.search(/\n\S/);
  return nextTopLevel >= 0 ? after.slice(0, nextTopLevel) : after;
}

function entriesAtIndent(
  block: string,
  indent: number,
): readonly { readonly id: string; readonly body: string }[] {
  const lines = block.split(/\r?\n/);
  const entries: { id: string; body: string }[] = [];
  const header = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):\\s*$`);
  let current: { id: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = line.match(header);
    if (match !== null) {
      if (current !== null) {
        entries.push({ id: current.id, body: current.body.join("\n") });
      }
      current = { id: match[1], body: [] };
    } else if (current !== null) {
      current.body.push(line);
    }
  }
  if (current !== null) {
    entries.push({ id: current.id, body: current.body.join("\n") });
  }
  return entries;
}

function scalar(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`, "m"));
  return match?.[1]?.trim() || null;
}
