import { createHash } from "node:crypto";

import {
  assertWorkflowDecisionEnvelope,
  lookupExactStageAssignment,
  sourceLineageHash,
  type SourceLineage,
  type WorkflowDecisionEnvelope,
  type WorkflowRoleAssignment,
} from "../contracts/index.ts";
import {
  isFirstmateDecisionReceipt,
  verifyFirstmateDecisionReceipt,
  type FirstmateDecisionReceipt,
} from "../authority/firstmate-decision-authority.ts";

export type ReviewDelivery = "inline" | "detached";

export type ReviewTarget =
  | { readonly type: "uncommittedChanges" }
  | { readonly type: "baseBranch"; readonly branch: string }
  | { readonly type: "commit"; readonly sha: string; readonly title: string | null }
  | { readonly type: "custom"; readonly instructions: string };

export type ReviewDecision =
  | "approved"
  | "changes_requested"
  | "blocked"
  | "informational"
  | "unverifiable";

export type ReviewVerificationStatus =
  | "confirmed"
  | "failed"
  | "unverifiable"
  | "constructed";

export type NativeAnnotationExportStatus = "confirmed" | "unverifiable";

export type ParentThreadReadState = "complete" | "paginated" | "unknown";

export type ReviewCapsuleLimitation =
  "native_annotation_export_unverifiable";

export interface ReviewSelection {
  readonly selectedText: string | null;
  readonly sourceArtifact: string | null;
  readonly file: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export interface ReviewSource {
  readonly taskId: string;
  readonly runId: string;
  readonly firstmateSessionRef: string;
  readonly lineage: SourceLineage;
}

export interface ReviewPrompt {
  readonly text: string;
}

export interface CodexReviewStartRequest {
  readonly workflowDecisionId: string;
  readonly decisionHash: string;
  readonly stageId: "reviewer";
  readonly idempotencyKey: string;
  readonly exactAssignment: WorkflowRoleAssignment;
  readonly source: ReviewSource;
  readonly target: ReviewTarget;
  readonly selection: ReviewSelection | null;
  readonly prompt: ReviewPrompt;
  readonly delivery: ReviewDelivery;
  readonly parentThreadReadState: ParentThreadReadState;
}

export interface CodexReviewStartReceipt {
  readonly sourceThreadId: string;
  readonly reviewThreadId: string;
  readonly delivery: ReviewDelivery;
  readonly turnId: string | null;
  readonly eventIds: readonly string[];
}

export type CodexReviewReadback =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly sourceThreadId: string;
      readonly sourceLineageHash: string;
      readonly summary: string;
      readonly decision: ReviewDecision | null;
      readonly rawReviewText: string;
      readonly annotations: readonly ReviewAnnotation[];
      readonly nativeAnnotationExport: NativeAnnotationExportStatus;
      readonly eventIds: readonly string[];
      readonly completedAt: string | null;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "bad_thread_id"
        | "thread_not_found"
        | "thread_read_failed"
        | "review_not_completed"
        | "parent_thread_ambiguous";
    };

export interface CodexAppServerReviewPort {
  startReview(
    request: CodexReviewStartRequest,
  ): Promise<CodexReviewStartReceipt>;
  readReviewThread(reviewThreadId: string): Promise<CodexReviewReadback>;
}

export interface CodexDesktopOpenRequest {
  readonly reviewThreadId: string;
  readonly url: string;
}

export interface CodexDesktopOpenReceipt {
  readonly opened: boolean;
  readonly observedThreadId: string | null;
  readonly reason: string | null;
}

export interface CodexDesktopOpenPort {
  openThread(request: CodexDesktopOpenRequest): Promise<CodexDesktopOpenReceipt>;
}

export type CodexDesktopOpenResult =
  | {
      readonly ok: true;
      readonly request: CodexDesktopOpenRequest;
      readonly receipt: CodexDesktopOpenReceipt;
    }
  | {
      readonly ok: false;
      readonly status: "failed_closed";
      readonly reason:
        | "bad_review_thread_id"
        | "desktop_open_failed"
        | "desktop_thread_mismatch";
    };

export interface ReviewCapsuleInput {
  readonly workflowDecision: WorkflowDecisionEnvelope;
  readonly workflowDecisionReceipt: FirstmateDecisionReceipt;
  readonly canonicalRunId: string;
  readonly idempotencyKey: string;
  readonly source: ReviewSource;
  readonly target: ReviewTarget;
  readonly selection: ReviewSelection | null;
  readonly prompt: ReviewPrompt;
  readonly delivery?: ReviewDelivery;
  readonly parentThreadReadState?: ParentThreadReadState;
  readonly now?: () => string;
}

export interface ReviewCapsulePorts {
  readonly appServer: CodexAppServerReviewPort;
  readonly trustedAuthorityRoot: string;
}

export interface ReviewAnnotation {
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly body: string;
  readonly source:
    | "codex_review_text"
    | "native_annotation"
    | "manual_import";
}

export interface ReviewCapsule {
  readonly capsuleVersion: 1;
  readonly capsuleId: string;
  readonly createdAt: string;
  readonly workflowDecision: WorkflowDecisionEnvelope;
  readonly workflowDecisionReceipt: FirstmateDecisionReceipt;
  readonly source: {
    readonly taskId: string;
    readonly runId: string;
    readonly firstmateSessionRef: string;
    readonly lineage: SourceLineage;
    readonly sourceLineageHash: string;
  };
  readonly target: ReviewTarget;
  readonly selection: ReviewSelection | null;
  readonly prompt: {
    readonly text: string;
    readonly hash: string;
  };
  readonly codex: {
    readonly protocol: "app-server-json-rpc";
    readonly delivery: ReviewDelivery;
    readonly sourceThreadId: string;
    readonly reviewThreadId: string;
    readonly desktopUrl: string;
  };
  readonly review: {
    readonly status: "completed";
    readonly summary: string;
    readonly decision: ReviewDecision;
    readonly rawReviewText: string;
    readonly annotations: readonly ReviewAnnotation[];
  };
  readonly verification: {
    readonly threadReadBack: "confirmed";
    readonly sourceLineage: "confirmed";
    readonly desktopDeepLink: "constructed";
    readonly nativeAnnotationExport: NativeAnnotationExportStatus;
  };
  readonly authority: {
    readonly bridgeMode: "port_driven_lineage_verified";
    readonly workflowAuthority: "firstmate_verified";
    readonly runtimeAuthority: "canonical_run_registry_verified";
    readonly canonicalRunId: string;
    readonly idempotencyKey: string;
    readonly codexReviewOwnership: "firstmate_decision_codex_thread";
  };
  readonly limitations: readonly ReviewCapsuleLimitation[];
  readonly lineage: {
    readonly sourceThreadId: string;
    readonly reviewThreadId: string;
    readonly turnId: string | null;
    readonly eventIds: readonly string[];
    readonly readBackEventIds: readonly string[];
    readonly completedAt: string | null;
  };
}

export type ReviewCapsuleFailureReason =
  | "source_task_missing"
  | "source_run_missing"
  | "source_task_lineage_mismatch"
  | "source_run_lineage_mismatch"
  | "firstmate_session_missing"
  | "source_lineage_missing"
  | "firstmate_decision_receipt_invalid"
  | "prompt_missing"
  | "review_target_missing"
  | "parent_thread_paginated"
  | "parent_thread_ambiguous"
  | "app_server_unavailable"
  | "review_thread_id_missing"
  | "bad_review_thread_id"
  | "source_thread_id_missing"
  | "bad_source_thread_id"
  | "thread_not_found"
  | "thread_read_failed"
  | "review_thread_mismatch"
  | "source_thread_mismatch"
  | "source_lineage_mismatch"
  | "review_not_completed"
  | "review_summary_missing";

export type ReviewCapsuleResult =
  | { readonly ok: true; readonly capsule: ReviewCapsule }
  | {
      readonly ok: false;
      readonly status: "failed_closed";
      readonly reason: ReviewCapsuleFailureReason;
    };

export function codexThreadUrl(reviewThreadId: string): string {
  if (!isStableThreadId(reviewThreadId)) {
    throw new Error("bad_review_thread_id");
  }
  return `codex://threads/${reviewThreadId}`;
}

export async function openCodexDesktopThread(
  port: CodexDesktopOpenPort,
  reviewThreadId: string,
): Promise<CodexDesktopOpenResult> {
  let url: string;
  try {
    url = codexThreadUrl(reviewThreadId);
  } catch {
    return {
      ok: false,
      status: "failed_closed",
      reason: "bad_review_thread_id",
    };
  }

  const request = { reviewThreadId, url };
  const receipt = await port.openThread(request);
  if (!receipt.opened) {
    return {
      ok: false,
      status: "failed_closed",
      reason: "desktop_open_failed",
    };
  }
  if (receipt.observedThreadId !== reviewThreadId) {
    return {
      ok: false,
      status: "failed_closed",
      reason: "desktop_thread_mismatch",
    };
  }
  return { ok: true, request, receipt };
}

export async function createReviewCapsule(
  input: ReviewCapsuleInput,
  ports: ReviewCapsulePorts,
): Promise<ReviewCapsuleResult> {
  const validation = validateReviewCapsuleInput(
    input,
    ports.trustedAuthorityRoot,
  );
  if (!validation.ok) return validation;

  const delivery = input.delivery ?? "detached";
  const parentThreadReadState = input.parentThreadReadState ?? "complete";
  if (parentThreadReadState === "paginated") {
    return fail("parent_thread_paginated");
  }
  if (parentThreadReadState === "unknown") {
    return fail("parent_thread_ambiguous");
  }

  const reviewerStage = lookupExactStageAssignment(
    input.workflowDecision,
    "reviewer",
  );
  let start: CodexReviewStartReceipt;
  try {
    start = await ports.appServer.startReview({
      workflowDecisionId: input.workflowDecision.workflowDecisionId,
      decisionHash: input.workflowDecision.decisionHash,
      stageId: "reviewer",
      idempotencyKey: input.idempotencyKey,
      exactAssignment: reviewerStage.roleAssignment,
      source: input.source,
      target: input.target,
      selection: input.selection,
      prompt: input.prompt,
      delivery,
      parentThreadReadState,
    });
  } catch {
    return fail("app_server_unavailable");
  }

  if (start.sourceThreadId.trim().length === 0) {
    return fail("source_thread_id_missing");
  }
  if (!isStableThreadId(start.sourceThreadId)) {
    return fail("bad_source_thread_id");
  }
  if (start.reviewThreadId.trim().length === 0) {
    return fail("review_thread_id_missing");
  }

  let desktopUrl: string;
  try {
    desktopUrl = codexThreadUrl(start.reviewThreadId);
  } catch {
    return fail("bad_review_thread_id");
  }

  let readBack: CodexReviewReadback;
  try {
    readBack = await ports.appServer.readReviewThread(start.reviewThreadId);
  } catch {
    return fail("thread_read_failed");
  }

  if (!readBack.ok) {
    return fail(
      readBack.reason === "bad_thread_id"
        ? "bad_review_thread_id"
        : readBack.reason,
    );
  }

  if (readBack.threadId !== start.reviewThreadId) {
    return fail("review_thread_mismatch");
  }
  if (readBack.sourceThreadId !== start.sourceThreadId) {
    return fail("source_thread_mismatch");
  }

  const expectedLineageHash = sourceLineageHash(input.source.lineage);
  if (readBack.sourceLineageHash !== expectedLineageHash) {
    return fail("source_lineage_mismatch");
  }
  if (readBack.summary.trim().length === 0) {
    return fail("review_summary_missing");
  }

  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const promptHash = sha256(input.prompt.text);
  const capsuleId = sha256(
    JSON.stringify({
      source: input.source,
      target: input.target,
      promptHash,
      reviewThreadId: start.reviewThreadId,
    }),
  );

  return {
    ok: true,
    capsule: {
      capsuleVersion: 1,
      capsuleId,
      createdAt,
      workflowDecision: input.workflowDecision,
      workflowDecisionReceipt: input.workflowDecisionReceipt,
      source: {
        taskId: input.source.taskId,
        runId: input.source.runId,
        firstmateSessionRef: input.source.firstmateSessionRef,
        lineage: input.source.lineage,
        sourceLineageHash: expectedLineageHash,
      },
      target: input.target,
      selection: input.selection,
      prompt: {
        text: input.prompt.text,
        hash: promptHash,
      },
      codex: {
        protocol: "app-server-json-rpc",
        delivery: start.delivery,
        sourceThreadId: start.sourceThreadId,
        reviewThreadId: start.reviewThreadId,
        desktopUrl,
      },
      review: {
        status: "completed",
        summary: readBack.summary,
        decision: readBack.decision ?? "unverifiable",
        rawReviewText: readBack.rawReviewText,
        annotations: readBack.annotations,
      },
      verification: {
        threadReadBack: "confirmed",
        sourceLineage: "confirmed",
        desktopDeepLink: "constructed",
        nativeAnnotationExport: readBack.nativeAnnotationExport,
      },
      authority: {
        bridgeMode: "port_driven_lineage_verified",
        workflowAuthority: "firstmate_verified",
        runtimeAuthority: "canonical_run_registry_verified",
        canonicalRunId: input.canonicalRunId,
        idempotencyKey: input.idempotencyKey,
        codexReviewOwnership: "firstmate_decision_codex_thread",
      },
      limitations: capsuleLimitations(readBack.nativeAnnotationExport),
      lineage: {
        sourceThreadId: start.sourceThreadId,
        reviewThreadId: start.reviewThreadId,
        turnId: start.turnId,
        eventIds: start.eventIds,
        readBackEventIds: readBack.eventIds,
        completedAt: readBack.completedAt,
      },
    },
  };
}

function validateReviewCapsuleInput(
  input: ReviewCapsuleInput,
  trustedAuthorityRoot: string,
): ReviewCapsuleResult | { readonly ok: true } {
  if (
    !isFirstmateDecisionReceipt(input.workflowDecisionReceipt)
    || !verifyFirstmateDecisionReceipt(
      input.workflowDecision,
      input.workflowDecisionReceipt,
      trustedAuthorityRoot,
    )
  ) {
    return fail("firstmate_decision_receipt_invalid");
  }
  if (input.source.taskId.trim().length === 0) return fail("source_task_missing");
  if (input.source.runId.trim().length === 0) return fail("source_run_missing");
  if (input.source.firstmateSessionRef.trim().length === 0) {
    return fail("firstmate_session_missing");
  }
  const lineage = input.source.lineage;
  if (
    lineage.taskId.trim().length === 0 ||
    lineage.runId.trim().length === 0 ||
    lineage.workspace.trim().length === 0 ||
    lineage.tabId.trim().length === 0 ||
    lineage.paneId.trim().length === 0
  ) {
    return fail("source_lineage_missing");
  }
  if (input.source.taskId !== lineage.taskId) {
    return fail("source_task_lineage_mismatch");
  }
  if (input.source.runId !== lineage.runId) {
    return fail("source_run_lineage_mismatch");
  }
  if (input.prompt.text.trim().length === 0) return fail("prompt_missing");
  if (!hasReviewTarget(input.target)) return fail("review_target_missing");
  if (
    input.canonicalRunId.trim().length === 0
    || input.idempotencyKey.trim().length === 0
  ) {
    return fail("source_run_missing");
  }
  try {
    assertWorkflowDecisionEnvelope(input.workflowDecision);
  } catch {
    return fail("source_run_lineage_mismatch");
  }
  if (
    input.workflowDecision.recipe.id !== "native-review"
    || sourceLineageHash(input.workflowDecision.sourceLineage)
      !== sourceLineageHash(input.source.lineage)
  ) {
    return fail("source_run_lineage_mismatch");
  }
  return { ok: true };
}

function hasReviewTarget(target: ReviewTarget): boolean {
  switch (target.type) {
    case "uncommittedChanges":
      return true;
    case "baseBranch":
      return target.branch.trim().length > 0;
    case "commit":
      return target.sha.trim().length > 0;
    case "custom":
      return target.instructions.trim().length > 0;
  }
}

function isStableThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function capsuleLimitations(
  nativeAnnotationExport: NativeAnnotationExportStatus,
): readonly ReviewCapsuleLimitation[] {
  const limitations: ReviewCapsuleLimitation[] = [];
  if (nativeAnnotationExport === "unverifiable") {
    limitations.push("native_annotation_export_unverifiable");
  }
  return limitations;
}

function fail(reason: ReviewCapsuleFailureReason): ReviewCapsuleResult {
  return { ok: false, status: "failed_closed", reason };
}
