import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./probe.ts";
import { renderDoctorText, renderPane } from "./render.ts";

export interface CliIO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const pluginId = "ai-coding-mate";

export async function main(args: string[], io: CliIO): Promise<number> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(helpText());
    return 0;
  }

  try {
    switch (command) {
      case "doctor":
        return runDoctorCommand(args.slice(1), io);
      case "pane":
        return await runPaneCommand(args.slice(1), io);
      case "install":
        return runInstallCommand(args.slice(1), io);
      case "link":
        return runLinkCommand(args.slice(1), io);
      case "open":
        return runOpenCommand(args.slice(1), io);
      default:
        io.stderr.write(`未知 command: ${command}\n\n${helpText()}`);
        return 2;
    }
  } catch (error) {
    io.stderr.write(`執行失敗: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function runDoctorCommand(args: string[], io: CliIO): number {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else {
      io.stderr.write(`doctor 不支援的參數: ${arg}\n`);
      return 2;
    }
  }
  const report = runDoctor({ cwd: io.cwd, env: io.env });
  io.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorText(report));
  return report.summary.ready ? 0 : 1;
}

async function runPaneCommand(args: string[], io: CliIO): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(`pane 不支援額外參數: ${args.join(" ")}\n`);
    return 2;
  }
  const report = runDoctor({ cwd: io.cwd, env: io.env });
  io.stdout.write(renderPane(report));
  if (io.env.HERDR_ENV === "1" && io.env.ACM_PANE_ONCE !== "1") {
    io.stdout.write("\nHerdr pane 保持開啟中；關閉此 pane 即可結束診斷面。\n");
    await keepPaneOpen();
  }
  return 0;
}

function runInstallCommand(args: string[], io: CliIO): number {
  if (args.length > 0) {
    io.stderr.write(`install 不支援額外參數: ${args.join(" ")}\n`);
    return 2;
  }
  const bun = io.env.BUN_INSTALL ? resolve(io.env.BUN_INSTALL, "bin", "bun") : "bun";
  const result = spawnSync(bun, ["install"], {
    cwd: repoRoot(),
    env: io.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  io.stdout.write(result.stdout ?? "");
  io.stderr.write(result.stderr ?? "");
  if (result.status === 0) {
    io.stdout.write("安裝完成。下一步: `bun bin/aicoding-mate link`。\n");
  }
  return result.status ?? 1;
}

function runLinkCommand(args: string[], io: CliIO): number {
  let disabled = false;
  for (const arg of args) {
    if (arg === "--disabled") {
      disabled = true;
    } else {
      io.stderr.write(`link 不支援的參數: ${arg}\n`);
      return 2;
    }
  }
  const herdr = herdrBin(io);
  const linkArgs = ["plugin", "link", repoRoot()];
  if (disabled) linkArgs.push("--disabled");
  const result = spawnSync(herdr, linkArgs, {
    cwd: io.cwd,
    env: io.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  io.stdout.write(result.stdout ?? "");
  io.stderr.write(result.stderr ?? "");
  if (result.status === 0) {
    io.stdout.write("Herdr plugin 已 link。下一步: `bun bin/aicoding-mate open`。\n");
  }
  return result.status ?? 1;
}

function runOpenCommand(args: string[], io: CliIO): number {
  let placement = "tab";
  let focus = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--placement") {
      const value = args[index + 1];
      if (!value || !["overlay", "popup", "split", "tab", "zoomed"].includes(value)) {
        io.stderr.write("open 的 --placement 必須是 overlay|popup|split|tab|zoomed。\n");
        return 2;
      }
      placement = value;
      index += 1;
    } else if (arg === "--no-focus") {
      focus = false;
    } else {
      io.stderr.write(`open 不支援的參數: ${arg}\n`);
      return 2;
    }
  }
  const herdr = herdrBin(io);
  const openArgs = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    "doctor",
    "--placement",
    placement,
    "--env",
    "ACM_OPENED_BY=aicoding-mate",
    focus ? "--focus" : "--no-focus",
  ];
  const result = spawnSync(herdr, openArgs, {
    cwd: io.cwd,
    env: io.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  io.stdout.write(result.stdout ?? "");
  io.stderr.write(result.stderr ?? "");
  return result.status ?? 1;
}

function herdrBin(io: CliIO): string {
  return io.env.HERDR_BIN_PATH || "herdr";
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function helpText(): string {
  return `AI Coding Mate CLI

用法:
  aicoding-mate install
  aicoding-mate link [--disabled]
  aicoding-mate open [--placement overlay|popup|split|tab|zoomed] [--no-focus]
  aicoding-mate doctor [--json]
  aicoding-mate pane

說明:
  install  安裝 Bun dependencies。
  link     將目前工作目錄註冊成 Herdr local plugin。
  open     從 Herdr 開啟 AI Coding Mate 診斷 pane。
  doctor   從 runtime 實際讀回 Herdr、Firstmate、Codex、Claude、git、gh、jq、Bun 狀態。
  pane     Herdr plugin pane entrypoint，輸出可讀診斷面。
`;
}

function keepPaneOpen(): Promise<void> {
  return new Promise((resolveKeepAlive) => {
    const timer = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(timer);
      resolveKeepAlive();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
