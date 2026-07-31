import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { FileFirstmateWorkflowAuthority } from "../src/authority/firstmate-workflow-authority.ts";
import type { SourceLineage } from "../src/contracts/index.ts";

const source: SourceLineage = {
  taskId: "task-authority-test",
  runId: "run-authority-test",
  workspace: "W1",
  tabId: "T1",
  paneId: "P1",
};

describe("Firstmate workflow authority", () => {
  test("fails closed before decision issuance when model policy is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-authority-"));
    const configPath = join(root, "runtime-models.yaml");
    writeFileSync(configPath, "version: 1\n");
    const authority = new FileFirstmateWorkflowAuthority({
      stateDir: join(root, "state"),
      env: { ACM_RUNTIME_MODEL_CONFIG: configPath },
    });

    expect(authority.decideNativeReview({
      intentHash: "a".repeat(64),
      source,
    })).toEqual({
      status: "blocked",
      reason: "model_policy_invalid:native_review_model_config_missing",
    });
  });

  test("requires signed decision read-back before authorizing a stage", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-authority-"));
    const authority = new FileFirstmateWorkflowAuthority({
      stateDir: join(root, "state"),
    });
    const decided = authority.decideNativeReview({
      intentHash: "b".repeat(64),
      source,
    });
    if (decided.status !== "resolved") {
      throw new Error(`unexpected blocker: ${decided.reason}`);
    }

    expect(authority.authorizeStage({
      workflowDecision: decided.workflowDecision,
      receipt: decided.receipt,
      stageId: "reviewer",
    }).roleAssignment.resolvedModel).toBe("gpt-5.6-sol");

    expect(() =>
      authority.authorizeStage({
        workflowDecision: {
          ...decided.workflowDecision,
          decisionHash: "c".repeat(64),
        },
        receipt: decided.receipt,
        stageId: "reviewer",
      })
    ).toThrow("firstmate_stage_authorization_readback_failed");
  });
});
