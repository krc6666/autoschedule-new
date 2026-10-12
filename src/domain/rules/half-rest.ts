import type { Assignment, Flight, PositionRule } from "../../model";
import { diagnoseBaseAssignmentEligibility } from "../candidates/assignment-eligibility";
import type { CandidatePriority } from "../candidates/candidate-priority";
import { assignmentRule } from "../flights/schedule-position-rules";
import { isPreNoonFlight } from "../flights/schedule-tasks";
import type { ScheduleRunPreferences } from "../shared/schedule-run-preferences";
import type { HalfRestMode } from "../shared/schedule-run-preferences";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { timeToMinutes } from "../shared/time";
import { isStrictNextWorkdayRecoveryTarget } from "../reviews/cross-day-recovery";
import type {
  DecisionVariable,
  LexicographicObjective,
  LinearConstraint,
} from "../solver/solver-port";

export interface HalfRestFacts {
  requestedStaffIds: readonly string[];
  activeStaffIds: ReadonlySet<string>;
  /** 非分队长半休人员必须至少落实一个允许时段岗位。 */
  minimumWorkStaffIds: ReadonlySet<string>;
  ignoredWarnings: readonly string[];
  modesByStaffId: ReadonlyMap<string, HalfRestMode>;
  earlyFinishStaffIds: ReadonlySet<string>;
  lateStartStaffIds: ReadonlySet<string>;
}

export interface HalfRestChoiceFact {
  variableId: string;
  staffId: string;
  startTime: string;
  endTime: string;
}

export interface HalfRestOptimizationModel {
  variables: readonly DecisionVariable[];
  constraints: readonly LinearConstraint[];
  objectives: readonly LexicographicObjective[];
}

export const HALF_REST_WARNING_PREFIX = "半休安排：";

/** 半休的“上午”指运营日早班，不包含跨午夜的凌晨航班。 */
export function isHalfRestMorningStart(startTime: string): boolean {
  const minutes = timeToMinutes(startTime);
  return Number.isFinite(minutes) && minutes >= 6 * 60 && minutes < 12 * 60;
}

export function isHalfRestWarning(message: string): boolean {
  return message.includes(HALF_REST_WARNING_PREFIX);
}

export function createHalfRestFacts(
  state: ScheduleGenerationFacts,
  preferences: ScheduleRunPreferences,
  _dutyStaffId: string | null
): HalfRestFacts {
  const activeStaffIds = new Set<string>();
  const modesByStaffId = new Map<string, HalfRestMode>();
  const ignoredWarnings: string[] = [];
  for (const staffId of preferences.halfRestStaffIds) {
    const person = state.staff.find((item) => item.id === staffId);
    if (!person) {
      ignoredWarnings.push(
        `${HALF_REST_WARNING_PREFIX}已选择的人员不存在，本次已忽略`
      );
      continue;
    }
    if (person.staffType !== "常规" || person.status !== "正常") {
      ignoredWarnings.push(
        `${HALF_REST_WARNING_PREFIX}${person.name}不是正常在岗的常规人员，本次不能设置半休`
      );
      continue;
    }
    activeStaffIds.add(person.id);
    modesByStaffId.set(
      person.id,
      preferences.halfRestModes?.[person.id] ?? "early-finish"
    );
  }
  return {
    requestedStaffIds: preferences.halfRestStaffIds,
    activeStaffIds,
    minimumWorkStaffIds: new Set(
      [...activeStaffIds].filter(
        (id) => !state.staff.find((person) => person.id === id)?.teamLeader
      )
    ),
    ignoredWarnings,
    modesByStaffId,
    earlyFinishStaffIds: new Set(
      [...activeStaffIds].filter(
        (id) => modesByStaffId.get(id) === "early-finish"
      )
    ),
    lateStartStaffIds: new Set(
      [...activeStaffIds].filter(
        (id) => modesByStaffId.get(id) === "late-start"
      )
    ),
  };
}

export function restrictHalfRestToEligiblePeriodCandidates(
  facts: HalfRestFacts
): HalfRestFacts {
  // 半休是用户明确的休息时段，不因该时段暂时没有岗位而降级为普通人员。
  return { ...facts };
}

export function hasHalfRestRecoveryConflict(
  priority: CandidatePriority
): boolean {
  return (
    priority.lateShiftRecovery.protectedMorningTarget ||
    priority.lateShiftRecovery.protectedLatePriorityTarget ||
    priority.lateShiftCutoff.disposition === "after-cutoff"
  );
}

export function excludeCandidateForHalfRest(options: {
  facts: HalfRestFacts;
  staffId: string;
  preNoon: boolean;
  startTime?: string;
  priority: CandidatePriority;
}): boolean {
  const selected = options.facts.activeStaffIds.has(options.staffId);
  const recoveryConflict = hasHalfRestRecoveryConflict(options.priority);
  const mode =
    options.facts.modesByStaffId.get(options.staffId) ?? "early-finish";
  const restrictedMorning =
    mode === "late-start"
      ? options.startTime !== undefined
        ? isHalfRestMorningStart(options.startTime)
        : options.preNoon
      : options.preNoon;
  if (mode === "late-start") return selected && restrictedMorning;
  return selected && (recoveryConflict || !restrictedMorning);
}

export function halfRestPeriodViolation(options: {
  facts: HalfRestFacts;
  staffId: string;
  startTime: string;
}): string | null {
  if (!options.facts.activeStaffIds.has(options.staffId)) return null;
  const mode =
    options.facts.modesByStaffId.get(options.staffId) ?? "early-finish";
  const preNoon = isHalfRestMorningStart(options.startTime);
  if (mode === "late-start" && preNoon)
    return "半休时段硬约束：上午半休人员不得安排12点前岗位";
  if (mode === "early-finish" && !preNoon)
    return "半休时段硬约束：下午半休人员不得安排12点后岗位";
  return null;
}

function isAllowedHalfRestPeriod(
  mode: HalfRestMode,
  startTime: string
): boolean {
  const preNoon =
    mode === "late-start"
      ? isHalfRestMorningStart(startTime)
      : isPreNoonFlight({ startTime });
  return mode === "late-start" ? !preNoon : preNoon;
}

export function halfRestAllowedAssignmentCount(
  assignments: readonly Assignment[],
  staffId: string,
  mode: HalfRestMode
): number {
  return assignments.filter(
    (assignment) =>
      (assignment.status === "assigned" || assignment.status === "manual") &&
      assignment.staffId === staffId &&
      isAllowedHalfRestPeriod(mode, assignment.startTime)
  ).length;
}

export function halfRestMinimumWorkViolation(options: {
  assignments: readonly Assignment[];
  facts: HalfRestFacts;
}): string[] {
  const violations: string[] = [];
  for (const staffId of options.facts.minimumWorkStaffIds) {
    const mode = options.facts.modesByStaffId.get(staffId) ?? "early-finish";
    if (halfRestAllowedAssignmentCount(options.assignments, staffId, mode) > 0)
      continue;
    violations.push(
      mode === "late-start"
        ? "半休提醒：有人上午休息，但没能安排到12点后岗位，今天允许无岗"
        : "半休提醒：有人下午休息，但没能安排到12点前岗位，今天允许无岗"
    );
  }
  return [...new Set(violations)];
}

export function halfRestBackfillStaffIds(options: {
  state: ScheduleGenerationFacts;
  facts: HalfRestFacts;
  flight: Flight;
  rule: PositionRule;
}): readonly string[] {
  if (isPreNoonFlight(options.flight)) return [];
  return [...options.facts.earlyFinishStaffIds].filter((staffId) => {
    const person = options.state.staff.find((item) => item.id === staffId);
    return Boolean(
      person &&
      diagnoseBaseAssignmentEligibility(
        options.state,
        options.flight,
        options.rule,
        person
      ).eligible
    );
  });
}

export function halfRestRestrictedStaffIds(options: {
  state: ScheduleGenerationFacts;
  facts: HalfRestFacts;
  flight: Flight;
  rule: PositionRule;
}): readonly string[] {
  return [...options.facts.activeStaffIds].filter((staffId) => {
    const person = options.state.staff.find((item) => item.id === staffId);
    if (
      !person ||
      !diagnoseBaseAssignmentEligibility(
        options.state,
        options.flight,
        options.rule,
        person
      ).eligible
    )
      return false;
    const mode = options.facts.modesByStaffId.get(staffId) ?? "early-finish";
    const preNoon =
      mode === "late-start"
        ? isHalfRestMorningStart(options.flight.startTime)
        : isPreNoonFlight(options.flight);
    return mode === "late-start" ? preNoon : !preNoon;
  });
}

export function isStrictRecoveryHalfRestBackfill(options: {
  state: ScheduleGenerationFacts;
  facts: HalfRestFacts;
  protectedStaffIds: ReadonlySet<string>;
  staffId: string;
  flight: Flight;
  rule: PositionRule;
}): boolean {
  return (
    !options.facts.activeStaffIds.has(options.staffId) &&
    options.protectedStaffIds.has(options.staffId) &&
    isStrictNextWorkdayRecoveryTarget(options.state, {
      flightNo: options.flight.flightNo,
      position: options.rule.name,
      remark: options.rule.remark,
    }) &&
    halfRestBackfillStaffIds(options).length > 0
  );
}

export function strictRecoveryHalfRestBackfillCount(options: {
  state: ScheduleGenerationFacts;
  assignments: readonly Assignment[];
  facts: HalfRestFacts;
  protectedStaffIds: ReadonlySet<string>;
}): number {
  return options.assignments.filter((assignment) => {
    if (assignment.status !== "assigned" || !assignment.staffId) return false;
    const flight = options.state.flights.find(
      (item) => item.id === assignment.flightId
    );
    const rule = assignmentRule(options.state, assignment);
    return Boolean(
      flight &&
      rule &&
      isStrictRecoveryHalfRestBackfill({
        state: options.state,
        facts: options.facts,
        protectedStaffIds: options.protectedStaffIds,
        staffId: assignment.staffId,
        flight,
        rule,
      })
    );
  }).length;
}

function operationalEndMinutes(startTime: string, endTime: string): number {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end <= start) end += 24 * 60;
  return end;
}

export function buildHalfRestOptimizationModel(
  facts: HalfRestFacts,
  choices: readonly HalfRestChoiceFact[]
): HalfRestOptimizationModel {
  const variables: DecisionVariable[] = [];
  const constraints: LinearConstraint[] = [];
  const participationTerms: Array<{
    variableId: string;
    coefficient: number;
  }> = [];
  const latestEndTerms: Array<{ variableId: string; coefficient: number }> = [];

  for (const staffId of facts.activeStaffIds) {
    const staffChoices = choices.filter((choice) => choice.staffId === staffId);
    const mode = facts.modesByStaffId.get(staffId) ?? "early-finish";
    const targetChoices = staffChoices.filter((choice) =>
      mode === "late-start"
        ? !isHalfRestMorningStart(choice.startTime)
        : isPreNoonFlight({ startTime: choice.startTime })
    );
    const workedId = `half-rest:worked:${staffId}`;
    const latestEndId = `half-rest:latest-end:${staffId}`;
    variables.push({ id: workedId, type: "binary" });
    if (mode === "early-finish") {
      variables.push({
        id: latestEndId,
        type: "continuous",
        lowerBound: 0,
        upperBound: 2 * 24 * 60,
        lowerEnvelope: true,
      });
    }
    constraints.push({
      id: `half-rest:morning-work:${staffId}`,
      terms: [
        { variableId: workedId, coefficient: 1 },
        ...targetChoices.map((choice) => ({
          variableId: choice.variableId,
          coefficient: -1,
        })),
      ],
      upperBound: 0,
    });
    if (mode === "early-finish") {
      for (const choice of staffChoices) {
        const end = operationalEndMinutes(choice.startTime, choice.endTime);
        constraints.push({
          id: `half-rest:latest-end:${staffId}:${choice.variableId}`,
          terms: [
            { variableId: latestEndId, coefficient: 1 },
            { variableId: choice.variableId, coefficient: -end },
          ],
          lowerBound: 0,
        });
      }
    }
    participationTerms.push({ variableId: workedId, coefficient: 1 });
    if (mode === "early-finish")
      latestEndTerms.push({ variableId: latestEndId, coefficient: 1 });
  }

  const objectives: LexicographicObjective[] = [];
  if (participationTerms.length) {
    objectives.push({
      id: "half-rest-morning:participation",
      direction: "maximize",
      terms: participationTerms,
    });
  }
  if (latestEndTerms.length) {
    objectives.push({
      id: "half-rest-early-finish:latest-end",
      direction: "minimize",
      terms: latestEndTerms,
    });
  }
  return { variables, constraints, objectives };
}

function latestAssignedEnd(
  assignments: readonly Assignment[],
  staffId: string
): number {
  return Math.max(
    0,
    ...assignments
      .filter(
        (assignment) =>
          assignment.status === "assigned" && assignment.staffId === staffId
      )
      .map((assignment) =>
        operationalEndMinutes(assignment.startTime, assignment.endTime)
      )
  );
}

export function halfRestRegressionReasons(
  before: readonly Assignment[],
  after: readonly Assignment[],
  facts: HalfRestFacts
): string[] {
  const reasons: string[] = [];
  for (const staffId of facts.activeStaffIds) {
    const mode = facts.modesByStaffId.get(staffId) ?? "early-finish";
    const hadMorning = before.some(
      (assignment) =>
        assignment.status === "assigned" &&
        assignment.staffId === staffId &&
        isPreNoonFlight({ startTime: assignment.startTime })
    );
    const hasMorning = after.some(
      (assignment) =>
        assignment.status === "assigned" &&
        assignment.staffId === staffId &&
        isPreNoonFlight({ startTime: assignment.startTime })
    );
    if (mode === "early-finish" && hadMorning && !hasMorning)
      reasons.push("调整会使半休人员失去12点前岗位");
    if (
      mode === "early-finish" &&
      latestAssignedEnd(after, staffId) > latestAssignedEnd(before, staffId)
    )
      reasons.push("调整会推迟半休人员的最终下班时间");
    if (
      mode === "late-start" &&
      latestAssignedEnd(after, staffId) < latestAssignedEnd(before, staffId)
    )
      reasons.push("调整会使上午半休人员失去最晚结束航班");
  }
  return [...new Set(reasons)];
}

export function halfRestBackfillRejectionReason(options: {
  state: ScheduleGenerationFacts;
  target: Assignment;
  facts: HalfRestFacts;
}): string | null {
  const flight = options.state.flights.find(
    (item) => item.id === options.target.flightId
  );
  const rule = assignmentRule(options.state, options.target);
  if (!flight || !rule || !options.facts.activeStaffIds.size) return null;
  return halfRestBackfillStaffIds({
    state: options.state,
    facts: options.facts,
    flight,
    rule,
  }).length
    ? "该岗位的其他资质人员已设置半休，不能重新安排到后续岗位"
    : null;
}
