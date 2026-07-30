import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type ToolId =
  | "herdr"
  | "firstmate"
  | "codex"
  | "claude"
  | "git"
  | "gh"
  | "jq"
  | "bun";

export type ProbeStatus = "ok" | "missing" | "error";

export interface ToolProbe {
  id: ToolId;
  label: string;
  status: ProbeStatus;
  command: string;
  path?: string;
  version?: string;
  detail: string;
  nextStep?: string;
}

export interface HerdrProbe extends ToolProbe {
  protocol?: number;
  compatible?: boolean;
  socket?: string;
  serverStatus?: string;
}

export interface FirstmateProbe extends ToolProbe {
  repository: string;
  ref: string;
  root?: string;
  currentRef?: string;
}

export interface DoctorReport {
  generatedAt: string;
  cwd: string;
  plugin: {
    id?: string;
    root?: string;
    configDir?: string;
    stateDir?: string;
    entrypoint?: string;
    inHerdr: boolean;
  };
  tools: Array<ToolProbe | HerdrProbe | FirstmateProbe>;
  summary: {
    ok: number;
    missing: number;
    error: number;
    ready: boolean;
  };
}

export interface ProbeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const toolLabels: Record<ToolId, string> = {
  herdr: "Herdr",
  firstmate: "Firstmate",
  codex: "Codex",
  claude: "Claude",
  git: "git",
  gh: "GitHub CLI",
  jq: "jq",
  bun: "Bun",
};

const nextSteps: Record<ToolId, string> = {
  herdr: "請先安裝 Herdr，並確認 `herdr status server` 可以連到目前 session。",
  firstmate: "請 clone kunchenguid/firstmate 到 pinned ref，並以 FIRSTMATE_ROOT 或 ACM_FIRSTMATE_ROOT 指向該 distro root。",
  codex: "請安裝 Codex CLI 或把可執行檔加入 PATH。",
  claude: "請安裝 Claude Code CLI 或把可執行檔加入 PATH。",
  git: "請安裝 git，並確認目前 shell 的 PATH 可找到它。",
  gh: "請安裝 GitHub CLI `gh`，並視需要完成 `gh auth login`。",
  jq: "請安裝 jq，供 JSON read-back 與 shell workflow 使用。",
  bun: "請安裝 Bun，或把 `bun` 加入 PATH 後重跑 doctor。",
};

const versionArgs: Record<ToolId, string[]> = {
  herdr: ["--version"],
  firstmate: [],
  codex: ["--version"],
  claude: ["--version"],
  git: ["--version"],
  gh: ["--version"],
  jq: ["--version"],
  bun: ["--version"],
};

export function runDoctor(options: ProbeOptions): DoctorReport {
  const tools: Array<ToolProbe | HerdrProbe> = [
    probeHerdr(options),
    probeFirstmate(options),
    probeTool("codex", options),
    probeTool("claude", options),
    probeTool("git", options),
    probeTool("gh", options),
    probeTool("jq", options),
    probeTool("bun", options),
  ];
  const summary = {
    ok: tools.filter((tool) => tool.status === "ok").length,
    missing: tools.filter((tool) => tool.status === "missing").length,
    error: tools.filter((tool) => tool.status === "error").length,
    ready: tools.every((tool) => tool.status === "ok"),
  };
  return {
    generatedAt: new Date().toISOString(),
    cwd: options.cwd,
    plugin: {
      id: options.env.HERDR_PLUGIN_ID,
      root: options.env.HERDR_PLUGIN_ROOT,
      configDir: options.env.HERDR_PLUGIN_CONFIG_DIR,
      stateDir: options.env.HERDR_PLUGIN_STATE_DIR,
      entrypoint: options.env.HERDR_PLUGIN_ENTRYPOINT_ID,
      inHerdr: options.env.HERDR_ENV === "1",
    },
    tools,
    summary,
  };
}

export function probeTool(id: ToolId, options: ProbeOptions): ToolProbe {
  const executable = resolveExecutable(id, options.env);
  if (!executable) {
    return {
      id,
      label: toolLabels[id],
      status: "missing",
      command: `${id} ${versionArgs[id].join(" ")}`,
      detail: "找不到可執行檔。",
      nextStep: nextSteps[id],
    };
  }

  const result = runCommand(executable, versionArgs[id], options);
  if (result.status === 0) {
    return {
      id,
      label: toolLabels[id],
      status: "ok",
      command: `${executable} ${versionArgs[id].join(" ")}`,
      path: executable,
      version: firstLine(result.stdout || result.stderr),
      detail: "runtime version read-back 成功。",
    };
  }

  return {
    id,
    label: toolLabels[id],
    status: "error",
    command: `${executable} ${versionArgs[id].join(" ")}`,
    path: executable,
    detail: compactFailure(result),
    nextStep: nextSteps[id],
  };
}

export function probeHerdr(options: ProbeOptions): HerdrProbe {
  const base = probeTool("herdr", options) as HerdrProbe;
  if (base.status !== "ok" || !base.path) {
    return base;
  }

  const status = runCommand(base.path, ["status", "server"], options);
  if (status.status !== 0) {
    return {
      ...base,
      status: "error",
      detail: `Herdr binary 可執行，但 server 狀態讀取失敗：${compactFailure(status)}`,
      nextStep: "請確認 Herdr server 已啟動；不要為了測試停止或重啟現有 session。",
    };
  }

  const snapshot = runCommand(base.path, ["api", "snapshot"], options);
  if (snapshot.status !== 0) {
    return {
      ...base,
      status: "error",
      serverStatus: firstLine(status.stdout || status.stderr),
      detail: `Herdr server 可讀，但 API snapshot 失敗：${compactFailure(snapshot)}`,
      nextStep: "請確認目前 Herdr protocol 與 CLI 相容。",
    };
  }

  const parsed = parseJson(snapshot.stdout);
  const snap = parsed?.result?.snapshot;
  return {
    ...base,
    serverStatus: readStatusLine(status.stdout),
    protocol: typeof snap?.protocol === "number" ? snap.protocol : undefined,
    compatible: status.stdout.includes("compatible: yes"),
    socket: parseColonLine(status.stdout, "socket"),
    detail: `server read-back 成功；protocol ${snap?.protocol ?? "unknown"}。`,
  };
}

export function probeFirstmate(options: ProbeOptions): FirstmateProbe {
  const repository = "https://github.com/kunchenguid/firstmate";
  const ref = "e595611291247368b982eb729097c54f2b45aa78";
  const configured = firstmateCandidates(options).find((candidate) => directoryExists(candidate));

  if (!configured) {
    return {
      id: "firstmate",
      label: toolLabels.firstmate,
      status: "missing",
      command: "git -C <FIRSTMATE_ROOT> rev-parse HEAD",
      repository,
      ref,
      detail: `尚未 bootstrap: kunchenguid/firstmate@${ref}`,
      nextStep: nextSteps.firstmate,
    };
  }

  const git = resolveExecutable("git", options.env);
  if (!git) {
    return {
      id: "firstmate",
      label: toolLabels.firstmate,
      status: "error",
      command: `git -C ${configured} rev-parse HEAD`,
      repository,
      ref,
      root: configured,
      detail: "已找到 Firstmate root，但找不到 git 以驗證 pinned ref。",
      nextStep: nextSteps.git,
    };
  }

  const current = runCommand(git, ["-C", configured, "rev-parse", "HEAD"], options);
  if (current.status !== 0) {
    return {
      id: "firstmate",
      label: toolLabels.firstmate,
      status: "error",
      command: `${git} -C ${configured} rev-parse HEAD`,
      repository,
      ref,
      root: configured,
      detail: `已找到 Firstmate root，但無法讀取 git ref：${compactFailure(current)}`,
      nextStep: "請確認 FIRSTMATE_ROOT 指向 pinned Firstmate git clone，而不是一般資料夾。",
    };
  }

  const currentRef = firstLine(current.stdout);
  if (currentRef !== ref) {
    return {
      id: "firstmate",
      label: toolLabels.firstmate,
      status: "error",
      command: `${git} -C ${configured} rev-parse HEAD`,
      repository,
      ref,
      root: configured,
      currentRef,
      detail: `Firstmate distro ref 不符合 pinned baseline；expected=${ref} actual=${currentRef}`,
      nextStep: `請 checkout ${repository}@${ref}，或更新 adapter config 後再驗證。`,
    };
  }

  return {
    id: "firstmate",
    label: toolLabels.firstmate,
    status: "ok",
    command: `${git} -C ${configured} rev-parse HEAD`,
    repository,
    ref,
    root: configured,
    currentRef,
    version: currentRef.slice(0, 12),
    detail: "pinned Firstmate distro read-back 成功。",
  };
}

export function resolveExecutable(id: ToolId, env: NodeJS.ProcessEnv): string | undefined {
  if (id === "herdr" && env.HERDR_BIN_PATH && canExecute(env.HERDR_BIN_PATH)) {
    return env.HERDR_BIN_PATH;
  }
  return findOnPath(id, env.PATH ?? "");
}

function findOnPath(name: string, pathValue: string): string | undefined {
  if (isAbsolute(name) && canExecute(name)) return name;
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (canExecute(candidate)) return candidate;
  }
  return undefined;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstmateCandidates(options: ProbeOptions): string[] {
  const candidates = [
    options.env.FIRSTMATE_ROOT,
    options.env.ACM_FIRSTMATE_ROOT,
    resolve(options.cwd, "..", "firstmate"),
    resolve(dirname(options.cwd), "firstmate"),
  ];
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function directoryExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], options: ProbeOptions): CommandResult {
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
    error: result.error,
  };
}

function compactFailure(result: CommandResult): string {
  if (result.error) return result.error.message;
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return output ? firstLine(output) : `exit ${result.status ?? "unknown"}`;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function readStatusLine(value: string): string {
  return parseColonLine(value, "status") ?? firstLine(value);
}

function parseColonLine(value: string, key: string): string | undefined {
  const line = value.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}

function parseJson(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
