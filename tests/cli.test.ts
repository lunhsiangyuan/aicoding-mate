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
});
