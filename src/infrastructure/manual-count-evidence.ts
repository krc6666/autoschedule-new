import type { ManualCountEvidence } from "../model";

/** Shared boundary decoder for JSON storage and the optional Excel evidence cell. */
export function restoreManualCountEvidence(
  value: unknown
): ManualCountEvidence {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: ManualCountEvidence = {};
  const remarks = source.assignmentRemarks;
  if (remarks && typeof remarks === "object") {
    const row = remarks as Record<string, unknown>;
    if (typeof row.remark === "string" && typeof row.manualRemark === "string")
      result.assignmentRemarks = {
        remark: row.remark,
        manualRemark: row.manualRemark,
      };
  }
  const baseline = source.countBaseline;
  if (baseline && typeof baseline === "object") {
    const row = baseline as Record<string, unknown>;
    if (
      (row.staffId === null || typeof row.staffId === "string") &&
      typeof row.staffName === "string"
    )
      result.countBaseline = { staffId: row.staffId, staffName: row.staffName };
  }
  if (Array.isArray(source.manualOverrideWarnings)) {
    result.manualOverrideWarnings = source.manualOverrideWarnings.flatMap(
      (w) =>
        w &&
        typeof w === "object" &&
        typeof w.code === "string" &&
        typeof w.message === "string"
          ? [{ code: w.code, message: w.message }]
          : []
    );
  }
  return result;
}

export function parseManualCountEvidence(value: string): ManualCountEvidence {
  try {
    return restoreManualCountEvidence(JSON.parse(value));
  } catch {
    return {};
  }
}

export function serializeManualCountEvidence(
  value: ManualCountEvidence
): string {
  if (
    !value.countBaseline &&
    !value.manualOverrideWarnings &&
    !value.assignmentRemarks
  )
    return "";
  return JSON.stringify(restoreManualCountEvidence(value));
}
