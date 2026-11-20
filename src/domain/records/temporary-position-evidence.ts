import type {
  Assignment,
  HistoryRecord,
  ManualCountEvidence,
} from "../../model";

/** Capture from the actual manual slot, never infer origin from a custom name. */
export function temporaryPositionEvidence(
  assignment: Assignment
): Pick<ManualCountEvidence, "temporaryPosition"> {
  if (assignment.positionRuleId !== null || !assignment.layoutGroup) return {};
  return {
    temporaryPosition: {
      layoutGroup: assignment.layoutGroup,
      ...(assignment.layoutIndex !== undefined
        ? { layoutIndex: assignment.layoutIndex }
        : {}),
    },
  };
}

export function historicalTemporaryPosition(
  record: HistoryRecord,
  hasConfiguredPosition: boolean
): ManualCountEvidence["temporaryPosition"] {
  if (record.temporaryPosition) return record.temporaryPosition;
  // The old unnamed manual slot had this exact name and zero workload.
  // Other unmatched positions may be removed configured jobs: keep them blocked.
  if (
    !hasConfiguredPosition &&
    record.position === "临时岗位" &&
    record.workHours === 0 &&
    record.fatiguePoints === 0
  )
    return { layoutGroup: "primary" };
  return undefined;
}
