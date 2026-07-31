import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  FileFirstmateDecisionAuthority,
  verifyFirstmateDecisionReceipt,
} from "../src/authority/firstmate-decision-authority.ts";
import {
  createWorkflowDecisionEnvelope,
  type WorkflowDecisionInput,
} from "../src/contracts/index.ts";

describe("Firstmate decision authority", () => {
  test("issues one signed receipt and reads it back idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "firstmate-authority-"));
    const authority = new FileFirstmateDecisionAuthority({
      rootDir: root,
      now: () => "2026-07-31T01:00:00.000Z",
    });
    const decision = createWorkflowDecisionEnvelope(decisionInput());

    const first = authority.issueDecision(decision);
    const second = authority.issueDecision(decision);

    expect(second).toEqual(first);
    expect(first.issuer).toBe("firstmate_control_plane");
    expect(first.signing.algorithm).toBe("Ed25519");
    expect(authority.readDecision(decision, first.receiptPath)).toEqual(first);
    expect(verifyFirstmateDecisionReceipt(decision, first, root)).toBe(true);
  });

  test("rejects a decision artifact changed after issuance", () => {
    const root = mkdtempSync(join(tmpdir(), "firstmate-authority-"));
    const authority = new FileFirstmateDecisionAuthority({ rootDir: root });
    const decision = createWorkflowDecisionEnvelope(decisionInput());
    const receipt = authority.issueDecision(decision);
    writeFileSync(
      receipt.decisionArtifact.path,
      readFileSync(receipt.decisionArtifact.path, "utf8").replace(
        "\"maxRounds\": 1",
        "\"maxRounds\": 2",
      ),
    );

    expect(
      authority.readDecision(decision, receipt.receiptPath),
    ).toBeUndefined();
    expect(verifyFirstmateDecisionReceipt(decision, receipt, root)).toBe(false);
  });

  test("rejects a valid self-signed receipt from an attacker-controlled alternate root", () => {
    const trustedRoot = mkdtempSync(join(tmpdir(), "firstmate-authority-"));
    const attackerRoot = mkdtempSync(join(tmpdir(), "firstmate-attacker-"));
    const trustedAuthority = new FileFirstmateDecisionAuthority({
      rootDir: trustedRoot,
      now: () => "2026-07-31T01:00:00.000Z",
    });
    const attackerAuthority = new FileFirstmateDecisionAuthority({
      rootDir: attackerRoot,
      now: () => "2026-07-31T01:00:00.000Z",
    });
    const decision = createWorkflowDecisionEnvelope(decisionInput());
    const trustedReceipt = trustedAuthority.issueDecision(decision);
    const attackerReceipt = attackerAuthority.issueDecision(decision);

    expect(
      verifyFirstmateDecisionReceipt(decision, trustedReceipt, trustedRoot),
    ).toBe(true);
    expect(
      attackerAuthority.readDecision(decision, attackerReceipt.receiptPath),
    ).toEqual(attackerReceipt);
    expect(
      verifyFirstmateDecisionReceipt(decision, attackerReceipt, trustedRoot),
    ).toBe(false);
  });

  test("rejects a receipt whose signature is changed", () => {
    const root = mkdtempSync(join(tmpdir(), "firstmate-authority-"));
    const authority = new FileFirstmateDecisionAuthority({ rootDir: root });
    const decision = createWorkflowDecisionEnvelope(decisionInput());
    const receipt = authority.issueDecision(decision);
    const parsed = JSON.parse(
      readFileSync(receipt.receiptPath, "utf8"),
    ) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.signing)) {
      throw new Error("receipt fixture invalid");
    }
    writeFileSync(
      receipt.receiptPath,
      `${JSON.stringify({
        ...parsed,
        signing: {
          ...parsed.signing,
          signature: Buffer.from("tampered").toString("base64"),
        },
      }, null, 2)}\n`,
    );

    expect(
      authority.readDecision(decision, receipt.receiptPath),
    ).toBeUndefined();
  });
});

function decisionInput(): WorkflowDecisionInput {
  const hash = "1".repeat(64);
  return {
    workflowDecisionVersion: 1,
    recipe: { id: "standard", version: "0.2.0" },
    hashes: {
      intentHash: hash,
      configHash: "2".repeat(64),
      availabilityHash: "3".repeat(64),
    },
    sourceLineage: {
      taskId: "task-1",
      runId: "run-1",
      workspace: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
    },
    roleAssignments: [
      {
        role: "author",
        alias: "openai-author",
        provider: "openai",
        family: "openai",
        resolvedModel: "configured-openai-author",
        capabilityTier: "implementation",
        reason: "fixture",
      },
      {
        role: "report_composer",
        alias: "firstmate-report-composer",
        provider: "firstmate",
        family: "firstmate",
        resolvedModel: "deterministic-v0.2",
        capabilityTier: "architecture",
        reason: "fixture",
      },
    ],
    stageAssignments: [
      { stageId: "author", role: "author", barrierId: "author_complete" },
      {
        stageId: "report",
        role: "report_composer",
        barrierId: "report_complete",
      },
    ],
    stageBarriers: [
      {
        id: "author_complete",
        afterStageId: "author",
        requires: ["author_read_back"],
      },
      {
        id: "report_complete",
        afterStageId: "report",
        requires: ["report_read_back"],
      },
    ],
    maxRounds: 1,
    stopConditions: ["completed", "failed_closed"],
    fallbackPolicy: {
      behavior: "new_decision_required",
      reason: "Firstmate issues a new decision.",
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
