import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  AvailabilityCandidate,
  AvailabilitySnapshot,
} from "../contracts/index.ts";
import {
  loadHighIntensityModelConfig,
  type HighIntensityConfiguredModel,
} from "../config/runtime-models.ts";
import type {
  HighIntensityModelPort,
  HighIntensityModelRequest,
  HighIntensityModelResult,
} from "./high-intensity-runtime.ts";
import {
  modelDispatchReceiptPath,
  persistModelDispatchReceipt,
  readModelDispatchReceipt,
} from "../runtime/model-dispatch-receipt.ts";

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

export type HighIntensityCliModelMapping = HighIntensityConfiguredModel;

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
  const receiptRoot = join(
    resolveStateDir(options.cwd, env),
    "model-dispatches",
  );
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
          env: {
            ...env,
            ACM_IDEMPOTENCY_KEY: request.idempotencyKey,
            ACM_WORKFLOW_DECISION_ID: request.workflowDecisionId,
            ACM_DECISION_HASH: request.decisionHash,
            ACM_STAGE_ID: request.stageId,
          },
        },
      );
      if (result.status !== 0 || result.error) {
        throw new Error("agent_execution_failed");
      }
      const rawOutput = result.stdout.trim();
      if (!rawOutput) {
        throw new Error("agent_empty_output");
      }
      const receiptPath = persistModelDispatchReceipt({
        rootDir: receiptRoot,
        identity: {
          idempotencyKey: request.idempotencyKey,
          workflowDecisionId: request.workflowDecisionId,
          decisionHash: request.decisionHash,
          stageId: request.stageId,
          assignment: request.assignment,
        },
        rawOutput,
        completedAt: (options.now ?? (() => new Date().toISOString()))(),
      }).receipt.receiptPath;
      return {
        rawOutput,
        alias: request.assignment.alias,
        family: request.assignment.family,
        model: request.assignment.resolvedModel,
        receiptPath,
      };
    },
    async readBack(request) {
      const receiptPath = modelDispatchReceiptPath(
        receiptRoot,
        request.idempotencyKey,
      );
      const readback = readModelDispatchReceipt(receiptPath, {
        idempotencyKey: request.idempotencyKey,
        workflowDecisionId: request.workflowDecisionId,
        decisionHash: request.decisionHash,
        stageId: request.stageId,
        assignment: request.assignment,
      });
      if (readback !== undefined) {
        return {
          status: "found",
          result: {
            rawOutput: readback.rawOutput,
            alias: request.assignment.alias,
            family: request.assignment.family,
            model: request.assignment.resolvedModel,
            receiptPath: readback.receipt.receiptPath,
          },
        };
      }
      const checkedAt = (options.now ?? (() => new Date().toISOString()))();
      return {
        status: "mismatch",
        checkedAt,
        reason: existsSync(receiptPath)
          ? "model_dispatch_receipt_identity_or_content_mismatch"
          : "downstream_acceptance_unverifiable_local_receipt_absent",
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
  return loadHighIntensityModelConfig(env).map((mapping) => ({
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
    capabilityTier:
      mapping.role === "judge"
        ? "architecture"
        : mapping.role === "search"
        ? "search"
        : "implementation",
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

function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_STATE_DIR ?? join(cwd, "state", "aicoding-mate"));
}
