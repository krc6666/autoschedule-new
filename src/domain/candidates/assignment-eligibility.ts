import type { Assignment, Flight, PositionRule, Staff } from "../../model";
import type { AssignmentEligibilityFacts } from "../shared/scheduling-facts";
import {
  minimumFlightTransitionMessage,
  minimumFlightTransitionViolationsForInsertion,
} from "../assignments/minimum-flight-transition";
import {
  administrativeSupportAutomaticRule,
  assignmentRule,
  guideSourceStaff,
} from "../flights/schedule-position-rules";
import {
  positionTransitionCost,
  positionTransitionInsertionCost,
  violatedPositionTransitionPolicies,
  violatedPositionTransitionPoliciesForInsertion,
} from "../reviews/schedule-protection";
import {
  assignmentConflictFacts,
  assignmentHoursFacts,
  staffAssignmentFacts,
} from "./assignment-eligibility-facts";
import {
  airlineCode,
  isSameAirlinePriorityPosition,
  sameAirlinePriorityAssignmentConflict,
} from "../rules/airline-rotation";
import {
  matchingSameFlightStaffExclusion,
  sameFlightStaffExclusionPairMessage,
} from "../rules/same-flight-staff-exclusion";
import { isDailyPrimaryPosition } from "../rules/daily-primary-position";

export type AssignmentEligibilityViolationCode =
  | "missing-target"
  | "staff-unavailable"
  | "staff-type"
  | "admin-support-disabled"
  | "position-qualification"
  | "night-shift"
  | "guide-source"
  | "time-conflict"
  | "daily-hours"
  | "minimum-flight-transition"
  | "position-transition"
  | "regular-staff-priority"
  | "same-airline-priority"
  | "same-flight-staff-exclusion"
  | "daily-primary-position-unique";

export interface AssignmentEligibilityViolation {
  code: AssignmentEligibilityViolationCode;
  message: string;
}

export interface AssignmentEligibilityDiagnostic {
  eligible: boolean;
  violations: AssignmentEligibilityViolation[];
}

export interface AutomaticAssignmentEligibilityOptions {
  state: AssignmentEligibilityFacts;
  assignments: Assignment[];
  flight: Flight;
  rule: PositionRule;
  person: Staff;
  workHours?: number;
  transitionMode?: "prefer" | "forbid";
  ignoreSameFlightReusable?: boolean;
}

export interface AutomaticEligibilityPoolOptions {
  state: AssignmentEligibilityFacts;
  assignments: Assignment[];
  flight: Flight;
  rule: PositionRule;
  excludedStaffIds?: ReadonlySet<string>;
}

export interface AutomaticEligibilityPool {
  configured: Staff[];
  available: Staff[];
  nightCapable: Staff[];
  conflictFree: Staff[];
  withinHours: Staff[];
}

function violation(
  code: AssignmentEligibilityViolationCode,
  message: string
): AssignmentEligibilityDiagnostic {
  return { eligible: false, violations: [{ code, message }] };
}

function warning(
  code: AssignmentEligibilityViolationCode,
  message: string
): AssignmentEligibilityDiagnostic {
  return { eligible: true, violations: [{ code, message }] };
}

function success(): AssignmentEligibilityDiagnostic {
  return { eligible: true, violations: [] };
}

function conflictMessage(
  person: Staff,
  conflicts: readonly Assignment[]
): string {
  return `${person.name} 时间冲突：${conflicts.map((a) => `${a.flightNo}/${a.position} ${a.startTime}–${a.endTime}`).join("、")}已有排班`;
}

function dailyHoursMessage(
  person: Staff,
  projectedHours: number,
  maximum: number
): string {
  return `${person.name} 将超过每日工时上限：安排后 ${Number(projectedHours.toFixed(2))} 小时，上限 ${maximum} 小时`;
}

function positionTransitionMessage(
  options: AutomaticAssignmentEligibilityOptions,
  check: PositionTransitionCheck
): string {
  const { state, assignments, person, flight, rule, transitionMode } = options;
  const policies =
    check === "insertion"
      ? violatedPositionTransitionPoliciesForInsertion(
          assignments,
          person.id,
          flight.flightNo,
          rule.name,
          flight.startTime,
          flight.endTime,
          state,
          transitionMode ?? "forbid"
        )
      : violatedPositionTransitionPolicies(
          assignments,
          person.id,
          flight.flightNo,
          rule.name,
          flight.startTime,
          state,
          transitionMode ?? "forbid"
        );
  return `${person.name} 不满足最小衔接间隔：${policies.map((p) => `“${p.name}”（${p.sourceFlightNo || "任意航班"}/${p.sourcePositions.join("、") || "任意岗位"}→${p.targetFlightNo}/${p.targetPosition}，要求 ${p.minimumGapMinutes} 分钟）`).join("；")}；拟接${flight.flightNo}/${rule.name} ${flight.startTime}–${flight.endTime}，已排${assignments
    .filter((a) => a.status === "assigned" && a.staffId === person.id)
    .map((a) => `${a.flightNo}/${a.position} ${a.startTime}–${a.endTime}`)
    .join("、")}`;
}

function diagnostic(
  violations: AssignmentEligibilityViolation[]
): AssignmentEligibilityDiagnostic {
  return { eligible: violations.length === 0, violations };
}

export function diagnoseBaseAssignmentEligibility(
  state: AssignmentEligibilityFacts,
  flight: Pick<Flight, "startTime" | "endTime">,
  rule: PositionRule,
  person: Staff
): AssignmentEligibilityDiagnostic {
  const facts = staffAssignmentFacts(state, flight, rule, person);
  if (!facts.available)
    return violation(
      "staff-unavailable",
      `${person.name} 当前状态为${person.status}`
    );
  if (!facts.regularStaff)
    return violation("staff-type", `${person.name} 不是常规人员`);
  if (!facts.positionQualified)
    return violation(
      "position-qualification",
      `${person.name} 不具备岗位资质：不在“${rule.flightNo}/${rule.name}”资质名单`
    );
  if (!facts.nightCapable)
    return violation("night-shift", `${person.name} 不具备夜班能力`);
  return success();
}

type PositionTransitionCheck = "target-only" | "insertion";

function automaticPositionTransitionCost(
  options: AutomaticAssignmentEligibilityOptions,
  transitionCheck: PositionTransitionCheck
): number {
  const { state, assignments, flight, rule, person, transitionMode } = options;
  if (!transitionMode) return 0;
  if (transitionCheck === "target-only") {
    return positionTransitionCost(
      assignments,
      person.id,
      flight.flightNo,
      rule.name,
      flight.startTime,
      state,
      transitionMode
    );
  }
  return positionTransitionInsertionCost(
    assignments,
    person.id,
    { key: `${flight.id}:${rule.id}`, flight, rule },
    state,
    transitionMode
  );
}

function diagnoseAutomaticStaffEligibilityWithTransitionCheck(
  options: AutomaticAssignmentEligibilityOptions,
  transitionCheck: PositionTransitionCheck
): AssignmentEligibilityDiagnostic {
  const { state, assignments, flight, rule, person, transitionMode } = options;
  const base = diagnoseBaseAssignmentEligibility(state, flight, rule, person);
  if (!base.eligible) return base;
  const factOptions = {
    state,
    assignments,
    flight,
    rule,
    person,
    workHours: options.workHours,
    sameFlightConflict: options.ignoreSameFlightReusable
      ? ("allow-reusable" as const)
      : ("block" as const),
  };
  const conflicts = assignmentConflictFacts(factOptions).blockingConflicts;
  if (conflicts.length) {
    return violation("time-conflict", conflictMessage(person, conflicts));
  }
  if (!assignmentHoursFacts(factOptions).withinDailyHours) {
    return violation(
      "daily-hours",
      dailyHoursMessage(
        person,
        assignmentHoursFacts(factOptions).projectedHours,
        state.settings.maxDailyHours
      )
    );
  }
  if (
    transitionMode &&
    automaticPositionTransitionCost(options, transitionCheck) > 0
  ) {
    return violation(
      "position-transition",
      positionTransitionMessage(options, transitionCheck)
    );
  }
  return success();
}

export function diagnoseAutomaticStaffEligibility(
  options: AutomaticAssignmentEligibilityOptions
): AssignmentEligibilityDiagnostic {
  return diagnoseAutomaticStaffEligibilityWithTransitionCheck(
    options,
    "insertion"
  );
}

export function diagnoseMinimumFlightTransitionEligibility(
  options: AutomaticAssignmentEligibilityOptions
): AssignmentEligibilityDiagnostic {
  const violation = minimumFlightTransitionViolationsForInsertion(
    options.state,
    options.assignments,
    options.person.id,
    options.flight,
    options.rule
  )[0];
  return violation
    ? {
        eligible: false,
        violations: [
          {
            code: "minimum-flight-transition",
            message: minimumFlightTransitionMessage(
              options.person.name,
              violation
            ),
          },
        ],
      }
    : success();
}

export function diagnoseSameAirlinePriorityEligibility(
  options: AutomaticAssignmentEligibilityOptions,
  excludedAssignmentIds: ReadonlySet<string> = new Set()
): AssignmentEligibilityDiagnostic {
  if (options.state.settings.sameDayCrossFlightPriorityEnabled === false)
    return success();
  if (!isSameAirlinePriorityPosition(options.rule)) return success();
  const conflict = options.assignments.find((assignment) => {
    if (
      excludedAssignmentIds.has(assignment.id) ||
      assignment.status !== "assigned" ||
      assignment.staffId !== options.person.id ||
      assignment.flightId === options.flight.id
    )
      return false;
    const existingRule = assignmentRule(options.state, assignment);
    return sameAirlinePriorityAssignmentConflict(
      { ...assignment, positionRule: existingRule },
      {
        flightNo: options.flight.flightNo,
        position: options.rule.name,
        remark: options.rule.remark,
        positionRule: options.rule,
      }
    );
  });
  return conflict
    ? warning(
        "same-airline-priority",
        `${options.person.name} → 已在${conflict.flightNo}/${conflict.position}承担同日${airlineCode(options.flight.flightNo)}航司控制/一号 → 跨航班组合优先避免但当前允许人工落位 → 保留目标岗位并提示 → 可继续安排${options.flight.flightNo}/${options.rule.name}（琥珀色警告）`
      )
    : success();
}

export function diagnoseDailyPrimaryPositionEligibility(
  options: AutomaticAssignmentEligibilityOptions
): AssignmentEligibilityDiagnostic {
  if (options.state.settings.dailyPrimaryPositionUniqueEnabled === false)
    return success();
  if (!isDailyPrimaryPosition(options.state, options.flight, options.rule))
    return success();
  const conflict = options.assignments.find((assignment) => {
    if (
      assignment.status !== "assigned" ||
      assignment.staffId !== options.person.id ||
      assignment.flightId === options.flight.id
    )
      return false;
    const existingRule = assignmentRule(options.state, assignment);
    const existingFlight = options.state.flights.find(
      (flight) => flight.id === assignment.flightId
    );
    return Boolean(
      existingRule &&
      existingFlight &&
      isDailyPrimaryPosition(options.state, existingFlight, existingRule)
    );
  });
  return conflict
    ? violation(
        "daily-primary-position-unique",
        `${options.person.name}已承担${conflict.flightNo}/${conflict.position}的一号岗位，同一班表内不能再次承担非督导一号岗位`
      )
    : success();
}

export function diagnoseSameFlightStaffExclusionEligibility(
  options: AutomaticAssignmentEligibilityOptions
): AssignmentEligibilityDiagnostic {
  const conflict = options.assignments.find(
    (assignment) =>
      assignment.status === "assigned" &&
      assignment.staffId &&
      assignment.staffId !== options.person.id &&
      assignment.flightId === options.flight.id &&
      matchingSameFlightStaffExclusion(
        options.state,
        options.person.id,
        assignment.staffId,
        options.flight.flightNo
      )
  );
  if (!conflict?.staffId) return success();
  const exclusion = matchingSameFlightStaffExclusion(
    options.state,
    options.person.id,
    conflict.staffId,
    options.flight.flightNo
  )!;
  return violation(
    "same-flight-staff-exclusion",
    sameFlightStaffExclusionPairMessage(
      options.state,
      exclusion,
      options.flight.flightNo
    )
  );
}

function diagnoseAutomaticAssignmentEligibilityWithTransitionCheck(
  options: AutomaticAssignmentEligibilityOptions,
  transitionCheck: PositionTransitionCheck
): AssignmentEligibilityDiagnostic {
  const staffEligibility = diagnoseAutomaticStaffEligibilityWithTransitionCheck(
    options,
    transitionCheck
  );
  if (!staffEligibility.eligible) return staffEligibility;
  const minimumTransition = diagnoseMinimumFlightTransitionEligibility(options);
  if (!minimumTransition.eligible) return minimumTransition;
  return diagnoseSameAirlinePriorityEligibility(options);
}

export function diagnoseAutomaticAssignmentEligibility(
  options: AutomaticAssignmentEligibilityOptions
): AssignmentEligibilityDiagnostic {
  return diagnoseAutomaticAssignmentEligibilityWithTransitionCheck(
    options,
    "insertion"
  );
}

export function analyzeAutomaticEligibilityPool({
  state,
  assignments,
  flight,
  rule,
  excludedStaffIds = new Set(),
}: AutomaticEligibilityPoolOptions): AutomaticEligibilityPool {
  const staffFacts = new Map(
    state.staff.map((person) => [
      person.id,
      staffAssignmentFacts(state, flight, rule, person),
    ])
  );
  const configured = state.staff.filter(
    (person) =>
      !excludedStaffIds.has(person.id) &&
      staffFacts.get(person.id)?.regularStaff &&
      staffFacts.get(person.id)?.positionQualified
  );
  const available = configured.filter(
    (person) => staffFacts.get(person.id)?.available
  );
  const nightCapable = available.filter(
    (person) => staffFacts.get(person.id)?.nightCapable
  );
  const conflictFacts = new Map(
    nightCapable.map((person) => [
      person.id,
      assignmentConflictFacts({
        state,
        assignments,
        flight,
        rule,
        person,
      }),
    ])
  );
  const conflictFree = nightCapable.filter(
    (person) => !conflictFacts.get(person.id)?.blockingConflicts.length
  );
  const hoursFacts = new Map(
    conflictFree.map((person) => [
      person.id,
      assignmentHoursFacts({ state, assignments, flight, person }),
    ])
  );
  const withinHours = conflictFree.filter(
    (person) => hoursFacts.get(person.id)?.withinDailyHours
  );
  return { configured, available, nightCapable, conflictFree, withinHours };
}

export function eligibleStaffForRule(
  state: AssignmentEligibilityFacts,
  flight: Flight,
  rule: PositionRule
): Staff[] {
  return state.staff.filter(
    (person) =>
      diagnoseBaseAssignmentEligibility(state, flight, rule, person).eligible
  );
}

export function diagnoseManualAssignmentEligibility(
  state: AssignmentEligibilityFacts,
  assignmentId: string,
  staffId: string,
  ignoreAssignmentId?: string
): AssignmentEligibilityDiagnostic {
  const assignment = state.assignments.find((item) => item.id === assignmentId);
  const person = state.staff.find((item) => item.id === staffId);
  if (!assignment || !person)
    return violation("missing-target", "人员或岗位不存在");
  const rule = assignmentRule(state, assignment);
  const flight = state.flights.find(
    (item) => item.id === assignment.flightId
  ) ?? {
    id: assignment.flightId,
    flightNo: assignment.flightNo,
    startTime: assignment.startTime,
    endTime: assignment.endTime,
    bookedPassengers: 0,
    positions: [assignment.position],
    remark: "",
  };
  const factRule = rule ?? {
    id: assignment.positionRuleId ?? assignment.id,
    flightNo: assignment.flightNo,
    name: assignment.position,
    category: "常规" as const,
    remark: assignment.remark,
    qualifiedStaffIds: [staffId],
    manual: true,
    fatiguePoints: assignment.fatiguePoints,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  };
  const automaticSupportRule = rule
    ? administrativeSupportAutomaticRule(state, rule)
    : factRule;
  const eligibilityRule =
    person.staffType === "行政支援" ? factRule : automaticSupportRule;
  const staffFacts = staffAssignmentFacts(
    state,
    flight,
    eligibilityRule,
    person
  );
  if (!staffFacts.available)
    return violation(
      "staff-unavailable",
      `${person.name} 当前状态为${person.status}`
    );
  const administrativeStaff = person.staffType === "行政支援";
  if (administrativeStaff && !state.settings.adminSupportEnabled) {
    return violation("admin-support-disabled", "行政支援模式尚未启用");
  }
  const violations: AssignmentEligibilityViolation[] = [];
  if (administrativeStaff && (!rule || !staffFacts.positionQualified)) {
    violations.push({
      code: "position-qualification",
      message: `${person.name} 不具备岗位资质：不在“${assignment.flightNo}/${assignment.position}”资质名单`,
    });
  }
  if (
    rule &&
    rule.category !== "引导" &&
    !rule.manual &&
    !staffFacts.positionQualified
  ) {
    violations.push({
      code: "position-qualification",
      message: `${person.name} 不具备岗位资质：不在“${assignment.flightNo}/${assignment.position}”资质名单`,
    });
  }
  if (administrativeStaff && rule) {
    const otherAssignments = state.assignments.filter(
      (item) => item.id !== assignmentId
    );
    const regularAvailable = Boolean(
      state.staff.some(
        (regular) =>
          diagnoseAutomaticAssignmentEligibilityWithTransitionCheck(
            {
              state,
              assignments: otherAssignments,
              flight,
              rule: automaticSupportRule,
              person: regular,
              workHours: assignment.workHours,
              transitionMode: "forbid",
              ignoreSameFlightReusable: true,
            },
            "target-only"
          ).eligible
      )
    );
    if (regularAvailable) {
      return violation(
        "regular-staff-priority",
        "仍有满足硬约束的常规人员可用，应优先安排常规人员"
      );
    }
  }
  if (!staffFacts.nightCapable) {
    violations.push({
      code: "night-shift",
      message: `${person.name} 不可上夜班`,
    });
    return diagnostic(violations);
  }
  const reuse = rule?.category === "引导";
  const otherAssignments = state.assignments.filter(
    (item) =>
      item.id !== assignmentId && (reuse || item.id !== ignoreAssignmentId)
  );
  const others = otherAssignments.filter((item) => item.staffId === staffId);
  const exclusionConflict = otherAssignments.find(
    (item) =>
      item.status === "assigned" &&
      item.staffId &&
      item.flightId === assignment.flightId &&
      matchingSameFlightStaffExclusion(
        state,
        staffId,
        item.staffId,
        assignment.flightNo
      )
  );
  if (exclusionConflict?.staffId) {
    const exclusion = matchingSameFlightStaffExclusion(
      state,
      staffId,
      exclusionConflict.staffId,
      assignment.flightNo
    )!;
    violations.push({
      code: "same-flight-staff-exclusion",
      message: `${sameFlightStaffExclusionPairMessage(
        state,
        exclusion,
        assignment.flightNo
      )}，本次为人工突破`,
    });
  }
  const sameAirlinePriority = diagnoseSameAirlinePriorityEligibility(
    {
      state,
      assignments: state.assignments,
      flight,
      rule: factRule,
      person,
      workHours: assignment.workHours,
    },
    new Set([assignmentId, ...(ignoreAssignmentId ? [ignoreAssignmentId] : [])])
  );
  violations.push(...sameAirlinePriority.violations);
  if (reuse) {
    if (person.staffType !== "常规")
      return violation("staff-type", "引导岗位只能复用常规人员");
    const source = others.find(
      (item) =>
        item.flightId === assignment.flightId &&
        Boolean(guideSourceStaff(state, item))
    );
    if (!source)
      return violation(
        "guide-source",
        `${person.name} 未在该航班承担可复用岗位`
      );
  }
  const factOptions = {
    state,
    assignments: others,
    assignment,
    flight,
    rule: eligibilityRule,
    person,
    workHours: assignment.workHours,
    sameFlightConflict: reuse
      ? ("allow-all" as const)
      : ("allow-reusable" as const),
  };
  const conflicts = assignmentConflictFacts(factOptions).blockingConflicts;
  if (conflicts.length) {
    violations.push({
      code: "time-conflict",
      message: conflictMessage(person, conflicts),
    });
  }
  if (!assignmentHoursFacts(factOptions).withinDailyHours) {
    violations.push({
      code: "daily-hours",
      message: dailyHoursMessage(
        person,
        assignmentHoursFacts(factOptions).projectedHours,
        state.settings.maxDailyHours
      ),
    });
  }
  const minimumTransition = minimumFlightTransitionViolationsForInsertion(
    state,
    others,
    staffId,
    flight,
    eligibilityRule
  )[0];
  if (minimumTransition) {
    violations.push({
      code: "minimum-flight-transition",
      message: minimumFlightTransitionMessage(person.name, minimumTransition),
    });
  }
  if (
    positionTransitionCost(
      others,
      staffId,
      assignment.flightNo,
      assignment.position,
      assignment.startTime,
      state,
      "forbid"
    ) > 0
  ) {
    violations.push({
      code: "position-transition",
      message: positionTransitionMessage(
        {
          state,
          assignments: others,
          flight,
          rule: eligibilityRule,
          person,
          transitionMode: "forbid",
        },
        "target-only"
      ),
    });
  }
  return diagnostic(violations);
}

/** Returns only people who can be assigned without any manual warning. */
export function availableStaffForManualAssignment(
  state: AssignmentEligibilityFacts,
  assignmentId: string
): Staff[] {
  const assignment = state.assignments.find((item) => item.id === assignmentId);
  if (!assignment?.positionRuleId) return [];
  return state.staff.filter(
    (person) =>
      person.id !== assignment?.staffId &&
      diagnoseManualAssignmentEligibility(state, assignmentId, person.id)
        .violations.length === 0
  );
}

export function canAssignStaff(
  state: AssignmentEligibilityFacts,
  assignmentId: string,
  staffId: string,
  ignoreAssignmentId?: string
): string | null {
  return (
    diagnoseManualAssignmentEligibility(
      state,
      assignmentId,
      staffId,
      ignoreAssignmentId
    ).violations[0]?.message ?? null
  );
}
