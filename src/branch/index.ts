import {
  injectConfirmedCapsule,
  isAllowedBranchTranscriptEntryKind,
  selectedTextHash,
  sourceLineageHash,
  validateContextSelection,
  type AtomicFirstmateCapsuleInjectionPort,
  type ConfirmedContextCapsule,
  type ContextCapsule,
  type SourceLineage,
} from "../contracts/index.ts";

export type BranchStatus =
  | "created"
  | "briefed"
  | "researching"
  | "recited"
  | "confirmed"
  | "sent"
  | "expired"
  | "failed_closed";

export type MutationIntent = "new_task" | "modify_task";

export type BranchFailureReason =
  | "invalid_context_json"
  | "context_not_object"
  | "selection_empty"
  | "selection_too_large"
  | "source_workspace_missing"
  | "source_tab_missing"
  | "source_pane_missing"
  | "source_task_missing"
  | "source_run_missing"
  | "firstmate_session_missing"
  | "branch_not_briefed"
  | "branch_not_ready_to_recite"
  | "branch_not_recited"
  | "branch_not_confirmed"
  | "branch_already_sent"
  | "confirmation_id_missing"
  | "confirmation_declined"
  | "invalid_lifecycle_transition"
  | "source_lineage_changed"
  | "lineage_intent_reused"
  | "capsule_injection_rejected";

export interface ParsedHerdrBranchContext {
  readonly selectedText: string;
  readonly selectedTextHash: string;
  readonly source: SourceLineage;
  readonly firstmateSessionRef: string;
  readonly contextHash: string;
}

export type BranchResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: "failed_closed";
      readonly reason: BranchFailureReason;
      readonly charLength?: number;
    };

export interface BranchTranscriptEntry {
  readonly kind: "brief" | "research" | "recitation" | "confirmation_result";
  readonly text: string;
  readonly createdAt: string;
}

export interface MainTranscriptProjection {
  readonly kind: "brief" | "recitation" | "confirmation_result";
  readonly text: string;
  readonly createdAt: string;
}

export interface BranchResearchNote {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly createdAt: string;
}

export interface ContextBranchSession {
  readonly branchId: string;
  readonly status: BranchStatus;
  readonly selectedText: string;
  readonly selectedTextHash: string;
  readonly source: SourceLineage;
  readonly sourceLineageHash: string;
  readonly firstmateSessionRef: string;
  readonly lineageIntentId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly brief: string | null;
  readonly privateResearch: readonly BranchResearchNote[];
  readonly mutationIntent: MutationIntent | null;
  readonly recitation: string | null;
  readonly confirmationId: string | null;
  readonly confirmedAt: string | null;
  readonly sentAt: string | null;
  readonly failureReason: BranchFailureReason | null;
  readonly transcript: readonly BranchTranscriptEntry[];
}

export interface BranchTaskRunRecord {
  readonly taskId: string;
  readonly runId: string;
  readonly firstmateSessionRef: string;
  readonly sourceLineageHash: string;
  readonly consumedLineageIntentIds: readonly string[];
}

export interface BranchTaskRunRegistryPort {
  lookup(source: SourceLineage): BranchTaskRunRecord | null;
}

export interface BranchClassifierInput {
  readonly selectedText: string;
  readonly brief: string;
  readonly source: SourceLineage;
  readonly taskRun: BranchTaskRunRecord;
}

export interface BranchResearchInput {
  readonly selectedText: string;
  readonly brief: string;
  readonly source: SourceLineage;
}

export type BranchClassifierPort = (
  input: BranchClassifierInput,
) => MutationIntent;

export type BranchResearcherPort = (
  input: BranchResearchInput,
) => Omit<BranchResearchNote, "createdAt">;

export interface CreateBranchOptions {
  readonly now: () => string;
  readonly branchId?: string;
  readonly expiresAt?: string | null;
}

export function parseHerdrBranchContext(
  contextJson: string,
): BranchResult<ParsedHerdrBranchContext> {
  const parsed = parseJsonObject(contextJson);
  if (!parsed.ok) return parsed;

  const value = parsed.value;
  const selectedText = readString(
    value,
    "selectedText",
    "selected_text",
    "selection.text",
  );
  if (selectedText === null || selectedText.trim().length === 0) {
    return fail(
      "selection_empty",
      selectedText ? Array.from(selectedText).length : 0,
    );
  }

  const selection = validateContextSelection(selectedText);
  if (!selection.ok) {
    return fail(selection.reason, selection.charLength);
  }

  const workspace = readString(
    value,
    "workspace",
    "workspace_id",
    "workspaceId",
  );
  if (workspace === null || workspace.trim().length === 0) {
    return fail("source_workspace_missing");
  }
  const tabId = readString(value, "tabId", "tab_id");
  if (tabId === null || tabId.trim().length === 0) {
    return fail("source_tab_missing");
  }
  const paneId = readString(
    value,
    "paneId",
    "pane_id",
    "focused_pane_id",
  );
  if (paneId === null || paneId.trim().length === 0) {
    return fail("source_pane_missing");
  }
  const taskId = readString(
    value,
    "sourceTaskId",
    "source_task_id",
    "task.id",
  );
  if (taskId === null || taskId.trim().length === 0) {
    return fail("source_task_missing");
  }
  const runId = readString(value, "sourceRunId", "source_run_id", "run.id");
  if (runId === null || runId.trim().length === 0) {
    return fail("source_run_missing");
  }
  const firstmateSessionRef = readString(
    value,
    "firstmateSessionRef",
    "firstmate_session_ref",
  );
  if (firstmateSessionRef === null || firstmateSessionRef.trim().length === 0) {
    return fail("firstmate_session_missing");
  }

  const source = {
    taskId,
    runId,
    workspace,
    tabId,
    paneId,
  };
  return {
    ok: true,
    value: {
      selectedText,
      selectedTextHash: selection.selectedTextHash,
      source,
      firstmateSessionRef,
      contextHash: selectedTextHash(
        JSON.stringify({
          selectedTextHash: selection.selectedTextHash,
          source,
          firstmateSessionRef,
        }),
      ),
    },
  };
}

export function createContextBranch(
  parsed: ParsedHerdrBranchContext,
  options: CreateBranchOptions,
): ContextBranchSession {
  const sourceHash = sourceLineageHash(parsed.source);
  const branchId = options.branchId ?? `branch-${parsed.contextHash.slice(0, 16)}`;
  return {
    branchId,
    status: "created",
    selectedText: parsed.selectedText,
    selectedTextHash: parsed.selectedTextHash,
    source: parsed.source,
    sourceLineageHash: sourceHash,
    firstmateSessionRef: parsed.firstmateSessionRef,
    lineageIntentId: selectedTextHash(
      JSON.stringify({
        branchId,
        selectedTextHash: parsed.selectedTextHash,
        sourceLineageHash: sourceHash,
        firstmateSessionRef: parsed.firstmateSessionRef,
      }),
    ),
    createdAt: options.now(),
    updatedAt: options.now(),
    expiresAt: options.expiresAt ?? null,
    brief: null,
    privateResearch: [],
    mutationIntent: null,
    recitation: null,
    confirmationId: null,
    confirmedAt: null,
    sentAt: null,
    failureReason: null,
    transcript: [],
  };
}

export function briefContextBranch(
  session: ContextBranchSession,
  now: () => string,
): ContextBranchSession {
  if (session.status !== "created") {
    return failSession(session, "invalid_lifecycle_transition", now);
  }
  const brief = plainLanguageBrief(session.selectedText);
  return appendTranscript(
    {
      ...session,
      status: "briefed",
      brief,
      updatedAt: now(),
    },
    {
      kind: "brief",
      text: brief,
      createdAt: now(),
    },
  );
}

export function chooseDeeperResearch(
  session: ContextBranchSession,
  choice: "deeper" | "return",
  researcher: BranchResearcherPort,
  now: () => string,
): BranchResult<ContextBranchSession> {
  if (session.status !== "briefed" || session.brief === null) {
    return fail("branch_not_briefed");
  }
  if (choice === "return") {
    return { ok: true, value: session };
  }
  const research = researcher({
    selectedText: session.selectedText,
    brief: session.brief,
    source: session.source,
  });
  const note = {
    ...research,
    createdAt: now(),
  };
  return {
    ok: true,
    value: appendTranscript(
      {
        ...session,
        status: "researching",
        privateResearch: [...session.privateResearch, note],
        updatedAt: now(),
      },
      {
        kind: "research",
        text: note.summary,
        createdAt: note.createdAt,
      },
    ),
  };
}

export function reciteBranchReturn(
  session: ContextBranchSession,
  registry: BranchTaskRunRegistryPort,
  classifier: BranchClassifierPort,
  now: () => string,
): BranchResult<ContextBranchSession> {
  if (
    session.brief === null ||
    (session.status !== "briefed" && session.status !== "researching")
  ) {
    return fail("branch_not_ready_to_recite");
  }
  const taskRun = registry.lookup(session.source);
  if (taskRun === null) return fail("source_task_missing");
  if (
    taskRun.sourceLineageHash !== session.sourceLineageHash ||
    taskRun.firstmateSessionRef !== session.firstmateSessionRef
  ) {
    return fail("source_lineage_changed");
  }
  if (taskRun.consumedLineageIntentIds.includes(session.lineageIntentId)) {
    return fail("lineage_intent_reused");
  }

  const mutationIntent = classifier({
    selectedText: session.selectedText,
    brief: session.brief,
    source: session.source,
    taskRun,
  });
  const recitation = buildRecitation(mutationIntent, session.selectedText);
  return {
    ok: true,
    value: appendTranscript(
      {
        ...session,
        status: "recited",
        mutationIntent,
        recitation,
        updatedAt: now(),
      },
      {
        kind: "recitation",
        text: recitation,
        createdAt: now(),
      },
    ),
  };
}

export function confirmBranchRecitation(
  session: ContextBranchSession,
  input: { readonly confirmed: boolean; readonly confirmationId: string },
  now: () => string,
): BranchResult<ContextBranchSession> {
  if (session.status !== "recited" || session.recitation === null) {
    return fail("branch_not_recited");
  }
  if (input.confirmed && input.confirmationId.trim().length === 0) {
    return fail("confirmation_id_missing");
  }
  if (!input.confirmed) {
    return {
      ok: true,
      value: appendTranscript(
        failSession(session, "confirmation_declined", now),
        {
          kind: "confirmation_result",
          text: "使用者未確認，Context Branch 已 fail-closed，未送回主對話。",
          createdAt: now(),
        },
      ),
    };
  }

  return {
    ok: true,
    value: appendTranscript(
      {
        ...session,
        status: "confirmed",
        confirmationId: input.confirmationId,
        confirmedAt: now(),
        updatedAt: now(),
      },
      {
        kind: "confirmation_result",
        text: "使用者已明確確認，Context Capsule 可送回來源 Firstmate session。",
        createdAt: now(),
      },
    ),
  };
}

export function toConfirmedCapsule(
  session: ContextBranchSession,
): BranchResult<ConfirmedContextCapsule> {
  if (
    session.status !== "confirmed" ||
    session.confirmationId === null ||
    session.confirmedAt === null ||
    session.recitation === null ||
    session.mutationIntent === null
  ) {
    return fail("branch_not_confirmed");
  }
  return {
    ok: true,
    value: {
      capsuleId: session.branchId,
      selectedText: session.selectedText,
      selectedTextHash: session.selectedTextHash,
      source: session.source,
      firstmateSessionRef: session.firstmateSessionRef,
      recitation: session.recitation,
      mutationIntent: session.mutationIntent,
      status: "confirmed",
      confirmationId: session.confirmationId,
      confirmedAt: session.confirmedAt,
    },
  };
}

export async function sendConfirmedBranchCapsule(
  session: ContextBranchSession,
  port: AtomicFirstmateCapsuleInjectionPort,
  now: () => string,
): Promise<BranchResult<ContextBranchSession>> {
  if (session.status === "sent" || session.sentAt !== null) {
    return fail("branch_already_sent");
  }
  const capsule = toConfirmedCapsule(session);
  if (!capsule.ok) return capsule;
  const result = await injectConfirmedCapsule(port, capsule.value);
  if (!result.ok) {
    return fail("capsule_injection_rejected");
  }
  return {
    ok: true,
    value: {
      ...session,
      status: "sent",
      sentAt: now(),
      updatedAt: now(),
    },
  };
}

export function projectMainTranscript(
  session: ContextBranchSession,
): readonly MainTranscriptProjection[] {
  return session.transcript.filter((entry): entry is MainTranscriptProjection =>
    isAllowedBranchTranscriptEntryKind(entry.kind),
  );
}

export function expireBranch(
  session: ContextBranchSession,
  now: () => string,
): ContextBranchSession {
  if (isTerminal(session)) return session;
  return {
    ...session,
    status: "expired",
    updatedAt: now(),
  };
}

export function failedClosedCapsule(
  session: ContextBranchSession,
): ContextCapsule {
  return {
    capsuleId: session.branchId,
    selectedText: session.selectedText,
    selectedTextHash: session.selectedTextHash,
    source: session.source,
    firstmateSessionRef: session.firstmateSessionRef,
    recitation: session.recitation ?? "",
    mutationIntent: session.mutationIntent ?? "failed_closed",
    status: "failed_closed",
    confirmationId: null,
    confirmedAt: null,
  };
}

function plainLanguageBrief(selectedText: string): string {
  const text = selectedText.replace(/\s+/g, " ").trim();
  const preview = Array.from(text).slice(0, 160).join("");
  return `這段選取內容的重點是：「${preview}${Array.from(text).length > 160 ? "..." : ""}」。`;
}

function buildRecitation(intent: MutationIntent, selectedText: string): string {
  const destination =
    intent === "new_task" ? "建立一個新任務" : "修改來源主任務";
  const preview = Array.from(selectedText.replace(/\s+/g, " ").trim())
    .slice(0, 180)
    .join("");
  return `我會把這段選取內容帶回主對話，判定為「${destination}」：${preview}`;
}

function appendTranscript(
  session: ContextBranchSession,
  entry: BranchTranscriptEntry,
): ContextBranchSession {
  return {
    ...session,
    transcript: [...session.transcript, entry],
  };
}

function failSession(
  session: ContextBranchSession,
  reason: BranchFailureReason,
  now: () => string,
): ContextBranchSession {
  return {
    ...session,
    status: "failed_closed",
    failureReason: reason,
    updatedAt: now(),
  };
}

function fail(
  reason: BranchFailureReason,
  charLength?: number,
): BranchResult<never> {
  return {
    ok: false,
    status: "failed_closed",
    reason,
    charLength,
  };
}

function isTerminal(session: ContextBranchSession): boolean {
  return ["expired", "failed_closed", "sent"].includes(session.status);
}

function parseJsonObject(contextJson: string): BranchResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson);
  } catch {
    return fail("invalid_context_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("context_not_object");
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function readString(
  value: Record<string, unknown>,
  ...paths: readonly string[]
): string | null {
  for (const path of paths) {
    const found = readPath(value, path);
    if (typeof found === "string") return found;
  }
  return null;
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
