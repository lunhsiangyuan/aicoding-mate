import type { DoctorReport, ProbeStatus } from "./probe.ts";

const statusLabel: Record<ProbeStatus, string> = {
  ok: "OK",
  missing: "缺少",
  error: "錯誤",
};

export function renderDoctorText(report: DoctorReport): string {
  const lines = [
    "Ari runtime doctor",
    "",
    `產生時間: ${report.generatedAt}`,
    `工作目錄: ${report.cwd}`,
    `Herdr plugin context: ${report.plugin.inHerdr ? "yes" : "no"}`,
  ];

  if (report.plugin.id) lines.push(`Plugin: ${report.plugin.id}`);
  if (report.plugin.entrypoint) lines.push(`Entrypoint: ${report.plugin.entrypoint}`);
  lines.push("", "狀態:");

  for (const tool of report.tools) {
    const version = tool.version ? ` (${tool.version})` : "";
    lines.push(`- ${tool.label}: ${statusLabel[tool.status]}${version}`);
    lines.push(`  command: ${tool.command}`);
    if (tool.path) lines.push(`  path: ${tool.path}`);
    lines.push(`  detail: ${tool.detail}`);
    if ("protocol" in tool && tool.protocol !== undefined) {
      lines.push(`  protocol: ${tool.protocol}`);
    }
    if ("socket" in tool && tool.socket) {
      lines.push(`  socket: ${tool.socket}`);
    }
    if (tool.nextStep) lines.push(`  next: ${tool.nextStep}`);
  }

  lines.push(
    "",
    `摘要: OK ${report.summary.ok} / 缺少 ${report.summary.missing} / 錯誤 ${report.summary.error}`,
  );
  lines.push(report.summary.ready ? "結果: 基礎工具已就緒。" : "結果: 尚未就緒，請先處理上方 next 項目。");
  return `${lines.join("\n")}\n`;
}

export function renderPane(report: DoctorReport): string {
  const width = 78;
  const rule = "=".repeat(width);
  const rows = report.tools.map((tool) => {
    const version = tool.version ? trim(tool.version, 28) : "-";
    return `${pad(tool.label, 14)} ${pad(statusLabel[tool.status], 6)} ${version}`;
  });
  const blockers = report.tools
    .filter((tool) => tool.status !== "ok")
    .flatMap((tool) => [
      `- ${tool.label}: ${tool.detail}`,
      ...(tool.nextStep ? [`  next: ${tool.nextStep}`] : []),
    ]);

  return [
    rule,
    "Ari - Herdr 診斷面",
    rule,
    `runtime read-back: ${report.generatedAt}`,
    `cwd: ${report.cwd}`,
    `plugin context: ${report.plugin.inHerdr ? "HERDR_ENV=1" : "standalone"}`,
    "",
    "工具             狀態   版本 / read-back",
    "-".repeat(width),
    ...rows,
    "",
    `summary: ok=${report.summary.ok} missing=${report.summary.missing} error=${report.summary.error}`,
    report.summary.ready ? "next: 可進入後續 Firstmate workflow wiring。" : "next:",
    ...(blockers.length ? blockers : []),
    "",
    "這個 pane 只做診斷入口；尚未宣稱 Firstmate workflow 已接通。",
    rule,
  ].join("\n") + "\n";
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length, " ");
}

function trim(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}
