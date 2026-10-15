import type { Staff } from "../../model";
import {
  baselineStaffId,
  hasQualificationOverride,
  monthlyCountRecords,
} from "./manual-count-evidence";
import {
  ordinaryPriorityConfigurationKey,
  ordinaryPriorityPositionKey,
} from "../reviews/position-rotation-policy";
import type { SchedulingFacts } from "../shared/scheduling-facts";

export interface OrdinaryPriorityStatisticsRow {
  staff: Staff;
  airlineCode: string;
  position: string;
  qualified: boolean;
  actualCount: number;
  manualCorrection: number;
  effectiveCount: number;
  qualificationOverrideCount: number;
  qualificationUnrecordedCount: number;
}

export function buildOrdinaryPriorityStatistics(
  state: SchedulingFacts,
  date: string
): OrdinaryPriorityStatisticsRow[] {
  const month = date.slice(0, 7);
  const rows: OrdinaryPriorityStatisticsRow[] = [];
  const monthRecords = monthlyCountRecords(state, date);
  for (const item of state.settings.ordinaryPriorityPositions) {
    const configuredKey = ordinaryPriorityConfigurationKey(
      item.airlineCode,
      item.position
    );
    const qualifiedStaffIds = new Set(
      state.positionRules
        .filter(
          (rule) =>
            rule.category === "常规" &&
            ordinaryPriorityPositionKey(
              rule.flightNo,
              rule.name,
              rule.remark
            ) === configuredKey
        )
        .flatMap((rule) => rule.qualifiedStaffIds)
    );
    const records = monthRecords.filter(
      (record) =>
        ordinaryPriorityPositionKey(
          record.flightNo,
          record.position,
          record.assignmentRemarks?.remark ?? record.remark
        ) === configuredKey
    );
    for (const staff of state.staff.filter(
      (person) => person.staffType === "常规"
    )) {
      const actual = records.filter(
        (r) => baselineStaffId(r) === staff.id
      ).length;
      const finalRecords = records.filter((r) => r.staffId === staff.id);
      const manualCorrection =
        finalRecords.length -
        actual +
        (state.ordinaryPriorityFrequencyAdjustments ?? [])
          .filter(
            (adjustment) =>
              adjustment.month === month &&
              adjustment.staffId === staff.id &&
              ordinaryPriorityConfigurationKey(
                adjustment.airlineCode,
                adjustment.position
              ) === configuredKey
          )
          .reduce(
            (sum, adjustment) =>
              sum + adjustment.delta + (adjustment.resetBaseline ?? 0),
            0
          );
      rows.push({
        staff,
        airlineCode: item.airlineCode,
        position: item.position,
        qualified: staff.status === "正常" && qualifiedStaffIds.has(staff.id),
        actualCount: actual,
        manualCorrection,
        effectiveCount: Math.max(0, actual + manualCorrection),
        qualificationOverrideCount: finalRecords.filter(
          hasQualificationOverride
        ).length,
        qualificationUnrecordedCount: finalRecords.filter(
          (r) => !r.countBaseline && !r.manualOverrideWarnings
        ).length,
      });
    }
  }
  return rows;
}
