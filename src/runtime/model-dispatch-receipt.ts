import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { RoleAssignment } from "../contracts/index.ts";

export interface ModelDispatchIdentity {
  readonly idempotencyKey: string;
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly stageId: string;
  readonly assignment: RoleAssignment;
}

export interface ModelDispatchReceipt extends ModelDispatchIdentity {
  readonly schemaVersion: 1;
  readonly completedAt: string;
  readonly outputPath: string;
  readonly outputHash: string;
  readonly receiptPath: string;
}

export interface ModelDispatchReadback {
  readonly receipt: ModelDispatchReceipt;
  readonly rawOutput: string;
}

export function modelDispatchReceiptPath(
  rootDir: string,
  idempotencyKey: string,
): string {
  return join(
    resolve(rootDir),
    sha256(idempotencyKey),
    "receipt.json",
  );
}

export function persistModelDispatchReceipt(options: {
  readonly rootDir: string;
  readonly identity: ModelDispatchIdentity;
  readonly rawOutput: string;
  readonly completedAt: string;
}): ModelDispatchReadback {
  if (!options.rawOutput.trim()) {
    throw new Error("model_dispatch_output_empty");
  }
  const receiptPath = modelDispatchReceiptPath(
    options.rootDir,
    options.identity.idempotencyKey,
  );
  const existing = readModelDispatchReceipt(
    receiptPath,
    options.identity,
  );
  if (existing !== undefined) {
    if (existing.rawOutput !== options.rawOutput) {
      throw new Error("model_dispatch_receipt_conflict");
    }
    return existing;
  }

  const outputPath = join(dirname(receiptPath), "output.txt");
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileAtomic(outputPath, options.rawOutput);
  const receipt: ModelDispatchReceipt = {
    schemaVersion: 1,
    ...options.identity,
    completedAt: options.completedAt,
    outputPath,
    outputHash: sha256(options.rawOutput),
    receiptPath,
  };
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const readback = readModelDispatchReceipt(receiptPath, options.identity);
  if (readback === undefined || readback.rawOutput !== options.rawOutput) {
    throw new Error("model_dispatch_receipt_readback_failed");
  }
  return readback;
}

export function readModelDispatchReceipt(
  receiptPath: string,
  expected: ModelDispatchIdentity,
): ModelDispatchReadback | undefined {
  try {
    const canonicalReceiptPath = resolve(receiptPath);
    const value: unknown = JSON.parse(
      readFileSync(canonicalReceiptPath, "utf8"),
    );
    if (!isModelDispatchReceipt(value)) return undefined;
    if (
      resolve(value.receiptPath) !== canonicalReceiptPath
      || dirname(resolve(value.outputPath)) !== dirname(canonicalReceiptPath)
      || !sameIdentity(value, expected)
    ) {
      return undefined;
    }
    const rawOutput = readFileSync(value.outputPath, "utf8");
    if (!rawOutput.trim() || sha256(rawOutput) !== value.outputHash) {
      return undefined;
    }
    return { receipt: value, rawOutput };
  } catch {
    return undefined;
  }
}

function sameIdentity(
  actual: ModelDispatchIdentity,
  expected: ModelDispatchIdentity,
): boolean {
  return actual.idempotencyKey === expected.idempotencyKey
    && actual.workflowDecisionId === expected.workflowDecisionId
    && actual.decisionHash === expected.decisionHash
    && actual.stageId === expected.stageId
    && actual.assignment.role === expected.assignment.role
    && actual.assignment.alias === expected.assignment.alias
    && actual.assignment.provider === expected.assignment.provider
    && actual.assignment.family === expected.assignment.family
    && actual.assignment.resolvedModel === expected.assignment.resolvedModel
    && actual.assignment.capabilityTier
      === expected.assignment.capabilityTier
    && actual.assignment.reason === expected.assignment.reason;
}

function isModelDispatchReceipt(
  value: unknown,
): value is ModelDispatchReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelDispatchReceipt>;
  return candidate.schemaVersion === 1
    && typeof candidate.idempotencyKey === "string"
    && typeof candidate.workflowDecisionId === "string"
    && typeof candidate.decisionHash === "string"
    && typeof candidate.stageId === "string"
    && typeof candidate.completedAt === "string"
    && typeof candidate.outputPath === "string"
    && typeof candidate.outputHash === "string"
    && typeof candidate.receiptPath === "string"
    && isRoleAssignment(candidate.assignment);
}

function isRoleAssignment(value: unknown): value is RoleAssignment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoleAssignment>;
  return typeof candidate.role === "string"
    && typeof candidate.alias === "string"
    && typeof candidate.provider === "string"
    && typeof candidate.family === "string"
    && typeof candidate.resolvedModel === "string"
    && typeof candidate.reason === "string"
    && (
      candidate.capabilityTier === "search"
      || candidate.capabilityTier === "implementation"
      || candidate.capabilityTier === "architecture"
    );
}

function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
