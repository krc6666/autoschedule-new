import type { Assignment, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { eligibleStaffForRule } from "../candidates/assignment-eligibility";
import { assignmentRule } from "../flights/schedule-position-rules";
import {
  createScheduleFrequencyFacts,
  positionFrequencyProfileForAssignment,
  type ScheduleFrequencyFacts,
} from "../statistics/schedule-frequency";

export const POSITION_FREQUENCY_ALERT_WORKDAY_COUNT = 8;
const FREQUENCY_ALERT_DIFFERENCE = 2;
const SOLE_QUALIFIED_HIGH_FREQUENCY_COUNT = 3;

export interface PositionFrequencyAlertPeriod {
  label: "本月" | "最近8个工作日";
  assignedCount: number;
  difference: number;
  assignedWasLowest: boolean;
}

export interface PositionFrequencyAlertAssessment {
  eligibleStaff: readonly Staff[];
  periods: readonly PositionFrequencyAlertPeriod[];
  needsAttention: boolean;
  improving: boolean;
  soleQualified: boolean;
}

function spread(values: readonly number[]): number {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

export function assessPositionFrequencyAlert(
  state: ScheduleGenerationFacts,
  assignment: Assignment,
  date: string,
  scheduleFrequency?: ScheduleFrequencyFacts
): PositionFrequencyAlertAssessment | null {
  const rule = assignmentRule(state, assignment);
  const flight = state.flights.find((item) => item.id === assignment.flightId);
  if (!rule || !flight || !assignment.staffId) return null;
  const eligibleStaff = eligibleStaffForRule(state, flight, rule);
  if (!eligibleStaff.some((person) => person.id === assignment.staffId))
    return null;

  const frequencyFacts =
    scheduleFrequency?.date === date
      ? scheduleFrequency
      : createScheduleFrequencyFacts(state, date);
  const counts = eligibleStaff.map((person) => {
    const profile = positionFrequencyProfileForAssignment(
      state,
      assignment,
      person.id,
      date,
      frequencyFacts
    );
    const current = person.id === assignment.staffId ? 1 : 0;
    return {
      person,
      monthBefore: profile.currentMonthCount,
      recentBefore: profile.recentWorkdayCount,
      current,
    };
  });
  const assigned = counts.find(
    (item) => item.person.id === assignment.staffId
  )!;
  const periodInputs = [
    {
      label: "本月" as const,
      beforeKey: "monthBefore" as const,
    },
    {
      label: "最近8个工作日" as const,
      beforeKey: "recentBefore" as const,
    },
  ];
  const periods = periodInputs.map(({ label, beforeKey }) => {
    const before = counts.map((item) => item[beforeKey]);
    const current = counts.map((item) => item[beforeKey] + item.current);
    return {
      label,
      assignedCount: assigned[beforeKey] + assigned.current,
      difference: spread(current),
      assignedWasLowest: assigned[beforeKey] === Math.min(...before),
    };
  });
  const imbalancedPeriods = periods.filter(
    (period) => period.difference >= FREQUENCY_ALERT_DIFFERENCE
  );
  const soleQualified = eligibleStaff.length === 1;
  const soleQualifiedHighFrequency =
    soleQualified &&
    periods.some(
      (period) => period.assignedCount >= SOLE_QUALIFIED_HIGH_FREQUENCY_COUNT
    );
  return {
    eligibleStaff,
    periods,
    needsAttention:
      soleQualifiedHighFrequency ||
      (!soleQualified && imbalancedPeriods.length > 0),
    improving:
      !soleQualified &&
      imbalancedPeriods.length > 0 &&
      imbalancedPeriods.every((period) => period.assignedWasLowest),
    soleQualified: soleQualifiedHighFrequency,
  };
}
