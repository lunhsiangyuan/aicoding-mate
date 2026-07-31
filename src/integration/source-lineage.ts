import type { SourceLineage } from "../contracts/index.ts";

export function sourceLineageFromEnvironment(
  env: NodeJS.ProcessEnv,
): SourceLineage {
  const paneId = env.HERDR_PANE_ID ?? env.ACM_QUICK_SOURCE_PANE ?? "";
  const workspace = env.HERDR_WORKSPACE_ID ?? "";
  const tabId = env.HERDR_TAB_ID ?? "";
  const stableSource = [workspace, tabId, paneId].filter(Boolean).join(":");
  return {
    taskId:
      env.ACM_SOURCE_TASK_ID
      ?? env.HERDR_TASK_ID
      ?? stableSource,
    runId:
      env.ACM_SOURCE_RUN_ID
      ?? env.HERDR_RUN_ID
      ?? stableSource,
    workspace,
    tabId,
    paneId,
  };
}
