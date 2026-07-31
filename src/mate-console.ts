export const mateModes = [
  "quick",
  "standard",
  "expert",
  "research",
  "learn",
] as const;

export type MateMode = (typeof mateModes)[number];

export interface MateContextTurn {
  readonly mode: MateMode;
  readonly request: string;
  readonly summary: string;
}

export interface MateConsoleState {
  readonly mode: MateMode;
  readonly completedTurns: number;
  readonly context: readonly MateContextTurn[];
}

export interface MateContinuityContext {
  readonly schemaVersion: 1;
  readonly purpose: "ui_continuity_only";
  readonly turns: readonly MateContextTurn[];
}

export interface MateRuntimeRequest {
  readonly currentTask: string;
  readonly continuityContext: MateContinuityContext;
}

export type MateConsoleAction =
  | { readonly kind: "noop"; readonly state: MateConsoleState }
  | { readonly kind: "help"; readonly state: MateConsoleState }
  | { readonly kind: "status"; readonly state: MateConsoleState }
  | { readonly kind: "doctor"; readonly state: MateConsoleState }
  | { readonly kind: "quit"; readonly state: MateConsoleState }
  | {
    readonly kind: "error";
    readonly state: MateConsoleState;
    readonly message: string;
  }
  | {
    readonly kind: "mode_changed";
    readonly state: MateConsoleState;
  }
  | {
    readonly kind: "run";
    readonly state: MateConsoleState;
    readonly mode: MateMode;
    readonly task: string;
  };

const contextLimit = 4;
const requestLimit = 320;
const summaryLimit = 320;
const mateEnvelopeMarkers = [
  "[ACM_MATE_CONTEXT_NON_EVIDENCE]",
  "[/ACM_MATE_CONTEXT_NON_EVIDENCE]",
  "[ACM_MATE_CURRENT_REQUEST]",
  "[/ACM_MATE_CURRENT_REQUEST]",
] as const;

export function createMateConsoleState(
  initialMode: string | undefined,
): MateConsoleState {
  return {
    mode: normalizeMateMode(initialMode) ?? "standard",
    completedTurns: 0,
    context: [],
  };
}

export function parseMateConsoleInput(
  state: MateConsoleState,
  rawInput: string,
): MateConsoleAction {
  const input = rawInput.trim();
  if (!input) return { kind: "noop", state };
  if (!input.startsWith("/")) {
    return { kind: "run", state, mode: state.mode, task: input };
  }

  const separator = input.search(/\s/);
  const rawCommand = (
    separator === -1 ? input.slice(1) : input.slice(1, separator)
  ).toLowerCase();
  const argument = separator === -1 ? "" : input.slice(separator).trim();

  if (rawCommand === "help") return { kind: "help", state };
  if (rawCommand === "status") return { kind: "status", state };
  if (rawCommand === "doctor") return { kind: "doctor", state };
  if (rawCommand === "quit" || rawCommand === "exit") {
    return { kind: "quit", state };
  }

  if (rawCommand === "mode") {
    if (!argument) return { kind: "status", state };
    const requested = normalizeMateMode(argument);
    if (!requested) {
      return {
        kind: "error",
        state,
        message: `未知模式：${argument}`,
      };
    }
    return {
      kind: "mode_changed",
      state: { ...state, mode: requested },
    };
  }

  const requested = normalizeMateMode(rawCommand);
  if (!requested) {
    return {
      kind: "error",
      state,
      message: `未知 slash command：/${rawCommand}`,
    };
  }
  const nextState = { ...state, mode: requested };
  return argument
    ? {
      kind: "run",
      state: nextState,
      mode: requested,
      task: argument,
    }
    : { kind: "mode_changed", state: nextState };
}

export function recordMateConsoleTurn(
  state: MateConsoleState,
  request: string,
  summary: string,
): MateConsoleState {
  const turn: MateContextTurn = {
    mode: state.mode,
    request: compact(request, requestLimit),
    summary: compact(summary, summaryLimit),
  };
  return {
    ...state,
    completedTurns: state.completedTurns + 1,
    context: [...state.context, turn].slice(-contextLimit),
  };
}

export function buildMateRuntimeRequest(
  state: MateConsoleState,
  mode: MateMode,
  task: string,
): MateRuntimeRequest {
  const currentTask = mode === "learn"
    ? [
      "這是一個 Architect learning request。",
      "先用白話提供短簡介，再列出在目前 context 中真正需要理解的少量技術概念。",
      "技術細節放在第二層；除非使用者再要求，不要展開 worker mechanics。",
      `學習內容：${task.trim()}`,
    ].join("\n")
    : task.trim();
  return {
    currentTask,
    continuityContext: {
      schemaVersion: 1,
      purpose: "ui_continuity_only",
      turns: [...state.context],
    },
  };
}

export function containsMateEnvelopeMarker(task: string): boolean {
  return mateEnvelopeMarkers.some((marker) => task.includes(marker));
}

export function summarizeMateOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && !line.startsWith("evidence:")
      && !line.startsWith("證據層：")
      && !line.startsWith("final claims:")
    );
  const conclusion = lines.find((line) => line.startsWith("結論："));
  if (conclusion) return compact(conclusion.slice("結論：".length), summaryLimit);
  const result = lines.find((line) =>
    line.startsWith("結果：") || line.startsWith("摘要：")
  );
  if (result) return compact(result.replace(/^(結果|摘要)：/, ""), summaryLimit);
  return compact(lines.at(-1) ?? "未產生可讀摘要", summaryLimit);
}

export function renderMateConsoleHelp(): string {
  return [
    "Slash commands：",
    "  /quick [任務]     快速唯讀檢查",
    "  /standard [任務]  一般架構與跨模型 review",
    "  /expert [任務]    對抗式 Author／Challenger／Judge",
    "  /research [任務]  Recall-first 深入研究",
    "  /learn [內容]     白話簡介，可在同一 pane 繼續追問",
    "  /status           顯示目前模式與 context",
    "  /doctor           檢查 runtime",
    "  /help             顯示這份說明",
    "  /quit             離開",
    "",
    "也可以直接輸入需求，系統會使用目前模式。",
  ].join("\n");
}

export function renderMateConsoleStatus(state: MateConsoleState): string {
  return `mode=${state.mode} completed_turns=${state.completedTurns}`
    + ` context_turns=${state.context.length}`;
}

export function renderMateWorkflowGraph(mode: MateMode): string {
  const graph = mode === "quick"
    ? "[你] --> [Firstmate] --> [快速 Scout] --> [Read-back] --> [摘要]"
    : mode === "standard"
    ? "[你] --> [Firstmate] --> [Author] --> [Reviewer] --> [收斂] --> [報告]"
    : mode === "expert"
    ? "[你] --> [Firstmate] --> [Author] <--> [Challenger] --> [Judge] --> [報告]"
    : mode === "research"
    ? "[你] --> [Firstmate] --> [廣搜] --> [Coverage] --> [Judge] --> [報告]"
    : "[你] --> [Firstmate] --> [白話 Author] --> [Reviewer] --> [分層說明]";
  return [
    `派工前 workflow 預覽（${mode}，尚未執行）：`,
    graph,
    "若通過 scope gate，Firstmate 將依當下可用模型決定實際派工。",
  ].join("\n");
}

function normalizeMateMode(value: string | undefined): MateMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "adversarial") return "expert";
  return mateModes.find((mode) => mode === normalized);
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}
