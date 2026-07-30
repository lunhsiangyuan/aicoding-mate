import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createFirstmateNativeReviewDecision } from "../src/authority/firstmate-decisions.ts";
import { sourceLineageHash, type SourceLineage } from "../src/contracts/index.ts";
import {
  createCodexAppServerReviewPort,
  createMacOSCodexDesktopOpenPort,
} from "../src/integration/codex-review-runtime.ts";
import {
  createReviewCapsule,
  openCodexDesktopThread,
  type CodexReviewStartRequest,
  type ReviewCapsuleInput,
} from "../src/review/index.ts";

const lineage: SourceLineage = {
  taskId: "task-1",
  runId: "run-1",
  workspace: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
};

const workflowDecision = createFirstmateNativeReviewDecision({
  intentHash: "2".repeat(64),
  configVersion: "native-review-v0.2",
  source: lineage,
  reviewer: {
    role: "reviewer",
    alias: "openai-native-reviewer",
    provider: "openai",
    family: "openai",
    resolvedModel: "gpt-5.6-sol",
    capabilityTier: "architecture",
    reason: "test reviewer",
  },
});
const exactAssignment = workflowDecision.roleAssignments.find(
  (assignment) => assignment.role === "reviewer",
);
if (exactAssignment === undefined) {
  throw new Error("reviewer assignment missing");
}

const request: CodexReviewStartRequest = {
  workflowDecisionId: workflowDecision.workflowDecisionId,
  decisionHash: workflowDecision.decisionHash,
  stageId: "reviewer",
  idempotencyKey: "dispatch-native-review",
  exactAssignment,
  source: {
    taskId: "task-1",
    runId: "run-1",
    firstmateSessionRef: "firstmate-main-1",
    lineage,
  },
  target: { type: "custom", instructions: "Review this selected context." },
  selection: {
    selectedText: "Adapter source",
    sourceArtifact: "branch-1",
    file: "src/review/index.ts",
    startLine: 12,
    endLine: 18,
  },
  prompt: { text: "Find correctness and handoff risks." },
  delivery: "detached",
  parentThreadReadState: "complete",
};

const capsuleInput: ReviewCapsuleInput = {
  workflowDecision,
  canonicalRunId: "run-canonical-review",
  idempotencyKey: request.idempotencyKey,
  source: request.source,
  target: request.target,
  selection: request.selection,
  prompt: request.prompt,
  delivery: request.delivery,
  parentThreadReadState: request.parentThreadReadState,
  now: () => "2026-07-30T20:00:00.000Z",
};

describe("Codex app-server review runtime", () => {
  test("starts detached custom review, waits for completion, and reads exact review thread back", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const logPath = join(root, "requests.jsonl");
    const script = fakeAppServer(root, "happy", logPath);
    const port = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [script],
      cwd: root,
      timeoutMs: 1_000,
      now: () => "2026-07-30T20:01:00.000Z",
    });

    try {
      const start = await port.startReview(request);
      const readBack = await port.readReviewThread(start.reviewThreadId);

      expect(start).toEqual({
        sourceThreadId: "thread-source-1",
        reviewThreadId: "thread-review-1",
        delivery: "detached",
        turnId: "turn-review-1",
        eventIds: ["item-review", "turn-review-1"],
      });
      expect(readBack.ok).toBe(true);
      if (!readBack.ok) throw new Error(readBack.reason);
      expect(readBack.threadId).toBe("thread-review-1");
      expect(readBack.sourceThreadId).toBe("thread-source-1");
      expect(readBack.sourceLineageHash).toBe(sourceLineageHash(lineage));
      expect(readBack.summary).toBe(
        "src/review/index.ts:12 changes requested",
      );
      expect(readBack.decision).toBe("changes_requested");
      expect(readBack.rawReviewText).toContain("Bad id handling should fail closed.");
      expect(readBack.annotations).toEqual([
        {
          file: "src/review/index.ts",
          line: 12,
          endLine: 12,
          body: [
            "src/review/index.ts:12 changes requested",
            "Bad id handling should fail closed.",
          ].join("\n"),
          source: "codex_review_text",
        },
      ]);
      expect(readBack.nativeAnnotationExport).toBe("unverifiable");
      expect(readBack.eventIds).toEqual(["item-review", "turn-review-1"]);
      expect(readBack.completedAt).toBe("2026-07-30T20:01:10.000Z");

      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(calls.map((call) => call.method)).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "review/start",
        "thread/read",
      ]);
      expect(calls[0].params).toEqual({
        clientInfo: { name: "aicoding-mate", version: "0.1.0" },
      });
      expect(calls[1].params).toBeNull();
      expect(calls[2].params).toEqual({
        cwd: root,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "aicoding-mate",
      });
      expect(calls[3].params).toEqual({
        threadId: "thread-source-1",
        delivery: "detached",
        target: {
          type: "custom",
          instructions: expect.stringContaining(
            "Find correctness and handoff risks.",
          ),
        },
      });
      expect(Object.keys(calls[3].params as Record<string, unknown>).sort()).toEqual([
        "delivery",
        "target",
        "threadId",
      ]);
    } finally {
      await port.dispose();
    }
  });

  test("drives createReviewCapsule through the fake app-server port", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const script = fakeAppServer(root, "happy", join(root, "requests.jsonl"));
    const port = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [script],
      cwd: root,
      timeoutMs: 1_000,
      now: () => "2026-07-30T20:01:00.000Z",
    });

    try {
      const result = await createReviewCapsule(capsuleInput, {
        appServer: port,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.capsule.codex.sourceThreadId).toBe("thread-source-1");
      expect(result.capsule.codex.reviewThreadId).toBe("thread-review-1");
      expect(result.capsule.review.decision).toBe("changes_requested");
      expect(result.capsule.verification.nativeAnnotationExport).toBe(
        "unverifiable",
      );
      expect(result.capsule.lineage.eventIds).toEqual([
        "item-review",
        "turn-review-1",
      ]);
    } finally {
      await port.dispose();
    }
  });

  test("forwards an already-decided model and public thread config without routing", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const logPath = join(root, "requests.jsonl");
    const port = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(root, "configured", logPath)],
      cwd: root,
      model: "gpt-5.6-sol",
      threadConfig: {
        web_search: "disabled",
        mcp_servers: {},
        model_reasoning_effort: "high",
      },
      timeoutMs: 1_000,
    });

    try {
      await port.startReview(request);
      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(calls[2].params).toEqual({
        cwd: root,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "aicoding-mate",
        model: "gpt-5.6-sol",
        config: {
          web_search: "disabled",
          mcp_servers: {},
          model_reasoning_effort: "high",
        },
      });
    } finally {
      await port.dispose();
    }
  });

  test("fails closed on bad app-server ids and JSON-RPC errors", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const badPort = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(badRoot, "bad-review-id", join(badRoot, "requests.jsonl"))],
      cwd: badRoot,
      timeoutMs: 1_000,
    });
    const errorRoot = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const errorPort = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(errorRoot, "json-rpc-error", join(errorRoot, "requests.jsonl"))],
      cwd: errorRoot,
      timeoutMs: 1_000,
    });

    try {
      await expect(badPort.startReview(request)).rejects.toThrow(
        "bad_review_thread_id",
      );
      await expect(errorPort.startReview(request)).rejects.toThrow(
        "JSON-RPC error",
      );
    } finally {
      await badPort.dispose();
      await errorPort.dispose();
    }
  });

  test("fails closed when review completion events never arrive", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const port = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(root, "no-completion", join(root, "requests.jsonl"))],
      cwd: root,
      timeoutMs: 500,
    });

    try {
      await expect(port.startReview(request)).rejects.toThrow(
        "timeout waiting for review completion",
      );
    } finally {
      await port.dispose();
    }
  });

  test("rejects response aliases, wrong turn completion, and assistant-only text", async () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const aliasPort = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(aliasRoot, "response-thread-id-only", join(aliasRoot, "requests.jsonl"))],
      cwd: aliasRoot,
      timeoutMs: 250,
    });
    const turnRoot = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const turnPort = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(turnRoot, "wrong-turn", join(turnRoot, "requests.jsonl"))],
      cwd: turnRoot,
      timeoutMs: 250,
    });
    const topLevelTurnRoot = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const topLevelTurnPort = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(topLevelTurnRoot, "top-level-turn-id-only", join(topLevelTurnRoot, "requests.jsonl"))],
      cwd: topLevelTurnRoot,
      timeoutMs: 250,
    });
    const assistantRoot = mkdtempSync(join(tmpdir(), "aicoding-mate-codex-runtime-"));
    const assistantPort = createCodexAppServerReviewPort({
      command: process.execPath,
      args: [fakeAppServer(assistantRoot, "assistant-only", join(assistantRoot, "requests.jsonl"))],
      cwd: assistantRoot,
      timeoutMs: 250,
    });

    try {
      await expect(aliasPort.startReview(request)).rejects.toThrow(
        "review_thread_id_missing",
      );
      await expect(turnPort.startReview(request)).rejects.toThrow(
        "timeout waiting for review completion",
      );
      await expect(topLevelTurnPort.startReview(request)).rejects.toThrow(
        "review_turn_id_missing",
      );
      const assistantStart = await assistantPort.startReview(request);
      expect(await assistantPort.readReviewThread(assistantStart.reviewThreadId)).toEqual({
        ok: false,
        reason: "review_not_completed",
      });
    } finally {
      await aliasPort.dispose();
      await turnPort.dispose();
      await topLevelTurnPort.dispose();
      await assistantPort.dispose();
    }
  });

  test("opens macOS Codex desktop URLs only when observer confirms the exact thread", async () => {
    const exactPort = createMacOSCodexDesktopOpenPort({
      runner: () => ({ status: 0 }),
      observer: {
        async observeThread(expectedThreadId) {
          return { observedThreadId: expectedThreadId };
        },
      },
    });
    const mismatchPort = createMacOSCodexDesktopOpenPort({
      runner: () => ({ status: 0 }),
      observer: {
        async observeThread() {
          return { observedThreadId: "thread-other" };
        },
      },
    });
    const noObserverPort = createMacOSCodexDesktopOpenPort({
      runner: () => ({ status: 0 }),
    });

    const opened = await openCodexDesktopThread(exactPort, "thread-review-1");
    const mismatch = await openCodexDesktopThread(
      mismatchPort,
      "thread-review-1",
    );
    const noObserver = await openCodexDesktopThread(
      noObserverPort,
      "thread-review-1",
    );

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.request.url).toBe("codex://threads/thread-review-1");
    expect(mismatch).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "desktop_thread_mismatch",
    });
    expect(noObserver).toEqual({
      ok: false,
      status: "failed_closed",
      reason: "desktop_open_failed",
    });
  });
});

function fakeAppServer(
  root: string,
  mode:
    | "happy"
    | "bad-review-id"
    | "json-rpc-error"
    | "no-completion"
    | "response-thread-id-only"
    | "top-level-turn-id-only"
    | "wrong-turn"
    | "assistant-only"
    | "configured",
  logPath: string,
): string {
  mkdirSync(root, { recursive: true });
  const scriptPath = join(root, `fake-codex-app-server-${mode}.mjs`);
  writeFileSync(
    scriptPath,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      `const mode = ${JSON.stringify(mode)};`,
      `const logPath = ${JSON.stringify(logPath)};`,
      "const rl = createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "function log(message) { appendFileSync(logPath, `${JSON.stringify({ method: message.method, params: message.params ?? null })}\\n`); }",
      "function paramKeys(value) { return Object.keys(value ?? {}).sort().join(','); }",
      "function expectParamKeys(message, expected) {",
      "  const actual = paramKeys(message.params);",
      "  if (actual !== expected) {",
      "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unexpected params ${actual}` } });",
      "    return false;",
      "  }",
      "  return true;",
      "}",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  log(message);",
      "  if (message.method === 'initialize') {",
      "    if (!expectParamKeys(message, 'clientInfo')) return;",
      "    if (paramKeys(message.params.clientInfo) !== 'name,version') {",
      "      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unexpected clientInfo' } });",
      "      return;",
      "    }",
      "    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });",
      "    return;",
      "  }",
      "  if (message.method === 'initialized') return;",
      "  if (message.method === 'thread/start') {",
      "    const expectedThreadKeys = mode === 'configured' ? 'approvalPolicy,config,cwd,model,sandbox,serviceName' : 'approvalPolicy,cwd,sandbox,serviceName';",
      "    if (!expectParamKeys(message, expectedThreadKeys)) return;",
      "    if (message.params.sandbox !== 'read-only') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'bad sandbox' } }); return; }",
      "    send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-source-1' } } });",
      "    return;",
      "  }",
      "  if (message.method === 'review/start') {",
      "    if (!expectParamKeys(message, 'delivery,target,threadId')) return;",
      "    if (mode === 'json-rpc-error') {",
      "      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'review failed' } });",
      "      return;",
      "    }",
      "    if (mode === 'response-thread-id-only') {",
      "      send({ jsonrpc: '2.0', id: message.id, result: { threadId: 'thread-review-1', turn: { id: 'turn-review-1' } } });",
      "      return;",
      "    }",
      "    if (mode === 'top-level-turn-id-only') {",
      "      send({ jsonrpc: '2.0', id: message.id, result: { reviewThreadId: 'thread-review-1', turnId: 'turn-review-1' } });",
      "      return;",
      "    }",
      "    const reviewThreadId = mode === 'bad-review-id' ? 'thread/review?bad' : 'thread-review-1';",
      "    send({ jsonrpc: '2.0', id: message.id, result: { reviewThreadId, turn: { id: 'turn-review-1' } } });",
      "    if (mode === 'no-completion' || mode === 'bad-review-id') return;",
      "    const item = mode === 'assistant-only' ? { id: 'item-review', type: 'assistant_message', text: 'approved' } : { id: 'item-review', type: 'exitedReviewMode', review: 'src/review/index.ts:12 changes requested\\nBad id handling should fail closed.' };",
      "    send({ jsonrpc: '2.0', method: 'item/completed', params: { completedAtMs: 1785441670000, threadId: reviewThreadId, turnId: 'turn-review-1', item } });",
      "    const completedTurnId = mode === 'wrong-turn' ? 'turn-other' : 'turn-review-1';",
      "    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: reviewThreadId, turn: { id: completedTurnId, status: 'completed', items: [], completedAt: 1785441670 } } });",
      "    return;",
      "  }",
      "  if (message.method === 'thread/read') {",
      "    if (!expectParamKeys(message, 'includeTurns,threadId')) return;",
      "    const readItem = mode === 'assistant-only' ? { id: 'item-review-read', type: 'assistant_message', text: 'approved' } : { id: 'item-review-read', type: 'exitedReviewMode', review: 'src/review/index.ts:12 changes requested\\nBad id handling should fail closed.' };",
      "    send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params.threadId, turns: [{ id: 'turn-review-1', status: 'completed', items: [readItem] }] } } });",
      "  }",
      "});",
    ].join("\n"),
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
