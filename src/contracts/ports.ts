import { createHash } from "node:crypto";

import type { RoleAssignment } from "./routing.ts";

export const CONTEXT_SELECTION_MAX_CHARS = 8_000;

export const ALLOWED_BRANCH_TRANSCRIPT_ENTRY_KINDS = [
  "brief",
  "recitation",
  "confirmation_result",
] as const;

export type AllowedBranchTranscriptEntryKind =
  (typeof ALLOWED_BRANCH_TRANSCRIPT_ENTRY_KINDS)[number];

export interface SourceLineage {
  readonly taskId: string;
  readonly runId: string;
  readonly workspace: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface FirstmateDispatchRequest {
  readonly idempotencyKey: string;
  readonly workflow: "standard";
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly stageId: "author";
  readonly exactAssignment: RoleAssignment;
  readonly projectDir: string;
  readonly source: SourceLineage;
  readonly task: string;
}

export type FirstmateDispatchReceipt =
  | {
      readonly accepted: true;
      readonly idempotencyStatus: "accepted" | "duplicate";
      readonly firstmateTaskId: string;
      readonly workerTarget: string;
      readonly evidencePath: string;
      readonly reason: null;
    }
  | {
      readonly accepted: false;
      readonly idempotencyStatus: "rejected";
      readonly firstmateTaskId: null;
      readonly workerTarget: null;
      readonly evidencePath: null;
      readonly reason: string;
    };

export interface FirstmateDispatchPort {
  dispatch(
    request: FirstmateDispatchRequest,
  ): Promise<FirstmateDispatchReceipt>;
}

export type PreConfirmationCapsuleStatus =
  | "created"
  | "briefed"
  | "researching"
  | "recited"
  | "expired"
  | "failed_closed";

interface ContextCapsuleCore {
  readonly capsuleId: string;
  readonly selectedText: string;
  readonly selectedTextHash: string;
  readonly source: SourceLineage;
  readonly firstmateSessionRef: string;
  readonly recitation: string;
  readonly mutationIntent: string;
}

export interface PreConfirmationContextCapsule extends ContextCapsuleCore {
  readonly status: PreConfirmationCapsuleStatus;
  readonly confirmationId: null;
  readonly confirmedAt: null;
}

export interface ConfirmedContextCapsule extends ContextCapsuleCore {
  readonly status: "confirmed";
  readonly confirmationId: string;
  readonly confirmedAt: string;
}

export interface SentContextCapsule extends ContextCapsuleCore {
  readonly status: "sent";
  readonly confirmationId: string;
  readonly confirmedAt: string;
}

export type ContextCapsule =
  | PreConfirmationContextCapsule
  | ConfirmedContextCapsule
  | SentContextCapsule;

export type ContextSelectionValidation =
  | {
      readonly ok: true;
      readonly charLength: number;
      readonly selectedTextHash: string;
    }
  | {
      readonly ok: false;
      readonly status: "failed_closed";
      readonly reason: "selection_empty" | "selection_too_large";
      readonly charLength: number;
    };

export interface AtomicCapsuleInjectionRequest {
  readonly capsule: ConfirmedContextCapsule;
  readonly expectedLineageHash: string;
}

export interface CapsuleInjectionReceipt {
  readonly accepted: boolean;
  readonly observedLineage: SourceLineage | null;
  readonly targetSessionRef: string | null;
  readonly injectedTextHash: string | null;
  readonly idempotencyStatus: "accepted" | "duplicate" | "rejected";
  readonly reason: string | null;
}

/**
 * The adapter must re-resolve the source pane, compare expectedLineageHash,
 * and inject the capsule as one atomic operation. A check-then-send adapter
 * does not satisfy this port.
 */
export interface AtomicFirstmateCapsuleInjectionPort {
  revalidateAndInject(
    request: AtomicCapsuleInjectionRequest,
  ): Promise<CapsuleInjectionReceipt>;
}

export type CapsuleInjectionResult =
  | { readonly ok: true; readonly receipt: CapsuleInjectionReceipt }
  | { readonly ok: false; readonly reason: string };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function selectedTextHash(selectedText: string): string {
  return sha256(selectedText);
}

export function validateContextSelection(
  selectedText: string,
): ContextSelectionValidation {
  const charLength = Array.from(selectedText).length;
  if (charLength === 0) {
    return {
      ok: false,
      status: "failed_closed",
      reason: "selection_empty",
      charLength,
    };
  }
  if (charLength > CONTEXT_SELECTION_MAX_CHARS) {
    return {
      ok: false,
      status: "failed_closed",
      reason: "selection_too_large",
      charLength,
    };
  }
  return {
    ok: true,
    charLength,
    selectedTextHash: selectedTextHash(selectedText),
  };
}

export function sourceLineageHash(source: SourceLineage): string {
  return sha256(
    JSON.stringify({
      taskId: source.taskId,
      runId: source.runId,
      workspace: source.workspace,
      tabId: source.tabId,
      paneId: source.paneId,
    }),
  );
}

export function isAllowedBranchTranscriptEntryKind(
  value: string,
): value is AllowedBranchTranscriptEntryKind {
  return (
    ALLOWED_BRANCH_TRANSCRIPT_ENTRY_KINDS as readonly string[]
  ).includes(value);
}

export async function injectConfirmedCapsule(
  port: AtomicFirstmateCapsuleInjectionPort,
  capsule: ContextCapsule,
): Promise<CapsuleInjectionResult> {
  if (capsule.status !== "confirmed") {
    return { ok: false, reason: "capsule_not_confirmed" };
  }
  const selection = validateContextSelection(capsule.selectedText);
  if (!selection.ok) {
    return { ok: false, reason: selection.reason };
  }
  if (selection.selectedTextHash !== capsule.selectedTextHash) {
    return { ok: false, reason: "capsule_hash_mismatch" };
  }

  const expectedLineageHash = sourceLineageHash(capsule.source);
  const receipt = await port.revalidateAndInject({
    capsule,
    expectedLineageHash,
  });

  if (!receipt.accepted) {
    return {
      ok: false,
      reason: receipt.reason ?? "capsule_injection_rejected",
    };
  }
  if (receipt.idempotencyStatus !== "accepted") {
    return { ok: false, reason: "capsule_already_used" };
  }
  if (
    receipt.observedLineage === null ||
    sourceLineageHash(receipt.observedLineage) !== expectedLineageHash
  ) {
    return { ok: false, reason: "source_lineage_changed" };
  }
  if (receipt.targetSessionRef !== capsule.firstmateSessionRef) {
    return { ok: false, reason: "target_session_changed" };
  }
  if (receipt.injectedTextHash !== capsule.selectedTextHash) {
    return { ok: false, reason: "injection_readback_mismatch" };
  }

  return { ok: true, receipt };
}
