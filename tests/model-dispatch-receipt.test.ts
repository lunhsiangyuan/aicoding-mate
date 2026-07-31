import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  persistModelDispatchReceipt,
  readModelDispatchReceipt,
  type ModelDispatchIdentity,
} from "../src/runtime/model-dispatch-receipt.ts";

const identity: ModelDispatchIdentity = {
  idempotencyKey: "dispatch-reviewer-1",
  workflowDecisionId: "wfd_review_1",
  decisionHash: "1".repeat(64),
  stageId: "reviewer",
  assignment: {
    role: "reviewer",
    alias: "anthropic-reviewer",
    provider: "anthropic",
    family: "anthropic",
    resolvedModel: "fable",
    capabilityTier: "architecture",
    reason: "independent cross-family review",
  },
};

describe("model dispatch receipt", () => {
  test("persists output and verifies exact identity on read-back", () => {
    const rootDir = mkdtempSync(
      join(tmpdir(), "aicoding-mate-model-receipt-"),
    );
    const persisted = persistModelDispatchReceipt({
      rootDir,
      identity,
      rawOutput: "review accepted",
      completedAt: "2026-07-31T02:00:00.000Z",
    });

    expect(
      readModelDispatchReceipt(persisted.receipt.receiptPath, identity),
    ).toEqual(persisted);
    expect(
      readModelDispatchReceipt(persisted.receipt.receiptPath, {
        ...identity,
        assignment: {
          ...identity.assignment,
          resolvedModel: "different-model",
        },
      }),
    ).toBeUndefined();
  });

  test("rejects tampered output even when the receipt JSON still exists", () => {
    const rootDir = mkdtempSync(
      join(tmpdir(), "aicoding-mate-model-receipt-"),
    );
    const persisted = persistModelDispatchReceipt({
      rootDir,
      identity,
      rawOutput: "original review",
      completedAt: "2026-07-31T02:00:00.000Z",
    });

    writeFileSync(persisted.receipt.outputPath, "tampered review");

    expect(
      readModelDispatchReceipt(persisted.receipt.receiptPath, identity),
    ).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(persisted.receipt.receiptPath, "utf8"),
      ).outputHash,
    ).toBe(persisted.receipt.outputHash);
    expect(() =>
      persistModelDispatchReceipt({
        rootDir,
        identity,
        rawOutput: "original review",
        completedAt: "2026-07-31T02:01:00.000Z",
      })
    ).toThrow("model_dispatch_receipt_invalid_existing");
  });

  test("same key is idempotent for identical output and rejects conflicts", () => {
    const rootDir = mkdtempSync(
      join(tmpdir(), "aicoding-mate-model-receipt-"),
    );
    const first = persistModelDispatchReceipt({
      rootDir,
      identity,
      rawOutput: "stable review",
      completedAt: "2026-07-31T02:00:00.000Z",
    });
    const repeated = persistModelDispatchReceipt({
      rootDir,
      identity,
      rawOutput: "stable review",
      completedAt: "2026-07-31T02:01:00.000Z",
    });

    expect(repeated).toEqual(first);
    expect(() =>
      persistModelDispatchReceipt({
        rootDir,
        identity,
        rawOutput: "conflicting review",
        completedAt: "2026-07-31T02:02:00.000Z",
      })
    ).toThrow("model_dispatch_receipt_conflict");
  });
});
