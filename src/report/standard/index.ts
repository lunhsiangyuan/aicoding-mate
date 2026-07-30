import type { StandardWorkflowConfig } from "../../config/standard.ts";
import type { NormalizedStandardInput } from "../../routing/standard.ts";
import type { AvailabilitySnapshot, RoutingDecision } from "../../contracts/routing.ts";
import type { DecisionReadyReport } from "../../contracts/report.ts";

export interface ComposeStandardDecisionReportOptions {
  readonly config: StandardWorkflowConfig;
  readonly normalizedInput: NormalizedStandardInput;
  readonly routingDecision: RoutingDecision;
  readonly availability: AvailabilitySnapshot;
}

export function composeStandardDecisionReport(
  options: ComposeStandardDecisionReportOptions,
): DecisionReadyReport {
  const crossFamily =
    options.routingDecision.diversityStatus === "cross_family"
      ? "author/reviewer 已分屬不同 model family。"
      : "author/reviewer 只能使用同 family fallback，報告已標示 degraded_same_family。";
  const assignments = options.routingDecision.roleAssignments
    .map((assignment) => `${assignment.role}:${assignment.alias}`)
    .join(", ");

  return {
    schemaVersion: 1,
    mainReport: {
      conclusion: `使用 standard workflow：${options.normalizedInput.task}`,
      impact: `會依固定 stages 執行建置、跨模型 review、修復與驗證；${crossFamily}`,
      nextAction: "將此 routing decision 交給 FirstmateDispatchPort，由 root 後續接 T2 runtime dispatch。",
    },
    evidenceLayer: {
      configVersionHash: options.config.versionHash,
      availabilitySnapshotId: options.availability.id,
      routingDecisionKey: options.routingDecision.requestKey,
      lineage: [
        options.normalizedInput.hash,
        options.config.versionHash,
        options.availability.id,
        options.routingDecision.requestKey,
        assignments,
      ],
      limitations: [
        "本 slice 只做純 Standard routing/report core，未呼叫外部模型、Herdr 或 Firstmate runtime。",
        "Provider availability 由呼叫端提供的 AvailabilitySnapshot 決定，本模組不自行探測登入或額度。",
      ],
      unknowns: [
        "實際 worker 完成狀態需由 root 後續接 FirstmateDispatchPort 後 read-back。",
        "模型 alias 到真實 provider model id 的解析仍屬外部 availability/config 輸入。",
      ],
    },
  };
}
