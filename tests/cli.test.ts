import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { main } from "../src/cli.ts";

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

  test("high-intensity final read-back trusts FM_HOME authority root", async () => {
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
      }),
    );
    expect(readCode).toBe(0);
    expect(readBuffer.stdout).toContain(
      '"workflowAuthority": "firstmate_verified"',
    );
    expect(readBuffer.stdout).toContain('"ok": true');
  });
});
