import type { AppState } from "../model";
import { markActiveScheduleStale } from "../domain/kernel/schedule-lifecycle";
import {
  normalizeOrdinaryPriorityPositions,
  ordinaryPriorityPositionKey,
} from "../domain/reviews/position-rotation-policy";
import type {
  CrossWorkdayQualificationReservation,
  CrossFlightPriorityPolicy,
  DutyPositionPriority,
  LateShiftRecoveryPositionRule,
  NextWorkdayRecoveryTarget,
  MobileSupervisorFillRule,
  SameFlightStaffExclusion,
} from "../domain/rules/structured-policy-contract";
import { STRUCTURED_POLICY_DEFINITIONS } from "../domain/rules/structured-policy-settings";
import { applyScheduleSettingsPatch } from "../domain/rules/schedule-settings";
import {
  fixedTeamLeaderGapFillPositionReason,
  teamLeaderGapFillPositionKey,
} from "../domain/coverage/team-leader-gap-fill-protection";
import { createId, normalizeText, splitList } from "../utils";
import {
  appendPolicyItem,
  deletePolicyItem,
  movePolicyItem,
  updatePolicyItem,
  type PolicyItemUpdate,
} from "./policy-collection-actions";

export type PolicyValue = string | number | boolean;
type RegisteredPolicyEntity =
  (typeof STRUCTURED_POLICY_DEFINITIONS)[keyof typeof STRUCTURED_POLICY_DEFINITIONS]["uiEntity"];
export type PolicyEntity = Exclude<
  RegisteredPolicyEntity,
  "team-leader-gap-fill"
>;
export type PolicyFieldUpdateResult = "not-policy" | "missing" | "saved";

export interface SchedulePolicyInput {
  maxDailyHours: number;
  minimumRegularTransitionMinutes: number;
  highLoadProtectionEnabled: boolean;
  highLoadFatigueThreshold: number;
  highLoadRecoveryMinutes: number;
  remarkedPositionHighLoad: boolean;
  rollingLoadProtectionEnabled: boolean;
  rollingLoadWindowMinutes: number;
  rollingLoadMaxFatigue: number;
  positionRotationEnabled: boolean;
  sameDayCrossFlightPriorityEnabled: boolean;
  dailyPrimaryPositionUniqueEnabled?: boolean;
  tr121H02CooldownWorkdays?: number;
  latePriorityFlightNumbers: string[];
  lateShiftRecoveryEnabled: boolean;
  nextWorkdayRecoveryMode?: "prefer" | "forbid";
  lateShiftEndTime: string;
  teamLeaderConcurrentSupervisionMaxOverlapMinutes: number;
  workloadBalanceEnabled: boolean;
  dailyFlightCountBalanceExemptHalfRest?: boolean;
  dailyFlightCountBalanceExemptTeamLeaders?: boolean;
  maxWorkHoursDifference: number;
  maxTodayFatigueDifference: number;
  dutyFatiguePoints: number;
  earlyDepartureCutoffTime: string;
  afternoonRestStartTime: string;
  afternoonRestEndTime: string;
}

function replacePolicyValue<T, K extends keyof T>(
  item: T,
  key: K,
  value: T[K]
): PolicyItemUpdate {
  if (Object.is(item[key], value)) return "unchanged";
  item[key] = value;
  return "changed";
}

export function applySchedulePolicy(
  state: AppState,
  input: SchedulePolicyInput
): boolean {
  state.settings = applyScheduleSettingsPatch(state.settings, input);
  return markActiveScheduleStale(state);
}

export function setTeamLeaderGapFillPositionsMovable(
  state: AppState,
  positionRuleIds: readonly string[],
  movable: boolean
): boolean {
  const selectedIds = new Set(positionRuleIds);
  const selectedRules = state.positionRules.filter(
    (rule) =>
      selectedIds.has(rule.id) && !fixedTeamLeaderGapFillPositionReason(rule)
  );
  if (!selectedRules.length) return false;

  const policies = new Map(
    state.settings.teamLeaderGapFillPositionPolicies.map((policy) => [
      teamLeaderGapFillPositionKey(policy.flightNo, policy.position),
      policy,
    ])
  );
  let changed = false;
  for (const rule of selectedRules) {
    const key = teamLeaderGapFillPositionKey(rule.flightNo, rule.name);
    const current = policies.get(key);
    if (current?.movable === movable) continue;
    policies.set(key, {
      flightNo: rule.flightNo.trim().toUpperCase(),
      position: rule.name.trim(),
      movable,
    });
    changed = true;
  }
  if (!changed) return false;
  state.settings.teamLeaderGapFillPositionPolicies = [...policies.values()];
  markActiveScheduleStale(state);
  return true;
}

export function addOrdinaryPriorityPosition(state: AppState): void {
  const first = state.positionRules.find((rule) => rule.category === "常规");
  if (!first) return;
  const item = {
    airlineCode: first.flightNo
      .trim()
      .toUpperCase()
      .replace(/\d+.*$/, ""),
    position: first.name.trim(),
  };
  state.settings.ordinaryPriorityPositions = normalizeOrdinaryPriorityPositions(
    [...state.settings.ordinaryPriorityPositions, item]
  );
  markActiveScheduleStale(state);
}

export function deleteOrdinaryPriorityPosition(
  state: AppState,
  airlineCode: string,
  position: string
): boolean {
  const before = state.settings.ordinaryPriorityPositions.length;
  state.settings.ordinaryPriorityPositions =
    state.settings.ordinaryPriorityPositions.filter(
      (item) =>
        ordinaryPriorityPositionKey(
          `${item.airlineCode}0`,
          item.position,
          ""
        ) !== ordinaryPriorityPositionKey(`${airlineCode}0`, position, "")
    );
  if (state.settings.ordinaryPriorityPositions.length === before) return false;
  markActiveScheduleStale(state);
  return true;
}

export function updateOrdinaryPriorityPosition(
  state: AppState,
  index: number,
  field: "airlineCode" | "position",
  value: string
): boolean {
  const item = state.settings.ordinaryPriorityPositions[index];
  if (!item) return false;
  item[field] = value.trim() as never;
  state.settings.ordinaryPriorityPositions = normalizeOrdinaryPriorityPositions(
    state.settings.ordinaryPriorityPositions
  );
  markActiveScheduleStale(state);
  return true;
}

export function addSameFlightStaffExclusion(
  state: AppState
): SameFlightStaffExclusion {
  const [first, second] = state.staff;
  const exclusion: SameFlightStaffExclusion = {
    id: createId("same-flight-staff-exclusion"),
    enabled: true,
    firstStaffId: first?.id ?? "",
    secondStaffId: second?.id ?? "",
    flightNo: "",
  };
  return appendPolicyItem(
    state,
    state.settings.sameFlightStaffExclusions,
    exclusion
  );
}

export function deleteSameFlightStaffExclusion(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(state, state.settings.sameFlightStaffExclusions, id);
}

function updateSameFlightStaffExclusion(
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
): boolean {
  return updatePolicyItem(
    state,
    state.settings.sameFlightStaffExclusions,
    id,
    (exclusion) => {
      if (field === "enabled")
        return replacePolicyValue(exclusion, "enabled", Boolean(value));
      if (field === "flightNo")
        return replacePolicyValue(
          exclusion,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "firstStaffId" || field === "secondStaffId") {
        const staffId = normalizeText(value);
        const otherStaffId =
          field === "firstStaffId"
            ? exclusion.secondStaffId
            : exclusion.firstStaffId;
        if (
          !state.staff.some((person) => person.id === staffId) ||
          staffId === otherStaffId
        )
          return "invalid";
        return replacePolicyValue(exclusion, field, staffId);
      }
      return "invalid";
    }
  );
}

export function addDutyPriority(state: AppState): DutyPositionPriority {
  const priority: DutyPositionPriority = {
    id: createId("duty-priority"),
    flightNo: "",
    positionKeyword: "一号",
    enabled: true,
  };
  return appendPolicyItem(
    state,
    state.settings.dutyPositionPriorities,
    priority
  );
}

export function moveDutyPriority(
  state: AppState,
  id: string,
  direction: -1 | 1
): boolean {
  return movePolicyItem(
    state,
    state.settings.dutyPositionPriorities,
    id,
    direction
  );
}

export function deleteDutyPriority(state: AppState, id: string): boolean {
  return deletePolicyItem(state, state.settings.dutyPositionPriorities, id);
}

export function updateDutyPriority(
  state: AppState,
  id: string,
  field: string,
  value: string | number | boolean
): boolean {
  return updatePolicyItem(
    state,
    state.settings.dutyPositionPriorities,
    id,
    (priority) => {
      if (field === "flightNo")
        return replacePolicyValue(
          priority,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "positionKeyword")
        return replacePolicyValue(
          priority,
          "positionKeyword",
          normalizeText(value)
        );
      if (field === "enabled")
        return replacePolicyValue(priority, "enabled", Boolean(value));
      return "invalid";
    }
  );
}

export function addNextWorkdayRecoveryTarget(
  state: AppState
): NextWorkdayRecoveryTarget {
  const target: NextWorkdayRecoveryTarget = {
    id: createId("recovery-target"),
    flightNo: "",
    positionKeyword: "一号",
    enabled: true,
  };
  return appendPolicyItem(
    state,
    state.settings.nextWorkdayRecoveryTargets,
    target
  );
}

export function addCrossWorkdayQualificationReservation(
  state: AppState
): CrossWorkdayQualificationReservation {
  const reservation: CrossWorkdayQualificationReservation = {
    id: createId("cross-workday-reservation"),
    enabled: true,
    flightNo: "",
    matchField: "position",
    keyword: "控制",
    minimumStaffCount: 1,
  };
  return appendPolicyItem(
    state,
    state.settings.crossWorkdayQualificationReservations,
    reservation
  );
}

export function moveCrossWorkdayQualificationReservation(
  state: AppState,
  id: string,
  direction: -1 | 1
): boolean {
  return movePolicyItem(
    state,
    state.settings.crossWorkdayQualificationReservations,
    id,
    direction
  );
}

export function deleteCrossWorkdayQualificationReservation(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(
    state,
    state.settings.crossWorkdayQualificationReservations,
    id
  );
}

export function addCrossFlightPriorityPolicy(
  state: AppState
): CrossFlightPriorityPolicy {
  const policy: CrossFlightPriorityPolicy = {
    id: createId("cross-flight-priority"),
    enabled: true,
    flightNo: state.flights[0]?.flightNo ?? "",
    staffIds: [],
  };
  return appendPolicyItem(
    state,
    state.settings.crossFlightPriorityPolicies,
    policy
  );
}

export function moveCrossFlightPriorityPolicy(
  state: AppState,
  id: string,
  direction: -1 | 1
): boolean {
  return movePolicyItem(
    state,
    state.settings.crossFlightPriorityPolicies,
    id,
    direction
  );
}

export function deleteCrossFlightPriorityPolicy(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(
    state,
    state.settings.crossFlightPriorityPolicies,
    id
  );
}

function updateCrossFlightPriorityPolicy(
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
): boolean {
  return updatePolicyItem(
    state,
    state.settings.crossFlightPriorityPolicies,
    id,
    (policy) => {
      if (field === "enabled")
        return replacePolicyValue(policy, "enabled", Boolean(value));
      if (field === "flightNo")
        return replacePolicyValue(
          policy,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "staffIds") {
        const currentStaffIds = new Set(state.staff.map((person) => person.id));
        const otherGroupStaffIds = new Set(
          Object.entries(state.groups)
            .filter(([groupId]) => groupId !== state.activeGroupId)
            .flatMap(([, group]) => group.staff.map((person) => person.id))
        );
        const staffIds = [
          ...policy.staffIds.filter(
            (staffId) =>
              !currentStaffIds.has(staffId) && otherGroupStaffIds.has(staffId)
          ),
          ...splitList(value).filter((staffId) => currentStaffIds.has(staffId)),
        ];
        if (policy.staffIds.join("\u0000") === staffIds.join("\u0000"))
          return "unchanged";
        policy.staffIds = staffIds;
        return "changed";
      }
      return "invalid";
    }
  );
}

function updateCrossWorkdayQualificationReservation(
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
): boolean {
  return updatePolicyItem(
    state,
    state.settings.crossWorkdayQualificationReservations,
    id,
    (reservation) => {
      if (field === "enabled")
        return replacePolicyValue(reservation, "enabled", Boolean(value));
      if (field === "flightNo")
        return replacePolicyValue(
          reservation,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "matchField")
        return replacePolicyValue(
          reservation,
          "matchField",
          value === "position" ? "position" : "remark"
        );
      if (field === "keyword")
        return replacePolicyValue(reservation, "keyword", normalizeText(value));
      if (field === "minimumStaffCount")
        return replacePolicyValue(
          reservation,
          "minimumStaffCount",
          Math.min(50, Math.max(1, Math.round(Number(value)) || 1))
        );
      return "invalid";
    }
  );
}

export function deleteNextWorkdayRecoveryTarget(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(state, state.settings.nextWorkdayRecoveryTargets, id);
}

export function updateNextWorkdayRecoveryTarget(
  state: AppState,
  id: string,
  field: string,
  value: string | number | boolean
): boolean {
  return updatePolicyItem(
    state,
    state.settings.nextWorkdayRecoveryTargets,
    id,
    (target) => {
      if (field === "flightNo")
        return replacePolicyValue(
          target,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "positionKeyword")
        return replacePolicyValue(
          target,
          "positionKeyword",
          normalizeText(value)
        );
      if (field === "enabled")
        return replacePolicyValue(target, "enabled", Boolean(value));
      return "invalid";
    }
  );
}

export function addLateShiftRecoveryPositionRule(
  state: AppState
): LateShiftRecoveryPositionRule {
  const rule: LateShiftRecoveryPositionRule = {
    id: createId("late-recovery-position"),
    enabled: true,
    flightNo: "",
    matchField: "remark",
    keyword: "一号",
    nextWorkdayCutoffTime: "",
  };
  return appendPolicyItem(
    state,
    state.settings.lateShiftRecoveryPositionRules,
    rule
  );
}

export function deleteLateShiftRecoveryPositionRule(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(
    state,
    state.settings.lateShiftRecoveryPositionRules,
    id
  );
}

export function updateLateShiftRecoveryPositionRule(
  state: AppState,
  id: string,
  field: string,
  value: string | number | boolean
): boolean {
  return updatePolicyItem(
    state,
    state.settings.lateShiftRecoveryPositionRules,
    id,
    (rule) => {
      if (field === "flightNo")
        return replacePolicyValue(
          rule,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "matchField")
        return replacePolicyValue(
          rule,
          "matchField",
          value === "position" ? "position" : "remark"
        );
      if (field === "keyword")
        return replacePolicyValue(rule, "keyword", normalizeText(value));
      if (field === "nextWorkdayCutoffTime") {
        const nextValue = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value))
          ? String(value)
          : "";
        return replacePolicyValue(rule, "nextWorkdayCutoffTime", nextValue);
      }
      if (field === "enabled")
        return replacePolicyValue(rule, "enabled", Boolean(value));
      return "invalid";
    }
  );
}

export function addTransitionPolicy(state: AppState): void {
  const sourceFlight = state.flights[0];
  const targetFlight = state.flights.at(-1) ?? sourceFlight;
  appendPolicyItem(state, state.settings.positionTransitionPolicies, {
    id: createId("transition-policy"),
    name: "新岗位衔接规则",
    enabled: false,
    sourceFlightNo: sourceFlight?.flightNo ?? "",
    sourcePositions: [],
    targetFlightNo: targetFlight?.flightNo ?? "",
    targetPosition: "",
    minimumGapMinutes: 180,
    mode: "prefer",
  });
}

export function deleteTransitionPolicy(state: AppState, id: string): boolean {
  return deletePolicyItem(state, state.settings.positionTransitionPolicies, id);
}

export function addMobileSupervisorCoverageRule(state: AppState): void {
  appendPolicyItem(state, state.settings.mobileSupervisorCoverageRules, {
    id: createId("supervisor-coverage"),
    enabled: true,
    flightNo: "",
    matchField: "remark",
    keyword: "",
    mode: "forbid",
  });
}

export function deleteMobileSupervisorCoverageRule(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(
    state,
    state.settings.mobileSupervisorCoverageRules,
    id
  );
}

export function addMobileSupervisorFillRule(
  state: AppState
): MobileSupervisorFillRule {
  const flightNo = state.flights[0]?.flightNo ?? "";
  return appendPolicyItem(state, state.settings.mobileSupervisorFillRules, {
    id: createId("supervisor-fill"),
    enabled: true,
    sourceFlightNo: flightNo,
    sourcePositionKeyword: "督导",
    targetFlightNo: flightNo,
    targetPositionKeyword: "H05",
    allowAutomatic: true,
    allowManual: true,
  });
}

export function deleteMobileSupervisorFillRule(
  state: AppState,
  id: string
): boolean {
  return deletePolicyItem(state, state.settings.mobileSupervisorFillRules, id);
}

function updateTransitionPolicy(
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
): boolean {
  return updatePolicyItem(
    state,
    state.settings.positionTransitionPolicies,
    id,
    (policy) => {
      if (field === "sourcePositions") {
        const nextValue = splitList(value);
        if (policy.sourcePositions.join("\u0000") === nextValue.join("\u0000"))
          return "unchanged";
        policy.sourcePositions = nextValue;
        return "changed";
      }
      if (field === "minimumGapMinutes")
        return replacePolicyValue(
          policy,
          "minimumGapMinutes",
          Math.min(1440, Math.max(0, Math.round(Number(value)) || 0))
        );
      if (field === "sourceFlightNo" || field === "targetFlightNo")
        return replacePolicyValue(
          policy,
          field,
          normalizeText(value).toUpperCase()
        );
      if (field === "mode")
        return replacePolicyValue(
          policy,
          "mode",
          value === "forbid" ? "forbid" : "prefer"
        );
      if (field === "enabled")
        return replacePolicyValue(policy, "enabled", Boolean(value));
      if (field === "name" || field === "targetPosition")
        return replacePolicyValue(policy, field, normalizeText(value));
      return "invalid";
    }
  );
}

function updateMobileSupervisorCoverageRule(
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
): boolean {
  return updatePolicyItem(
    state,
    state.settings.mobileSupervisorCoverageRules,
    id,
    (rule) => {
      if (field === "enabled")
        return replacePolicyValue(rule, "enabled", Boolean(value));
      if (field === "flightNo")
        return replacePolicyValue(
          rule,
          "flightNo",
          normalizeText(value).toUpperCase()
        );
      if (field === "matchField")
        return replacePolicyValue(
          rule,
          "matchField",
          value === "position" ? "position" : "remark"
        );
      if (field === "keyword")
        return replacePolicyValue(rule, "keyword", normalizeText(value));
      if (field === "mode")
        return replacePolicyValue(
          rule,
          "mode",
          value === "allow" ? "allow" : "forbid"
        );
      return "invalid";
    }
  );
}

function updateMobileSupervisorFillRule(
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
): boolean {
  return updatePolicyItem(
    state,
    state.settings.mobileSupervisorFillRules,
    id,
    (rule) => {
      if (
        field === "enabled" ||
        field === "allowAutomatic" ||
        field === "allowManual"
      )
        return replacePolicyValue(rule, field, Boolean(value));
      if (field === "sourceFlightNo" || field === "targetFlightNo")
        return replacePolicyValue(
          rule,
          field,
          normalizeText(value).toUpperCase()
        );
      if (
        field === "sourcePositionKeyword" ||
        field === "targetPositionKeyword"
      )
        return replacePolicyValue(rule, field, normalizeText(value));
      return "invalid";
    }
  );
}

type PolicyEntityUpdater = (
  state: AppState,
  id: string,
  field: string,
  value: PolicyValue
) => boolean;

const POLICY_ENTITY_UPDATERS: Readonly<
  Record<PolicyEntity, PolicyEntityUpdater>
> = {
  "same-flight-staff-exclusion": updateSameFlightStaffExclusion,
  "duty-priority": updateDutyPriority,
  "recovery-target": updateNextWorkdayRecoveryTarget,
  "late-shift-recovery-position": updateLateShiftRecoveryPositionRule,
  "cross-workday-reservation": updateCrossWorkdayQualificationReservation,
  "transition-policy": updateTransitionPolicy,
  "supervisor-coverage": updateMobileSupervisorCoverageRule,
  "supervisor-fill": updateMobileSupervisorFillRule,
  "cross-flight-priority": updateCrossFlightPriorityPolicy,
};

function isPolicyEntity(entity: string): entity is PolicyEntity {
  return Object.hasOwn(POLICY_ENTITY_UPDATERS, entity);
}

export function updatePolicyEntityField(
  state: AppState,
  entity: string,
  id: string,
  field: string,
  value: PolicyValue
): PolicyFieldUpdateResult {
  if (!isPolicyEntity(entity)) return "not-policy";
  const updated = POLICY_ENTITY_UPDATERS[entity](state, id, field, value);
  return updated ? "saved" : "missing";
}
