import { spawnSync } from "node:child_process";

import type {
  AvailabilityCandidate,
  AvailabilitySnapshot,
} from "../contracts/index.ts";
import type {
  HighIntensityModelPort,
  HighIntensityModelRequest,
  HighIntensityModelResult,
} from "./high-intensity-runtime.ts";

export interface HighIntensityCliRunnerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type HighIntensityCliRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => HighIntensityCliRunnerResult;

export interface HighIntensityCliOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: HighIntensityCliRunner;
  readonly now?: () => string;
}

export interface HighIntensityCliModelMapping {
  readonly role: "author" | "challenger" | "judge";
  readonly alias: string;
  readonly model: string;
  readonly family: string;
}

const defaultMappings: readonly HighIntensityCliModelMapping[] = [
  {
    role: "author",
    alias: "openai-author",
    model: "gpt-5.6-sol-high",
    family: "openai",
  },
  {
    role: "challenger",
    alias: "anthropic-challenger",
    model: "claude-fable-5-thinking-high",
    family: "anthropic",
  },
  {
    role: "judge",
    alias: "xai-judge",
    model: "cursor-grok-4.5-high",
    family: "xai",
  },
];

export function probeHighIntensityCliAvailability(
  options: HighIntensityCliOptions,
): AvailabilitySnapshot {
  const now = options.now ?? (() => new Date().toISOString());
  const capturedAt = now();
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const mappings = resolveMappings(env);
  const listed = runner("agent", ["--list-models"], {
    cwd: options.cwd,
    env,
  });
  const listSucceeded = listed.status === 0 && !listed.error;
  const modelList = listed.stdout;
  return {
    id: `high-intensity-cli-${compactTimestamp(capturedAt)}`,
    capturedAt,
    candidates: mappings.map((mapping) =>
      candidateFromMapping(mapping, listSucceeded, modelList),
    ),
  };
}

export function createHighIntensityCliPort(
  options: HighIntensityCliOptions,
): HighIntensityModelPort {
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  return {
    async execute(request: HighIntensityModelRequest): Promise<HighIntensityModelResult> {
      const result = runner(
        "agent",
        [
          "-p",
          "--output-format",
          "text",
          "--mode",
          "ask",
          "--trust",
          "--sandbox",
          "enabled",
          "--model",
          request.assignment.resolvedModel,
          "--workspace",
          options.cwd,
          request.prompt,
        ],
        {
          cwd: options.cwd,
          env,
        },
      );
      if (result.status !== 0 || result.error) {
        throw new Error("agent_execution_failed");
      }
      const rawOutput = result.stdout.trim();
      if (!rawOutput) {
        throw new Error("agent_empty_output");
      }
      return {
        rawOutput,
        alias: request.assignment.alias,
        family: request.assignment.family,
        model: request.assignment.resolvedModel,
      };
    },
  };
}

export function resolveHighIntensityCliMappings(
  env: NodeJS.ProcessEnv = process.env,
): readonly HighIntensityCliModelMapping[] {
  return resolveMappings(env);
}

function resolveMappings(env: NodeJS.ProcessEnv): readonly HighIntensityCliModelMapping[] {
  return defaultMappings.map((mapping) => ({
    role: mapping.role,
    alias: env[`ACM_HIGH_INTENSITY_${mapping.role.toUpperCase()}_ALIAS`] ?? mapping.alias,
    model: env[`ACM_HIGH_INTENSITY_${mapping.role.toUpperCase()}_MODEL`] ?? mapping.model,
    family: env[`ACM_HIGH_INTENSITY_${mapping.role.toUpperCase()}_FAMILY`] ?? mapping.family,
  }));
}

function candidateFromMapping(
  mapping: HighIntensityCliModelMapping,
  listSucceeded: boolean,
  modelList: string,
): AvailabilityCandidate {
  const listed = modelListed(modelList, mapping.model);
  return {
    alias: mapping.alias,
    provider: mapping.family,
    family: mapping.family,
    resolvedModel: mapping.model,
    capabilityTier: mapping.role === "judge" ? "architecture" : "implementation",
    state: listSucceeded && listed ? "available" : "unavailable",
    reason: listSucceeded
      ? listed ? null : "model_not_listed"
      : "agent_list_models_failed",
  };
}

function modelListed(modelList: string, model: string): boolean {
  return modelList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === model || line.startsWith(`${model} `));
}

function defaultRunner(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
): HighIntensityCliRunnerResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function compactTimestamp(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 14);
}
