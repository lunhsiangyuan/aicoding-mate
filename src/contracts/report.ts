export interface MainReport {
  readonly conclusion: string;
  readonly impact: string;
  readonly nextAction: string;
}

export interface EvidenceLayer {
  readonly configVersionHash: string;
  readonly availabilitySnapshotId: string;
  readonly routingDecisionKey: string;
  readonly lineage: readonly string[];
  readonly limitations: readonly string[];
  readonly unknowns: readonly string[];
}

export interface DecisionReadyReport {
  readonly schemaVersion: 1;
  readonly mainReport: MainReport;
  readonly evidenceLayer: EvidenceLayer;
}

export function assertDecisionReadyReport(
  report: DecisionReadyReport,
): void {
  const requiredMainFields = [
    report.mainReport.conclusion,
    report.mainReport.impact,
    report.mainReport.nextAction,
  ];
  if (requiredMainFields.some((value) => value.trim().length === 0)) {
    throw new Error(
      "main_report_incomplete: conclusion, impact, and nextAction are required",
    );
  }

  const requiredEvidenceFields = [
    report.evidenceLayer.configVersionHash,
    report.evidenceLayer.availabilitySnapshotId,
    report.evidenceLayer.routingDecisionKey,
  ];
  if (requiredEvidenceFields.some((value) => value.trim().length === 0)) {
    throw new Error(
      "evidence_layer_incomplete: config, availability, and routing lineage are required",
    );
  }
  if (
    report.evidenceLayer.lineage.length === 0 ||
    report.evidenceLayer.lineage.some((value) => value.trim().length === 0)
  ) {
    throw new Error(
      "evidence_lineage_missing: at least one non-empty lineage reference is required",
    );
  }
}
