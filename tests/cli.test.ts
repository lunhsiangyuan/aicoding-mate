import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  conductMateConsole,
  dispatchMateTask,
  main,
  type MateWorkflowRunners,
} from "../src/cli.ts";
import {
  buildMateRuntimeRequest,
  containsMateEnvelopeMarker,
  createMateConsoleState,
} from "../src/mate-console.ts";

class BufferIO {
  stdout = "";
  stderr = "";
  io(env: NodeJS.ProcessEnv = process.env) {
    return {
      cwd: process.cwd(),
      env,
      stdout: { write: (chunk: string) => { this.stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { this.stderr += chunk; return true; } },
    };
  }
}

describe("cli", () => {
  test("--help prints concise Traditional Chinese usage", async () => {
    const buffer = new BufferIO();
    const code = await main(["--help"], buffer.io());

    expect(code).toBe(0);
    expect(buffer.stdout).toContain("用法");
    expect(buffer.stdout).toContain("doctor");
    expect(buffer.stdout).toContain("standard");
    expect(buffer.stdout).toContain("adversarial");
    expect(buffer.stdout).toContain("research");
    expect(buffer.stdout).toContain("context-branch-start");
    expect(buffer.stdout).toContain("codex-review-start");
  });

  test("unknown command is a bad input with help", async () => {
    const buffer = new BufferIO();
    const code = await main(["wat"], buffer.io());

    expect(code).toBe(2);
    expect(buffer.stderr).toContain("未知 command");
    expect(buffer.stderr).toContain("用法");
  });

  test("doctor command returns non-zero when required tools are missing", async () => {
    const buffer = new BufferIO();
    const code = await main(["doctor"], buffer.io({ PATH: "" }));

    expect(code).toBe(1);
    expect(buffer.stdout).toContain("尚未就緒");
  });

  test("doctor json exposes missing tools when PATH is empty", async () => {
    const buffer = new BufferIO();
    const code = await main(["doctor", "--json"], buffer.io({ PATH: "" }));

    expect(code).toBe(1);
    const parsed = JSON.parse(buffer.stdout);
    expect(parsed.summary.ready).toBe(false);
    expect(parsed.tools.some((tool: { status: string }) => tool.status === "missing")).toBe(true);
  });

  test("open always launches the single Mate pane with the requested initial mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-cli-open-"));
    const herdrPath = join(root, "herdr");
    const capturePath = join(root, "args.txt");
    writeFileSync(
      herdrPath,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ACM_CAPTURE_PATH\"\n",
      { mode: 0o755 },
    );
    chmodSync(herdrPath, 0o755);
    const buffer = new BufferIO();
    const defaultCode = await main(
      ["open"],
      buffer.io({
        ...process.env,
        HERDR_BIN_PATH: herdrPath,
        ACM_CAPTURE_PATH: capturePath,
      }),
    );
    expect(defaultCode).toBe(0);
    const defaultArgs = readFileSync(capturePath, "utf8")
      .trim()
      .split("\n");
    expect(defaultArgs).toContain("mate");
    expect(defaultArgs).toContain("ACM_INITIAL_MODE=standard");

    const code = await main(
      ["open", "--mode", "expert", "--placement", "tab"],
      buffer.io({
        ...process.env,
        HERDR_BIN_PATH: herdrPath,
        ACM_CAPTURE_PATH: capturePath,
      }),
    );

    expect(code).toBe(0);
    const args = readFileSync(capturePath, "utf8").trim().split("\n");
    expect(args).toContain("mate");
    expect(args).toContain("ACM_INITIAL_MODE=expert");
    expect(args).not.toContain("adversarial");
  });

  test("open rejects an unknown user mode before calling Herdr", async () => {
    const buffer = new BufferIO();
    const code = await main(
      ["open", "--mode", "wat"],
      buffer.io({ HERDR_BIN_PATH: "/not-called" }),
    );

    expect(code).toBe(2);
    expect(buffer.stderr).toContain(
      "--mode 必須是 quick|standard|expert|research|learn",
    );
  });

  test("open rejects legacy entrypoints so Context Branch stays selection-only", async () => {
    const buffer = new BufferIO();
    const code = await main(
      ["open", "--entrypoint", "context-branch"],
      buffer.io({ HERDR_BIN_PATH: "/not-called" }),
    );

    expect(code).toBe(2);
    expect(buffer.stderr).toContain("open 不支援的參數: --entrypoint");
  });

  test("pane consumes a multi-line non-TTY session without dropping buffered input", () => {
    const result = spawnSync(
      process.execPath,
      ["bin/aicoding-mate", "pane"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ACM_INITIAL_MODE: "research" },
        input: "/status\n/quit\n",
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "mode=research completed_turns=0 context_turns=0",
    );
    expect(result.stdout).toContain("AI Coding Mate 已離開");
  });

  test("pane contains a thrown workflow to one turn and keeps the session alive", async () => {
    const buffer = new BufferIO();
    const inputs = ["檢查架構", "/status", "/quit"];
    const code = await conductMateConsole(
      buffer.io(),
      async () => inputs.shift() ?? "/quit",
      async () => {
        throw new Error("simulated_dispatch_failure");
      },
    );

    expect(code).toBe(0);
    expect(buffer.stderr).toContain("本輪執行失敗：simulated_dispatch_failure");
    expect(buffer.stdout).toContain(
      "mode=standard completed_turns=1 context_turns=1",
    );
    expect(buffer.stdout).toContain("AI Coding Mate 已離開");
  });

  test("pane keeps prior turns as local continuity without redispatching them", async () => {
    const buffer = new BufferIO();
    const inputs = [
      "分析部署架構",
      "/quick 檢查 README 並摘要目前入口",
      "/quit",
    ];
    const dispatched: Array<{
      mode: string;
      currentTask: string;
      continuityRequests: readonly string[];
    }> = [];
    const code = await conductMateConsole(
      buffer.io(),
      async () => inputs.shift() ?? "/quit",
      async (mode, request, io) => {
        dispatched.push({
          mode,
          currentTask: request.currentTask,
          continuityRequests: request.continuityContext.turns.map(
            (turn) => turn.request,
          ),
        });
        io.stdout.write("結論：本輪完成。\n");
        return 0;
      },
    );

    expect(code).toBe(0);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toEqual({
      mode: "quick",
      currentTask: "檢查 README 並摘要目前入口",
      continuityRequests: ["分析部署架構"],
    });
    expect(dispatched[1]?.currentTask).not.toContain("分析部署架構");
  });

  test("real Mate dispatcher maps every user mode to the intended workflow", async () => {
    const calls: string[] = [];
    const runners: MateWorkflowRunners = {
      quick: async (task) => {
        calls.push(`quick:${task}`);
        return 0;
      },
      standard: async (task) => {
        calls.push(`standard:${task}`);
        return 0;
      },
      highIntensity: async (recipe, task) => {
        calls.push(`${recipe}:${task}`);
        return 0;
      },
    };
    const buffer = new BufferIO();
    const state = createMateConsoleState("standard");
    for (const mode of ["quick", "standard", "expert", "research", "learn"] as const) {
      await dispatchMateTask(
        mode,
        buildMateRuntimeRequest(state, mode, `task-${mode}`),
        buffer.io(),
        runners,
      );
    }

    expect(calls.slice(0, 4)).toEqual([
      "quick:task-quick",
      "standard:task-standard",
      "adversarial:task-expert",
      "research:task-research",
    ]);
    expect(calls[4]).toStartWith(
      "standard:這是一個 Architect learning request。",
    );
    expect(calls[4]).toContain("學習內容：task-learn");
  });

  test("direct workflow commands reject reserved Mate envelope markers", async () => {
    const envelope = [
      "[ACM_MATE_CONTEXT_NON_EVIDENCE]",
      "先前問題",
      "[/ACM_MATE_CONTEXT_NON_EVIDENCE]",
    ].join("\n");
    expect(containsMateEnvelopeMarker(envelope)).toBe(true);
    const buffer = new BufferIO();
    const code = await main(
      ["quick", "--task", envelope],
      buffer.io({ PATH: "" }),
    );

    expect(code).toBe(2);
    expect(buffer.stderr).toContain("保留的 Mate context marker");
  });

  test("standard fails closed before dispatch outside a Herdr pane", async () => {
    const buffer = new BufferIO();
    const code = await main(
      ["standard", "--task", "分析目前架構"],
      buffer.io({ PATH: "" }),
    );

    expect(code).toBe(1);
    expect(buffer.stdout).toContain("BLOCKED");
  });

  test("context branch start requires a Herdr selection context", async () => {
    const buffer = new BufferIO();
    const code = await main(
      ["context-branch-start"],
      buffer.io({ PATH: process.env.PATH }),
    );

    expect(code).toBe(1);
    expect(buffer.stderr).toContain("選取文字 action");
  });

  test("Codex review start requires a Herdr selection context", async () => {
    const buffer = new BufferIO();
    const code = await main(
      ["codex-review-start"],
      buffer.io({ PATH: process.env.PATH }),
    );

    expect(code).toBe(1);
    expect(buffer.stderr).toContain("選取文字 action");
  });

  test("high-intensity command fails closed before model calls when agent is unavailable", async () => {
    const buffer = new BufferIO();
    const code = await main(
      ["adversarial", "--task", "判斷控制平面邊界"],
      buffer.io({ PATH: "" }),
    );

    expect(code).toBe(1);
    expect(buffer.stdout).toContain("BLOCKED");
    expect(buffer.stdout).toContain("evidence:");
  });

  test("high-intensity command rejects a missing task", async () => {
    const buffer = new BufferIO();
    const code = await main(["research"], buffer.io());

    expect(code).toBe(2);
    expect(buffer.stderr).toContain("需要任務文字");
  });

  test("Quick read-run is historical and never claims verified success", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-cli-quick-read-"));
    const recordPath = join(root, "quick.json");
    writeFileSync(
      recordPath,
      JSON.stringify({
        schemaVersion: 1,
        recipe: "quick",
        id: "quick-historical",
      }),
    );
    const buffer = new BufferIO();
    const code = await main(["read-run", recordPath], buffer.io());

    expect(code).toBe(1);
    expect(buffer.stdout).toContain("quick_record_historical_unverified");
    expect(buffer.stdout).toContain('"ok": false');
  });

  test("high-intensity final read-back trusts only configured FM_HOME root", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-cli-fm-home-"));
    const binDir = join(root, "bin");
    const stateDir = join(root, "state");
    const fmHome = join(stateDir, "fm-home");
    mkdirSync(binDir);
    const agentPath = join(binDir, "agent");
    writeFileSync(
      agentPath,
      [
        "#!/bin/zsh",
        "if [ \"$1\" = \"--list-models\" ]; then",
        "  printf '%s\\n' gpt-5.4-mini gpt-5.6-sol-high claude-fable-5-thinking-high cursor-grok-4.5-high",
        "  exit 0",
        "fi",
        "prompt=\"${@: -1}\"",
        "case \"$prompt\" in",
        "  *'\"observations\"'*)",
        "    printf '%s\\n' '{\"observations\":[{\"id\":\"obs-1\",\"subquestion\":\"哪些需求與限制已被確認？\",\"statement\":\"FM_HOME authority root must be trusted by CLI read-back.\",\"category\":\"confirmed\",\"sourceIds\":[\"src/cli.ts\"],\"lineage\":[\"cli\"],\"counterexample\":false,\"limitation\":null}]}'",
        "    ;;",
        "  *'\"claim\"'*)",
        "    printf '%s\\n' '{\"claim\":\"CLI final read-back should use FM_HOME authority root.\"}'",
        "    ;;",
        "  *'\"counterexample\"'*)",
        "    printf '%s\\n' '{\"counterexample\":\"A stateDir-derived authority root rejects the completed record.\"}'",
        "    ;;",
        "  *'\"accepted\"'*)",
        "    printf '%s\\n' '{\"accepted\":true,\"acceptedReasons\":[\"The trusted root matches runtime issuance.\"],\"rejectedReasons\":[]}'",
        "    ;;",
        "  *)",
        "    printf '%s\\n' '{}'",
        "    ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(agentPath, 0o755);

    const buffer = new BufferIO();
    const code = await main(
      ["adversarial", "--task", "確認 FM_HOME final read-back"],
      buffer.io({
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        ACM_STATE_DIR: stateDir,
        FM_HOME: fmHome,
        HERDR_TASK_ID: "task-cli-fm-home",
        HERDR_RUN_ID: "run-cli-fm-home",
        HERDR_WORKSPACE_ID: "workspace-cli-fm-home",
        HERDR_TAB_ID: "tab-cli-fm-home",
        HERDR_PANE_ID: "pane-cli-fm-home",
      }),
    );

    expect(code).toBe(0);
    expect(buffer.stdout).toContain("對抗式架構審查");
    expect(buffer.stdout).toContain("證據層：");
    expect(buffer.stdout).not.toContain("BLOCKED");

    const recordName = readdirSync(join(stateDir, "high-intensity-runs")).find(
      (name) => name.endsWith(".json"),
    );
    expect(recordName).toBeDefined();
    if (recordName === undefined) throw new Error("high record missing");
    const readBuffer = new BufferIO();
    const readCode = await main(
      [
        "read-run",
        join(stateDir, "high-intensity-runs", recordName),
      ],
      readBuffer.io({
        ACM_STATE_DIR: stateDir,
        FM_HOME: fmHome,
      }),
    );
    expect(readCode).toBe(0);
    expect(readBuffer.stdout).toContain(
      '"workflowAuthority": "firstmate_verified"',
    );
    expect(readBuffer.stdout).toContain('"ok": true');

    const alternateRootBuffer = new BufferIO();
    const alternateRootCode = await main(
      [
        "read-run",
        join(stateDir, "high-intensity-runs", recordName),
      ],
      alternateRootBuffer.io({
        ACM_STATE_DIR: stateDir,
        FM_HOME: join(root, "alternate-fm-home"),
      }),
    );
    expect(alternateRootCode).toBe(1);
    expect(alternateRootBuffer.stderr).toContain("無法讀取 run record");
    expect(alternateRootBuffer.stdout).not.toContain('"ok": true');
  });
});
