import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  assertWorkflowDecisionEnvelope,
  type WorkflowDecisionEnvelope,
} from "./workflow-authority.ts";

export interface FirstmateDecisionReceipt {
  readonly schemaVersion: 1;
  readonly issuer: "firstmate_control_plane";
  readonly authorityVersion: "0.2";
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly issuedAt: string;
  readonly decisionArtifact: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly signing: {
    readonly algorithm: "Ed25519";
    readonly publicKeyPath: string;
    readonly publicKeyFingerprint: string;
    readonly signature: string;
  };
  readonly receiptPath: string;
}

export interface FirstmateDecisionAuthorityPort {
  issueDecision(decision: WorkflowDecisionEnvelope): FirstmateDecisionReceipt;
  readDecision(
    decision: WorkflowDecisionEnvelope,
    receiptPath: string,
  ): FirstmateDecisionReceipt | undefined;
}

export interface FileFirstmateDecisionAuthorityOptions {
  readonly rootDir: string;
  readonly now?: () => string;
}

export class FileFirstmateDecisionAuthority
  implements FirstmateDecisionAuthorityPort
{
  readonly rootDir: string;
  private readonly now: () => string;

  constructor(options: FileFirstmateDecisionAuthorityOptions) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  issueDecision(
    decision: WorkflowDecisionEnvelope,
  ): FirstmateDecisionReceipt {
    assertWorkflowDecisionEnvelope(decision);
    const paths = this.pathsFor(decision.workflowDecisionId);
    const decisionContent = `${JSON.stringify(decision, null, 2)}\n`;
    writeImmutable(paths.decisionPath, decisionContent, 0o600);
    const decisionArtifactHash = sha256(decisionContent);
    const keys = this.loadOrCreateSigningIdentity();

    const existing = this.readDecision(decision, paths.receiptPath);
    if (existing !== undefined) return existing;

    const issuedAt = this.now();
    const signaturePayload = receiptSignaturePayload({
      workflowDecisionId: decision.workflowDecisionId,
      decisionHash: decision.decisionHash,
      decisionArtifactHash,
      issuedAt,
    });
    const receipt: FirstmateDecisionReceipt = {
      schemaVersion: 1,
      issuer: "firstmate_control_plane",
      authorityVersion: "0.2",
      workflowDecisionId: decision.workflowDecisionId,
      decisionHash: decision.decisionHash,
      issuedAt,
      decisionArtifact: {
        path: paths.decisionPath,
        sha256: decisionArtifactHash,
      },
      signing: {
        algorithm: "Ed25519",
        publicKeyPath: keys.publicKeyPath,
        publicKeyFingerprint: sha256(keys.publicKeyPem),
        signature: sign(
          null,
          Buffer.from(signaturePayload, "utf8"),
          keys.privateKeyPem,
        ).toString("base64"),
      },
      receiptPath: paths.receiptPath,
    };
    const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
    try {
      writeImmutable(paths.receiptPath, receiptContent, 0o600);
    } catch (error) {
      const raced = this.readDecision(decision, paths.receiptPath);
      if (raced !== undefined) return raced;
      throw error;
    }
    const readBack = this.readDecision(decision, paths.receiptPath);
    if (readBack === undefined) {
      throw new Error("firstmate_decision_receipt_readback_failed");
    }
    return readBack;
  }

  readDecision(
    decision: WorkflowDecisionEnvelope,
    receiptPath: string,
  ): FirstmateDecisionReceipt | undefined {
    try {
      assertWorkflowDecisionEnvelope(decision);
      const expected = this.pathsFor(decision.workflowDecisionId);
      if (resolve(receiptPath) !== expected.receiptPath) return undefined;
      const receipt = JSON.parse(
        readFileSync(expected.receiptPath, "utf8"),
      ) as unknown;
      if (!isFirstmateDecisionReceipt(receipt)) return undefined;
      if (
        receipt.workflowDecisionId !== decision.workflowDecisionId
        || receipt.decisionHash !== decision.decisionHash
        || resolve(receipt.decisionArtifact.path) !== expected.decisionPath
        || resolve(receipt.signing.publicKeyPath) !== expected.publicKeyPath
        || resolve(receipt.receiptPath) !== expected.receiptPath
      ) {
        return undefined;
      }
      const decisionContent = readFileSync(expected.decisionPath, "utf8");
      if (sha256(decisionContent) !== receipt.decisionArtifact.sha256) {
        return undefined;
      }
      const storedDecision = JSON.parse(decisionContent) as unknown;
      assertWorkflowDecisionEnvelope(storedDecision);
      if (JSON.stringify(storedDecision) !== JSON.stringify(decision)) {
        return undefined;
      }
      const publicKeyPem = readFileSync(expected.publicKeyPath, "utf8");
      if (sha256(publicKeyPem) !== receipt.signing.publicKeyFingerprint) {
        return undefined;
      }
      const signaturePayload = receiptSignaturePayload({
        workflowDecisionId: receipt.workflowDecisionId,
        decisionHash: receipt.decisionHash,
        decisionArtifactHash: receipt.decisionArtifact.sha256,
        issuedAt: receipt.issuedAt,
      });
      if (
        !verify(
          null,
          Buffer.from(signaturePayload, "utf8"),
          publicKeyPem,
          Buffer.from(receipt.signing.signature, "base64"),
        )
      ) {
        return undefined;
      }
      return receipt;
    } catch {
      return undefined;
    }
  }

  private pathsFor(workflowDecisionId: string): {
    readonly decisionPath: string;
    readonly receiptPath: string;
    readonly publicKeyPath: string;
  } {
    if (!/^wfd_[a-f0-9]{32}$/.test(workflowDecisionId)) {
      throw new Error("firstmate_decision_id_invalid");
    }
    return {
      decisionPath: join(
        this.rootDir,
        "decisions",
        `${workflowDecisionId}.json`,
      ),
      receiptPath: join(
        this.rootDir,
        "receipts",
        `${workflowDecisionId}.json`,
      ),
      publicKeyPath: join(this.rootDir, "identity", "ed25519-public.pem"),
    };
  }

  private loadOrCreateSigningIdentity(): {
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
    readonly publicKeyPath: string;
  } {
    const identityDir = join(this.rootDir, "identity");
    const privateKeyPath = join(identityDir, "ed25519-private.pem");
    const publicKeyPath = join(identityDir, "ed25519-public.pem");
    mkdirSync(identityDir, { recursive: true });

    let privateKeyPem: string;
    try {
      privateKeyPem = readFileSync(privateKeyPath, "utf8");
    } catch {
      const generated = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      try {
        writeFileSync(privateKeyPath, generated.privateKey, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        privateKeyPem = generated.privateKey;
      } catch {
        privateKeyPem = readFileSync(privateKeyPath, "utf8");
      }
    }

    const publicKeyPem = createPublicKey(privateKeyPem).export({
      type: "spki",
      format: "pem",
    }).toString();
    try {
      writeImmutable(publicKeyPath, publicKeyPem, 0o644);
    } catch {
      if (readFileSync(publicKeyPath, "utf8") !== publicKeyPem) {
        throw new Error("firstmate_signing_identity_conflict");
      }
    }
    return { privateKeyPem, publicKeyPem, publicKeyPath };
  }
}

export function resolveFirstmateAuthorityRoot(
  stateDir: string,
  env: NodeJS.ProcessEnv = {},
): string {
  const explicit = env.ACM_FIRSTMATE_AUTHORITY_DIR?.trim();
  if (explicit) return resolve(explicit);
  const fmHome = env.FM_HOME?.trim();
  if (fmHome) return join(resolve(fmHome), "aicoding-mate-authority");
  return join(resolve(stateDir), "firstmate-authority");
}

export function verifyFirstmateDecisionReceipt(
  decision: WorkflowDecisionEnvelope,
  receipt: FirstmateDecisionReceipt,
  trustedAuthorityRoot: string,
): boolean {
  const authority = new FileFirstmateDecisionAuthority({
    rootDir: trustedAuthorityRoot,
  });
  return authority.readDecision(decision, receipt.receiptPath) !== undefined;
}

function receiptSignaturePayload(input: {
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly decisionArtifactHash: string;
  readonly issuedAt: string;
}): string {
  return JSON.stringify({
    workflowDecisionId: input.workflowDecisionId,
    decisionHash: input.decisionHash,
    decisionArtifactHash: input.decisionArtifactHash,
    issuedAt: input.issuedAt,
  });
}

function writeImmutable(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
  } catch (error) {
    try {
      if (readFileSync(path, "utf8") === content) return;
    } catch {
    }
    throw error;
  }
}

export function isFirstmateDecisionReceipt(
  value: unknown,
): value is FirstmateDecisionReceipt {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1
    || value.issuer !== "firstmate_control_plane"
    || value.authorityVersion !== "0.2"
    || typeof value.workflowDecisionId !== "string"
    || typeof value.decisionHash !== "string"
    || typeof value.issuedAt !== "string"
    || typeof value.receiptPath !== "string"
    || !isRecord(value.decisionArtifact)
    || typeof value.decisionArtifact.path !== "string"
    || typeof value.decisionArtifact.sha256 !== "string"
    || !isRecord(value.signing)
    || value.signing.algorithm !== "Ed25519"
    || typeof value.signing.publicKeyPath !== "string"
    || typeof value.signing.publicKeyFingerprint !== "string"
    || typeof value.signing.signature !== "string"
  ) {
    return false;
  }
  return (
    /^wfd_[a-f0-9]{32}$/.test(value.workflowDecisionId)
    && /^[a-f0-9]{64}$/.test(value.decisionHash)
    && /^[a-f0-9]{64}$/.test(value.decisionArtifact.sha256)
    && /^[a-f0-9]{64}$/.test(value.signing.publicKeyFingerprint)
    && value.signing.signature.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
