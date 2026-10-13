import type {
  Assignment,
  Flight,
  HistoryRecord,
  PositionRule,
} from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  createScheduleFrequencyFacts,
  type ScheduleFrequencyFacts,
} from "./schedule-frequency";
import {
  isLatePriorityPosition,
  isSupervisorPosition,
  LATE_PRIORITY_ALLOWED_DIFFERENCE,
  latePriorityFrequencyKinds,
  LATE_PRIORITY_FREQUENCY_ORDER,
  normalizeLatePriorityFlightNumber,
  normalizeLatePriorityPositionReference,
  type LatePriorityFrequencyKind,
} from "../reviews/late-priority-policy";
import { assignmentRule } from "../flights/schedule-position-rules";
import { latePriorityFlightInScope } from "./late-priority-flight-scope";

function manualAdjustmentCount(
  state: ScheduleGenerationFacts,
  staffId: string,
  month: string,
  flightNo: string | undefined,
  kind: LatePriorityFrequencyKind
): number {
  const normalizedFlight =
    flightNo && normalizeLatePriorityFlightNumber(flightNo);
  return (state.latePriorityFrequencyAdjustments ?? [])
    .filter((item) => {
      const itemFlight = normalizeLatePriorityFlightNumber(item.flightNo);
      return (
        item.month === month &&
        item.staffId === staffId &&
        item.kind === kind &&
        (normalizedFlight
          ? itemFlight === normalizedFlight
          : latePriorityFlightInScope(
              state.settings.latePriorityFlightNumbers,
              itemFlight
            )) &&
        state.positionRules.some(
          (rule) =>
            rule.category === "常规" &&
            normalizeLatePriorityFlightNumber(rule.flightNo) === itemFlight &&
            latePriorityFrequencyKinds(rule).includes(kind)
        )
      );
    })
    .reduce((sum, item) => sum + item.delta, 0);
}

export interface LatePriorityFrequencyCount {
  currentMonthCount: number;
  recentWorkdayCount: number;
}

export interface LatePriorityFrequencyProfile {
  applies: boolean;
  targetKinds: readonly LatePriorityFrequencyKind[];
  previousWorkdayAssigned: boolean;
  supervisorQualified: boolean;
  supervisorRotationDeficit: number;
  categoryBoundaryExcess: Readonly<Record<LatePriorityFrequencyKind, number>>;
  counts: Readonly<
    Record<LatePriorityFrequencyKind, LatePriorityFrequencyCount>
  >;
  totalCurrentMonthCount: number;
  totalRecentWorkdayCount: number;
}

function emptyCounts(): Record<
  LatePriorityFrequencyKind,
  LatePriorityFrequencyCount
> {
  return {
    supervisor: { currentMonthCount: 0, recentWorkdayCount: 0 },
    "number-one": { currentMonthCount: 0, recentWorkdayCount: 0 },
    declaration: { currentMonthCount: 0, recentWorkdayCount: 0 },
    delivery: { currentMonthCount: 0, recentWorkdayCount: 0 },
  };
}

function emptyBoundaryExcess(): Record<LatePriorityFrequencyKind, number> {
  return { supervisor: 0, "number-one": 0, declaration: 0, delivery: 0 };
}

const EMPTY_LATE_PRIORITY_FREQUENCY: LatePriorityFrequencyProfile = {
  applies: false,
  targetKinds: [],
  previousWorkdayAssigned: false,
  supervisorQualified: false,
  supervisorRotationDeficit: 0,
  categoryBoundaryExcess: emptyBoundaryExcess(),
  counts: emptyCounts(),
  totalCurrentMonthCount: 0,
  totalRecentWorkdayCount: 0,
};

function historyRule(
  state: ScheduleGenerationFacts,
  record: HistoryRecord
): PositionRule | undefined {
  return state.positionRules.find(
    (rule) =>
      rule.category === "常规" &&
      normalizeLatePriorityFlightNumber(rule.flightNo) ===
        normalizeLatePriorityFlightNumber(record.flightNo) &&
      normalizeLatePriorityPositionReference(rule.name) ===
        normalizeLatePriorityPositionReference(record.position) &&
      latePriorityFrequencyKinds(rule).some((kind) =>
        latePriorityFrequencyKinds({
          name: record.position,
          remark: record.remark,
        }).includes(kind)
      )
  );
}

function isScopedLatePriorityHistoryRecord(
  state: ScheduleGenerationFacts,
  record: HistoryRecord
): boolean {
  const rule = historyRule(state, record);
  return Boolean(
    rule &&
    latePriorityFlightInScope(
      state.settings.latePriorityFlightNumbers,
      record.flightNo
    ) &&
    isLatePriorityPosition(rule, record, state.settings.lateShiftEndTime)
  );
}

function countForKind(
  records: readonly HistoryRecord[],
  kind: LatePriorityFrequencyKind
): number {
  return new Set(
    records.flatMap((record) =>
      latePriorityFrequencyKinds({
        name: record.position,
        remark: record.remark,
      }).includes(kind) && !(kind === "supervisor" && record.teamLeaderGapFill)
        ? [
            [
              record.date,
              normalizeLatePriorityFlightNumber(record.flightNo),
              kind,
            ].join("\u0000"),
          ]
        : []
    )
  ).size;
}

function hasCountedLatePriorityKind(record: HistoryRecord): boolean {
  return latePriorityFrequencyKinds({
    name: record.position,
    remark: record.remark,
  }).some((kind) => !(kind === "supervisor" && record.teamLeaderGapFill));
}

function totalCount(
  counts: Readonly<
    Record<LatePriorityFrequencyKind, LatePriorityFrequencyCount>
  >,
  period: keyof LatePriorityFrequencyCount
): number {
  return LATE_PRIORITY_FREQUENCY_ORDER.reduce(
    (sum, kind) => sum + counts[kind][period],
    0
  );
}

function scopedRecordsForStaff(
  state: ScheduleGenerationFacts,
  staffId: string,
  date: string,
  facts: ScheduleFrequencyFacts
): HistoryRecord[] {
  return (facts.recordsByStaffId.get(staffId) ?? []).filter(
    (record) =>
      record.date < date && isScopedLatePriorityHistoryRecord(state, record)
  );
}

function currentMonthKindCount(
  state: ScheduleGenerationFacts,
  staffId: string,
  date: string,
  kind: LatePriorityFrequencyKind,
  facts: ScheduleFrequencyFacts,
  cache: LatePriorityHistoryCache
): number {
  return historicalStaffProfile(state, staffId, date, facts, cache).counts[kind]
    .currentMonthCount;
}

type HistoricalStaffProfile = Pick<
  LatePriorityFrequencyProfile,
  "counts" | "previousWorkdayAssigned" | "supervisorQualified"
>;

interface LatePriorityHistoryCache {
  configuration: string;
  staffProfiles: Map<string, HistoricalStaffProfile>;
}

// Lifetime is the immutable history snapshot of one run, never the application
// state. Today's assignments are deliberately NOT cached here.
const historyCaches = new WeakMap<
  ScheduleFrequencyFacts,
  LatePriorityHistoryCache
>();

function historyCache(
  state: ScheduleGenerationFacts,
  facts: ScheduleFrequencyFacts
): LatePriorityHistoryCache {
  const configuration = JSON.stringify([
    state.settings.latePriorityFlightNumbers,
    state.settings.lateShiftEndTime,
    state.positionRules.map((rule) => [
      rule.category,
      rule.flightNo,
      rule.name,
      rule.remark,
      rule.qualifiedStaffIds,
    ]),
    state.latePriorityFrequencyAdjustments,
  ]);
  const existing = historyCaches.get(facts);
  if (existing?.configuration === configuration) return existing;
  const cache = {
    configuration,
    staffProfiles: new Map<string, HistoricalStaffProfile>(),
  };
  historyCaches.set(facts, cache);
  return cache;
}

function historicalStaffProfile(
  state: ScheduleGenerationFacts,
  staffId: string,
  date: string,
  facts: ScheduleFrequencyFacts,
  cache: LatePriorityHistoryCache
): HistoricalStaffProfile {
  const existing = cache.staffProfiles.get(staffId);
  if (existing) return existing;
  const month = date.slice(0, 7);
  const matching = scopedRecordsForStaff(state, staffId, date, facts);
  const monthly = matching.filter((record) => record.date.startsWith(month));
  const recent = matching.filter((record) =>
    facts.recentEightWorkdayRecordIds.has(record.id)
  );
  const counts = emptyCounts();
  for (const kind of LATE_PRIORITY_FREQUENCY_ORDER) {
    counts[kind] = {
      currentMonthCount: Math.max(
        0,
        countForKind(monthly, kind) +
          manualAdjustmentCount(state, staffId, month, undefined, kind)
      ),
      recentWorkdayCount: countForKind(recent, kind),
    };
  }
  const previousDate = facts.recentConsecutiveWorkdays[0];
  const profile = {
    counts,
    previousWorkdayAssigned: Boolean(
      previousDate &&
      matching.some(
        (record) =>
          record.date === previousDate && hasCountedLatePriorityKind(record)
      )
    ),
    supervisorQualified: supervisorQualifiedForScope(state, staffId),
  };
  cache.staffProfiles.set(staffId, profile);
  return profile;
}

function supervisorQualifiedForScope(
  state: ScheduleGenerationFacts,
  staffId: string
): boolean {
  return state.positionRules.some(
    (rule) =>
      rule.category === "常规" &&
      latePriorityFlightInScope(
        state.settings.latePriorityFlightNumbers,
        rule.flightNo
      ) &&
      isSupervisorPosition(rule) &&
      rule.qualifiedStaffIds.includes(staffId)
  );
}

function supervisorRotationDeficit(
  state: ScheduleGenerationFacts,
  staffId: string,
  date: string,
  facts: ScheduleFrequencyFacts,
  cache: LatePriorityHistoryCache
): number {
  if (!supervisorQualifiedForScope(state, staffId)) return 0;
  const qualifiedIds = new Set(
    state.positionRules.flatMap((rule) =>
      rule.category === "常规" &&
      latePriorityFlightInScope(
        state.settings.latePriorityFlightNumbers,
        rule.flightNo
      ) &&
      isSupervisorPosition(rule)
        ? rule.qualifiedStaffIds
        : []
    )
  );
  const counts = [...qualifiedIds].map((qualifiedStaffId) =>
    currentMonthKindCount(
      state,
      qualifiedStaffId,
      date,
      "supervisor",
      facts,
      cache
    )
  );
  return Math.max(
    0,
    Math.max(0, ...counts) -
      currentMonthKindCount(state, staffId, date, "supervisor", facts, cache)
  );
}

function categoryBoundaryExcess(
  state: ScheduleGenerationFacts,
  staffId: string,
  rule: Pick<PositionRule, "qualifiedStaffIds" | "name" | "remark">,
  date: string,
  facts: ScheduleFrequencyFacts,
  cache: LatePriorityHistoryCache
): Record<LatePriorityFrequencyKind, number> {
  const result = emptyBoundaryExcess();
  const eligibleIds = rule.qualifiedStaffIds.filter((qualifiedStaffId) => {
    const person = state.staff.find((item) => item.id === qualifiedStaffId);
    return person?.status === "正常" && person.staffType === "常规";
  });
  if (!eligibleIds.length) return result;
  for (const kind of latePriorityFrequencyKinds(rule)) {
    const counts = eligibleIds.map((qualifiedStaffId) =>
      currentMonthKindCount(state, qualifiedStaffId, date, kind, facts, cache)
    );
    const minimum = counts.length ? Math.min(...counts) : 0;
    const projected =
      currentMonthKindCount(state, staffId, date, kind, facts, cache) + 1;
    result[kind] = Math.max(
      0,
      projected - (minimum + LATE_PRIORITY_ALLOWED_DIFFERENCE[kind])
    );
  }
  return result;
}

export function latePriorityFrequencyProfileForRule(
  state: ScheduleGenerationFacts,
  staffId: string,
  flight: Pick<Flight, "startTime" | "endTime">,
  rule: Pick<
    PositionRule,
    "flightNo" | "category" | "name" | "remark" | "qualifiedStaffIds"
  >,
  date: string,
  facts?: ScheduleFrequencyFacts
): LatePriorityFrequencyProfile {
  if (
    !state.settings.positionRotationEnabled ||
    !latePriorityFlightInScope(
      state.settings.latePriorityFlightNumbers,
      rule.flightNo
    ) ||
    !isLatePriorityPosition(rule, flight, state.settings.lateShiftEndTime)
  )
    return EMPTY_LATE_PRIORITY_FREQUENCY;
  const scheduleFacts =
    facts?.date === date ? facts : createScheduleFrequencyFacts(state, date);
  const cache = historyCache(state, scheduleFacts);
  const historical = historicalStaffProfile(
    state,
    staffId,
    date,
    scheduleFacts,
    cache
  );
  const counts = historical.counts;
  return {
    applies: true,
    targetKinds: latePriorityFrequencyKinds(rule),
    previousWorkdayAssigned: historical.previousWorkdayAssigned,
    supervisorQualified: historical.supervisorQualified,
    supervisorRotationDeficit: supervisorRotationDeficit(
      state,
      staffId,
      date,
      scheduleFacts,
      cache
    ),
    categoryBoundaryExcess: categoryBoundaryExcess(
      state,
      staffId,
      rule,
      date,
      scheduleFacts,
      cache
    ),
    counts,
    totalCurrentMonthCount: totalCount(counts, "currentMonthCount"),
    totalRecentWorkdayCount: totalCount(counts, "recentWorkdayCount"),
  };
}

export function isLatePriorityAssignment(
  state: ScheduleGenerationFacts,
  assignment: Assignment
): boolean {
  const rule = assignmentRule(state, assignment);
  return Boolean(
    rule &&
    assignment.status === "assigned" &&
    assignment.staffId &&
    latePriorityFlightInScope(
      state.settings.latePriorityFlightNumbers,
      assignment.flightNo
    ) &&
    isLatePriorityPosition(rule, assignment, state.settings.lateShiftEndTime)
  );
}

export function latePriorityFrequencyProfileForAssignment(
  state: ScheduleGenerationFacts,
  staffId: string,
  assignment: Assignment,
  date: string,
  facts?: ScheduleFrequencyFacts
): LatePriorityFrequencyProfile {
  const rule = assignmentRule(state, assignment);
  if (!rule) return EMPTY_LATE_PRIORITY_FREQUENCY;
  return latePriorityFrequencyProfileForRule(
    state,
    staffId,
    assignment,
    rule,
    date,
    facts
  );
}

export function latePriorityFrequencyProfileWithSchedule(
  state: ScheduleGenerationFacts,
  staffId: string,
  target: Assignment,
  assignments: readonly Assignment[],
  date: string,
  facts?: ScheduleFrequencyFacts
): LatePriorityFrequencyProfile {
  const historical = latePriorityFrequencyProfileForAssignment(
    state,
    staffId,
    target,
    date,
    facts
  );
  if (!historical.applies) return historical;
  const current = assignments.filter(
    (assignment) =>
      assignment.staffId === staffId &&
      isLatePriorityAssignment(state, assignment)
  );
  const counts = emptyCounts();
  for (const kind of LATE_PRIORITY_FREQUENCY_ORDER) {
    const currentKeys = new Set(
      current.flatMap((assignment) => {
        const rule = assignmentRule(state, assignment);
        return rule &&
          latePriorityFrequencyKinds(rule).includes(kind) &&
          !(kind === "supervisor" && assignment.teamLeaderGapFill)
          ? [
              [
                date,
                normalizeLatePriorityFlightNumber(assignment.flightNo),
                kind,
              ].join("\u0000"),
            ]
          : [];
      })
    );
    counts[kind] = {
      currentMonthCount:
        historical.counts[kind].currentMonthCount + currentKeys.size,
      recentWorkdayCount: historical.counts[kind].recentWorkdayCount,
    };
  }
  return {
    ...historical,
    counts,
    totalCurrentMonthCount: totalCount(counts, "currentMonthCount"),
    totalRecentWorkdayCount: totalCount(counts, "recentWorkdayCount"),
  };
}

export function compareLatePriorityAggregate(
  left: LatePriorityFrequencyProfile,
  right: LatePriorityFrequencyProfile
): number {
  if (!left.applies || !right.applies) return 0;
  return (
    Number(left.previousWorkdayAssigned) -
      Number(right.previousWorkdayAssigned) ||
    left.totalCurrentMonthCount - right.totalCurrentMonthCount ||
    left.totalRecentWorkdayCount - right.totalRecentWorkdayCount
  );
}

export function compareLatePriorityCategoryBoundary(
  left: LatePriorityFrequencyProfile,
  right: LatePriorityFrequencyProfile
): number {
  if (!left.applies || !right.applies) return 0;
  for (const kind of LATE_PRIORITY_FREQUENCY_ORDER) {
    if (!left.targetKinds.includes(kind) || !right.targetKinds.includes(kind))
      continue;
    const difference =
      left.categoryBoundaryExcess[kind] - right.categoryBoundaryExcess[kind];
    if (difference) return difference;
  }
  return 0;
}

export function compareLatePriorityFrequencyForKind(
  left: LatePriorityFrequencyProfile,
  right: LatePriorityFrequencyProfile,
  kind: LatePriorityFrequencyKind
): number {
  if (
    !left.applies ||
    !right.applies ||
    !left.targetKinds.includes(kind) ||
    !right.targetKinds.includes(kind)
  )
    return 0;
  if (kind !== "supervisor") {
    const reserveDifference =
      left.supervisorRotationDeficit - right.supervisorRotationDeficit;
    if (reserveDifference) return reserveDifference;
  }
  const preserveSupervisorRelief =
    (kind === "declaration" || kind === "delivery") &&
    left.supervisorQualified !== right.supervisorQualified;
  return (
    left.categoryBoundaryExcess[kind] - right.categoryBoundaryExcess[kind] ||
    (preserveSupervisorRelief
      ? 0
      : left.counts[kind].currentMonthCount -
        right.counts[kind].currentMonthCount)
  );
}

export function compareLatePriorityFrequency(
  left: LatePriorityFrequencyProfile,
  right: LatePriorityFrequencyProfile
): number {
  if (!left.applies || !right.applies) return 0;
  for (const kind of LATE_PRIORITY_FREQUENCY_ORDER) {
    const difference = compareLatePriorityFrequencyForKind(left, right, kind);
    if (difference) return difference;
  }
  return 0;
}

export function latePriorityFrequencyComparisonValue(
  profile: LatePriorityFrequencyProfile,
  kind: LatePriorityFrequencyKind,
  period: keyof LatePriorityFrequencyCount
): number {
  return profile.counts[kind][period];
}

export function isTr121NumberOne(
  flightNo: string,
  rule: Pick<PositionRule, "name" | "remark">
): boolean {
  return (
    normalizeLatePriorityFlightNumber(flightNo) === "TR121" &&
    latePriorityFrequencyKinds(rule).includes("number-one")
  );
}

export function tr121NumberOneCurrentMonthCount(
  state: ScheduleGenerationFacts,
  staffId: string,
  date: string,
  facts?: ScheduleFrequencyFacts
): number {
  const scheduleFacts =
    facts?.date === date ? facts : createScheduleFrequencyFacts(state, date);
  const month = date.slice(0, 7);
  return Math.max(
    0,
    new Set(
      (scheduleFacts.recordsByStaffId.get(staffId) ?? [])
        .filter(
          (record) =>
            record.date < date &&
            record.date.startsWith(month) &&
            normalizeLatePriorityFlightNumber(record.flightNo) === "TR121" &&
            latePriorityFrequencyKinds({
              name: record.position,
              remark: record.remark,
            }).includes("number-one")
        )
        .map((record) => record.date)
    ).size + manualAdjustmentCount(state, staffId, month, "TR121", "number-one")
  );
}

export const TR121_NUMBER_ONE_MONTHLY_AUTOMATIC_LIMIT = 2;

export function exceedsTr121NumberOneAutomaticLimit(
  state: ScheduleGenerationFacts,
  staffId: string,
  flightNo: string,
  rule: Pick<PositionRule, "name" | "remark">,
  date: string,
  facts?: ScheduleFrequencyFacts
): boolean {
  return (
    isTr121NumberOne(flightNo, rule) &&
    tr121NumberOneCurrentMonthCount(state, staffId, date, facts) >=
      TR121_NUMBER_ONE_MONTHLY_AUTOMATIC_LIMIT
  );
}
