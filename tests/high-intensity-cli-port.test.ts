import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { RoleAssignment } from "../src/contracts/index.ts";
import {
  createHighIntensityCliPort,
  probeHighIntensityCliAvailability,
  resolveHighIntensityCliMappings,
  type HighIntensityCliRunner,
} from "../src/integration/high-intensity-cli-port.ts";

interface RunnerCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

const cwd = "/tmp/aicoding-mate-workspace";
const authorAssignment: RoleAssignment = {
  role: "author",
  alias: "openai-author",
  provider: "openai",
  family: "openai",
  resolvedModel: "gpt-5.6-sol-high",
  capabilityTier: "implementation",
  reason: "test assignment",
};

describe("high-intensity CLI port", () => {
  test("probes agent --list-models into default high-intensity availability", () => {
    const calls: RunnerCall[] = [];
    const availability = probeHighIntensityCliAvailability({
      cwd,
      env: {},
      now: () => "2026-07-31T02:00:00.000Z",
      runner: recordingRunner(calls, [
        "gpt-5.4-mini-medium",
        "gpt-5.6-sol-high",
        "claude-fable-5-thinking-high",
        "cursor-grok-4.5-high",
      ].join("\n")),
    });

    expect(calls).toEqual([
      {
        command: "agent",
        args: ["--list-models"],
        cwd,
      },
    ]);
    expect(availability.id).toBe("high-intensity-cli-20260731020000");
    expect(availability.candidates.map((candidate) => ({
      alias: candidate.alias,
      family: candidate.family,
      model: candidate.resolvedModel,
      tier: candidate.capabilityTier,
      state: candidate.state,
      reason: candidate.reason,
    }))).toEqual([
      {
        alias: "openai-search",
        family: "openai",
        model: "gpt-5.4-mini-medium",
        tier: "search",
        state: "available",
        reason: null,
      },
      {
        alias: "openai-author",
        family: "openai",
        model: "gpt-5.6-sol-high",
        tier: "implementation",
        state: "available",
        reason: null,
      },
      {
        alias: "anthropic-challenger",
        family: "anthropic",
        model: "claude-fable-5-thinking-high",
        tier: "implementation",
        state: "available",
        reason: null,
      },
      {
        alias: "xai-judge",
        family: "xai",
        model: "cursor-grok-4.5-high",
        tier: "architecture",
        state: "available",
        reason: null,
      },
    ]);
  });

  test("allows env overrides without changing adapter mechanics", () => {
    const mappings = resolveHighIntensityCliMappings({
      ACM_HIGH_INTENSITY_SEARCH_MODEL: "custom-search-model",
      ACM_HIGH_INTENSITY_AUTHOR_ALIAS: "custom-author",
      ACM_HIGH_INTENSITY_AUTHOR_MODEL: "custom-openai-model",
      ACM_HIGH_INTENSITY_AUTHOR_FAMILY: "openai",
      ACM_HIGH_INTENSITY_CHALLENGER_MODEL: "custom-anthropic-model",
      ACM_HIGH_INTENSITY_JUDGE_FAMILY: "xai",
      ACM_HIGH_INTENSITY_JUDGE_MODEL: "custom-judge-model",
    });

    expect(mappings).toEqual([
      {
        role: "search",
        alias: "openai-search",
        model: "custom-search-model",
        family: "openai",
      },
      {
        role: "author",
        alias: "custom-author",
        model: "custom-openai-model",
        family: "openai",
      },
      {
        role: "challenger",
        alias: "anthropic-challenger",
        model: "custom-anthropic-model",
        family: "anthropic",
      },
      {
        role: "judge",
        alias: "xai-judge",
        model: "custom-judge-model",
        family: "xai",
      },
    ]);
  });

  test("executes exact role assignment through agent without rerouting", async () => {
    const calls: RunnerCall[] = [];
    const stateDir = mkdtempSync(
      join(tmpdir(), "aicoding-mate-high-cli-receipt-"),
    );
    const port = createHighIntensityCliPort({
      cwd,
      env: { PATH: "/bin", ACM_STATE_DIR: stateDir },
      runner: recordingRunner(calls, "model output"),
    });

    const request = {
      assignment: authorAssignment,
      prompt: "do the work",
      contextId: "ctx-author-1",
      phase: "author" as const,
      round: 1,
      workflowDecisionId: "wfd_test",
      decisionHash: "1".repeat(64),
      stageId: "author" as const,
      idempotencyKey: "dispatch-test",
    };
    const result = await port.execute(request);

    expect(calls).toEqual([
      {
        command: "agent",
        args: [
          "-p",
          "--output-format",
          "text",
          "--mode",
          "ask",
          "--trust",
          "--sandbox",
          "enabled",
          "--model",
          "gpt-5.6-sol-high",
          "--workspace",
          cwd,
          "do the work",
        ],
        cwd,
      },
    ]);
    expect(result).toMatchObject({
      rawOutput: "model output",
      alias: "openai-author",
      family: "openai",
      model: "gpt-5.6-sol-high",
    });
    expect(result.receiptPath).toStartWith(stateDir);
    expect(await port.readBack(request)).toEqual({
      status: "found",
      result,
    });
  });

  test("default agent execution leaves the event loop available for progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-async-agent-"));
    const agentPath = join(root, "agent");
    writeFileSync(
      agentPath,
      "#!/bin/sh\nsleep 0.1\nprintf 'model output\\n'\n",
    );
    chmodSync(agentPath, 0o755);
    const port = createHighIntensityCliPort({
      cwd: root,
      env: {
        PATH: root,
        ACM_STATE_DIR: join(root, "state"),
      },
    });
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 10);

    await port.execute({
      assignment: authorAssignment,
      prompt: "do the work",
      contextId: "ctx-author-async",
      phase: "author",
      round: 1,
      workflowDecisionId: "wfd_async_test",
      decisionHash: "2".repeat(64),
      stageId: "author",
      idempotencyKey: "dispatch-async-test",
    });
    clearTimeout(timer);

    expect(timerFired).toBe(true);
  });

  test("fails closed on missing listed model and failed agent command", () => {
    const partial = probeHighIntensityCliAvailability({
      cwd,
      env: {},
      runner: recordingRunner([], "gpt-5.6-sol-high\n"),
      now: () => "2026-07-31T02:00:00.000Z",
    });
    expect(partial.candidates.map((candidate) => candidate.reason)).toEqual([
      "model_not_listed",
      null,
      "model_not_listed",
      "model_not_listed",
    ]);

    const failed = probeHighIntensityCliAvailability({
      cwd,
      env: {},
      runner: () => ({
        status: 1,
        stdout: "",
        stderr: "agent unavailable",
      }),
      now: () => "2026-07-31T02:00:00.000Z",
    });
    expect(failed.candidates.map((candidate) => candidate.state)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(failed.candidates.map((candidate) => candidate.reason)).toEqual([
      "agent_list_models_failed",
      "agent_list_models_failed",
      "agent_list_models_failed",
      "agent_list_models_failed",
    ]);
  });

  test("execution failure rejects instead of falling back", async () => {
    const calls: RunnerCall[] = [];
    const port = createHighIntensityCliPort({
      cwd,
      env: {},
      runner(command, args, options) {
        calls.push({ command, args: [...args], cwd: options.cwd });
        return {
          status: 2,
          stdout: "",
          stderr: "model unavailable",
        };
      },
    });

    await expect(port.execute({
      assignment: authorAssignment,
      prompt: "do the work",
      contextId: "ctx-author-1",
      phase: "author",
      round: 1,
      workflowDecisionId: "wfd_test",
      decisionHash: "1".repeat(64),
      stageId: "author",
      idempotencyKey: "dispatch-test",
    })).rejects.toThrow("agent_execution_failed");
    expect(calls[0]?.args).toContain("gpt-5.6-sol-high");
    expect(calls.length).toBe(1);
  });

  test("does not claim authoritative not_found when only the local receipt is absent", async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "aicoding-mate-high-cli-missing-receipt-"),
    );
    const port = createHighIntensityCliPort({
      cwd,
      env: { ACM_STATE_DIR: stateDir },
      now: () => "2026-07-31T02:00:00.000Z",
      runner: recordingRunner([], ""),
    });

    const readback = await port.readBack({
      assignment: authorAssignment,
      prompt: "do the work",
      contextId: "ctx-author-1",
      phase: "author",
      round: 1,
      workflowDecisionId: "wfd_test",
      decisionHash: "1".repeat(64),
      stageId: "author",
      idempotencyKey: "dispatch-without-local-receipt",
    });

    expect(readback).toEqual({
      status: "mismatch",
      checkedAt: "2026-07-31T02:00:00.000Z",
      reason: "downstream_acceptance_unverifiable_local_receipt_absent",
    });
  });
});

function recordingRunner(
  calls: RunnerCall[],
  stdout: string,
): HighIntensityCliRunner {
  return (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    return {
      status: 0,
      stdout,
      stderr: "",
    };
  };
}
