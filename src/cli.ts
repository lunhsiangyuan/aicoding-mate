import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { runDoctor } from "./probe.ts";
import { resolveFirstmateAuthorityRoot } from "./authority/firstmate-decision-authority.ts";
import { renderDoctorText } from "./render.ts";
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
  readStandardRunRecord,
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
import {
  createHighIntensityCliPort,
  probeHighIntensityCliAvailability,
} from "./integration/high-intensity-cli-port.ts";
import {
  createHighIntensityRun,
  readHighIntensityRunRecord,
} from "./integration/high-intensity-runtime.ts";
import { runCodexReviewFromHerdrSelection } from "./integration/codex-review-command.ts";
import {
  buildMateRuntimeRequest,
  containsMateEnvelopeMarker,
  createMateConsoleState,
  parseMateConsoleInput,
  recordMateConsoleTurn,
  renderMateConsoleHelp,
  renderMateConsoleStatus,
  renderMateWorkflowGraph,
  summarizeMateOutput,
  type MateMode,
  type MateRuntimeRequest,
} from "./mate-console.ts";
import type { SourceLineage } from "./contracts/index.ts";

export interface CliIO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AriLaunchContext {
  readonly projectDir: string;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveAriLaunchContext(
  launchCwd: string,
  env: NodeJS.ProcessEnv,
  appRoot = repoRoot(),
): AriLaunchContext {
  const gitRoot = spawnSync(
    "git",
    ["-C", launchCwd, "rev-parse", "--show-toplevel"],
    {
      cwd: launchCwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const detectedProject = gitRoot.status === 0
    ? gitRoot.stdout.trim()
    : "";
  const fellBackToApp = detectedProject.length === 0;
  const projectDir = fellBackToApp
    ? resolve(appRoot)
    : resolve(detectedProject);
  return {
    projectDir,
    env: {
      ...env,
      ACM_STATE_DIR:
        env.ACM_STATE_DIR?.trim()
        || resolve(appRoot, "state", "aicoding-mate"),
      ACM_PROJECT_FALLBACK: fellBackToApp ? "1" : "0",
    },
  };
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
      case "standard":
        return await runStandardCommand(args.slice(1), io);
      case "adversarial":
      case "research":
        return await runHighIntensityCommand(command, args.slice(1), io);
      case "context-branch-start":
        return runContextBranchStartCommand(args.slice(1), io);
      case "codex-review-start":
        return await runCodexReviewStartCommand(args.slice(1), io);
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

async function runCodexReviewStartCommand(
  args: string[],
  io: CliIO,
): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(
      `codex-review-start 不支援額外參數: ${args.join(" ")}\n`,
    );
    return 2;
  }
  const contextJson = io.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!contextJson) {
    io.stderr.write("Codex Review 必須從 Herdr 的選取文字 action 啟動。\n");
    return 1;
  }
  const result = await runCodexReviewFromHerdrSelection({
    contextJson,
    cwd: io.cwd,
    env: io.env,
  });
  if (!result.ok) {
    io.stderr.write(`Codex Review 未建立: ${result.reason}\n`);
    return 1;
  }
  io.stdout.write(
    "Codex native review 已完成並寫入 Review Capsule。\n"
      + `review task: ${result.capsule.codex.reviewThreadId}\n`
      + `capsule: ${result.capsulePath}\n`
      + `Codex UI: ${result.desktopLaunch.status}\n`
      + `deep link: ${result.desktopLaunch.url}\n`,
  );
  return 0;
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

  const lineReader = createPaneLineReader();
  let exitCode: number;
  try {
    exitCode = await conductContextBranchConversation(
      resolve(branchPath),
      original,
      lineReader.read,
      io,
    );
  } finally {
    lineReader.close();
  }
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
    "Ari Context Branch\n\n"
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
  const trustedAuthorityRoot = resolveFirstmateAuthorityRoot(
    stateDir(io),
    io.env,
  );
  const presented = markStandardRunPresented(
    result.record.recordPath,
    conclusion,
    observed,
    trustedAuthorityRoot,
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

type HighIntensityRecipe = "adversarial" | "research";

const defaultHighIntensityQuestions = [
  "哪些需求與限制已被確認？",
  "哪些內容仍只是候選、推論或未知？",
  "有哪些反例、遺漏或錯誤前提會改變決策？",
  "建議的架構決策與下一步是什麼？",
] as const;

async function runHighIntensityCommand(
  recipe: HighIntensityRecipe,
  args: string[],
  io: CliIO,
): Promise<number> {
  const parsed = parseHighIntensityInput(recipe, args, io);
  if (!parsed.ok) return 2;
  const availability = probeHighIntensityCliAvailability({
    cwd: parsed.projectDir,
    env: io.env,
  });
  const result = await createHighIntensityRun({
    input: {
      task: parsed.task,
      subquestions: parsed.questions,
      configVersionHash: `${recipe}-v0.2`,
    },
    availability,
    stateDir: stateDir(io),
    projectDir: parsed.projectDir,
    env: io.env,
    recipe,
    source: highIntensitySource(io.env),
    modelPort: createHighIntensityCliPort({
      cwd: parsed.projectDir,
      env: io.env,
    }),
  });
  const trustedAuthorityRoot = resolveFirstmateAuthorityRoot(
    stateDir(io),
    io.env,
  );
  const readBack = readHighIntensityRunRecord(
    result.record.recordPath,
    trustedAuthorityRoot,
  );
  if (!result.ok || readBack === undefined || readBack.status !== "completed") {
    io.stdout.write(
      `BLOCKED: ${result.record.blockers.join("; ") || "durable_readback_failed"}\n`
        + `evidence: ${result.record.recordPath}\n`,
    );
    return 1;
  }
  const report = readBack.report;
  if (report === null) {
    io.stdout.write(
      `BLOCKED: decision_ready_report_missing\n`
        + `evidence: ${readBack.recordPath}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `${recipe === "adversarial" ? "對抗式架構審查" : "Recall-first 研究"}\n\n`
      + `結論：${report.mainReport.conclusion}\n`
      + `影響：${report.mainReport.impact}\n`
      + `下一步：${report.mainReport.nextAction}\n\n`
      + `證據層：${readBack.recordPath}\n`,
  );
  return 0;
}

function highIntensitySource(
  env: NodeJS.ProcessEnv,
): SourceLineage | undefined {
  const taskId = env.ACM_SOURCE_TASK_ID ?? env.HERDR_TASK_ID;
  const runId = env.ACM_SOURCE_RUN_ID ?? env.HERDR_RUN_ID;
  const workspace = env.HERDR_WORKSPACE_ID;
  const tabId = env.HERDR_TAB_ID;
  const paneId = env.HERDR_PANE_ID;
  if (!taskId || !runId || !workspace || !tabId || !paneId) return undefined;
  return {
    taskId,
    runId,
    workspace,
    tabId,
    paneId,
  };
}

function parseHighIntensityInput(
  recipe: HighIntensityRecipe,
  args: string[],
  io: CliIO,
):
  | {
      readonly ok: true;
      readonly task: string;
      readonly projectDir: string;
      readonly questions: readonly string[];
    }
  | { readonly ok: false } {
  let projectDir = io.cwd;
  const taskParts: string[] = [];
  const questions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task" || arg === "--question" || arg === "--project") {
      const value = args[index + 1];
      if (!value) {
        io.stderr.write(`${recipe} 的 ${arg} 需要值。\n`);
        return { ok: false };
      }
      if (arg === "--task") taskParts.push(value);
      if (arg === "--question") questions.push(value.trim());
      if (arg === "--project") projectDir = resolve(io.cwd, value);
      index += 1;
    } else if (arg.startsWith("--")) {
      io.stderr.write(`${recipe} 不支援的參數: ${arg}\n`);
      return { ok: false };
    } else {
      taskParts.push(arg);
    }
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    io.stderr.write(`${recipe} 需要任務文字。\n`);
    return { ok: false };
  }
  if (containsMateEnvelopeMarker(task)) {
    io.stderr.write(`${recipe} 的任務包含保留的 Mate context marker。\n`);
    return { ok: false };
  }
  const selectedQuestions = questions.filter((question) => question.length > 0);
  return {
    ok: true,
    task,
    projectDir,
    questions:
      selectedQuestions.length > 0
        ? selectedQuestions
        : defaultHighIntensityQuestions,
  };
}

function stateDir(io: CliIO): string {
  return io.env.ACM_STATE_DIR
    ? resolve(io.cwd, io.env.ACM_STATE_DIR)
    : resolve(io.cwd, "state", "aicoding-mate");
}

async function runQuickCommand(
  args: string[],
  io: CliIO,
): Promise<number> {
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
  if (containsMateEnvelopeMarker(task)) {
    io.stderr.write(`${command} 的任務包含保留的 Mate context marker。\n`);
    return { ok: false };
  }
  return { ok: true, task, projectDir };
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
  const recordPath = resolve(io.cwd, args[0]);
  const quickRecord = readRunRecord(recordPath);
  if (quickRecord) {
    const consistency = {
      ok: false,
      reason: "quick_record_historical_unverified",
    };
    io.stdout.write(
      `${JSON.stringify({ record: quickRecord, consistency }, null, 2)}\n`,
    );
    return 1;
  }
  const trustedAuthorityRoot = resolveFirstmateAuthorityRoot(
    stateDir(io),
    io.env,
  );
  const standardRecord = readStandardRunRecord(
    recordPath,
    trustedAuthorityRoot,
  );
  if (standardRecord) {
    const consistency = {
      ok:
        standardRecord.status === "completed"
        && standardRecord.claims.reportReadbackMatchesPane,
      reason:
        standardRecord.status !== "completed"
          ? `standard_status_${standardRecord.status}`
          : standardRecord.claims.reportReadbackMatchesPane
          ? null
          : "standard_pane_readback_missing",
    };
    io.stdout.write(
      `${JSON.stringify({ record: standardRecord, consistency }, null, 2)}\n`,
    );
    return consistency.ok ? 0 : 1;
  }
  const highIntensityRecord = readHighIntensityRunRecord(
    recordPath,
    trustedAuthorityRoot,
  );
  if (highIntensityRecord) {
    const consistency = {
      ok: highIntensityRecord.status === "completed",
      reason:
        highIntensityRecord.status === "completed"
          ? null
          : `high_intensity_status_${highIntensityRecord.status}`,
    };
    io.stdout.write(
      `${JSON.stringify(
        { record: highIntensityRecord, consistency },
        null,
        2,
      )}\n`,
    );
    return consistency.ok ? 0 : 1;
  }
  io.stderr.write(`無法讀取 run record: ${args[0]}\n`);
  return 1;
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
  const lineReader = createPaneLineReader();
  try {
    return await conductMateConsole(io, lineReader.read);
  } finally {
    lineReader.close();
  }
}

export async function conductMateConsole(
  io: CliIO,
  question: () => Promise<string>,
  dispatch: (
    mode: MateMode,
    request: MateRuntimeRequest,
    io: CliIO,
  ) => Promise<number> = dispatchMateTask,
): Promise<number> {
  let state = createMateConsoleState(io.env.ACM_INITIAL_MODE);
  const once = io.env.ACM_PANE_ONCE === "1";
  io.stdout.write(
    "Ari\n"
      + `目前模式：${state.mode}。直接輸入需求，或輸入 /help 查看切換方式。\n`
      + `目前專案：${io.cwd}`
      + (io.env.ACM_PROJECT_FALLBACK === "1"
        ? "（啟動位置不是 git checkout，使用 Ari repository）"
        : "")
      + "\n",
  );

  while (true) {
    io.stdout.write(`\n[${state.mode}] > `);
    let input: string;
    try {
      input = await question();
    } catch (error) {
      if (
        error instanceof Error
        && ["pane_input_closed", "pane_input_cancelled"].includes(error.message)
      ) {
        io.stdout.write("\nAri 已離開。\n");
        return 0;
      }
      throw error;
    }

    const action = parseMateConsoleInput(state, input);
    state = action.state;
    if (action.kind === "quit") {
      io.stdout.write("Ari 已離開。\n");
      return 0;
    }
    if (action.kind === "noop") {
      if (once) return 0;
      continue;
    }
    if (action.kind === "help") {
      io.stdout.write(`${renderMateConsoleHelp()}\n`);
      if (once) return 0;
      continue;
    }
    if (action.kind === "status") {
      io.stdout.write(`${renderMateConsoleStatus(state)}\n`);
      if (once) return 0;
      continue;
    }
    if (action.kind === "doctor") {
      const report = runDoctor({ cwd: io.cwd, env: io.env });
      io.stdout.write(renderDoctorText(report));
      if (once) return report.summary.ready ? 0 : 1;
      continue;
    }
    if (action.kind === "error") {
      io.stderr.write(`${action.message}。輸入 /help 查看可用指令。\n`);
      if (once) return 2;
      continue;
    }
    if (action.kind === "mode_changed") {
      io.stdout.write(
        `已切換到 ${state.mode}；接著直接輸入需求即可。\n`,
      );
      if (once) return 0;
      continue;
    }

    io.stdout.write(`\n${renderMateWorkflowGraph(action.mode)}\n\n`);
    const captured = captureMateOutput(io);
    const request = buildMateRuntimeRequest(state, action.mode, action.task);
    let exitCode: number;
    try {
      exitCode = await dispatch(
        action.mode,
        request,
        captured.io,
      );
    } catch (error) {
      exitCode = 1;
      io.stderr.write(
        `本輪執行失敗：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    const summary = summarizeMateOutput(captured.read());
    state = recordMateConsoleTurn(
      state,
      action.task,
      exitCode === 0 ? summary : `未完成：${summary}`,
    );
    io.stdout.write(
      `\n已保留本次摘要供同一 pane 繼續追問；${renderMateConsoleStatus(state)}\n`,
    );
    if (once) return exitCode;
  }
}

export interface MateWorkflowRunners {
  readonly quick: (task: string, io: CliIO) => Promise<number>;
  readonly standard: (task: string, io: CliIO) => Promise<number>;
  readonly highIntensity: (
    recipe: HighIntensityRecipe,
    task: string,
    io: CliIO,
  ) => Promise<number>;
}

const defaultMateWorkflowRunners: MateWorkflowRunners = {
  quick: async (task, io) => await runQuickCommand(["--task", task], io),
  standard: async (task, io) =>
    await runStandardCommand(["--task", task], io),
  highIntensity: async (recipe, task, io) =>
    await runHighIntensityCommand(recipe, ["--task", task], io),
};

export async function dispatchMateTask(
  mode: MateMode,
  request: MateRuntimeRequest,
  io: CliIO,
  runners: MateWorkflowRunners = defaultMateWorkflowRunners,
): Promise<number> {
  const task = request.currentTask;
  if (mode === "quick") {
    return await runners.quick(task, io);
  }
  if (mode === "expert") {
    return await runners.highIntensity("adversarial", task, io);
  }
  if (mode === "research") {
    return await runners.highIntensity("research", task, io);
  }
  return await runners.standard(task, io);
}

function captureMateOutput(io: CliIO): {
  readonly io: CliIO;
  readonly read: () => string;
} {
  let output = "";
  return {
    io: {
      ...io,
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return io.stdout.write(chunk);
        },
      },
    },
    read: () => output,
  };
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
    if (!installAriLauncher(io)) return 1;
    io.stdout.write("Herdr plugin 已 link。下一步: 在 Herdr shell 輸入 `Ari`。\n");
  }
  return result.status ?? 1;
}

function installAriLauncher(io: CliIO): boolean {
  const configuredDir = io.env.ACM_USER_BIN_DIR?.trim();
  const homeDir = io.env.HOME?.trim();
  if (!configuredDir && !homeDir) {
    io.stderr.write("無法安裝 Ari launcher：找不到使用者目錄。\n");
    return false;
  }
  const binDir = configuredDir
    ? resolve(io.cwd, configuredDir)
    : resolve(homeDir ?? "", ".local", "bin");
  const launcherPath = resolve(binDir, "Ari");
  const launcherTarget = resolve(repoRoot(), "bin", "Ari");
  mkdirSync(binDir, { recursive: true });
  try {
    symlinkSync(launcherTarget, launcherPath);
  } catch {
    const existingTarget = (() => {
      try {
        if (!lstatSync(launcherPath).isSymbolicLink()) return undefined;
        return resolve(dirname(launcherPath), readlinkSync(launcherPath));
      } catch {
        return undefined;
      }
    })();
    if (existingTarget !== launcherTarget) {
      io.stderr.write(
        `無法安裝 Ari launcher：${launcherPath} 已存在且不是目前 repository。\n`,
      );
      return false;
    }
  }
  io.stdout.write(`Ari launcher 已就緒：${launcherPath}\n`);
  return true;
}

function runOpenCommand(args: string[], io: CliIO): number {
  let placement = "overlay";
  let focus = true;
  let mode: MateMode = "standard";
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
    } else if (arg === "--mode") {
      const value = args[index + 1];
      const parsed = createMateConsoleState(value);
      if (
        !value
        || !["quick", "standard", "expert", "research", "learn"].includes(
          value.toLowerCase(),
        )
      ) {
        io.stderr.write(
          "open 的 --mode 必須是 quick|standard|expert|research|learn。\n",
        );
        return 2;
      }
      mode = parsed.mode;
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
    "mate",
    "--placement",
    placement,
    "--env",
    "ACM_OPENED_BY=aicoding-mate",
    "--env",
    `ACM_INITIAL_MODE=${mode}`,
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
  return `Ari CLI

用法:
  aicoding-mate install
  aicoding-mate link [--disabled]
  aicoding-mate open [--mode quick|standard|expert|research|learn] [--placement overlay|popup|split|tab|zoomed] [--no-focus]
  aicoding-mate doctor [--json]
  aicoding-mate bootstrap-firstmate

進階／automation:
  aicoding-mate quick --task "小型任務" [--project <git-root>]
  aicoding-mate standard --task "架構目標" [--project <git-root>]
  aicoding-mate adversarial --task "高風險架構判斷" [--question "子問題"] [--project <git-root>]
  aicoding-mate research --task "Recall-first 研究目標" [--question "子問題"] [--project <git-root>]
  aicoding-mate context-branch-start
  aicoding-mate codex-review-start
  aicoding-mate read-run <record.json>
  aicoding-mate pane

說明:
  install  安裝 Bun dependencies。
  link     將目前工作目錄註冊成 Herdr local plugin。
  open     相容入口；預設以 overlay 開啟 Ari。主要入口是在 Herdr shell 輸入 Ari。
  doctor   從 runtime 實際讀回 Herdr、Firstmate、Codex、Claude、git、gh、jq、Bun 狀態。
  bootstrap-firstmate 取得 pinned Firstmate distro 並建立隔離 FM_HOME。
  quick    啟動 Firstmate-on-Herdr Quick run；四項 read-back 缺一就 fail closed。
  standard 由 Firstmate/Codex 產出架構方案，再由 Claude 跨 family review。
  adversarial 由 Author、Challenger 與獨立 Judge 進行最多兩輪對抗式審查。
  research 保留 discovery 分母、成熟度與 coverage，再交由跨模型 Judge 裁決。
  context-branch-start 從 Herdr 選取內容建立同 lineage 分支，複誦確認後送回來源任務。
  codex-review-start 從 Herdr 選取內容建立 detached Codex review；UI request 與 review 完成狀態分開回報。
  read-run 驗證受簽章的 managed record；Quick 歷史 record 只供閱讀，不標示 verified。
  pane     Herdr plugin 單一互動入口；支援 /quick、/standard、/expert、/research、/learn。
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

function createPaneLineReader(): {
  readonly read: () => Promise<string>;
  readonly close: () => void;
} {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const lines = prompt[Symbol.asyncIterator]();
    return {
      read: async () => {
        const next = await lines.next();
        if (next.done) throw new Error("pane_input_closed");
        return next.value;
      },
      close: () => prompt.close(),
    };
  }

  return {
    read: readTtyPaneLine,
    close: () => undefined,
  };
}

async function readTtyPaneLine(): Promise<string> {
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
