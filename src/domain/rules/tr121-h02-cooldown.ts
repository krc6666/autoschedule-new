import type { Assignment, HistoryRecord, PositionRule } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { ScheduleFrequencyFacts } from "../statistics/schedule-frequency";
import {
  latePriorityFrequencyKinds,
  normalizeLatePriorityPositionReference,
} from "../reviews/late-priority-policy";
import { assignmentRule } from "../flights/schedule-position-rules";
import {
  flightHasSpecialRule,
  type FlightIdentityFacts,
} from "../flights/flight-identities";

export interface Tr121H02CooldownProfile {
  applies: boolean;
  inCooldown: boolean;
  remainingWorkdays: number;
  lastAssignedDate: string | null;
}

const NOT_APPLICABLE: Tr121H02CooldownProfile = {
  applies: false,
  inCooldown: false,
  remainingWorkdays: 0,
  lastAssignedDate: null,
};

export function isTr121H02NumberOne(
  flightNo: string,
  target: Pick<PositionRule, "name" | "remark">,
  context: FlightIdentityFacts = {},
  date?: string
): boolean {
  return (
    flightHasSpecialRule(context, flightNo, "TR121", date) &&
    normalizeLatePriorityPositionReference(target.name) === "H02" &&
    latePriorityFrequencyKinds(target).includes("number-one")
  );
}

function isMatchingHistoryRecord(
  record: HistoryRecord,
  context: FlightIdentityFacts
): boolean {
  return isTr121H02NumberOne(
    record.flightNo,
    {
      name: record.position,
      remark: record.remark,
    },
    context,
    record.date
  );
}

export function tr121H02CooldownProfile(
  state: Pick<ScheduleGenerationFacts, "history" | "settings"> &
    FlightIdentityFacts,
  staffId: string,
  flightNo: string,
  target: Pick<PositionRule, "name" | "remark">,
  date: string,
  facts: ScheduleFrequencyFacts
): Tr121H02CooldownProfile {
  const cooldownWorkdays = state.settings.tr121H02CooldownWorkdays;
  if (
    cooldownWorkdays <= 0 ||
    facts.date !== date ||
    !isTr121H02NumberOne(flightNo, target, state, date)
  )
    return NOT_APPLICABLE;
  const matchingDates = new Set(
    state.history
      .filter(
        (record) =>
          record.staffId === staffId &&
          record.date < date &&
          isMatchingHistoryRecord(record, state)
      )
      .map((record) => record.date)
  );
  const lastAssignedIndex = facts.recentArchivedWorkdayDates.findIndex((item) =>
    matchingDates.has(item)
  );
  if (lastAssignedIndex < 0)
    return {
      applies: true,
      inCooldown: false,
      remainingWorkdays: 0,
      lastAssignedDate: null,
    };
  const remainingWorkdays = Math.max(0, cooldownWorkdays - lastAssignedIndex);
  return {
    applies: true,
    inCooldown: remainingWorkdays > 0,
    remainingWorkdays,
    lastAssignedDate: facts.recentArchivedWorkdayDates[lastAssignedIndex]!,
  };
}

export function compareTr121H02Cooldown(
  left: Tr121H02CooldownProfile,
  right: Tr121H02CooldownProfile
): number {
  if (!left.applies || !right.applies) return 0;
  return (
    Number(left.inCooldown) - Number(right.inCooldown) ||
    left.remainingWorkdays - right.remainingWorkdays
  );
}

type CooldownQuality = readonly [violations: number, remainingWorkdays: number];

export function tr121H02CooldownQuality(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  date: string,
  facts: ScheduleFrequencyFacts
): CooldownQuality {
  let violations = 0;
  let remainingWorkdays = 0;
  for (const assignment of assignments) {
    if (assignment.status !== "assigned" || !assignment.staffId) continue;
    const rule = assignmentRule(state, assignment);
    if (!rule || !isTr121H02NumberOne(assignment.flightNo, rule, state, date))
      continue;
    const profile = tr121H02CooldownProfile(
      state,
      assignment.staffId,
      assignment.flightNo,
      rule,
      date,
      facts
    );
    if (!profile.inCooldown) continue;
    violations += 1;
    remainingWorkdays += profile.remainingWorkdays;
  }
  return [violations, remainingWorkdays];
}

export function worsensTr121H02Cooldown(
  state: ScheduleGenerationFacts,
  before: readonly Assignment[],
  after: readonly Assignment[],
  date: string,
  facts: ScheduleFrequencyFacts
): boolean {
  const beforeQuality = tr121H02CooldownQuality(state, before, date, facts);
  const afterQuality = tr121H02CooldownQuality(state, after, date, facts);
  return (
    afterQuality[0] > beforeQuality[0] ||
    (afterQuality[0] === beforeQuality[0] && afterQuality[1] > beforeQuality[1])
  );
}
