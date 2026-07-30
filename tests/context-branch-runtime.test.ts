import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createDefaultBranchClassifier,
  createDefaultBranchResearcher,
  readBranchSession,
  resolveFirstmateSourceBinding,
  startContextBranch,
  type FirstmateSourceBinding,
} from "../src/integration/context-branch-runtime.ts";

const binding: FirstmateSourceBinding = {
  taskId: "quick-1",
  runId: "quick-1",
  firstmateSessionRef: "quick-1",
  sourcePaneId: "w1:p1",
  quickRecordPath: "/tmp/quick-1.json",
  firstmateRoot: "/tmp/firstmate",
  fmHome: "/tmp/fm-home",
  herdrSession: "default",
  workerTarget: "w1:p2",
};

function invocation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    selected_text: "把這段內容變成一個新的架構任務",
    workspace_label: "workspace-1",
    tab_label: "tab-1",
    focused_pane_id: "w1:p1",
    ...overrides,
  });
}

describe("context branch runtime", () => {
  test("enriches a Herdr selection with Firstmate run lineage and opens branch pane", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    let openedPath = "";
    const result = startContextBranch({
      contextJson: invocation(),
      cwd: root,
      env: { ACM_STATE_DIR: join(root, "state") },
      now: () => "2026-07-30T16:00:00.000Z",
      ports: {
        resolveSource: () => binding,
        openBranchPane(path) {
          openedPath = path;
          return { ok: true, error: null };
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.session.status).toBe("briefed");
    expect(result.session.source).toEqual({
      taskId: "quick-1",
      runId: "quick-1",
      workspace: "workspace-1",
      tabId: "tab-1",
      paneId: "w1:p1",
    });
    expect(result.session.firstmateSessionRef).toBe("quick-1");
    expect(openedPath).toBe(result.branchPath);
    expect(readBranchSession(result.branchPath)?.branchId).toBe(
      result.session.branchId,
    );
  });

  test("fails closed when selection has no matching Firstmate run", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    let opened = false;
    const result = startContextBranch({
      contextJson: invocation(),
      cwd: root,
      env: { ACM_STATE_DIR: join(root, "state") },
      ports: {
        resolveSource: () => null,
        openBranchPane() {
          opened = true;
          return { ok: true, error: null };
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "firstmate_source_run_not_found",
    });
    expect(opened).toBe(false);
  });

  test("uses the latest complete Firstmate binding when a newer failed run shares the source pane", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    const runsDir = join(root, "runs");
    mkdirSync(runsDir);
    const validPath = join(runsDir, "quick-valid.json");
    writeFileSync(
      validPath,
      JSON.stringify({
        schemaVersion: 1,
        recipe: "quick",
        id: "quick-valid",
        updatedAt: "2026-07-30T16:00:00.000Z",
        source: { paneId: "w1:p1" },
        worker: {
          taskId: "quick-valid",
          target: "default:w1:p2",
        },
        recordPath: validPath,
        firstmateRoot: "/tmp/firstmate",
        fmHome: "/tmp/fm-home",
        herdr: { session: "default" },
      }),
    );
    writeFileSync(
      join(runsDir, "quick-failed.json"),
      JSON.stringify({
        schemaVersion: 1,
        recipe: "quick",
        id: "quick-failed",
        updatedAt: "2026-07-30T16:01:00.000Z",
        source: { paneId: "w1:p1" },
        worker: {},
      }),
    );

    expect(resolveFirstmateSourceBinding(root, "w1:p1")).toEqual({
      taskId: "quick-valid",
      runId: "quick-valid",
      firstmateSessionRef: "quick-valid",
      sourcePaneId: "w1:p1",
      quickRecordPath: validPath,
      firstmateRoot: "/tmp/firstmate",
      fmHome: "/tmp/fm-home",
      herdrSession: "default",
      workerTarget: "default:w1:p2",
    });
  });

  test("fails closed when Herdr action has no selected text", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    const result = startContextBranch({
      contextJson: invocation({ selected_text: "" }),
      cwd: root,
      env: { ACM_STATE_DIR: join(root, "state") },
      ports: {
        resolveSource: () => binding,
        openBranchPane: () => ({ ok: true, error: null }),
      },
    });

    expect(result).toEqual({ ok: false, reason: "selection_empty" });
  });

  test("reports pane-open failure without claiming the branch is active", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    let branchPath = "";
    const result = startContextBranch({
      contextJson: invocation(),
      cwd: root,
      env: { ACM_STATE_DIR: join(root, "state") },
      ports: {
        resolveSource: () => binding,
        openBranchPane: (path) => {
          branchPath = path;
          return {
            ok: false,
            error: "branch_pane_open_failed",
          };
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "branch_pane_open_failed",
    });
    expect(readBranchSession(branchPath)?.status).toBe("expired");
  });

  test("creates a distinct branch session for repeated selections", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    const options = {
      contextJson: invocation(),
      cwd: root,
      env: { ACM_STATE_DIR: join(root, "state") },
      now: () => "2026-07-30T16:00:00.000Z",
      ports: {
        resolveSource: () => binding,
        openBranchPane: () => ({ ok: true, error: null }),
      },
    };

    const first = startContextBranch(options);
    const second = startContextBranch(options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("branch_start_failed");
    expect(first.session.branchId).not.toBe(second.session.branchId);
    expect(first.session.lineageIntentId).not.toBe(
      second.session.lineageIntentId,
    );
  });

  test("uses explicit Codex fallback for branch classifier and researcher when Claude review is disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-branch-"));
    const bin = join(root, "bin");
    const claudeMarker = join(root, "claude-called");
    const codexArgsLog = join(root, "codex-args.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\ntouch "${claudeMarker}"\necho should-not-run\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${codexArgsLog}"`,
        "case \"$*\" in",
        "  *\"intent\"*) echo '{\"intent\":\"new_task\"}' ;;",
        "  *) echo '{\"summary\":\"Codex fallback 研究摘要\"}' ;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);
    const env = {
      ACM_CLAUDE_REVIEW_DISABLED: "1",
      PATH: bin,
    };

    const classifier = createDefaultBranchClassifier(root, env);
    const researcher = createDefaultBranchResearcher(root, env);
    const intent = classifier({
      selectedText: "請建立新的 review 任務",
      brief: "一段 Context Branch 簡介",
      returnInstruction: "建立新任務",
      source: {
        taskId: "quick-1",
        runId: "quick-1",
        workspace: "w1",
        tabId: "t1",
        paneId: "p1",
      },
      taskRun: {
        taskId: "quick-1",
        runId: "quick-1",
        firstmateSessionRef: "quick-1",
        sourceLineageHash: "hash",
        consumedLineageIntentIds: [],
      },
    });
    const research = researcher({
      selectedText: "需要理解 adapter 與 capsule 邊界",
      brief: "一段 Context Branch 簡介",
      source: {
        taskId: "quick-1",
        runId: "quick-1",
        workspace: "w1",
        tabId: "t1",
        paneId: "p1",
      },
    });

    expect(intent).toBe("new_task");
    expect(research).toEqual({
      summary: "Codex fallback 研究摘要",
      evidence: ["codex:codex-session-default"],
    });
    expect(existsSync(claudeMarker)).toBe(false);
    const codexArgs = readFileSync(codexArgsLog, "utf8");
    expect(codexArgs).toContain("exec --ephemeral --sandbox read-only");
    expect(codexArgs).toContain("只輸出 new_task 或 modify_task");
    expect(codexArgs).toContain("請用繁體中文簡介");
  });
});
