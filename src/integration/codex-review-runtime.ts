import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { sourceLineageHash } from "../contracts/index.ts";
import {
  codexThreadUrl,
  type CodexAppServerReviewPort,
  type CodexDesktopOpenPort,
  type CodexReviewReadback,
  type CodexReviewStartReceipt,
  type CodexReviewStartRequest,
  type NativeAnnotationExportStatus,
  type ReviewAnnotation,
  type ReviewDecision,
  type ReviewTarget,
} from "../review/index.ts";

export interface CodexAppServerRuntimeOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly threadConfig?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly now?: () => string;
  readonly onReviewStarted?: (
    request: CodexReviewStartRequest,
    receipt: CodexReviewStartReceipt,
  ) => void | Promise<void>;
}

export interface DisposableCodexAppServerReviewPort
  extends CodexAppServerReviewPort {
  restoreReviewSession(
    request: CodexReviewStartRequest,
    receipt: CodexReviewStartReceipt,
  ): void;
  dispose(): Promise<void>;
}

export interface CodexDesktopObserverPort {
  observeThread(
    expectedThreadId: string,
  ): Promise<{ readonly observedThreadId: string | null }>;
}

export interface CodexDesktopOpenRuntimeOptions {
  readonly command?: string;
  readonly runner?: DesktopOpenRunner;
  readonly observer?: CodexDesktopObserverPort;
}

export type DesktopOpenRunner = (
  command: string,
  args: readonly string[],
) => { readonly status: number | null; readonly error?: Error };

interface ReviewSession {
  readonly request: CodexReviewStartRequest;
  readonly sourceThreadId: string;
  readonly reviewThreadId: string;
  readonly turnId: string | null;
  readonly sourceLineageHash: string;
  readonly events: readonly CodexRuntimeEvent[];
  readonly completedAt: string | null;
}

interface CodexRuntimeEvent {
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
  readonly receivedAt: string;
}

interface JsonRpcRequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

type JsonRpcOutboundMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage;

interface JsonRpcResponseMessage {
  readonly jsonrpc?: string;
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerRuntimeError";
  }
}

export function createCodexAppServerReviewPort(
  options: CodexAppServerRuntimeOptions = {},
): DisposableCodexAppServerReviewPort {
  const runtime = new CodexAppServerRuntime(options);
  return {
    startReview(request) {
      return runtime.startReview(request);
    },
    readReviewThread(reviewThreadId) {
      return runtime.readReviewThread(reviewThreadId);
    },
    restoreReviewSession(request, receipt) {
      runtime.restoreReviewSession(request, receipt);
    },
    dispose() {
      return runtime.dispose();
    },
  };
}

export function createMacOSCodexDesktopOpenPort(
  options: CodexDesktopOpenRuntimeOptions = {},
): CodexDesktopOpenPort {
  const command = options.command ?? "open";
  const runner = options.runner ?? defaultDesktopOpenRunner;
  return {
    async openThread(request) {
      const result = runner(command, [request.url]);
      if (result.status !== 0) {
        return {
          opened: false,
          observedThreadId: null,
          reason: result.error?.message ?? `open exited ${String(result.status)}`,
        };
      }
      if (options.observer === undefined) {
        return {
          opened: false,
          observedThreadId: null,
          reason: "desktop_observer_required",
        };
      }
      const observed = await options.observer.observeThread(request.reviewThreadId);
      return {
        opened: true,
        observedThreadId: observed.observedThreadId,
        reason: null,
      };
    },
  };
}

class CodexAppServerRuntime implements CodexAppServerReviewPort {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly model: string | null;
  private readonly threadConfig: Readonly<Record<string, unknown>> | null;
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly onReviewStarted:
    | ((
        request: CodexReviewStartRequest,
        receipt: CodexReviewStartReceipt,
      ) => void | Promise<void>)
    | null;
  private readonly sessions = new Map<string, ReviewSession>();
  private client: StdioJsonRpcClient | null = null;
  private initialized = false;

  constructor(options: CodexAppServerRuntimeOptions) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--stdio"];
    this.cwd = options.cwd ?? process.cwd();
    this.env = { ...process.env, ...options.env };
    this.model = nonEmptyOption(options.model);
    this.threadConfig = options.threadConfig ?? null;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onReviewStarted = options.onReviewStarted ?? null;
  }

  async startReview(
    request: CodexReviewStartRequest,
  ): Promise<CodexReviewStartReceipt> {
    if (request.delivery !== "detached") {
      throw new CodexAppServerRuntimeError("codex_review_requires_detached_delivery");
    }
    const client = await this.readyClient();
    const sourceResult = await client.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "aicoding-mate",
      ...(this.model === null ? {} : { model: this.model }),
      ...(this.threadConfig === null ? {} : { config: this.threadConfig }),
    });
    const sourceThreadId = threadIdFromResult(sourceResult);
    assertStableThreadId(sourceThreadId, "bad_source_thread_id");

    const reviewResult = await client.request("review/start", {
      threadId: sourceThreadId,
      delivery: "detached",
      target: customReviewTarget(request),
    });
    const reviewThreadId = reviewThreadIdFromResult(reviewResult);
    assertStableThreadId(reviewThreadId, "bad_review_thread_id");
    const turnId = turnIdFromResult(reviewResult);
    if (turnId === null) {
      throw new CodexAppServerRuntimeError("review_turn_id_missing");
    }
    const acceptedReceipt: CodexReviewStartReceipt = {
      sourceThreadId,
      reviewThreadId,
      delivery: "detached",
      turnId,
      eventIds: stableEventIds([
        ...eventsForThread(client.eventsForThread(sourceThreadId), sourceThreadId),
        ...eventsForThread(client.eventsForThread(reviewThreadId), reviewThreadId),
      ]),
    };
    await this.onReviewStarted?.(request, acceptedReceipt);

    const completed = await client.waitForEvent(
      (event) => isReviewCompletionEvent(event, reviewThreadId, turnId),
      this.timeoutMs,
      `review completion for ${reviewThreadId}`,
    );
    if (nestedPropertyString(completed.params, "turn", "status") !== "completed") {
      throw new CodexAppServerRuntimeError("review_turn_not_completed");
    }
    const reviewEvents = client.eventsForThread(reviewThreadId);
    const eventIds = stableEventIds([
      ...eventsForThread(client.eventsForThread(sourceThreadId), sourceThreadId),
      ...eventsForThread(reviewEvents, reviewThreadId),
      completed,
    ]);
    const completedAt = completedAtFromEvent(completed) ?? completed.receivedAt;
    this.sessions.set(reviewThreadId, {
      request,
      sourceThreadId,
      reviewThreadId,
      turnId,
      sourceLineageHash: sourceLineageHash(request.source.lineage),
      events: reviewEvents,
      completedAt,
    });

    return {
      ...acceptedReceipt,
      eventIds,
    };
  }

  restoreReviewSession(
    request: CodexReviewStartRequest,
    receipt: CodexReviewStartReceipt,
  ): void {
    if (request.delivery !== "detached" || receipt.delivery !== "detached") {
      throw new CodexAppServerRuntimeError("codex_review_requires_detached_delivery");
    }
    assertStableThreadId(receipt.sourceThreadId, "bad_source_thread_id");
    assertStableThreadId(receipt.reviewThreadId, "bad_review_thread_id");
    if (receipt.turnId === null || receipt.turnId.trim().length === 0) {
      throw new CodexAppServerRuntimeError("review_turn_id_missing");
    }
    this.sessions.set(receipt.reviewThreadId, {
      request,
      sourceThreadId: receipt.sourceThreadId,
      reviewThreadId: receipt.reviewThreadId,
      turnId: receipt.turnId,
      sourceLineageHash: sourceLineageHash(request.source.lineage),
      events: [],
      completedAt: null,
    });
  }

  async readReviewThread(reviewThreadId: string): Promise<CodexReviewReadback> {
    if (!isStableThreadId(reviewThreadId)) {
      return { ok: false, reason: "bad_thread_id" };
    }
    const session = this.sessions.get(reviewThreadId);
    if (session === undefined) {
      return { ok: false, reason: "thread_not_found" };
    }
    const client = await this.readyClient();
    let result: unknown;
    try {
      result = await client.request("thread/read", {
        threadId: reviewThreadId,
        includeTurns: true,
      });
    } catch {
      return { ok: false, reason: "thread_read_failed" };
    }

    let observedThreadId: string;
    try {
      observedThreadId = threadIdFromResult(result);
    } catch {
      return { ok: false, reason: "thread_read_failed" };
    }
    if (observedThreadId !== reviewThreadId) {
      return { ok: false, reason: "thread_read_failed" };
    }

    const reviewText = firstNonEmpty([
      ...reviewModeTextsFromUnknown(result),
      ...reviewModeTextsFromEvents(session.events),
    ]);
    if (reviewText === null) {
      return { ok: false, reason: "review_not_completed" };
    }

    const annotations = annotationsFromReviewText(reviewText);
    return {
      ok: true,
      threadId: reviewThreadId,
      sourceThreadId: session.sourceThreadId,
      sourceLineageHash: session.sourceLineageHash,
      summary: summaryFromReviewText(reviewText),
      decision: decisionFromReviewText(reviewText),
      rawReviewText: reviewText,
      annotations,
      nativeAnnotationExport: nativeAnnotationExportStatus(result),
      eventIds: stableEventIds(session.events),
      completedAt: session.completedAt,
    };
  }

  async dispose(): Promise<void> {
    if (this.client === null) return;
    await this.client.dispose();
    this.client = null;
    this.initialized = false;
  }

  private async readyClient(): Promise<StdioJsonRpcClient> {
    if (this.client === null) {
      this.client = new StdioJsonRpcClient({
        command: this.command,
        args: this.args,
        cwd: this.cwd,
        env: this.env,
        timeoutMs: this.timeoutMs,
        now: this.now,
      });
    }
    if (!this.initialized) {
      await this.client.request("initialize", {
        clientInfo: {
          name: "aicoding-mate",
          version: "0.1.0",
        },
      });
      this.client.notify("initialized");
      this.initialized = true;
    }
    return this.client;
  }
}

class StdioJsonRpcClient {
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: CodexRuntimeEvent[] = [];
  private readonly waiters: Array<{
    readonly predicate: (event: CodexRuntimeEvent) => boolean;
    readonly resolve: (event: CodexRuntimeEvent) => void;
    readonly reject: (reason: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  private nextId = 1;
  private nextEvent = 1;
  private stdoutBuffer = "";
  private closed = false;

  constructor(options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly now: () => string;
  }) {
    this.timeoutMs = options.timeoutMs;
    this.now = options.now;
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("error", (error) => this.closeWithError(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.closeWithError(
        new CodexAppServerRuntimeError(
          `app server exited code=${String(code)} signal=${String(signal)}`,
        ),
      );
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerRuntimeError(`timeout waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  waitForEvent(
    predicate: (event: CodexRuntimeEvent) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<CodexRuntimeEvent> {
    const existing = this.notifications.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CodexAppServerRuntimeError(`timeout waiting for ${description}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  eventsForThread(threadId: string): readonly CodexRuntimeEvent[] {
    return this.notifications.filter((event) => eventThreadId(event) === threadId);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerRuntimeError("app server disposed"));
    }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new CodexAppServerRuntimeError("app server disposed"));
    }
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private write(message: JsonRpcOutboundMessage): void {
    if (this.closed) {
      throw new CodexAppServerRuntimeError("app server closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.closeWithError(new CodexAppServerRuntimeError("invalid JSON-RPC message"));
      return;
    }
    if (!isRecord(message)) return;
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(
        new CodexAppServerRuntimeError(
          `JSON-RPC error in ${pending.method}: ${JSON.stringify(message.error)}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown): void {
    const event: CodexRuntimeEvent = {
      id: eventIdFromParams(params) ?? `event-${this.nextEvent}`,
      method,
      params,
      receivedAt: this.now(),
    };
    this.nextEvent += 1;
    this.notifications.push(event);
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index];
      if (!waiter.predicate(event)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
  }

  private closeWithError(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function defaultDesktopOpenRunner(
  command: string,
  args: readonly string[],
): { readonly status: number | null; readonly error?: Error } {
  const result = spawnSync(command, [...args], { stdio: "ignore" });
  return {
    status: result.status,
    error: result.error,
  };
}

function customReviewTarget(
  request: CodexReviewStartRequest,
): Extract<ReviewTarget, { type: "custom" }> {
  const context = {
    authority: {
      workflowDecisionId: request.workflowDecisionId,
      decisionHash: request.decisionHash,
      stageId: request.stageId,
      idempotencyKey: request.idempotencyKey,
      exactAssignment: request.exactAssignment,
    },
    source: {
      taskId: request.source.taskId,
      runId: request.source.runId,
      lineageHash: sourceLineageHash(request.source.lineage),
    },
    target: request.target,
    selection: request.selection,
  };
  return {
    type: "custom",
    instructions: [
      request.prompt.text,
      "",
      "Firstmate-decided review request context:",
      JSON.stringify(context, null, 2),
    ].join("\n"),
  };
}

function threadIdFromResult(result: unknown): string {
  const found = nestedPropertyString(result, "thread", "id");
  if (found === null) {
    throw new CodexAppServerRuntimeError("thread_id_missing");
  }
  return found;
}

function reviewThreadIdFromResult(result: unknown): string {
  const found = propertyString(result, "reviewThreadId");
  if (found === null) {
    throw new CodexAppServerRuntimeError("review_thread_id_missing");
  }
  return found;
}

function turnIdFromResult(result: unknown): string | null {
  return nestedPropertyString(result, "turn", "id");
}

function assertStableThreadId(value: string, reason: string): void {
  if (!isStableThreadId(value)) {
    throw new CodexAppServerRuntimeError(reason);
  }
}

function isStableThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function isReviewCompletionEvent(
  event: CodexRuntimeEvent,
  reviewThreadId: string,
  turnId: string,
): boolean {
  if (eventThreadId(event) !== reviewThreadId) return false;
  return event.method === "turn/completed"
    && nestedPropertyString(event.params, "turn", "id") === turnId;
}

function eventsForThread(
  events: readonly CodexRuntimeEvent[],
  threadId: string,
): readonly CodexRuntimeEvent[] {
  return events.filter((event) => eventThreadId(event) === threadId);
}

function eventThreadId(event: CodexRuntimeEvent): string | null {
  return firstNonEmpty([
    propertyString(event.params, "threadId"),
    nestedPropertyString(event.params, "thread", "id"),
    nestedPropertyString(event.params, "item", "threadId"),
  ]);
}

function eventIdFromParams(params: unknown): string | null {
  return firstNonEmpty([
    propertyString(params, "eventId"),
    propertyString(params, "id"),
    nestedPropertyString(params, "event", "id"),
    nestedPropertyString(params, "item", "id"),
    nestedPropertyString(params, "turn", "id"),
  ]);
}

function completedAtFromEvent(event: CodexRuntimeEvent): string | null {
  const text = firstNonEmpty([
    propertyString(event.params, "completedAt"),
    nestedPropertyString(event.params, "turn", "completedAt"),
  ]);
  if (text !== null) return text;
  const seconds = nestedPropertyNumber(event.params, "turn", "completedAt");
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

function reviewModeTextsFromEvents(
  events: readonly CodexRuntimeEvent[],
): readonly string[] {
  return events.flatMap((event) => reviewModeTextsFromUnknown(event.params));
}

function reviewModeTextsFromUnknown(value: unknown): readonly string[] {
  const texts: string[] = [];
  walk(value, (node) => {
    if (!isRecord(node)) return;
    if (node.type === "exitedReviewMode" && typeof node.review === "string") {
      texts.push(node.review);
    }
  });
  return texts;
}

function summaryFromReviewText(reviewText: string): string {
  const line = reviewText
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? reviewText.trim();
}

function decisionFromReviewText(reviewText: string): ReviewDecision | null {
  const lower = reviewText.toLowerCase();
  if (lower.includes("changes requested") || lower.includes("needs changes")) {
    return "changes_requested";
  }
  if (lower.includes("blocked")) return "blocked";
  if (lower.includes("approved") || lower.includes("lgtm")) return "approved";
  if (lower.includes("informational")) return "informational";
  return null;
}

function annotationsFromReviewText(reviewText: string): readonly ReviewAnnotation[] {
  const annotations: ReviewAnnotation[] = [];
  const pattern = /(^|\s)([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
  for (const match of reviewText.matchAll(pattern)) {
    const line = Number.parseInt(match[3], 10);
    const endLine =
      match[4] === undefined ? line : Number.parseInt(match[4], 10);
    annotations.push({
      file: match[2],
      line,
      endLine,
      body: reviewText,
      source: "codex_review_text",
    });
  }
  return annotations;
}

function nativeAnnotationExportStatus(
  result: unknown,
): NativeAnnotationExportStatus {
  return propertyString(result, "nativeAnnotationExport") === "confirmed"
    ? "confirmed"
    : "unverifiable";
}

function stableEventIds(events: readonly CodexRuntimeEvent[]): readonly string[] {
  return [...new Set(events.map((event) => event.id))];
}

function firstNonEmpty(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function nonEmptyOption(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function propertyString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function nestedPropertyString(
  value: unknown,
  parent: string,
  child: string,
): string | null {
  const nested = recordProperty(value, parent);
  return nested === null ? null : propertyString(nested, child);
}

function nestedPropertyNumber(
  value: unknown,
  parent: string,
  child: string,
): number | null {
  const nested = recordProperty(value, parent);
  if (nested === null) return null;
  const candidate = nested[child];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : null;
}

function walk(value: unknown, visit: (node: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  for (const item of Object.values(value)) {
    walk(item, visit);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponseMessage {
  return isRecord(value) && typeof value.id === "number";
}
