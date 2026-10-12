import type { Assignment } from "../../model";
import {
  assignmentRule,
  makeUnfilled,
} from "../flights/schedule-position-rules";
import { createAssignedPosition } from "./assignment-factory";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import { durationHours } from "../shared/time";
import { intervalsOverlap } from "../shared/time";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  groupStaffFlightsByNormalizedNumber,
  normalizeStaffFlightNumber,
} from "../statistics/staff-flight-count";
import { setAutomaticVacancyEvidence } from "./vacancy-evidence";
import { clearAutomaticAssignmentEvidence } from "./assignment-evidence";
import { clearSupervisorFillLink } from "../coverage/supervisor-fill-facts";

export interface DailyFlightCountBalanceEnforcementOptions {
  dutyStaffId: string | null;
  halfRestStaffIds?: ReadonlySet<string>;
  lockedAssignmentIds?: ReadonlySet<string>;
  candidateStaffIds?: ReadonlySet<string>;
  useFullEligibility?: boolean;
  /** Vacancy fallback may release a locked group but must not reassign it. */
  allowTransfers?: boolean;
}

export interface DailyFlightCountBalanceEnforcementResult {
  spread: number;
  changed: boolean;
}

function participantIds(
  state: Pick<ScheduleGenerationFacts, "staff" | "settings" | "positionRules">,
  options: DailyFlightCountBalanceEnforcementOptions
): Set<string> {
  const qualifiedIds =
    options.candidateStaffIds ??
    new Set(state.positionRules.flatMap((rule) => rule.qualifiedStaffIds));
  return new Set(
    state.staff
      .filter(
        (person) =>
          person.status === "正常" &&
          person.staffType === "常规" &&
          person.id !== options.dutyStaffId &&
          qualifiedIds.has(person.id) &&
          !(
            state.settings.dailyFlightCountBalanceExemptHalfRest &&
            options.halfRestStaffIds?.has(person.id)
          ) &&
          !(
            state.settings.dailyFlightCountBalanceExemptTeamLeaders &&
            person.teamLeader
          )
      )
      .map((person) => person.id)
  );
}

function assignedGroups(
  assignments: readonly Assignment[],
  ids: ReadonlySet<string>
): Map<string, Map<string, Assignment[]>> {
  const grouped = groupStaffFlightsByNormalizedNumber(
    assignments.flatMap((assignment) =>
      assignment.status === "assigned" &&
      assignment.staffId &&
      ids.has(assignment.staffId)
        ? [
            {
              staffId: assignment.staffId,
              flightNo: assignment.flightNo,
              assignment,
            },
          ]
        : []
    )
  );
  return new Map(
    [...grouped].map(([staffId, flights]) => [
      staffId,
      new Map(
        [...flights].map(([flightNo, entries]) => [
          flightNo,
          entries.map((entry) => entry.assignment),
        ])
      ),
    ])
  );
}

function spreadOf(
  assignments: readonly Assignment[],
  ids: ReadonlySet<string>
): {
  spread: number;
  groups: Map<string, Map<string, Assignment[]>>;
  maximum: number;
  minimum: number;
} {
  const groups = assignedGroups(assignments, ids);
  const counts = [...ids].map((staffId) => groups.get(staffId)?.size ?? 0);
  const maximum = Math.max(0, ...counts);
  const minimum = counts.length ? Math.min(...counts) : 0;
  return { spread: maximum - minimum, groups, maximum, minimum };
}

function releaseFlightGroup(
  state: Pick<ScheduleGenerationFacts, "flights" | "positionRules">,
  entries: readonly Assignment[],
  lockedAssignmentIds: ReadonlySet<string>
): boolean {
  if (
    !entries.length ||
    entries.some((assignment) => lockedAssignmentIds.has(assignment.id))
  )
    return false;
  const replacements = entries.map((assignment) => {
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = assignmentRule(state, assignment);
    if (!flight || !rule) return null;
    const vacancy = makeUnfilled(flight, assignment.position, rule);
    return { assignment, vacancy };
  });
  if (replacements.some((replacement) => !replacement)) return false;
  const validReplacements = replacements as Array<{
    assignment: Assignment;
    vacancy: Assignment;
  }>;
  if (
    validReplacements.some(
      ({ assignment, vacancy }) =>
        assignment.status !== "assigned" ||
        assignmentRule(state, assignment)?.manual ||
        vacancy.status !== "unfilled"
    )
  )
    return false;
  validReplacements.forEach(({ assignment, vacancy }) => {
    vacancy.id = assignment.id;
    vacancy.manualRemark = assignment.manualRemark;
    clearAutomaticAssignmentEvidence(assignment);
    clearSupervisorFillLink(assignment);
    Object.assign(assignment, vacancy);
    setAutomaticVacancyEvidence(assignment, {
      reason: "daily-flight-count-balance",
      blockers: [
        `高航班数人员的 ${normalizeStaffFlightNumber(assignment.flightNo)} 岗位在均衡回退中留空`,
      ],
    });
  });
  return true;
}

function transferFlightGroup(
  state: Pick<
    ScheduleGenerationFacts,
    "staff" | "settings" | "positionRules" | "flights" | "assignments"
  >,
  assignments: Assignment[],
  entries: readonly Assignment[],
  targetStaffId: string,
  lockedAssignmentIds: ReadonlySet<string>
): boolean {
  if (
    !entries.length ||
    entries.some(
      (assignment) =>
        lockedAssignmentIds.has(assignment.id) ||
        assignmentRule(state, assignment)?.manual
    )
  )
    return false;
  const target = state.staff.find((person) => person.id === targetStaffId);
  if (!target) return false;
  const entryIds = new Set(entries.map((assignment) => assignment.id));
  const simulated = assignments.filter(
    (assignment) => !entryIds.has(assignment.id)
  );
  const replacements: Assignment[] = [];
  for (const assignment of entries) {
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = assignmentRule(state, assignment);
    if (!flight || !rule || !rule.qualifiedStaffIds.includes(target.id))
      return false;
    const replacement = createAssignedPosition(
      { key: `${flight.id}:${rule.id}`, flight, rule },
      target,
      assignment.workHours > 0
        ? durationHours(flight.startTime, flight.endTime)
        : 0,
      [],
      []
    );
    if (
      !evaluateAutomaticHardConstraints({
        state,
        assignments: [...simulated, ...replacements],
        flight,
        rule,
        person: target,
        workHours: replacement.workHours,
      }).eligible
    )
      return false;
    replacements.push(replacement);
  }
  const byId = new Map(
    replacements.map((replacement, index) => [entries[index]!.id, replacement])
  );
  for (const assignment of entries) {
    const replacement = byId.get(assignment.id);
    if (!replacement) return false;
    assignment.staffId = replacement.staffId;
    assignment.staffName = replacement.staffName;
    assignment.workHours = replacement.workHours;
    assignment.fatiguePoints = replacement.fatiguePoints;
  }
  return true;
}

function quickTransferFlightGroup(
  state: Pick<
    ScheduleGenerationFacts,
    "staff" | "settings" | "positionRules" | "flights"
  >,
  assignments: Assignment[],
  entries: readonly Assignment[],
  targetStaffId: string,
  lockedAssignmentIds: ReadonlySet<string>
): boolean {
  if (
    !entries.length ||
    entries.some(
      (assignment) =>
        lockedAssignmentIds.has(assignment.id) ||
        assignmentRule(state, assignment)?.manual
    )
  )
    return false;
  const target = state.staff.find((person) => person.id === targetStaffId);
  if (!target) return false;
  const entryIds = new Set(entries.map((assignment) => assignment.id));
  const existing = assignments.filter(
    (assignment) =>
      !entryIds.has(assignment.id) &&
      assignment.status === "assigned" &&
      assignment.staffId === targetStaffId &&
      assignment.workHours > 0
  );
  let hours = existing.reduce(
    (sum, assignment) => sum + assignment.workHours,
    0
  );
  for (const assignment of entries) {
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = assignmentRule(state, assignment);
    if (!flight || !rule || !rule.qualifiedStaffIds.includes(targetStaffId))
      return false;
    if (
      existing.some((other) =>
        intervalsOverlap(
          assignment.startTime,
          assignment.endTime,
          other.startTime,
          other.endTime
        )
      )
    )
      return false;
    hours += assignment.workHours;
  }
  if (hours > state.settings.maxDailyHours) return false;
  for (const assignment of entries) {
    assignment.staffId = target.id;
    assignment.staffName = target.name;
  }
  return true;
}

export function enforceDailyFlightCountBalance(
  state: Pick<
    ScheduleGenerationFacts,
    "staff" | "settings" | "positionRules" | "flights" | "assignments"
  >,
  assignments: Assignment[],
  options: DailyFlightCountBalanceEnforcementOptions
): DailyFlightCountBalanceEnforcementResult {
  const ids = participantIds(state, options);
  if (ids.size < 2) return { spread: 0, changed: false };
  const locked = options.lockedAssignmentIds ?? new Set<string>();
  let changed = false;
  while (true) {
    const current = spreadOf(assignments, ids);
    if (current.spread <= 1) return { spread: current.spread, changed };
    const highStaffIds = [...ids].filter(
      (staffId) => (current.groups.get(staffId)?.size ?? 0) === current.maximum
    );
    const releaseCandidates = highStaffIds
      .flatMap((staffId) => [...(current.groups.get(staffId)?.values() ?? [])])
      .sort((left, right) => left.length - right.length);
    const lowStaffIds = [...ids].filter(
      (staffId) => (current.groups.get(staffId)?.size ?? 0) === current.minimum
    );
    const transfer =
      state.flights.length > 5 && !options.useFullEligibility
        ? quickTransferFlightGroup
        : transferFlightGroup;
    const transferred =
      options.allowTransfers !== false &&
      releaseCandidates.some((group) =>
        lowStaffIds.some((targetStaffId) =>
          transfer(state, assignments, group, targetStaffId, locked)
        )
      );
    const released =
      transferred ||
      releaseCandidates.some((release) =>
        releaseFlightGroup(state, release, locked)
      );
    if (!released) return { spread: current.spread, changed };
    changed = true;
  }
}
