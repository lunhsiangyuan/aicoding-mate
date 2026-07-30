import { describe, expect, test } from "bun:test";
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
});
