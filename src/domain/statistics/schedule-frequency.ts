import type { Assignment, HistoryRecord, PositionRule } from "../../model";
import type {
  HistoryRuleFacts,
  PositionFrequencyFacts,
} from "../shared/scheduling-facts";
import { recentArchivedWorkdays } from "./fatigue";
import { assignmentRule } from "../flights/schedule-position-rules";
import {
  ordinaryPriorityConfigurationKey,
  ordinaryPositionReference,
  isOrdinaryPriorityPosition,
  ordinaryPriorityPositionKey,
} from "../reviews/position-rotation-policy";
import {
  airlineCode,
  normalizedRotationPosition,
  positionRotationGroupKey,
} from "../rules/airline-rotation";

export interface ScheduleFrequencyFacts {
  date: string;
  recentArchivedWorkdayDates: readonly string[];
  recentConsecutiveWorkdays: readonly string[];
  recentFrequencyRecordIds: ReadonlySet<string>;
  recentEightWorkdayRecordIds: ReadonlySet<string>;
  recordsByPosition: ReadonlyMap<string, readonly HistoryRecord[]>;
  recordsByStaffId: ReadonlyMap<string, readonly HistoryRecord[]>;
  ordinaryPriorityAdjustmentsByKey: ReadonlyMap<
    string,
    { delta: number; resetBaseline: number }
  >;
}

function ordinaryPriorityAdjustmentKey(
  month: string,
  staffId: string,
  positionKey: string
): string {
  return [month, staffId, positionKey].join("\u0000");
}

function positionHistoryKey(
  staffId: string,
  flightNo: string,
  position: string,
  remark: string,
  resolvedAirlineCode = airlineCode(flightNo)
): string {
  return [
    staffId,
    resolvedAirlineCode,
    normalizedRotationPosition(position, remark),
  ].join("\u0000");
}

function frequencyPositionKey(
  state: HistoryRuleFacts,
  flightNo: string,
  position: string,
  remark: string
): string {
  return isOrdinaryPriorityPosition(
    { category: "常规", flightNo, name: position, remark },
    state.settings.ordinaryPriorityPositions
  )
    ? ordinaryPriorityPositionKey(flightNo, position, remark)
    : positionRotationGroupKey(flightNo, position, remark);
}

export function createScheduleFrequencyFacts(
  state: HistoryRuleFacts,
  date: string
): ScheduleFrequencyFacts {
  const recordsByPosition = new Map<string, HistoryRecord[]>();
  const recordsByStaffId = new Map<string, HistoryRecord[]>();
  const configuredOrdinaryKeys = new Set(
    state.settings.ordinaryPriorityPositions.map((item) =>
      ordinaryPriorityConfigurationKey(item.airlineCode, item.position)
    )
  );
  const configuredOrdinaryAirlines = new Set(
    state.settings.ordinaryPriorityPositions.map((item) =>
      item.airlineCode.toUpperCase()
    )
  );
  const airlineByFlightNo = new Map<string, string>();
  const cachedAirlineCode = (flightNo: string): string => {
    const cached = airlineByFlightNo.get(flightNo);
    if (cached) return cached;
    const resolved = airlineCode(flightNo);
    airlineByFlightNo.set(flightNo, resolved);
    return resolved;
  };
  for (const record of state.history) {
    // Independent guide history records workload, not priority-position counts.
    if (record.guideMode === "independent") continue;
    const recordAirline = cachedAirlineCode(record.flightNo);
    const positionKey = positionHistoryKey(
      record.staffId,
      record.flightNo,
      record.position,
      record.remark,
      recordAirline
    );
    const records = recordsByPosition.get(positionKey) ?? [];
    records.push(record);
    recordsByPosition.set(positionKey, records);
    if (configuredOrdinaryAirlines.has(recordAirline)) {
      const ordinaryKey = ordinaryPriorityConfigurationKey(
        recordAirline,
        ordinaryPositionReference(record.position)
      );
      const ordinaryHistoryKey = [record.staffId, ordinaryKey].join("\u0000");
      if (
        ordinaryHistoryKey !== positionKey &&
        configuredOrdinaryKeys.has(ordinaryKey)
      ) {
        const ordinaryRecords = recordsByPosition.get(ordinaryHistoryKey) ?? [];
        ordinaryRecords.push(record);
        recordsByPosition.set(ordinaryHistoryKey, ordinaryRecords);
      }
    }
    const staffRecords = recordsByStaffId.get(record.staffId) ?? [];
    staffRecords.push(record);
    recordsByStaffId.set(record.staffId, staffRecords);
  }
  const ordinaryPriorityAdjustmentsByKey = new Map<
    string,
    { delta: number; resetBaseline: number }
  >();
  for (const adjustment of state.ordinaryPriorityFrequencyAdjustments ?? []) {
    const key = ordinaryPriorityAdjustmentKey(
      adjustment.month,
      adjustment.staffId,
      ordinaryPriorityConfigurationKey(
        adjustment.airlineCode,
        adjustment.position
      )
    );
    const current = ordinaryPriorityAdjustmentsByKey.get(key) ?? {
      delta: 0,
      resetBaseline: 0,
    };
    current.delta += adjustment.delta;
    current.resetBaseline += adjustment.resetBaseline ?? 0;
    ordinaryPriorityAdjustmentsByKey.set(key, current);
  }
  const recentArchivedWorkdayDates = [
    ...new Set(
      recentArchivedWorkdays(
        state.history,
        date,
        Math.max(8, state.settings.tr121H02CooldownWorkdays)
      ).map((record) => record.date)
    ),
  ].sort((left, right) => right.localeCompare(left));
  return {
    date,
    recentArchivedWorkdayDates,
    recentConsecutiveWorkdays: [
      ...new Set(
        recentArchivedWorkdays(state.history, date, 2).map(
          (record) => record.date
        )
      ),
    ].sort((left, right) => right.localeCompare(left)),
    recentFrequencyRecordIds: new Set(
      recentArchivedWorkdays(
        state.history,
        date,
        POSITION_FREQUENCY_WORKDAY_COUNT
      ).map((record) => record.id)
    ),
    recentEightWorkdayRecordIds: new Set(
      recentArchivedWorkdays(state.history, date, 8).map((record) => record.id)
    ),
    recordsByPosition,
    recordsByStaffId,
    ordinaryPriorityAdjustmentsByKey,
  };
}

function frequencyFactsFor(
  state: HistoryRuleFacts,
  date: string,
  facts?: ScheduleFrequencyFacts
): ScheduleFrequencyFacts {
  return facts?.date === date
    ? facts
    : createScheduleFrequencyFacts(state, date);
}

export function consecutivePositionAssignments(
  state: HistoryRuleFacts,
  staffId: string,
  flightNo: string,
  position: string,
  remark: string,
  date: string,
  facts?: ScheduleFrequencyFacts
): number {
  if (!state.settings.positionRotationEnabled) return 0;
  const scheduleFacts = frequencyFactsFor(state, date, facts);
  const records =
    scheduleFacts.recordsByPosition.get(
      [staffId, frequencyPositionKey(state, flightNo, position, remark)].join(
        "\u0000"
      )
    ) ?? [];
  const recordedDates = new Set(records.map((record) => record.date));
  let count = 0;
  for (const workday of scheduleFacts.recentConsecutiveWorkdays) {
    if (!recordedDates.has(workday)) break;
    count += 1;
  }
  return count;
}

export const POSITION_FREQUENCY_WORKDAY_COUNT = 6;

export interface PositionFrequencyProfile {
  currentMonthCount: number;
  recentWorkdayCount: number;
}

export function samePositionFrequencyProfile(
  state: HistoryRuleFacts,
  staffId: string,
  flightNo: string,
  position: string,
  remark: string,
  date: string,
  facts?: ScheduleFrequencyFacts
): PositionFrequencyProfile {
  if (!state.settings.positionRotationEnabled)
    return { currentMonthCount: 0, recentWorkdayCount: 0 };
  const scheduleFacts = frequencyFactsFor(state, date, facts);
  const matching =
    scheduleFacts.recordsByPosition.get(
      [staffId, frequencyPositionKey(state, flightNo, position, remark)].join(
        "\u0000"
      )
    ) ?? [];
  const currentMonth = /^\d{4}-\d{2}/.exec(date)?.[0] ?? "";
  return {
    currentMonthCount: matching.filter(
      (record) => record.date < date && record.date.startsWith(currentMonth)
    ).length,
    recentWorkdayCount: matching.filter((record) =>
      scheduleFacts.recentFrequencyRecordIds.has(record.id)
    ).length,
  };
}

export function positionFrequencyProfileForRule(
  state: HistoryRuleFacts,
  staffId: string,
  flightNo: string,
  rule: Pick<PositionRule, "category" | "name" | "remark" | "flightNo">,
  date: string,
  facts?: ScheduleFrequencyFacts
): PositionFrequencyProfile {
  if (
    !isOrdinaryPriorityPosition(rule, state.settings.ordinaryPriorityPositions)
  )
    return { currentMonthCount: 0, recentWorkdayCount: 0 };
  const scheduleFacts = frequencyFactsFor(state, date, facts);
  const matching =
    scheduleFacts.recordsByPosition.get(
      [
        staffId,
        ordinaryPriorityPositionKey(flightNo, rule.name, rule.remark),
      ].join("\u0000")
    ) ?? [];
  const profile = {
    currentMonthCount: matching.filter(
      (record) => record.date < date && record.date.startsWith(date.slice(0, 7))
    ).length,
    recentWorkdayCount: matching.filter((record) =>
      scheduleFacts.recentFrequencyRecordIds.has(record.id)
    ).length,
  };
  const key = ordinaryPriorityPositionKey(flightNo, rule.name, rule.remark);
  const manual = scheduleFacts.ordinaryPriorityAdjustmentsByKey.get(
    ordinaryPriorityAdjustmentKey(date.slice(0, 7), staffId, key)
  ) ?? { delta: 0, resetBaseline: 0 };
  return {
    currentMonthCount: Math.max(
      0,
      profile.currentMonthCount - manual.resetBaseline + manual.delta
    ),
    recentWorkdayCount: profile.recentWorkdayCount,
  };
}

export function positionFrequencyProfileForAssignment(
  state: PositionFrequencyFacts,
  assignment: Assignment,
  staffId: string,
  date: string,
  facts?: ScheduleFrequencyFacts
): PositionFrequencyProfile {
  const rule = assignmentRule(state, assignment);
  return rule
    ? positionFrequencyProfileForRule(
        state,
        staffId,
        assignment.flightNo,
        rule,
        date,
        facts
      )
    : { currentMonthCount: 0, recentWorkdayCount: 0 };
}

export function comparePositionFrequency(
  left: PositionFrequencyProfile,
  right: PositionFrequencyProfile
): number {
  return (
    left.currentMonthCount - right.currentMonthCount ||
    left.recentWorkdayCount - right.recentWorkdayCount
  );
}
