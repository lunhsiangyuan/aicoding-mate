import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const pinnedFirstmateRef = "e595611291247368b982eb729097c54f2b45aa78";
const firstmateRepo = "https://github.com/kunchenguid/firstmate";

export type QuickStatus = "blocked" | "running" | "completed" | "failed";

export interface QuickRunRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  recipe: "quick";
  status: QuickStatus;
  source: {
    paneId?: string;
  };
  firstmateRoot: string;
  fmHome: string;
  herdr: {
    backend: "herdr";
    session: string;
    primaryPaneId?: string;
  };
  worker: {
    taskId: string;
    harness: "codex";
    kind: "scout";
    paneId?: string;
    target?: string;
  };
  controlChannel: {
    outbound: "fm-brief+fm-spawn";
    inbound: "fm-peek+report";
    sourcePaneId?: string;
    workerTarget?: string;
  };
  paneSummary?: string;
  result?: {
    summary: string;
    readBackAt: string;
  };
  blockers: string[];
  evidence?: {
    brief: string;
    firstmateMeta: string;
    firstmateStatus: string;
    scoutReport: string;
    herdrPaneId?: string;
    observedAt?: string;
  };
  claims: {
    firstmatePrimaryInHerdr: boolean;
    workerVisible: boolean;
    resultReturnedToPane: boolean;
    recordReadbackMatchesPane: boolean;
  };
  recordPath?: string;
}

export interface QuickOptions {
  task: string;
  cwd: string;
  projectDir?: string;
  env: NodeJS.ProcessEnv;
  idempotencyKey?: string;
  now?: () => string;
  maxPolls?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => void;
}

export interface QuickResult {
  ok: boolean;
  record: QuickRunRecord;
  stdout: string;
  stderr: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface BootstrapResult {
  cloneReady: boolean;
  toolchainReady: boolean;
  firstmateRoot: string;
  firstmateRef?: string;
  fmHome: string;
  stateDir: string;
  blockers: string[];
}

export interface BootstrapOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function bootstrapFirstmate(options: BootstrapOptions): BootstrapResult {
  const stateDir = resolveStateDir(options.cwd, options.env);
  const firstmateRoot = resolveFirstmateRoot(options.cwd, options.env);
  const fmHome = join(stateDir, "fm-home");
  const blockers: string[] = [];
  prepareHerdrPathAdapter(stateDir, options.env);
  prepareCodexSandboxAdapter(stateDir, options.env);
  const runtimeEnv = withLocalToolchainPath(stateDir, options.env);
  const git = findOnPath("git", runtimeEnv.PATH ?? "");

  if (!directoryExists(firstmateRoot)) {
    if (!git) {
      blockers.push("缺少 git，無法 bootstrap Firstmate distro。");
    } else {
      mkdirSync(dirname(firstmateRoot), { recursive: true });
      const clone = run(
        git,
        ["clone", "--no-checkout", firstmateRepo, firstmateRoot],
        { cwd: options.cwd, env: runtimeEnv },
      );
      if (clone.status !== 0) {
        blockers.push(`Firstmate clone 失敗：${compactFailure(clone)}`);
      } else {
        const checkout = run(
          git,
          ["-C", firstmateRoot, "checkout", "--detach", pinnedFirstmateRef],
          { cwd: options.cwd, env: runtimeEnv },
        );
        if (checkout.status !== 0) blockers.push(`Firstmate pin checkout 失敗：${compactFailure(checkout)}`);
      }
    }
  }

  prepareFirstmateHome(fmHome);
  const distroBlockers = validatePinnedDistro(firstmateRoot, runtimeEnv);
  blockers.push(...distroBlockers);
  const firstmateRef = distroBlockers.length === 0
    ? firstLine(run("git", ["-C", firstmateRoot, "rev-parse", "HEAD"], { cwd: options.cwd, env: runtimeEnv }).stdout)
    : undefined;
  const toolchainBlockers = preflightToolchain(firstmateRoot, runtimeEnv);

  return {
    cloneReady: distroBlockers.length === 0,
    toolchainReady: toolchainBlockers.length === 0,
    firstmateRoot,
    firstmateRef,
    fmHome,
    stateDir,
    blockers: [...blockers, ...toolchainBlockers],
  };
}

export function createQuickRun(options: QuickOptions): QuickResult {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const stateDir = resolveStateDir(options.cwd, options.env);
  prepareHerdrPathAdapter(stateDir, options.env);
  prepareCodexSandboxAdapter(stateDir, options.env);
  const runtimeEnv = withLocalToolchainPath(stateDir, options.env);
  const runId = options.idempotencyKey
    ? quickRunIdForIdempotencyKey(options.idempotencyKey)
    : `quick-${compactTimestamp(createdAt)}`;
  const fmHome = join(stateDir, "fm-home");
  const firstmateRoot = resolveFirstmateRoot(options.cwd, options.env);
  const projectDir = resolve(options.projectDir ?? options.cwd);
  const recordPath = join(stateDir, "runs", `${runId}.json`);
  const codexAdapter = join(stateDir, "toolchain", "bin", "codex");
  const evidence = {
    brief: join(fmHome, "data", runId, "brief.md"),
    firstmateMeta: join(fmHome, "state", `${runId}.meta`),
    firstmateStatus: join(fmHome, "state", `${runId}.status`),
    scoutReport: join(fmHome, "data", runId, "report.md"),
  };
  const baseRecord: QuickRunRecord = {
    schemaVersion: 1,
    id: runId,
    createdAt,
    updatedAt: createdAt,
    task: options.task,
    recipe: "quick",
    status: "blocked",
    source: {
      paneId: options.env.ACM_QUICK_SOURCE_PANE ?? options.env.HERDR_PANE_ID,
    },
    firstmateRoot,
    fmHome,
    herdr: {
      backend: "herdr",
      session: options.env.ACM_HERDR_SESSION ?? options.env.HERDR_SESSION ?? "default",
    },
    worker: {
      taskId: runId,
      harness: "codex",
      kind: "scout",
    },
    controlChannel: {
      outbound: "fm-brief+fm-spawn",
      inbound: "fm-peek+report",
      sourcePaneId: options.env.ACM_QUICK_SOURCE_PANE ?? options.env.HERDR_PANE_ID,
    },
    blockers: [],
    evidence,
    claims: {
      firstmatePrimaryInHerdr: false,
      workerVisible: false,
      resultReturnedToPane: false,
      recordReadbackMatchesPane: false,
    },
    recordPath,
  };
  const existing = readRunRecord(recordPath);
  if (existing && reusableIdempotentQuickRecord(existing)) {
    return {
      ok: true,
      record: existing,
      stdout: existing.result.summary,
      stderr: "",
    };
  }

  const preflight = preflightRuntime(firstmateRoot, projectDir, runtimeEnv);
  if (!baseRecord.source.paneId) {
    preflight.push("Quick 必須從 Herdr pane 啟動；請執行 `aicoding-mate open --entrypoint quick`。");
  } else if (!herdrHasPane(baseRecord.source.paneId, runtimeEnv, firstmateRoot)) {
    preflight.push(`來源 Herdr pane ${baseRecord.source.paneId} 不存在；拒絕在無法回傳結果的情況下派工。`);
  }
  const taskScopeBlocker = validateQuickTaskScope(options.task, projectDir);
  if (taskScopeBlocker) preflight.push(taskScopeBlocker);
  if (!existsSync(codexAdapter)) {
    preflight.push("Codex sandbox adapter 建立失敗；拒絕使用 Firstmate upstream 的 full-access launch。");
  }
  if (preflight.length > 0) {
    const record = writeRecord({
      ...baseRecord,
      blockers: preflight,
      updatedAt: now(),
    });
    return { ok: false, record, stdout: "", stderr: preflight.join("\n") };
  }

  prepareFirstmateHome(fmHome);
  const env = {
    ...runtimeEnv,
    FM_HOME: fmHome,
    FM_BACKEND: "herdr",
    FIRSTMATE_ROOT: firstmateRoot,
    ACM_FIRSTMATE_ROOT: firstmateRoot,
    HERDR_SESSION: baseRecord.herdr.session,
  };

  registerProject(fmHome, projectDir, createdAt);
  const brief = run(
    join(firstmateRoot, "bin", "fm-brief.sh"),
    [runId, basename(projectDir), "--scout"],
    { cwd: firstmateRoot, env },
  );
  if (brief.status !== 0) {
    return blockedResult(baseRecord, now, `Firstmate brief 建立失敗：${compactFailure(brief)}`);
  }
  fillBrief(evidence.brief, options.task);

  const codexLaunch =
    `${codexAdapter} --dangerously-bypass-approvals-and-sandbox `
    + '-c "notify=[\\"bash\\",\\"-c\\",\\"touch __TURNEND__\\"]" '
    + '"$(__OPINPUT__ encode launch-brief < __BRIEF__)"';
  const spawn = run(
    join(firstmateRoot, "bin", "fm-spawn.sh"),
    [runId, projectDir, codexLaunch, "--backend", "herdr", "--scout"],
    { cwd: firstmateRoot, env },
  );
  if (spawn.status !== 0) {
    return blockedResult(
      baseRecord,
      now,
      `Firstmate worker 啟動失敗：${compactFailure(spawn)}；請執行 `
      + "`aicoding-mate bootstrap-firstmate` 修正 blockers 後重試，並只檢查錯誤訊息指定的 task pane。",
    );
  }

  const completed = observeQuickRun(baseRecord, env, options, now);
  return {
    ok: completed.status === "completed",
    record: completed,
    stdout: completed.result?.summary ?? spawn.stdout,
    stderr: completed.blockers.join("\n"),
  };
}

export function readRunRecord(path: string): QuickRunRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isQuickRunRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function quickRunIdForIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey.trim()) {
    throw new Error("quick_idempotency_key_empty");
  }
  return `quick-idem-${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32)}`;
}

export function markRunPresented(
  path: string,
  presentedSummary: string,
  observedPaneText: string,
): QuickRunRecord | undefined {
  const record = readRunRecord(path);
  if (
    !record
    || record.result?.summary !== presentedSummary
    || !observedPaneText.includes(presentedSummary)
  ) return undefined;
  const updated: QuickRunRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    paneSummary: presentedSummary,
    claims: {
      ...record.claims,
      resultReturnedToPane: true,
      recordReadbackMatchesPane: true,
    },
  };
  return writeRecord(updated);
}

export function verifyPaneRecordConsistency(record: QuickRunRecord): { ok: true } | { ok: false; reason: string } {
  if (!record.paneSummary || !record.result?.summary) {
    return { ok: false, reason: "pane summary 或 durable result 缺失，不能宣稱 Quick 任務完成。" };
  }
  if (record.paneSummary !== record.result.summary) {
    return { ok: false, reason: "pane summary 與 durable run record result 不一致。" };
  }
  if (
    record.status !== "completed"
    || !record.claims.firstmatePrimaryInHerdr
    || !record.claims.workerVisible
    || !record.claims.resultReturnedToPane
    || !record.claims.recordReadbackMatchesPane
  ) {
    return { ok: false, reason: "run 尚未通過來源 pane、worker、presentation 與 durable read-back 四項 gate。" };
  }
  return { ok: true };
}

export function readPaneUntilContains(
  paneId: string,
  expected: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = run(
      "herdr",
      ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "400", "--format", "text"],
      { cwd, env },
    );
    if (read.status === 0 && read.stdout.includes(expected)) return read.stdout;
    sleepSync(100);
  }
  return undefined;
}

export function renderQuickText(result: QuickResult): string {
  const record = result.record;
  const lines = [
    "AI Coding Mate Quick run",
    "",
    `run: ${record.id}`,
    `status: ${record.status}`,
    `record: ${record.recordPath ?? "(not written)"}`,
    `Firstmate: ${record.firstmateRoot}`,
    `FM_HOME: ${record.fmHome}`,
    `Herdr backend: ${record.herdr.backend}`,
    `Herdr session: ${record.herdr.session}`,
  ];
  if (record.herdr.primaryPaneId) lines.push(`primary pane: ${record.herdr.primaryPaneId}`);
  if (record.worker.paneId) lines.push(`worker pane: ${record.worker.paneId}`);
  if (record.result?.summary) lines.push("", "worker result:", record.result.summary);
  if (record.paneSummary) lines.push("", "pane result:", record.paneSummary);
  if (record.blockers.length > 0) lines.push("", "blocked / next:", ...record.blockers.map((blocker) => `- ${blocker}`));
  return `${lines.join("\n")}\n`;
}

function observeQuickRun(
  record: QuickRunRecord,
  env: NodeJS.ProcessEnv,
  options: QuickOptions,
  now: () => string,
): QuickRunRecord {
  const maxPolls = options.maxPolls ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sleep = options.sleep ?? sleepSync;
  const evidence = record.evidence;
  if (!evidence) {
    return writeRecord({
      ...record,
      status: "failed",
      updatedAt: now(),
      blockers: ["run record 缺少 evidence paths，拒絕監看未綁定的 Firstmate task。"],
    });
  }

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const meta = readMeta(evidence.firstmateMeta);
    const status = readOptional(evidence.firstmateStatus);
    const paneId = meta?.herdr_pane_id;
    const paneVisible = paneId ? herdrHasPane(paneId, env, record.firstmateRoot) : false;
    const done = status?.split(/\r?\n/).some((line) => line.startsWith("done:")) ?? false;
    const report = readOptional(evidence.scoutReport)?.trim();

    if (meta && paneId && done && report) {
      const identityOk =
        meta.endpoint_task_id === record.id
        && meta.backend === "herdr"
        && meta.harness === "codex"
        && meta.kind === "scout";
      if (!identityOk) {
        return writeRecord({
          ...record,
          status: "failed",
          updatedAt: now(),
          blockers: ["Firstmate meta 與本次 Quick run identity 不一致，拒絕讀取其他 worker 的結果。"],
        });
      }
      const sourcePaneId = record.source.paneId;
      const sourcePaneVisible = sourcePaneId
        ? herdrHasPane(sourcePaneId, env, record.firstmateRoot)
        : false;
      if (!sourcePaneId || !sourcePaneVisible) {
        return writeRecord({
          ...record,
          status: "failed",
          updatedAt: now(),
          blockers: ["來源 Herdr pane 已不存在，無法證明 Firstmate primary 與結果回傳路徑。請重新從 `aicoding-mate open --entrypoint quick` 啟動。"],
        });
      }
      if (!paneVisible) {
        return writeRecord({
          ...record,
          status: "failed",
          updatedAt: now(),
          blockers: [`Firstmate worker pane ${paneId} 不在目前 Herdr snapshot，拒絕宣稱 worker 可見。`],
        });
      }
      const worktree = meta.worktree;
      const project = meta.project;
      const worktreeGit = worktree
        ? run("git", ["-C", worktree, "rev-parse", "--show-toplevel"], { cwd: record.firstmateRoot, env })
        : undefined;
      const isolatedWorktree =
        Boolean(worktree)
        && Boolean(project)
        && directoryExists(worktree)
        && worktreeGit?.status === 0
        && resolve(firstLine(worktreeGit.stdout)) === resolve(worktree)
        && resolve(worktree) !== resolve(project);
      if (!isolatedWorktree) {
        return writeRecord({
          ...record,
          status: "failed",
          updatedAt: now(),
          blockers: ["Firstmate meta 未指向可讀且與 project 分離的 git worktree，拒絕宣稱 worker 已隔離。"],
        });
      }
      const peek = run(
        join(record.firstmateRoot, "bin", "fm-peek.sh"),
        [record.id, "80"],
        { cwd: record.firstmateRoot, env },
      );
      if (peek.status !== 0) {
        return writeRecord({
          ...record,
          status: "failed",
          updatedAt: now(),
          blockers: [`Firstmate fm-peek read-back 失敗：${compactFailure(peek)}`],
        });
      }
      const completed: QuickRunRecord = {
        ...record,
        status: "completed",
        updatedAt: now(),
        herdr: {
          ...record.herdr,
          primaryPaneId: record.source.paneId,
        },
        worker: {
          ...record.worker,
          paneId,
          target: meta.window,
        },
        controlChannel: {
          ...record.controlChannel,
          sourcePaneId,
          workerTarget: meta.window,
        },
        result: {
          summary: report,
          readBackAt: now(),
        },
        evidence: {
          ...evidence,
          herdrPaneId: paneId,
          observedAt: now(),
        },
        blockers: [],
        claims: {
          firstmatePrimaryInHerdr: true,
          workerVisible: true,
          resultReturnedToPane: false,
          recordReadbackMatchesPane: false,
        },
      };
      return writeRecord(completed);
    }

    if (status?.split(/\r?\n/).some((line) => line.startsWith("blocked:"))) {
      return writeRecord({
        ...record,
        status: "blocked",
        updatedAt: now(),
        blockers: [`Firstmate worker blocked：${lastNonEmptyLine(status)}`],
      });
    }
    if (attempt + 1 < maxPolls) sleep(pollIntervalMs);
  }

  return writeRecord({
    ...record,
    status: "running",
    updatedAt: now(),
    blockers: [
      `已派出 Firstmate worker，但在 bounded wait 內未同時觀測到 meta、Herdr pane、done status 與 scout report；請以 read-run 重新讀回 ${record.recordPath ?? ""}。`,
    ],
  });
}

function preflightRuntime(firstmateRoot: string, projectDir: string, env: NodeJS.ProcessEnv): string[] {
  const blockers = [
    ...validatePinnedDistro(firstmateRoot, env),
    ...preflightToolchain(firstmateRoot, env),
  ];
  if (!directoryExists(projectDir)) {
    blockers.push(`Quick project 不存在：${projectDir}`);
  } else {
    const projectGit = run("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], { cwd: projectDir, env });
    if (projectGit.status !== 0 || resolve(firstLine(projectGit.stdout)) !== resolve(projectDir)) {
      blockers.push(`Quick project 必須是 git checkout root：${projectDir}`);
    }
  }
  return blockers;
}

function validateQuickTaskScope(task: string, projectDir: string): string | undefined {
  const withoutNegatedBoundaries = task
    .replace(
      /\b(?:do not|don't|never)\s+(?:write|edit|modify|change|create|add|update|fix|commit|push|deploy|publish|release|send|email|message|share|upload|invite|grant|revoke|delete|remove|drop|destroy|restart|stop|pay|purchase|merge|submit|post|archive|move|copy|download|install|run|execute)\b/gi,
      "",
    )
    .replace(
      /(?:不要|不得|禁止|勿)\s*(?:寫入|編輯|修改|變更|建立|新增|更新|修復|提交|推送|部署|發布|寄信|發信|傳送|分享|上傳|邀請|授權|撤銷|刪除|清除|付款|購買|合併|送出|貼文|封存|移動|複製|下載|安裝|執行)/g,
      "",
    );
  const externalEndpoint = findExternalEndpoint(withoutNegatedBoundaries, projectDir);
  if (externalEndpoint) {
    return `Quick scout 不接受外部 endpoint「${externalEndpoint}」；請改用具有明確確認與 review gate 的正式 workflow。`;
  }
  const unsafe = withoutNegatedBoundaries.match(
    /\b(?:write|edit|modify|change|create|add|update|fix|commit|push|deploy|publish|release|send|email|message|share|upload|invite|grant|revoke|permission|delete|remove|drop|destroy|restart|stop|pay|purchase|merge|submit|post|archive|move|copy|download|install|run|execute|curl|wget|nc|netcat|telnet|socat|nmap|ping|traceroute|dig|nslookup|ssh|scp|rsync|ftp|httpie|socket|tcp|udp|dns|connect|request|fetch|internet|network|remote|webhook|dropbox|credential|secret|token|password|patient|medical\s+record|api\s+key)\b|寫入|編輯|修改|變更|建立|新增|更新|修復|提交|推送|部署|發布|寄信|發信|傳送|分享|上傳|邀請|授權|權限|撤銷|刪除|清除|付款|購買|合併|送出|貼文|封存|移動|複製|下載|安裝|執行|連線|網路|遠端|網址|網站|病歷|病人|個資|密碼|憑證|權杖|金鑰|開啟\s*PR/i,
  );
  if (unsafe) {
    return `Quick scout 不接受高風險或敏感意圖「${unsafe[0]}」；請改用具有明確確認與 review gate 的正式 workflow。`;
  }
  const readOnlyIntent =
    /\b(?:read|inspect|check|list|find|search|summarize|explain|analyze|review|compare|verify|report)\b|唯讀|讀取|檢查|列出|尋找|搜尋|摘要|解釋|分析|審查|比較|驗證|報告/i;
  const outputConstraint =
    /\b(?:reply|respond|output|return|include|mention|format|show)\b|回覆|輸出|返回|包含|提及|格式|顯示/i;
  if (!readOnlyIntent.test(withoutNegatedBoundaries)) {
    return "Quick scout 只接受明確唯讀的檢查、搜尋、摘要、解釋或 review；其他意圖請改用正式 workflow。";
  }
  const clauses = withoutNegatedBoundaries
    .split(/\b(?:then|and|using|via)\b|(?:然後|接著|再來|透過|使用|；|;|\n)/i)
    .map((clause) => clause.replace(/^[\s。.，,：:]+|[\s。.，,：:]+$/g, ""))
    .filter(Boolean);
  const unapprovedClause = clauses.find(
    (clause) => !readOnlyIntent.test(clause) && !outputConstraint.test(clause),
  );
  if (unapprovedClause) {
    return `Quick scout 無法把複合動作「${unapprovedClause}」判定為唯讀；請拆成單一唯讀任務，或改用正式 workflow。`;
  }
  return undefined;
}

function findExternalEndpoint(task: string, projectDir: string): string | undefined {
  const url = task.match(/(?:https?|wss?|ftp):\/\/\S+/i);
  if (url) return url[0];
  const ipOrLocalhost = task.match(
    /\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?\b/i,
  );
  if (ipOrLocalhost) return ipOrLocalhost[0];

  const hostWithPort = task.match(/\b[a-z0-9][a-z0-9_.-]*:\d{1,5}\b/i);
  if (hostWithPort) {
    const localCandidate = hostWithPort[0].replace(/:\d{1,5}$/, "");
    if (!isProjectLocalPath(projectDir, localCandidate)) return hostWithPort[0];
  }

  const dottedCandidates = task.match(/[a-z0-9_./-]+\.[a-z][a-z0-9-]{1,62}/gi) ?? [];
  return dottedCandidates.find((candidate) => !isProjectLocalPath(projectDir, candidate));
}

function isProjectLocalPath(projectDir: string, candidate: string): boolean {
  try {
    const projectRoot = realpathSync(projectDir);
    const target = realpathSync(resolve(projectRoot, candidate));
    const fromRoot = relative(projectRoot, target);
    return fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot);
  } catch {
    return false;
  }
}

function validatePinnedDistro(firstmateRoot: string, env: NodeJS.ProcessEnv): string[] {
  const blockers: string[] = [];
  if (!directoryExists(firstmateRoot)) {
    return [`Firstmate distro 不存在：${firstmateRoot}。請先 bootstrap ${firstmateRepo}@${pinnedFirstmateRef}。`];
  }
  for (const script of ["fm-spawn.sh", "fm-brief.sh", "fm-peek.sh", "fm-send.sh", "fm-bootstrap.sh"]) {
    const path = join(firstmateRoot, "bin", script);
    if (!existsSync(path)) blockers.push(`Firstmate script 缺失：${path}`);
  }
  const head = run("git", ["-C", firstmateRoot, "rev-parse", "HEAD"], { cwd: firstmateRoot, env });
  if (head.status !== 0) {
    blockers.push(`無法讀取 Firstmate git ref：${compactFailure(head)}`);
  } else if (firstLine(head.stdout) !== pinnedFirstmateRef) {
    blockers.push(`Firstmate ref 不符合 pinned baseline；expected=${pinnedFirstmateRef} actual=${firstLine(head.stdout)}`);
  }
  const status = run("git", ["-C", firstmateRoot, "status", "--short"], { cwd: firstmateRoot, env });
  if (status.status !== 0) {
    blockers.push(`無法讀取 Firstmate git status：${compactFailure(status)}`);
  } else if (status.stdout.trim() !== "") {
    blockers.push("Firstmate clone 不是 pristine；拒絕在修改過的 upstream distro 上派工。");
  }
  return blockers;
}

function preflightToolchain(firstmateRoot: string, env: NodeJS.ProcessEnv): string[] {
  const blockers: string[] = [];
  const tools = [
    "node",
    "git",
    "gh",
    "no-mistakes",
    "gh-axi",
    "chrome-devtools-axi",
    "lavish-axi",
    "tasks-axi",
    "quota-axi",
    "herdr",
    "jq",
    "treehouse",
    "codex",
  ];
  for (const tool of tools) {
    if (!findOnPath(tool, env.PATH ?? "")) blockers.push(`缺少 Firstmate 必要工具 ${tool}。`);
  }
  if (blockers.length > 0) return blockers;

  const ghAuth = run("gh", ["auth", "status"], { cwd: firstmateRoot, env });
  if (ghAuth.status !== 0) blockers.push("GitHub CLI 尚未登入；請先執行 `gh auth login`。");
  const herdrStatus = run("herdr", ["status", "server"], { cwd: firstmateRoot, env });
  if (herdrStatus.status !== 0 || !herdrStatus.stdout.includes("compatible: yes")) {
    blockers.push(`Herdr server 不可用或 protocol 不相容：${compactFailure(herdrStatus)}`);
  }
  const snapshot = run("herdr", ["api", "snapshot"], { cwd: firstmateRoot, env });
  const protocol = readSnapshotProtocol(snapshot.stdout);
  if (snapshot.status !== 0 || protocol === undefined || protocol < 14) {
    blockers.push(`Herdr protocol 必須 >=14；actual=${protocol ?? "unknown"}。`);
  }
  const treehouseHelp = run("treehouse", ["get", "--help"], { cwd: firstmateRoot, env });
  if (treehouseHelp.status !== 0 || !`${treehouseHelp.stdout}\n${treehouseHelp.stderr}`.includes("--lease")) {
    blockers.push("treehouse 不支援 `get --lease`，不符合 Firstmate worktree contract。");
  }
  const noMistakes = run("no-mistakes", ["--version"], { cwd: firstmateRoot, env });
  if (!versionAtLeast(`${noMistakes.stdout}\n${noMistakes.stderr}`, [1, 31, 2])) {
    blockers.push("no-mistakes 必須 >=1.31.2。");
  }
  const tasksUpdate = run("tasks-axi", ["update", "--help"], { cwd: firstmateRoot, env });
  const tasksMove = run("tasks-axi", ["mv", "--help"], { cwd: firstmateRoot, env });
  if (!`${tasksUpdate.stdout}\n${tasksUpdate.stderr}`.includes("--archive-body")
    || !`${tasksMove.stdout}\n${tasksMove.stderr}`.includes("[<id>...]")) {
    blockers.push("tasks-axi 缺少 Firstmate 需要的 update/mv contract。");
  }
  return blockers;
}

function prepareFirstmateHome(fmHome: string) {
  mkdirSync(join(fmHome, "data"), { recursive: true });
  mkdirSync(join(fmHome, "state"), { recursive: true });
  mkdirSync(join(fmHome, "config"), { recursive: true });
  mkdirSync(join(fmHome, "projects"), { recursive: true });
  writeFileSync(join(fmHome, "config", "backend"), "herdr\n");
  writeFileSync(join(fmHome, "config", "crew-harness"), "codex\n");
}

function registerProject(fmHome: string, projectDir: string, createdAt: string) {
  const registry = join(fmHome, "data", "projects.md");
  const name = basename(projectDir);
  const existing = readOptional(registry) ?? "# Projects\n";
  const pattern = new RegExp(`^- ${escapeRegExp(name)} \\[`, "m");
  if (pattern.test(existing)) return;
  const date = createdAt.slice(0, 10);
  writeFileSync(registry, `${existing.trimEnd()}\n- ${name} [local-only] - AI Coding Mate Quick runtime target (added ${date})\n`);
}

function fillBrief(path: string, task: string) {
  const template = readFileSync(path, "utf8");
  if (!template.includes("{TASK}")) throw new Error(`Firstmate brief 缺少 {TASK} placeholder：${path}`);
  writeFileSync(path, template.replace("{TASK}", task));
}

function writeRecord(record: QuickRunRecord): QuickRunRecord {
  if (record.recordPath) {
    mkdirSync(dirname(record.recordPath), { recursive: true });
    const temporary = `${record.recordPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temporary, record.recordPath);
  }
  return record;
}

function blockedResult(record: QuickRunRecord, now: () => string, blocker: string): QuickResult {
  const written = writeRecord({
    ...record,
    status: "blocked",
    updatedAt: now(),
    blockers: [blocker],
  });
  return { ok: false, record: written, stdout: "", stderr: blocker };
}

function resolveStateDir(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_STATE_DIR ?? join(cwd, "state", "aicoding-mate"));
}

function withLocalToolchainPath(stateDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const localPaths = [
    join(stateDir, "toolchain", "bin"),
    join(stateDir, "toolchain", "npm", "node_modules", ".bin"),
  ].filter(directoryExists);
  return {
    ...env,
    PATH: [...localPaths, env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
}

function prepareHerdrPathAdapter(stateDir: string, env: NodeJS.ProcessEnv) {
  const adapter = join(stateDir, "toolchain", "bin", "herdr");
  const realHerdr = findOnPathExcluding("herdr", env.PATH ?? "", adapter);
  if (!realHerdr) return;
  const script = [
    "#!/usr/bin/env bash",
    "set -eu",
    `real_herdr=${shellSingleQuote(realHerdr)}`,
    "case \"${1:-}:${2:-}\" in",
    "  workspace:create|tab:create)",
    "    exec \"$real_herdr\" \"$1\" \"$2\" --env \"PATH=${PATH:-}\" \"${@:3}\"",
    "    ;;",
    "  *)",
    "    exec \"$real_herdr\" \"$@\"",
    "    ;;",
    "esac",
    "",
  ].join("\n");
  mkdirSync(dirname(adapter), { recursive: true });
  const temporary = `${adapter}.tmp-${process.pid}`;
  writeFileSync(temporary, script);
  chmodSync(temporary, 0o755);
  renameSync(temporary, adapter);
}

function prepareCodexSandboxAdapter(stateDir: string, env: NodeJS.ProcessEnv) {
  const adapter = join(stateDir, "toolchain", "bin", "codex");
  const fmHome = join(stateDir, "fm-home");
  const realCodex = findOnPathExcluding("codex", env.PATH ?? "", adapter);
  if (!realCodex) return;
  const script = [
    "#!/usr/bin/env bash",
    "set -eu",
    `real_codex=${shellSingleQuote(realCodex)}`,
    `fm_home=${shellSingleQuote(fmHome)}`,
    "safe_args=()",
    "for arg in \"$@\"; do",
    "  [ \"$arg\" = \"--dangerously-bypass-approvals-and-sandbox\" ] && continue",
    "  safe_args+=(\"$arg\")",
    "done",
    "exec \"$real_codex\" \\",
    "  --sandbox workspace-write \\",
    "  --ask-for-approval never \\",
    "  --add-dir \"$fm_home\" \\",
    "  -c 'sandbox_workspace_write.network_access=false' \\",
    "  -c 'web_search=\"disabled\"' \\",
    "  -c 'mcp_servers={}' \\",
    "  \"${safe_args[@]}\"",
    "",
  ].join("\n");
  mkdirSync(dirname(adapter), { recursive: true });
  const temporary = `${adapter}.tmp-${process.pid}`;
  writeFileSync(temporary, script);
  chmodSync(temporary, 0o755);
  renameSync(temporary, adapter);
}

function resolveFirstmateRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.ACM_FIRSTMATE_ROOT ?? env.FIRSTMATE_ROOT ?? join(cwd, "state", "upstream", "firstmate"));
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function findOnPath(name: string, pathValue: string): string | undefined {
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function findOnPathExcluding(name: string, pathValue: string, excluded: string): string | undefined {
  const excludedResolved = resolve(excluded);
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      if (resolve(candidate) !== excludedResolved && statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readMeta(path: string | undefined): Record<string, string> | undefined {
  const contents = readOptional(path);
  if (!contents) return undefined;
  const result: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function readOptional(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function herdrHasPane(paneId: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const snapshot = run("herdr", ["api", "snapshot"], { cwd, env });
  if (snapshot.status !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(snapshot.stdout);
    return collectPaneIds(parsed).includes(paneId);
  } catch {
    return false;
  }
}

function collectPaneIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPaneIds);
  if (!value || typeof value !== "object") return [];
  const ids: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (key === "pane_id" && typeof nested === "string") ids.push(nested);
    else ids.push(...collectPaneIds(nested));
  }
  return ids;
}

function readSnapshotProtocol(value: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return findNumberProperty(parsed, "protocol");
  } catch {
    return undefined;
  }
}

function findNumberProperty(value: unknown, key: string): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumberProperty(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [candidate, nested] of Object.entries(value)) {
    if (candidate === key && typeof nested === "number") return nested;
    const found = findNumberProperty(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function versionAtLeast(value: string, minimum: [number, number, number]): boolean {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function lastNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).filter(Boolean).at(-1) ?? value;
}

function sleepSync(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactFailure(result: CommandResult): string {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return output ? firstLine(output) : `exit ${result.status ?? "unknown"}`;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function compactTimestamp(value: string): string {
  return value.replace(/[^0-9TZ]/g, "").replace(/Z$/, "Z").toLowerCase();
}

function isQuickRunRecord(value: unknown): value is QuickRunRecord {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<QuickRunRecord>;
  return maybe.schemaVersion === 1 && maybe.recipe === "quick" && typeof maybe.id === "string";
}

function reusableIdempotentQuickRecord(
  record: QuickRunRecord,
): record is QuickRunRecord & {
  result: NonNullable<QuickRunRecord["result"]>;
} {
  return record.status === "completed"
    && Boolean(record.result?.summary.trim())
    && Boolean(record.result?.readBackAt)
    && Boolean(record.worker.taskId)
    && Boolean(record.worker.target)
    && Boolean(record.evidence?.firstmateStatus)
    && Boolean(record.evidence?.scoutReport)
    && record.claims.firstmatePrimaryInHerdr
    && record.claims.workerVisible;
}
