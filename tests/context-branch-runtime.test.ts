import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  readBranchSession,
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
});
