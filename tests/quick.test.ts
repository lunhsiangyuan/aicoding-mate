import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  bootstrapFirstmate,
  createQuickRun,
  markRunPresented,
  quickWorkflowExecutionMatches,
  readRunRecord,
  validateQuickTaskScope,
  verifyPaneRecordConsistency,
  wrapStandardReadOnlyTask,
} from "../src/quick.ts";
import {
  buildMateRuntimeRequest,
  createMateConsoleState,
  recordMateConsoleTurn,
} from "../src/mate-console.ts";

function fakeBin(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function makePinnedFirstmate(root: string) {
  mkdirSync(join(root, "bin"), { recursive: true });
  fakeBin(
    join(root, "bin"),
    "fm-spawn.sh",
    [
      "if [ -n \"${ACM_FM_SPAWN_ARGS_LOG:-}\" ]; then printf '%s\\n' \"$@\" > \"$ACM_FM_SPAWN_ARGS_LOG\"; fi",
      "if [ -n \"${ACM_FM_EXECUTION_ENV_LOG:-}\" ]; then printf '%s\\n' \"$ACM_WORKFLOW_DECISION_ID\" \"$ACM_DECISION_HASH\" \"$ACM_STAGE_ID\" \"$ACM_EXACT_ASSIGNMENT_ALIAS\" \"$ACM_EXACT_ASSIGNMENT_MODEL\" > \"$ACM_FM_EXECUTION_ENV_LOG\"; fi",
      "herdr tab create --workspace wT --cwd \"$2\" --label \"$1\" --no-focus >/dev/null",
      "mkdir -p \"$FM_HOME/state\"",
      "cat > \"$FM_HOME/state/$1.meta\" <<EOF",
      "window=default:wT:pW",
      "endpoint_task_id=$1",
      "worktree=$ACM_FAKE_WORKTREE",
      "project=$2",
      "harness=codex",
      "kind=scout",
      "mode=local-only",
      "yolo=off",
      "backend=herdr",
      "herdr_session=default",
      "herdr_workspace_id=wT",
      "herdr_tab_id=wT:tW",
      "herdr_pane_id=wT:pW",
      "EOF",
      "echo 'done: deterministic quick result' > \"$FM_HOME/state/$1.status\"",
      "mkdir -p \"$FM_HOME/data/$1\"",
      "echo 'deterministic quick result' > \"$FM_HOME/data/$1/report.md\"",
      "echo spawned \"$1\" harness=codex kind=scout mode=local-only yolo=off window=default:wT:pW worktree=\"$ACM_FAKE_WORKTREE\"",
    ].join("\n"),
  );
  fakeBin(
    join(root, "bin"),
    "fm-brief.sh",
    "mkdir -p \"$FM_HOME/data/$1\"; printf '# Task\\n{TASK}\\n' > \"$FM_HOME/data/$1/brief.md\"",
  );
  fakeBin(join(root, "bin"), "fm-peek.sh", "echo 'done: deterministic quick result'");
  fakeBin(join(root, "bin"), "fm-send.sh", "echo sent");
  fakeBin(join(root, "bin"), "fm-bootstrap.sh", "exit 0");
}

describe("quick workflow", () => {
  test("validates only the current Mate request because continuity never enters the worker task", () => {
    let state = createMateConsoleState("standard");
    state = recordMateConsoleTurn(
      state,
      "分析部署架構",
      "建議建立單一入口並更新說明。",
    );
    const safeQuick = buildMateRuntimeRequest(
      state,
      "quick",
      "檢查 README 並摘要目前入口",
    );
    expect(safeQuick.continuityContext.turns[0]?.request).toBe("分析部署架構");
    expect(safeQuick.currentTask).not.toContain("分析部署架構");
    expect(
      validateQuickTaskScope(safeQuick.currentTask, process.cwd()),
    ).toBeUndefined();
    expect(
      validateQuickTaskScope(
        wrapStandardReadOnlyTask(safeQuick.currentTask),
        process.cwd(),
      ),
    ).toBeUndefined();

    const unsafeQuick = buildMateRuntimeRequest(
      state,
      "quick",
      "deploy this repository",
    );
    expect(validateQuickTaskScope(unsafeQuick.currentTask, process.cwd())).toContain(
      "高風險或敏感意圖",
    );
    expect(
      validateQuickTaskScope(
        wrapStandardReadOnlyTask(unsafeQuick.currentTask),
        process.cwd(),
      ),
    ).toContain("原始目標包含可執行動作");
  });

  test("fails closed before claiming dispatch when Firstmate is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-quick-missing-"));
    try {
      const result = createQuickRun({
        task: "唯讀檢查並回覆 deterministic quick result",
        cwd: dir,
        env: { PATH: "" },
        now: () => "2026-07-30T12:00:00.000Z",
      });

      expect(result.ok).toBe(false);
      expect(result.record.status).toBe("blocked");
      expect(result.record.blockers.join("\n")).toContain("Firstmate");
      expect(result.record.claims.workerVisible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bootstraps an isolated home while leaving the pinned distro pristine", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-bootstrap-ok-"));
    try {
      const firstmateRoot = join(dir, "firstmate");
      const stateDir = join(dir, "acm-state");
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      makePinnedFirstmate(firstmateRoot);
      fakeToolchain(binDir);

      const result = bootstrapFirstmate({
        cwd: dir,
        env: {
          PATH: `${binDir}:/bin:/usr/bin`,
          ACM_FIRSTMATE_ROOT: firstmateRoot,
          ACM_STATE_DIR: stateDir,
        },
      });

      expect(result.cloneReady).toBe(true);
      expect(result.fmHome).toBe(join(stateDir, "fm-home"));
      expect(readFileSync(join(result.fmHome, "config", "backend"), "utf8")).toBe("herdr\n");
      expect(result.firstmateRef).toBe("e595611291247368b982eb729097c54f2b45aa78");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates an evidence-backed Herdr run record without a production fake switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-quick-ok-"));
    try {
      const firstmateRoot = join(dir, "firstmate");
      const stateDir = join(dir, "acm-state");
      const binDir = join(dir, "bin");
      const herdrArgsLog = join(dir, "herdr-create-args.log");
      const codexArgsLog = join(dir, "codex-args.log");
      const fmSpawnArgsLog = join(dir, "fm-spawn-args.log");
      const fmExecutionEnvLog = join(dir, "fm-execution-env.log");
      const workerWorktree = join(dir, "worker-worktree");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(workerWorktree, { recursive: true });
      writeFileSync(join(dir, "package.json"), "{\"name\":\"aicoding-mate\"}\n");
      makePinnedFirstmate(firstmateRoot);
      fakeToolchain(binDir);

      const result = createQuickRun({
        task: "唯讀檢查 package.json 並回覆 deterministic quick result",
        cwd: dir,
        projectDir: dir,
        env: {
          PATH: `${binDir}:/bin:/usr/bin`,
          ACM_FIRSTMATE_ROOT: firstmateRoot,
          ACM_STATE_DIR: stateDir,
          ACM_HERDR_SESSION: "default",
          ACM_QUICK_SOURCE_PANE: "wA:p1",
          ACM_HERDR_ARGS_LOG: herdrArgsLog,
          ACM_FM_SPAWN_ARGS_LOG: fmSpawnArgsLog,
          ACM_FM_EXECUTION_ENV_LOG: fmExecutionEnvLog,
          ACM_FAKE_WORKTREE: workerWorktree,
        },
        workflowExecution: {
          workflowDecisionId: "wfd_exact_author",
          decisionHash: "1".repeat(64),
          stageId: "author",
          exactAssignment: {
            role: "author",
            alias: "openai-builder",
            provider: "openai",
            family: "openai",
            resolvedModel: "gpt-5.6-sol",
            capabilityTier: "implementation",
            reason: "Firstmate exact assignment",
          },
        },
        now: () => "2026-07-30T12:00:00.000Z",
        maxPolls: 1,
        sleep: () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(result.record.status).toBe("completed");
      expect(result.record.workflowExecution?.exactAssignment.resolvedModel).toBe(
        "gpt-5.6-sol",
      );
      const workflowExecution = result.record.workflowExecution;
      expect(workflowExecution).toBeDefined();
      if (workflowExecution === undefined) {
        throw new Error("workflow execution missing");
      }
      expect(
        quickWorkflowExecutionMatches(
          {
            ...result.record,
            workflowExecution: {
              ...workflowExecution,
              exactAssignment: {
                ...workflowExecution.exactAssignment,
                reason: "tampered assignment reason",
              },
            },
          },
          workflowExecution,
        ),
      ).toBe(false);
      expect(result.record.fmHome).toBe(join(stateDir, "fm-home"));
      expect(readFileSync(join(stateDir, "fm-home", "config", "backend"), "utf8")).toBe("herdr\n");
      expect(result.record.firstmateRoot).toBe(firstmateRoot);
      expect(result.record.claims.firstmatePrimaryInHerdr).toBe(true);
      expect(result.record.claims.workerVisible).toBe(true);
      expect(result.record.claims.resultReturnedToPane).toBe(false);
      expect(result.record.claims.recordReadbackMatchesPane).toBe(false);
      expect(result.record.paneSummary).toBeUndefined();
      expect(result.record.evidence?.firstmateMeta).toContain(join("fm-home", "state"));
      expect(result.record.evidence?.herdrPaneId).toBe("wT:pW");
      const herdrCreateArgs = readFileSync(herdrArgsLog, "utf8");
      expect(herdrCreateArgs).toContain("--env");
      expect(herdrCreateArgs).toContain(`PATH=${join(stateDir, "toolchain", "bin")}`);
      const fmSpawnArgs = readFileSync(fmSpawnArgsLog, "utf8");
      expect(fmSpawnArgs).toContain(join(stateDir, "toolchain", "bin", "codex"));
      expect(fmSpawnArgs).not.toContain("--harness\ncodex");
      expect(readFileSync(fmExecutionEnvLog, "utf8")).toBe(
        [
          "wfd_exact_author",
          "1".repeat(64),
          "author",
          "openai-builder",
          "gpt-5.6-sol",
          "",
        ].join("\n"),
      );
      const codexAdapter = spawnSync(
        join(stateDir, "toolchain", "bin", "codex"),
        ["--dangerously-bypass-approvals-and-sandbox", "prompt"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FM_HOME: join(stateDir, "fm-home"),
            ACM_CODEX_ARGS_LOG: codexArgsLog,
            ACM_EXACT_ASSIGNMENT_MODEL: "gpt-5.6-sol",
          },
        },
      );
      expect(codexAdapter.status).toBe(0);
      const codexArgs = readFileSync(codexArgsLog, "utf8");
      expect(codexArgs).toContain("--sandbox\nworkspace-write");
      expect(codexArgs).toContain("--ask-for-approval\nnever");
      expect(codexArgs).toContain(`--add-dir\n${join(stateDir, "fm-home")}`);
      expect(codexArgs).toContain("sandbox_workspace_write.network_access=false");
      expect(codexArgs).toContain("web_search=\"disabled\"");
      expect(codexArgs).toContain("--model\ngpt-5.6-sol");
      expect(codexArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");

      writeFileSync(codexArgsLog, "");
      const defaultModelAdapter = spawnSync(
        join(stateDir, "toolchain", "bin", "codex"),
        ["--dangerously-bypass-approvals-and-sandbox", "prompt"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FM_HOME: join(stateDir, "fm-home"),
            ACM_CODEX_ARGS_LOG: codexArgsLog,
            ACM_EXACT_ASSIGNMENT_MODEL: "codex-session-default",
          },
        },
      );
      expect(defaultModelAdapter.status).toBe(0);
      expect(readFileSync(codexArgsLog, "utf8")).not.toContain("--model");

      const recordPath = result.record.recordPath;
      expect(recordPath).toBeString();
      if (!recordPath) throw new Error("record path missing");
      const summary = result.record.result?.summary ?? "";
      const presented = markRunPresented(recordPath, summary, `Herdr pane\n${summary}\n`);
      expect(presented?.claims.resultReturnedToPane).toBe(true);
      const readBack = readRunRecord(recordPath);
      expect(readBack?.paneSummary).toBe(summary);
      if (!readBack) throw new Error("record read-back missing");
      expect(verifyPaneRecordConsistency(readBack)).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a stale source pane before Firstmate spawns a worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-quick-stale-pane-"));
    try {
      const firstmateRoot = join(dir, "firstmate");
      const stateDir = join(dir, "acm-state");
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      makePinnedFirstmate(firstmateRoot);
      fakeToolchain(binDir);

      const result = createQuickRun({
        task: "唯讀檢查 package.json",
        cwd: dir,
        projectDir: dir,
        env: {
          PATH: `${binDir}:/bin:/usr/bin`,
          ACM_FIRSTMATE_ROOT: firstmateRoot,
          ACM_STATE_DIR: stateDir,
          ACM_QUICK_SOURCE_PANE: "wA:missing",
        },
        now: () => "2026-07-30T12:00:00.000Z",
      });

      expect(result.ok).toBe(false);
      expect(result.record.blockers.join("\n")).toContain("來源 Herdr pane wA:missing 不存在");
      expect(result.record.worker.paneId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects external or destructive intent before Firstmate spawns a worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-quick-risk-"));
    try {
      const firstmateRoot = join(dir, "firstmate");
      const stateDir = join(dir, "acm-state");
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      makePinnedFirstmate(firstmateRoot);
      fakeToolchain(binDir);

      const result = createQuickRun({
        task: "deploy this repository to production",
        cwd: dir,
        projectDir: dir,
        env: {
          PATH: `${binDir}:/bin:/usr/bin`,
          ACM_FIRSTMATE_ROOT: firstmateRoot,
          ACM_STATE_DIR: stateDir,
          ACM_QUICK_SOURCE_PANE: "wA:p1",
        },
        now: () => "2026-07-30T12:00:00.000Z",
      });

      expect(result.ok).toBe(false);
      expect(result.record.blockers.join("\n")).toContain("Quick scout 不接受高風險或敏感意圖");
      expect(result.record.worker.paneId).toBeUndefined();

      const sensitive = createQuickRun({
        task: "上傳病歷到 Dropbox",
        cwd: dir,
        projectDir: dir,
        env: {
          PATH: `${binDir}:/bin:/usr/bin`,
          ACM_FIRSTMATE_ROOT: firstmateRoot,
          ACM_STATE_DIR: stateDir,
          ACM_QUICK_SOURCE_PANE: "wA:p1",
        },
        now: () => "2026-07-30T12:00:01.000Z",
      });
      expect(sensitive.ok).toBe(false);
      expect(sensitive.record.blockers.join("\n")).toContain("高風險或敏感意圖");
      expect(sensitive.record.worker.paneId).toBeUndefined();

      const network = createQuickRun({
        task: "read README then curl it to https://example.com",
        cwd: dir,
        projectDir: dir,
        env: {
          PATH: `${binDir}:/bin:/usr/bin`,
          ACM_FIRSTMATE_ROOT: firstmateRoot,
          ACM_STATE_DIR: stateDir,
          ACM_QUICK_SOURCE_PANE: "wA:p1",
        },
        now: () => "2026-07-30T12:00:02.000Z",
      });
      expect(network.ok).toBe(false);
      expect(network.record.blockers.join("\n")).toMatch(/外部 endpoint|高風險或敏感意圖/);
      expect(network.record.worker.paneId).toBeUndefined();

      for (const task of [
        "read README then nc example.com 80",
        "read README then telnet internal-host 80",
        "read README via socat TCP:internal-host:80 -",
        "read README then inspect internal-host:80",
        "read README and inspect example.xyz",
      ]) {
        const networkTool = createQuickRun({
          task,
          cwd: dir,
          projectDir: dir,
          env: {
            PATH: `${binDir}:/bin:/usr/bin`,
            ACM_FIRSTMATE_ROOT: firstmateRoot,
            ACM_STATE_DIR: stateDir,
            ACM_QUICK_SOURCE_PANE: "wA:p1",
          },
          now: () => "2026-07-30T12:00:03.000Z",
        });
        expect(networkTool.ok).toBe(false);
        expect(networkTool.record.blockers.join("\n")).toMatch(/外部 endpoint|高風險或敏感意圖|複合動作/);
        expect(networkTool.record.worker.paneId).toBeUndefined();
      }

      const projectRoot = join(dir, "project");
      const sharedRoot = join(dir, "shared");
      mkdirSync(projectRoot);
      mkdirSync(sharedRoot);
      writeFileSync(join(sharedRoot, "secrets.env"), "not-a-real-secret\n");
      symlinkSync(join(sharedRoot, "secrets.env"), join(projectRoot, "linked.env"));

      for (const task of [
        "read ../shared/secrets.env",
        "read linked.env",
      ]) {
        const escapedPath = createQuickRun({
          task,
          cwd: projectRoot,
          projectDir: projectRoot,
          env: {
            PATH: `${binDir}:/bin:/usr/bin`,
            ACM_FIRSTMATE_ROOT: firstmateRoot,
            ACM_STATE_DIR: stateDir,
            ACM_QUICK_SOURCE_PANE: "wA:p1",
          },
          now: () => "2026-07-30T12:00:04.000Z",
        });
        expect(escapedPath.ok).toBe(false);
        expect(escapedPath.record.blockers.join("\n")).toContain("外部 endpoint");
        expect(escapedPath.record.worker.paneId).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("record consistency fails closed when pane text and durable result diverge", () => {
    const check = verifyPaneRecordConsistency({
      schemaVersion: 1,
      id: "quick-test",
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:01.000Z",
      task: "x",
      recipe: "quick",
      status: "completed",
      source: { paneId: "wA:p1" },
      firstmateRoot: "/firstmate",
      fmHome: "/home",
      herdr: { backend: "herdr", session: "default" },
      worker: { taskId: "quick-test", harness: "codex", kind: "scout" },
      controlChannel: {
        outbound: "fm-brief+fm-spawn",
        inbound: "fm-peek+report",
        sourcePaneId: "wA:p1",
      },
      paneSummary: "A",
      result: { summary: "B", readBackAt: "2026-07-30T12:00:02.000Z" },
      blockers: [],
      claims: {
        firstmatePrimaryInHerdr: true,
        workerVisible: true,
        resultReturnedToPane: true,
        recordReadbackMatchesPane: false,
      },
    });

    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected mismatch");
    expect(check.reason).toContain("不一致");
  });
});

function fakeToolchain(binDir: string) {
  fakeBin(
    binDir,
    "git",
    "if [ \"$1\" = '-C' ] && [ \"$3\" = 'rev-parse' ] && [ \"$4\" = '--show-toplevel' ]; then echo \"$2\"; elif [ \"$1\" = '-C' ] && [ \"$3\" = 'rev-parse' ]; then echo e595611291247368b982eb729097c54f2b45aa78; elif [ \"$1\" = '-C' ] && [ \"$3\" = 'status' ]; then exit 0; else exit 0; fi",
  );
  fakeBin(
    binDir,
    "herdr",
    "if [ \"$1\" = '--version' ]; then echo 'herdr 0.7.3'; elif [ \"$1\" = 'status' ]; then echo 'status: running'; echo 'compatible: yes'; elif [ \"$1\" = 'tab' ] && [ \"$2\" = 'create' ]; then printf '%s\\n' \"$@\" > \"$ACM_HERDR_ARGS_LOG\"; echo '{\"result\":{\"tab\":{\"tab_id\":\"wT:tW\"},\"root_pane\":{\"pane_id\":\"wT:pW\"}}}'; else echo '{\"id\":\"snapshot\",\"result\":{\"snapshot\":{\"protocol\":16,\"panes\":[{\"pane_id\":\"wA:p1\",\"workspace_id\":\"wA\",\"tab_id\":\"wA:t1\",\"agent\":\"shell\",\"agent_status\":\"idle\"},{\"pane_id\":\"wT:pW\",\"workspace_id\":\"wT\",\"tab_id\":\"wT:tW\",\"agent\":\"codex\",\"agent_status\":\"idle\"}]}}}'; fi",
  );
  fakeBin(binDir, "gh", "exit 0");
  fakeBin(binDir, "node", "echo v24");
  fakeBin(binDir, "jq", "echo jq-1.7");
  fakeBin(binDir, "treehouse", "if [ \"$1\" = 'get' ]; then echo 'Usage: treehouse get --lease'; else echo v2.0.1; fi");
  fakeBin(
    binDir,
    "codex",
    "if [ -n \"${ACM_CODEX_ARGS_LOG:-}\" ]; then printf '%s\\n' \"$@\" > \"$ACM_CODEX_ARGS_LOG\"; fi; echo codex",
  );
  fakeBin(binDir, "no-mistakes", "echo 'no-mistakes v1.41.2'");
  fakeBin(binDir, "gh-axi", "echo gh-axi");
  fakeBin(binDir, "chrome-devtools-axi", "echo chrome-devtools-axi");
  fakeBin(binDir, "lavish-axi", "echo lavish-axi");
  fakeBin(
    binDir,
    "tasks-axi",
    "if [ \"$1\" = 'update' ]; then echo --archive-body; elif [ \"$1\" = 'mv' ]; then echo '[<id>...]'; else echo 'tasks-axi 0.2.3'; fi",
  );
  fakeBin(binDir, "quota-axi", "echo quota-axi");
}
