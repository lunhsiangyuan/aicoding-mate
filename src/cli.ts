import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  createStandardRun,
  markStandardRunPresented,
  renderStandardText,
} from "./integration/standard-runtime.ts";
import {
  chooseDeeperResearch,
  confirmBranchRecitation,
  reciteBranchReturn,
  sendConfirmedBranchCapsule,
  setBranchReturnInstruction,
} from "./branch/index.ts";
import {
  createDefaultBranchClassifier,
  createDefaultBranchRegistry,
  createDefaultBranchResearcher,
  createDefaultCapsuleInjectionPort,
  readBranchSession,
  startContextBranch,
  writeBranchSession,
} from "./integration/context-branch-runtime.ts";

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
      case "standard":
        return await runStandardCommand(args.slice(1), io);
      case "standard-pane":
        return await runStandardPaneCommand(args.slice(1), io);
      case "context-branch-start":
        return runContextBranchStartCommand(args.slice(1), io);
      case "context-branch-pane":
        return await runContextBranchPaneCommand(args.slice(1), io);
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

function runContextBranchStartCommand(args: string[], io: CliIO): number {
  if (args.length > 0) {
    io.stderr.write(
      `context-branch-start 不支援額外參數: ${args.join(" ")}\n`,
    );
    return 2;
  }
  const contextJson = io.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!contextJson) {
    io.stderr.write(
      "Context Branch 必須從 Herdr 的選取文字 action 啟動。\n",
    );
    return 1;
  }
  const result = startContextBranch({
    contextJson,
    cwd: io.cwd,
    env: io.env,
  });
  if (!result.ok) {
    io.stderr.write(`Context Branch 未建立: ${result.reason}\n`);
    return 1;
  }
  io.stdout.write(
    `Context Branch 已建立並綁定來源 Firstmate session：${result.session.firstmateSessionRef}\n`,
  );
  return 0;
}

async function runContextBranchPaneCommand(
  args: string[],
  io: CliIO,
): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(
      `context-branch-pane 不支援額外參數: ${args.join(" ")}\n`,
    );
    return 2;
  }
  const branchPath = io.env.ACM_BRANCH_PATH;
  if (!branchPath) {
    io.stderr.write("Context Branch pane 缺少 ACM_BRANCH_PATH。\n");
    return 1;
  }
  const original = readBranchSession(resolve(branchPath));
  if (!original) {
    io.stderr.write(`無法讀取 Context Branch: ${branchPath}\n`);
    return 1;
  }

  const exitCode = await conductContextBranchConversation(
    resolve(branchPath),
    original,
    askPaneLine,
    io,
  );
  if (io.env.HERDR_ENV === "1" && io.env.ACM_PANE_ONCE !== "1") {
    io.stdout.write(
      "\nContext Branch pane 保持開啟，方便檢查回送結果；關閉此 pane 即可離開。\n",
    );
    await keepPaneOpen();
  }
  return exitCode;
}

async function conductContextBranchConversation(
  branchPath: string,
  initialSession: NonNullable<ReturnType<typeof readBranchSession>>,
  question: () => Promise<string>,
  io: CliIO,
): Promise<number> {
  const now = () => new Date().toISOString();
  let session = initialSession;
  io.stdout.write(
    "AI Coding Mate Context Branch\n\n"
      + `簡介：${session.brief ?? "尚無簡介"}\n\n`
      + "輸入 d 可先做較深入的技術研究；直接按 Enter 則準備帶回主對話。\n> ",
  );
  const choice = (await question()).trim().toLowerCase();
  if (choice === "d") {
    const researched = chooseDeeperResearch(
      session,
      "deeper",
      createDefaultBranchResearcher(io.cwd, io.env),
      now,
    );
    if (!researched.ok) {
      io.stderr.write(`深入研究未完成: ${researched.reason}\n`);
      return 1;
    }
    session = writeBranchSession(branchPath, researched.value);
    io.stdout.write(
      `\n深入研究：${session.privateResearch.at(-1)?.summary ?? "無結果"}\n`,
    );
  }

  io.stdout.write(
    "\n請告訴我帶回主對話後要做什麼，例如「建立新的 review 任務」或「修改原任務的報告格式」。\n> ",
  );
  const instructed = setBranchReturnInstruction(
    session,
    await question(),
    now,
  );
  if (!instructed.ok) {
    io.stderr.write(`無法記錄帶回指示: ${instructed.reason}\n`);
    return 1;
  }
  session = writeBranchSession(branchPath, instructed.value);

  const recited = reciteBranchReturn(
    session,
    createDefaultBranchRegistry(session, io.cwd, io.env),
    createDefaultBranchClassifier(io.cwd, io.env),
    now,
  );
  if (!recited.ok) {
    io.stderr.write(`無法準備回送: ${recited.reason}\n`);
    return 1;
  }
  session = writeBranchSession(branchPath, recited.value);
  io.stdout.write(
    `\n最後複誦：${session.recitation}\n\n`
      + "只有輸入「確認」才會送回來源主對話；其他輸入都不會送出。\n> ",
  );
  const answer = (await question()).trim();
  const confirmation = confirmBranchRecitation(
    session,
    {
      confirmed: answer === "確認",
      confirmationId: answer === "確認" ? `confirm-${randomUUID()}` : "declined",
    },
    now,
  );
  if (!confirmation.ok) {
    io.stderr.write(`確認失敗: ${confirmation.reason}\n`);
    return 1;
  }
  session = writeBranchSession(branchPath, confirmation.value);
  if (answer !== "確認") {
    io.stdout.write("未確認，Context Branch 已結束，沒有送回主對話。\n");
    return 0;
  }

  const sent = await sendConfirmedBranchCapsule(
    session,
    createDefaultCapsuleInjectionPort(io.cwd, io.env),
    now,
  );
  if (!sent.ok) {
    io.stderr.write(`回送失敗: ${sent.reason}\n`);
    return 1;
  }
  writeBranchSession(branchPath, sent.value);
  io.stdout.write(
    `已送回來源 Firstmate session：${sent.value.firstmateSessionRef}\n`,
  );
  return 0;
}

async function runStandardCommand(
  args: string[],
  io: CliIO,
): Promise<number> {
  const parsed = parseTaskAndProject("standard", args, io);
  if (!parsed.ok) return 2;
  const result = await createStandardRun({
    task: parsed.task,
    cwd: io.cwd,
    projectDir: parsed.projectDir,
    env: io.env,
  });
  const rendered = renderStandardText(result);
  io.stdout.write(rendered);
  const conclusion = result.record.report?.mainReport.conclusion;
  const sourcePaneId = result.record.source.paneId;
  if (!result.ok || !conclusion || !sourcePaneId) return 1;
  const observed = readPaneUntilContains(
    sourcePaneId,
    conclusion,
    io.cwd,
    io.env,
  );
  if (!observed) {
    io.stderr.write(
      "Standard 報告已輸出，但來源 Herdr pane 未讀回同一結論；read-back claim 保持 false。\n",
    );
    return 1;
  }
  const presented = markStandardRunPresented(
    result.record.recordPath,
    conclusion,
    observed,
  );
  if (!presented) {
    io.stderr.write("Standard durable report 與 pane read-back 不一致。\n");
    return 1;
  }
  io.stdout.write(
    `final claims: firstmate=${presented.claims.authorCompletedInFirstmate}`
      + ` review=${presented.claims.independentReviewCompleted}`
      + ` report=${presented.claims.reportDecisionReady}`
      + ` readback=${presented.claims.reportReadbackMatchesPane}\n`,
  );
  return 0;
}

async function runStandardPaneCommand(
  args: string[],
  io: CliIO,
): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(`standard-pane 不支援額外參數: ${args.join(" ")}\n`);
    return 2;
  }
  const reviewDescription = io.env.ACM_CLAUDE_REVIEW_DISABLED === "1"
    ? "再由 Codex 進行顯式同家族降級 review"
    : "再交給 Claude 獨立跨模型 review";
  io.stdout.write(
    "AI Coding Mate Standard\n"
      + "請描述目標與邊界；系統會由 Firstmate/Codex 產出架構方案，"
      + reviewDescription
      + "：\n> ",
  );
  const task = (await askPaneLine()).trim();
  if (!task) {
    io.stderr.write("任務不可為空。\n");
    return 2;
  }
  const exitCode = await runStandardCommand(["--task", task], io);
  if (io.env.HERDR_ENV === "1" && io.env.ACM_PANE_ONCE !== "1") {
    io.stdout.write(
      "\nStandard pane 保持開啟，方便回讀報告；關閉此 pane 即可離開。\n",
    );
    await keepPaneOpen();
  }
  return exitCode;
}

async function runQuickCommand(args: string[], io: CliIO): Promise<number> {
  const parsed = parseTaskAndProject("quick", args, io);
  if (!parsed.ok) return 2;
  const result = createQuickRun({
    task: parsed.task,
    cwd: io.cwd,
    projectDir: parsed.projectDir,
    env: io.env,
  });
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

function parseTaskAndProject(
  command: "quick" | "standard",
  args: string[],
  io: CliIO,
):
  | { readonly ok: true; readonly task: string; readonly projectDir: string }
  | { readonly ok: false } {
  let projectDir = io.cwd;
  const taskParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task") {
      const value = args[index + 1];
      if (!value) {
        io.stderr.write(`${command} 的 --task 需要文字。\n`);
        return { ok: false };
      }
      taskParts.push(value);
      index += 1;
    } else if (arg === "--project") {
      const value = args[index + 1];
      if (!value) {
        io.stderr.write(`${command} 的 --project 需要路徑。\n`);
        return { ok: false };
      }
      projectDir = resolve(io.cwd, value);
      index += 1;
    } else if (arg.startsWith("--")) {
      io.stderr.write(`${command} 不支援的參數: ${arg}\n`);
      return { ok: false };
    } else {
      taskParts.push(arg);
    }
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    io.stderr.write(
      `${command} 需要任務文字，例如：aicoding-mate ${command} --task "分析目前架構"。\n`,
    );
    return { ok: false };
  }
  return { ok: true, task, projectDir };
}

async function runQuickPaneCommand(args: string[], io: CliIO): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(`quick-pane 不支援額外參數: ${args.join(" ")}\n`);
    return 2;
  }
  io.stdout.write("AI Coding Mate Quick\n請輸入一個明確唯讀的檢查、搜尋、摘要、解釋或 review 任務：\n> ");
  const task = (await askPaneLine()).trim();
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
      if (
        !value ||
        !["doctor", "quick", "standard", "context-branch"].includes(value)
      ) {
        io.stderr.write(
          "open 的 --entrypoint 必須是 doctor|quick|standard|context-branch。\n",
        );
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
  aicoding-mate open [--entrypoint doctor|quick|standard|context-branch] [--placement overlay|popup|split|tab|zoomed] [--no-focus]
  aicoding-mate doctor [--json]
  aicoding-mate bootstrap-firstmate
  aicoding-mate quick --task "小型任務" [--project <git-root>]
  aicoding-mate standard --task "架構目標" [--project <git-root>]
  aicoding-mate context-branch-start
  aicoding-mate read-run <record.json>
  aicoding-mate pane

說明:
  install  安裝 Bun dependencies。
  link     將目前工作目錄註冊成 Herdr local plugin。
  open     從 Herdr 開啟 AI Coding Mate 診斷 pane。
  doctor   從 runtime 實際讀回 Herdr、Firstmate、Codex、Claude、git、gh、jq、Bun 狀態。
  bootstrap-firstmate 取得 pinned Firstmate distro 並建立隔離 FM_HOME。
  quick    啟動 Firstmate-on-Herdr Quick run；四項 read-back 缺一就 fail closed。
  standard 由 Firstmate/Codex 產出架構方案，再由 Claude 跨 family review。
  context-branch-start 從 Herdr 選取內容建立同 lineage 分支，複誦確認後送回來源任務。
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

async function askPaneLine(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await prompt.question("");
    } finally {
      prompt.close();
    }
  }

  const input = process.stdin;
  const wasRaw = input.isRaw;
  return await new Promise<string>((resolveLine, rejectLine) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onInputClosed);
      input.off("close", onInputClosed);
      if (!input.destroyed) {
        input.setRawMode(Boolean(wasRaw));
        input.pause();
      }
    };
    const rejectInput = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectLine(new Error(reason));
    };
    const onInputClosed = () => {
      rejectInput("pane_input_closed");
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          if (settled) return;
          settled = true;
          process.stdout.write("\n");
          cleanup();
          resolveLine(value);
          return;
        }
        if (character === "\u0003") {
          rejectInput("pane_input_cancelled");
          return;
        }
        if (character === "\u0004") {
          rejectInput("pane_input_closed");
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const codePoints = Array.from(value);
          if (codePoints.length > 0) {
            codePoints.pop();
            value = codePoints.join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write(character);
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    input.once("end", onInputClosed);
    input.once("close", onInputClosed);
  });
}
