import { describe, expect, test } from "bun:test";

import {
  buildMateRuntimeRequest,
  createMateConsoleState,
  parseMateConsoleInput,
  recordMateConsoleTurn,
  renderMateConsoleStatus,
  renderMateWorkflowGraph,
  summarizeMateOutput,
} from "../src/mate-console.ts";

describe("single Mate console", () => {
  test("starts in Standard and accepts legacy adversarial initial mode", () => {
    expect(createMateConsoleState(undefined).mode).toBe("standard");
    expect(createMateConsoleState("adversarial").mode).toBe("expert");
  });

  test("switches mode without dispatching and keeps plain text in that mode", () => {
    const initial = createMateConsoleState("standard");
    const switched = parseMateConsoleInput(initial, "/quick");
    expect(switched.kind).toBe("mode_changed");
    const next = switched.state;
    expect(next.mode).toBe("quick");

    const task = parseMateConsoleInput(next, "說明目前架構");
    expect(task).toMatchObject({
      kind: "run",
      mode: "quick",
      task: "說明目前架構",
    });
  });

  test("switches and dispatches an inline slash-command task", () => {
    const action = parseMateConsoleInput(
      createMateConsoleState("quick"),
      "/expert 找出這個方案的反例",
    );
    expect(action).toMatchObject({
      kind: "run",
      mode: "expert",
      task: "找出這個方案的反例",
    });
    expect(action.state.mode).toBe("expert");
  });

  test("supports control commands and rejects unknown slash commands", () => {
    const state = createMateConsoleState("research");
    expect(parseMateConsoleInput(state, "/help").kind).toBe("help");
    expect(parseMateConsoleInput(state, "/status").kind).toBe("status");
    expect(parseMateConsoleInput(state, "/doctor").kind).toBe("doctor");
    expect(parseMateConsoleInput(state, "/exit").kind).toBe("quit");
    expect(parseMateConsoleInput(state, "/wat")).toMatchObject({
      kind: "error",
      message: "未知 slash command：/wat",
    });
  });

  test("keeps bounded context and marks it as continuity rather than evidence", () => {
    let state = createMateConsoleState("standard");
    for (let index = 1; index <= 5; index += 1) {
      state = recordMateConsoleTurn(
        state,
        `request-${index}`,
        `summary-${index}`,
      );
    }
    expect(state.context).toHaveLength(4);
    expect(state.context[0]?.request).toBe("request-2");
    state = recordMateConsoleTurn(state, "x".repeat(500), "y".repeat(500));
    expect(state.context.at(-1)?.request.length).toBe(320);
    expect(state.context.at(-1)?.summary.length).toBe(320);
    const runtimeRequest = buildMateRuntimeRequest(
      state,
      "standard",
      "current",
    );
    expect(runtimeRequest.currentTask).toBe("current");
    expect(runtimeRequest.currentTask).not.toContain("request-5");
    expect(runtimeRequest.continuityContext).toMatchObject({
      schemaVersion: 1,
      purpose: "ui_continuity_only",
    });
    expect(runtimeRequest.continuityContext.turns[0]?.request).toBe(
      "request-3",
    );
    expect(runtimeRequest.continuityContext.turns.at(-1)?.request).toHaveLength(
      320,
    );
    expect(renderMateConsoleStatus(state)).toBe(
      "mode=standard completed_turns=6 context_turns=4",
    );
  });

  test("learn mode creates architect-first layered learning instructions", () => {
    const request = buildMateRuntimeRequest(
      createMateConsoleState("learn"),
      "learn",
      "什麼是 idempotency？",
    );
    expect(request.currentTask).toContain("Architect learning request");
    expect(request.currentTask).toContain("先用白話提供短簡介");
    expect(request.currentTask).toContain("什麼是 idempotency？");
  });

  test("extracts a concise context summary from workflow output", () => {
    expect(summarizeMateOutput(
      "對抗式架構審查\n\n結論：使用單一入口。\n證據層：/tmp/run.json\n",
    )).toBe("使用單一入口。");
  });

  test("renders a distinct pre-dispatch workflow graph for every mode", () => {
    expect(renderMateWorkflowGraph("quick")).toContain("[快速 Scout]");
    expect(renderMateWorkflowGraph("standard")).toContain("[Reviewer]");
    expect(renderMateWorkflowGraph("expert")).toContain(
      "[Author] <--> [Challenger]",
    );
    expect(renderMateWorkflowGraph("research")).toContain("[Coverage]");
    expect(renderMateWorkflowGraph("learn")).toContain("[白話 Author]");
    expect(renderMateWorkflowGraph("standard")).toContain("尚未執行");
  });

});
