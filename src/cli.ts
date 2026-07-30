import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { runDoctor } from "./probe.ts";
import { renderDoctorText, renderPane } from "./render.ts";
import {
  bootstrapFirstmate,
  createQuickRun,
  markRunPresented,
  readPaneUntilContains,
  readRunRecord,
  renderQuickText,
  verifyPaneRecordConsistency,
} from "./quick.ts";

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
      case "quick":
        return await runQuickCommand(args.slice(1), io);
      case "quick-pane":
        return await runQuickPaneCommand(args.slice(1), io);
      case "bootstrap-firstmate":
        return runBootstrapFirstmateCommand(args.slice(1), io);
      case "read-run":
        return runReadRunCommand(args.slice(1), io);
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

async function runQuickCommand(args: string[], io: CliIO): Promise<number> {
  let projectDir = io.cwd;
  const taskParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task") {
      const value = args[index + 1];
      if (!value) {
        io.stderr.write("quick 的 --task 需要文字。\n");
        return 2;
      }
      taskParts.push(value);
      index += 1;
    } else if (arg === "--project") {
      const value = args[index + 1];
      if (!value) {
        io.stderr.write("quick 的 --project 需要路徑。\n");
        return 2;
      }
      projectDir = resolve(io.cwd, value);
      index += 1;
    } else if (arg.startsWith("--")) {
      io.stderr.write(`quick 不支援的參數: ${arg}\n`);
      return 2;
    } else {
      taskParts.push(arg);
    }
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    io.stderr.write("quick 需要任務文字，例如：aicoding-mate quick --task \"回覆 hello\"。\n");
    return 2;
  }
  const result = createQuickRun({ task, cwd: io.cwd, projectDir, env: io.env });
  if (result.stderr) io.stderr.write(`${result.stderr}\n`);
  if (!result.ok || !result.record.recordPath || !result.record.result?.summary) {
    io.stdout.write(renderQuickText(result));
    return 1;
  }
  io.stdout.write(renderQuickText(result));
  const sourcePaneId = result.record.source.paneId;
  const observedPaneText = sourcePaneId
    ? readPaneUntilContains(sourcePaneId, result.record.result.summary, io.cwd, io.env)
    : undefined;
  if (!observedPaneText) {
    io.stderr.write("結果已輸出，但無法從來源 Herdr pane runtime 讀回同一內容；durable claims 保持 false。\n");
    return 1;
  }
  const presented = markRunPresented(
    result.record.recordPath,
    result.record.result.summary,
    observedPaneText,
  );
  if (!presented) {
    io.stderr.write("來源 pane read-back 與 durable result 不一致。\n");
    return 1;
  }
  io.stdout.write(
    `final claims: primary=${presented.claims.firstmatePrimaryInHerdr}`
    + ` worker=${presented.claims.workerVisible}`
    + ` returned=${presented.claims.resultReturnedToPane}`
    + ` readback=${presented.claims.recordReadbackMatchesPane}\n`,
  );
  return 0;
}

async function runQuickPaneCommand(args: string[], io: CliIO): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(`quick-pane 不支援額外參數: ${args.join(" ")}\n`);
    return 2;
  }
  io.stdout.write("AI Coding Mate Quick\n請輸入一個明確唯讀的檢查、搜尋、摘要、解釋或 review 任務：\n> ");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const task = (await prompt.question("")).trim();
  prompt.close();
  if (!task) {
    io.stderr.write("任務不可為空。\n");
    return 2;
  }
  const exitCode = await runQuickCommand(["--task", task], io);
  if (io.env.HERDR_ENV === "1" && io.env.ACM_PANE_ONCE !== "1") {
    io.stdout.write("\nQuick pane 保持開啟，方便回讀結果；關閉此 pane 即可離開。\n");
    await keepPaneOpen();
  }
  return exitCode;
}

function runBootstrapFirstmateCommand(args: string[], io: CliIO): number {
  if (args.length > 0) {
    io.stderr.write(`bootstrap-firstmate 不支援額外參數: ${args.join(" ")}\n`);
    return 2;
  }
  const result = bootstrapFirstmate({ cwd: io.cwd, env: io.env });
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.cloneReady && result.toolchainReady ? 0 : 1;
}

function runReadRunCommand(args: string[], io: CliIO): number {
  if (args.length !== 1) {
    io.stderr.write("read-run 需要一個 run record JSON 路徑。\n");
    return 2;
  }
  const record = readRunRecord(resolve(io.cwd, args[0]));
  if (!record) {
    io.stderr.write(`無法讀取 run record: ${args[0]}\n`);
    return 1;
  }
  const consistency = verifyPaneRecordConsistency(record);
  io.stdout.write(`${JSON.stringify({ record, consistency }, null, 2)}\n`);
  return consistency.ok ? 0 : 1;
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
  let entrypoint = "doctor";
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
    } else if (arg === "--entrypoint") {
      const value = args[index + 1];
      if (!value || !["doctor", "quick"].includes(value)) {
        io.stderr.write("open 的 --entrypoint 必須是 doctor|quick。\n");
        return 2;
      }
      entrypoint = value;
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
    entrypoint,
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
  aicoding-mate open [--entrypoint doctor|quick] [--placement overlay|popup|split|tab|zoomed] [--no-focus]
  aicoding-mate doctor [--json]
  aicoding-mate bootstrap-firstmate
  aicoding-mate quick --task "小型任務" [--project <git-root>]
  aicoding-mate read-run <record.json>
  aicoding-mate pane

說明:
  install  安裝 Bun dependencies。
  link     將目前工作目錄註冊成 Herdr local plugin。
  open     從 Herdr 開啟 AI Coding Mate 診斷 pane。
  doctor   從 runtime 實際讀回 Herdr、Firstmate、Codex、Claude、git、gh、jq、Bun 狀態。
  bootstrap-firstmate 取得 pinned Firstmate distro 並建立隔離 FM_HOME。
  quick    啟動 Firstmate-on-Herdr Quick run；四項 read-back 缺一就 fail closed。
  read-run 重新讀取 durable run record 並檢查 pane/result 一致性。
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
