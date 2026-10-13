import { normalizeSupervisorAssignments } from "../domain/assignments/schedule-adjustment";
import { normalizeScheduleSettings } from "../domain/rules/schedule-settings";
import { removeUnavailableStaffAssignments } from "../domain/kernel/schedule-state";
import type {
  AppState,
  Assignment,
  DutyRosterOverride,
  Flight,
  FlightTemplate,
  GroupWorkspace,
  HistoryRecord,
  LatePriorityFrequencyAdjustment,
  OrdinaryPriorityFrequencyAdjustment,
  PositionRule,
  ScheduleSettings,
  SharedScheduleData,
  Staff,
  WeeklyFlightPlanEntry,
} from "../model";
import {
  SCHEDULING_RULES,
  type SchedulingDecision,
  type SchedulingDecisionOutcome,
  type SchedulingRuleId,
} from "../domain/rules/schedule-rule-contract";
import { orderPositionRules } from "../utils";
import {
  normalizeLatePriorityFlightNumber,
  normalizeLatePriorityPositionReference,
} from "../domain/reviews/late-priority-policy";
import { latePriorityFlightScopeCandidates } from "../domain/statistics/late-priority-flight-scope";
import {
  createEmptyWeeklyFlightPlans,
  replaceWeeklyFlightPlan,
} from "../domain/flights/weekly-flight-plan";
import { mergeLatePriorityFrequencyAdjustments } from "../domain/statistics/late-priority-frequency-adjustment";
import { mergeOrdinaryPriorityFrequencyAdjustments } from "../domain/statistics/ordinary-priority-frequency-adjustment";
import {
  isPriorityRotationPosition,
  normalizeOrdinaryPriorityPositions,
} from "../domain/reviews/position-rotation-policy";
import { airlineCode } from "../domain/rules/airline-rotation";
import { scheduleRuleFingerprint } from "../domain/rules/schedule-rule-fingerprint";
import { normalizeTime } from "../domain/shared/time";

type PersistedSettings = Partial<ScheduleSettings>;
type PersistedAppState = Record<string, unknown> & {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
};

const LATE_PRIORITY_KINDS = new Set([
  "supervisor",
  "number-one",
  "declaration",
  "delivery",
]);
function restoreLatePriorityFrequencyAdjustments(
  value: unknown
): LatePriorityFrequencyAdjustment[] {
  if (!Array.isArray(value)) return [];
  return mergeLatePriorityFrequencyAdjustments(
    value
      .flatMap((item): LatePriorityFrequencyAdjustment[] => {
        if (
          !isRecord(item) ||
          !/^\d{4}-\d{2}$/.test(String(item.month)) ||
          typeof item.staffId !== "string" ||
          typeof item.flightNo !== "string" ||
          !LATE_PRIORITY_KINDS.has(String(item.kind)) ||
          typeof item.delta !== "number" ||
          !Number.isFinite(item.delta)
        )
          return [];
        return [
          {
            month: String(item.month),
            staffId: item.staffId,
            flightNo: normalizeLatePriorityFlightNumber(item.flightNo),
            kind: item.kind as LatePriorityFrequencyAdjustment["kind"],
            delta: Math.trunc(item.delta),
            resetBaseline:
              typeof item.resetBaseline === "number" &&
              Number.isFinite(item.resetBaseline) &&
              item.resetBaseline > 0
                ? Math.trunc(item.resetBaseline)
                : undefined,
          },
        ];
      })
      .filter((item) => item.delta !== 0 || (item.resetBaseline ?? 0) > 0)
  );
}

function restoreOrdinaryPriorityFrequencyAdjustments(
  value: unknown
): OrdinaryPriorityFrequencyAdjustment[] {
  if (!Array.isArray(value)) return [];
  return mergeOrdinaryPriorityFrequencyAdjustments(
    value.flatMap((item): OrdinaryPriorityFrequencyAdjustment[] => {
      if (
        !isRecord(item) ||
        !/^\d{4}-\d{2}$/.test(String(item.month)) ||
        typeof item.staffId !== "string" ||
        typeof item.airlineCode !== "string" ||
        typeof item.position !== "string" ||
        typeof item.delta !== "number" ||
        !Number.isFinite(item.delta)
      )
        return [];
      return [
        {
          month: String(item.month),
          staffId: item.staffId,
          airlineCode: item.airlineCode,
          position: item.position,
          delta: Math.trunc(item.delta),
          resetBaseline:
            typeof item.resetBaseline === "number" &&
            Number.isFinite(item.resetBaseline) &&
            item.resetBaseline > 0
              ? Math.trunc(item.resetBaseline)
              : undefined,
        },
      ];
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPersistedState(value: unknown): value is PersistedAppState {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 ||
    value.version === 2 ||
    value.version === 3 ||
    value.version === 4 ||
    value.version === 5 ||
    value.version === 6 ||
    value.version === 7 ||
    value.version === 8
  );
}

function restoredCollection<T>(
  value: unknown,
  fallback: T[],
  restore: (items: unknown[]) => T[]
): T[] {
  return Array.isArray(value) ? restore(value) : fallback;
}

function migrateSettings(
  parsed: PersistedAppState,
  fallback: AppState,
  positionRules: readonly PositionRule[]
): ScheduleSettings {
  const persistedSettings = isRecord(parsed.settings)
    ? (parsed.settings as PersistedSettings)
    : {};
  const migrated = { ...fallback.settings, ...persistedSettings };
  if (
    parsed.version < 7 &&
    Array.isArray(migrated.crossFlightPriorityPolicies)
  ) {
    migrated.crossFlightPriorityPolicies =
      migrated.crossFlightPriorityPolicies.map((item) => {
        const record: Record<string, unknown> = isRecord(item) ? item : {};
        return {
          id: String(record.id ?? ""),
          enabled: record.enabled !== false,
          flightNo: String(record.flightNo ?? ""),
          staffIds: [],
        };
      });
  }
  Reflect.deleteProperty(migrated, "highLoadTransitionMode");
  Reflect.deleteProperty(migrated, "rollingLoadMode");
  Reflect.deleteProperty(migrated, "lateShiftRecoveryMode");
  Reflect.deleteProperty(migrated, "nextDayLateMaxFatigue");
  if (parsed.version < 3 && Array.isArray(migrated.dutyPositionPriorities)) {
    migrated.dutyPositionPriorities = migrated.dutyPositionPriorities.map(
      (item) =>
        String(item.flightNo ?? "")
          .trim()
          .toUpperCase() === "TR121" &&
        String(item.positionKeyword ?? "").trim() === "一号"
          ? { ...item, id: "duty-priority-tr121-h02", positionKeyword: "H02" }
          : item
    );
  }
  if (parsed.version < 4) {
    migrated.latePriorityFlightNumbers =
      latePriorityFlightScopeCandidates(positionRules);
  }
  if (parsed.version < 8) {
    migrated.ordinaryPriorityPositions = normalizeOrdinaryPriorityPositions(
      positionRules.filter(isPriorityRotationPosition).map((rule) => ({
        airlineCode: airlineCode(rule.flightNo),
        position: rule.name.trim(),
      }))
    );
  }
  return normalizeScheduleSettings(migrated, fallback.settings);
}

const STAFF_STATUSES = new Set<Staff["status"]>(["正常", "病假", "休假"]);

function restoreStaff(value: unknown[]): Staff[] {
  return value.flatMap((item): Staff[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.nightShift !== "boolean" ||
      !STAFF_STATUSES.has(item.status as Staff["status"]) ||
      typeof item.remark !== "string"
    )
      return [];
    const staffType = item.staffType === "行政支援" ? "行政支援" : "常规";
    return [
      {
        id: item.id,
        name: item.name,
        staffType,
        teamLeader: staffType === "行政支援" ? false : Boolean(item.teamLeader),
        cxPreflightQualified:
          staffType === "行政支援" ? false : Boolean(item.cxPreflightQualified),
        dutyQualified:
          staffType === "行政支援" ? false : item.dutyQualified !== false,
        standbyQualified:
          staffType === "行政支援" ? false : item.standbyQualified !== false,
        nightShift: item.nightShift,
        status: item.status as Staff["status"],
        remark: item.remark,
      },
    ];
  });
}

function restoreFlights(value: unknown[]): Flight[] {
  return value.flatMap((item): Flight[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.flightNo !== "string" ||
      typeof item.startTime !== "string" ||
      typeof item.endTime !== "string" ||
      typeof item.bookedPassengers !== "number" ||
      !Number.isFinite(item.bookedPassengers) ||
      !Array.isArray(item.positions) ||
      !item.positions.every((position) => typeof position === "string") ||
      typeof item.remark !== "string"
    )
      return [];
    return [
      {
        id: item.id,
        flightNo: item.flightNo,
        startTime: item.startTime,
        endTime: item.endTime,
        bookedPassengers: item.bookedPassengers,
        positions: item.positions,
        remark: item.remark,
      },
    ];
  });
}

function restoreTemplates(value: unknown[]): FlightTemplate[] {
  return value.flatMap((item): FlightTemplate[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.flightNo !== "string" ||
      typeof item.startTime !== "string" ||
      typeof item.endTime !== "string" ||
      !Array.isArray(item.positions) ||
      !item.positions.every((position) => typeof position === "string") ||
      typeof item.remark !== "string"
    )
      return [];
    return [
      {
        id: item.id,
        flightNo: item.flightNo,
        startTime: item.startTime,
        endTime: item.endTime,
        positions: item.positions,
        remark: item.remark,
      },
    ];
  });
}

function restoreWeeklyFlightPlans(value: unknown): WeeklyFlightPlanEntry[] {
  if (!Array.isArray(value)) return createEmptyWeeklyFlightPlans();
  return value.reduce<WeeklyFlightPlanEntry[]>((plans, item) => {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.weekday) ||
      Number(item.weekday) < 1 ||
      Number(item.weekday) > 7 ||
      !Array.isArray(item.flightNos) ||
      !item.flightNos.every((flightNo) => typeof flightNo === "string")
    )
      return plans;
    return replaceWeeklyFlightPlan(
      plans,
      Number(item.weekday) as WeeklyFlightPlanEntry["weekday"],
      item.flightNos as string[]
    );
  }, createEmptyWeeklyFlightPlans());
}

type PersistedPositionCategory = PositionRule["category"] | "督导" | "督导补位";
const POSITION_CATEGORIES = new Set<PersistedPositionCategory>([
  "常规",
  "引导",
  "机动督导",
  "督导补位",
  "督导",
  "分流",
  "行政支援",
]);

function restorePositionRules(
  value: unknown[],
  resetMobileSupervisors: boolean
): PositionRule[] {
  const restored = value.flatMap((item): PositionRule[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.flightNo !== "string" ||
      typeof item.name !== "string" ||
      !POSITION_CATEGORIES.has(item.category as PersistedPositionCategory) ||
      typeof item.remark !== "string" ||
      !Array.isArray(item.qualifiedStaffIds) ||
      !item.qualifiedStaffIds.every((staffId) => typeof staffId === "string") ||
      typeof item.fatiguePoints !== "number" ||
      !Number.isFinite(item.fatiguePoints)
    )
      return [];
    const persistedCategory = item.category as PersistedPositionCategory;
    const category =
      persistedCategory === "督导补位" ||
      persistedCategory === "督导" ||
      (resetMobileSupervisors && persistedCategory === "机动督导")
        ? ("常规" as const)
        : persistedCategory;
    const coverageRole =
      persistedCategory === "督导补位" ||
      item.coverageRole === "supervisor-fill"
        ? ("supervisor-fill" as const)
        : ("none" as const);
    return [
      {
        id: item.id,
        flightNo: item.flightNo,
        name: item.name,
        category,
        coverageRole,
        remark: item.remark,
        qualifiedStaffIds: item.qualifiedStaffIds,
        manual: persistedCategory === "督导补位" ? false : Boolean(item.manual),
        fatiguePoints: item.fatiguePoints,
        minPassengers: Number(item.minPassengers) || 0,
        earlyReleaseMinutes: Number(item.earlyReleaseMinutes) || 0,
      },
    ];
  });
  return orderPositionRules(restored);
}

function restoreHistory(value: unknown[]): HistoryRecord[] {
  return value.flatMap((item): HistoryRecord[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.date !== "string" ||
      typeof item.flightNo !== "string" ||
      typeof item.position !== "string" ||
      typeof item.staffId !== "string" ||
      typeof item.staffName !== "string" ||
      typeof item.startTime !== "string" ||
      typeof item.endTime !== "string" ||
      typeof item.workHours !== "number" ||
      !Number.isFinite(item.workHours) ||
      typeof item.fatiguePoints !== "number" ||
      !Number.isFinite(item.fatiguePoints) ||
      typeof item.remark !== "string"
    )
      return [];
    const historyCoverage =
      item.historyCoverage === "complete" ||
      item.historyCoverage === "late-priority-only"
        ? item.historyCoverage
        : undefined;
    const flightCutoffTime =
      typeof item.flightCutoffTime === "string"
        ? normalizeTime(item.flightCutoffTime)
        : "";
    return [
      {
        id: item.id,
        date: item.date,
        flightNo: item.flightNo,
        position: item.position,
        staffId: item.staffId,
        staffName: item.staffName,
        startTime: item.startTime,
        endTime: item.endTime,
        ...(flightCutoffTime ? { flightCutoffTime } : {}),
        workHours: item.workHours,
        fatiguePoints: item.fatiguePoints,
        remark: item.remark,
        ...(historyCoverage ? { historyCoverage } : {}),
      },
    ];
  });
}

function migrateLegacyHistoryMetadata(
  history: HistoryRecord[],
  positionRules: readonly PositionRule[]
): HistoryRecord[] {
  return history.map((record) => {
    if (!record.id.startsWith("legacy-history-")) return record;
    const rule = positionRules.find(
      (candidate) =>
        normalizeLatePriorityFlightNumber(candidate.flightNo) ===
          normalizeLatePriorityFlightNumber(record.flightNo) &&
        normalizeLatePriorityPositionReference(candidate.name) ===
          normalizeLatePriorityPositionReference(record.position)
    );
    return {
      ...record,
      historyCoverage: "late-priority-only" as const,
      ...(rule
        ? {
            remark: rule.remark,
            fatiguePoints: rule.fatiguePoints,
          }
        : {}),
    };
  });
}

const SCHEDULING_DECISION_OUTCOMES = new Set<SchedulingDecisionOutcome>([
  "selected",
  "blocked",
  "fallback",
  "preserved",
]);
const SCHEDULING_RULE_BY_ID = new Map(
  SCHEDULING_RULES.map((definition) => [definition.id, definition])
);

function validDecision(value: unknown): value is SchedulingDecision {
  if (
    !isRecord(value) ||
    typeof value.ruleId !== "string" ||
    typeof value.message !== "string"
  )
    return false;
  const definition = SCHEDULING_RULE_BY_ID.get(
    value.ruleId as SchedulingRuleId
  );
  return Boolean(
    definition &&
    value.stage === definition.stage &&
    SCHEDULING_DECISION_OUTCOMES.has(value.outcome as SchedulingDecisionOutcome)
  );
}

const ASSIGNMENT_STATUSES = new Set<Assignment["status"]>([
  "assigned",
  "unfilled",
  "manual",
]);

export interface StateRestorationIssue {
  readonly collection: string;
  readonly index?: number;
  readonly reason: string;
}

export interface StateRestorationReport {
  readonly issues: readonly StateRestorationIssue[];
}

let lastRestorationReport: StateRestorationReport = { issues: [] };

export function getLastRestorationReport(): StateRestorationReport {
  return lastRestorationReport;
}

export function clearLastRestorationReport(): void {
  lastRestorationReport = { issues: [] };
}

export function recordRestorationIssue(reason: string): void {
  lastRestorationReport = {
    issues: [...lastRestorationReport.issues, { collection: "state", reason }],
  };
}

function restoredAssignment(value: unknown): Assignment | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.flightId !== "string" ||
    typeof value.flightNo !== "string" ||
    !(
      value.positionRuleId === null || typeof value.positionRuleId === "string"
    ) ||
    typeof value.position !== "string" ||
    !(value.staffId === null || typeof value.staffId === "string") ||
    typeof value.staffName !== "string" ||
    typeof value.startTime !== "string" ||
    typeof value.endTime !== "string" ||
    typeof value.workHours !== "number" ||
    !Number.isFinite(value.workHours) ||
    typeof value.fatiguePoints !== "number" ||
    !Number.isFinite(value.fatiguePoints) ||
    typeof value.remark !== "string" ||
    !ASSIGNMENT_STATUSES.has(value.status as Assignment["status"])
  )
    return null;
  const assignment: Assignment = {
    id: value.id,
    flightId: value.flightId,
    flightNo: value.flightNo,
    positionRuleId: value.positionRuleId,
    position: value.position,
    staffId: value.staffId,
    staffName: value.staffName,
    startTime: value.startTime,
    endTime: value.endTime,
    workHours: value.workHours,
    fatiguePoints: value.fatiguePoints,
    remark: value.remark,
    manualRemark:
      typeof value.manualRemark === "string" ? value.manualRemark : "",
    status: value.status as Assignment["status"],
  };
  if (Array.isArray(value.systemNotes)) {
    assignment.systemNotes = value.systemNotes.map(String).filter(Boolean);
  }
  if (isRecord(value.vacancyEvidence)) {
    const reason = value.vacancyEvidence.reason;
    const blockers = value.vacancyEvidence.blockers;
    if (
      (reason === "daily-flight-count-balance" ||
        reason === "no-qualified-candidate") &&
      Array.isArray(blockers) &&
      blockers.every((item) => typeof item === "string")
    ) {
      assignment.vacancyEvidence = { reason, blockers: [...blockers] };
    }
  }
  if (Array.isArray(value.decisionTrace)) {
    assignment.decisionTrace = value.decisionTrace.filter(validDecision);
  }
  if (assignment.decisionTrace?.length && isRecord(value.decisionEvidence)) {
    const scheduleRunId = value.decisionEvidence.scheduleRunId;
    const ruleFingerprint = value.decisionEvidence.ruleFingerprint;
    if (
      typeof scheduleRunId === "string" &&
      typeof ruleFingerprint === "string"
    )
      assignment.decisionEvidence = { scheduleRunId, ruleFingerprint };
  }
  if (Array.isArray(value.manualOverrideWarnings)) {
    const warnings = value.manualOverrideWarnings.flatMap((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.code !== "string" ||
        typeof item.message !== "string"
      )
        return [];
      return [{ code: item.code, message: item.message }];
    });
    if (warnings.length) assignment.manualOverrideWarnings = warnings;
  }
  const supervisorSourceAssignmentId =
    typeof value.supervisorSourceAssignmentId === "string"
      ? value.supervisorSourceAssignmentId
      : typeof value.supervisorCoverSourceAssignmentId === "string"
        ? value.supervisorCoverSourceAssignmentId
        : undefined;
  if (supervisorSourceAssignmentId)
    assignment.supervisorSourceAssignmentId = supervisorSourceAssignmentId;
  if (typeof value.supervisorFillRuleId === "string")
    assignment.supervisorFillRuleId = value.supervisorFillRuleId;
  if (value.layoutGroup === "primary" || value.layoutGroup === "bottom")
    assignment.layoutGroup = value.layoutGroup;
  if (
    typeof value.layoutIndex === "number" &&
    Number.isFinite(value.layoutIndex)
  )
    assignment.layoutIndex = value.layoutIndex;
  return assignment;
}

function restoreAssignments(
  next: AppState,
  value: unknown[],
  issues: StateRestorationIssue[]
): Assignment[] {
  const administrativePositions = new Set(
    next.positionRules
      .filter((rule) => rule.category === "行政支援")
      .map((rule) => `${rule.flightNo}\u0000${rule.name.trim()}`)
  );
  return value.flatMap((raw, index) => {
    const assignment = restoredAssignment(raw);
    if (!assignment) {
      issues.push({
        collection: "assignments",
        index,
        reason: "字段缺失或类型无效",
      });
      return [];
    }
    if (assignment.layoutGroup) return [assignment];
    if (!assignment.positionRuleId) {
      issues.push({
        collection: "assignments",
        index,
        reason: "缺少岗位规则标识",
      });
      return [];
    }
    const rule = next.positionRules.find(
      (item) =>
        item.id === assignment.positionRuleId &&
        item.flightNo === assignment.flightNo
    );
    if (!rule) {
      issues.push({
        collection: "assignments",
        index,
        reason: "找不到对应的岗位规则",
      });
      return [];
    }
    if (!next.settings.adminSupportEnabled && rule.category === "行政支援") {
      issues.push({
        collection: "assignments",
        index,
        reason: "行政支援模式未启用",
      });
      return [];
    }
    if (
      next.settings.adminSupportEnabled &&
      rule.category !== "行政支援" &&
      administrativePositions.has(`${rule.flightNo}\u0000${rule.name.trim()}`)
    ) {
      issues.push({
        collection: "assignments",
        index,
        reason: "同名行政支援岗位替换了普通岗位",
      });
      return [];
    }
    return [assignment];
  });
}

function restoreDutyRosterOverrides(value: unknown[]): DutyRosterOverride[] {
  return value.flatMap((item): DutyRosterOverride[] => {
    if (!isRecord(item) || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date)))
      return [];
    const standbyStaffIds = Array.isArray(item.standbyStaffIds)
      ? item.standbyStaffIds
      : [];
    return [
      {
        date: String(item.date),
        cxPreflightStaffId: item.cxPreflightStaffId
          ? String(item.cxPreflightStaffId)
          : null,
        dutyStaffId: item.dutyStaffId ? String(item.dutyStaffId) : null,
        standbyStaffIds: [
          standbyStaffIds[0] ? String(standbyStaffIds[0]) : null,
          standbyStaffIds[1] ? String(standbyStaffIds[1]) : null,
        ],
      },
    ];
  });
}

function emptyGroupWorkspace(): GroupWorkspace {
  return {
    flights: [],
    staff: [],
    history: [],
    dutyRosterOverrides: [],
    latePriorityFrequencyAdjustments: [],
    ordinaryPriorityFrequencyAdjustments: [],
    assignments: [],
    activeScheduleDate: null,
    schedulePolicyStale: false,
  };
}

function groupWorkspaceFromState(state: AppState): GroupWorkspace {
  return {
    flights: structuredClone(state.flights),
    staff: structuredClone(state.staff),
    history: structuredClone(state.history),
    dutyRosterOverrides: structuredClone(state.dutyRosterOverrides),
    latePriorityFrequencyAdjustments: structuredClone(
      state.latePriorityFrequencyAdjustments
    ),
    ordinaryPriorityFrequencyAdjustments: structuredClone(
      state.ordinaryPriorityFrequencyAdjustments
    ),
    assignments: structuredClone(state.assignments),
    activeScheduleDate: state.activeScheduleDate,
    schedulePolicyStale: state.schedulePolicyStale,
    scheduleRuleFingerprint: state.scheduleRuleFingerprint,
  };
}

function sharedScheduleDataFromState(state: AppState): SharedScheduleData {
  return {
    templates: structuredClone(state.templates),
    weeklyFlightPlans: structuredClone(state.weeklyFlightPlans),
    positionRules: structuredClone(state.positionRules),
    settings: structuredClone(state.settings),
  };
}

function restoreGroupWorkspace(
  value: unknown,
  fallback: GroupWorkspace,
  base: AppState,
  issues: StateRestorationIssue[]
): GroupWorkspace {
  if (!isRecord(value)) return structuredClone(fallback);
  const staff = restoredCollection(value.staff, fallback.staff, restoreStaff);
  const flights = restoredCollection(
    value.flights,
    fallback.flights,
    restoreFlights
  );
  const positionRules = base.positionRules;
  const history = migrateLegacyHistoryMetadata(
    restoredCollection(value.history, fallback.history, restoreHistory),
    positionRules
  );
  const workspaceState = {
    ...base,
    flights,
    staff,
    history,
    assignments: [],
  };
  const rawAssignments = Array.isArray(value.assignments)
    ? value.assignments
    : [];
  const assignments = restoreAssignments(
    workspaceState,
    rawAssignments,
    issues
  );
  return {
    flights,
    staff,
    history,
    dutyRosterOverrides: restoredCollection(
      value.dutyRosterOverrides,
      fallback.dutyRosterOverrides,
      restoreDutyRosterOverrides
    ),
    latePriorityFrequencyAdjustments: restoreLatePriorityFrequencyAdjustments(
      value.latePriorityFrequencyAdjustments
    ),
    ordinaryPriorityFrequencyAdjustments:
      restoreOrdinaryPriorityFrequencyAdjustments(
        value.ordinaryPriorityFrequencyAdjustments
      ),
    assignments,
    activeScheduleDate:
      value.activeScheduleDate === null ||
      typeof value.activeScheduleDate === "string"
        ? value.activeScheduleDate
        : fallback.activeScheduleDate,
    schedulePolicyStale:
      typeof value.schedulePolicyStale === "boolean"
        ? value.schedulePolicyStale
        : fallback.schedulePolicyStale,
    scheduleRuleFingerprint:
      typeof value.scheduleRuleFingerprint === "string"
        ? value.scheduleRuleFingerprint
        : undefined,
  };
}

function projectActiveGroup(next: AppState): void {
  const active = next.groups[next.activeGroupId];
  if (!active) {
    next.activeGroupId = "A";
    return projectActiveGroup(next);
  }
  next.flights = active.flights;
  next.staff = active.staff;
  next.history = active.history;
  next.dutyRosterOverrides = active.dutyRosterOverrides;
  next.latePriorityFrequencyAdjustments =
    active.latePriorityFrequencyAdjustments;
  next.ordinaryPriorityFrequencyAdjustments =
    active.ordinaryPriorityFrequencyAdjustments;
  next.assignments = active.assignments;
  next.activeScheduleDate = active.activeScheduleDate;
  next.schedulePolicyStale = active.schedulePolicyStale;
  next.scheduleRuleFingerprint = active.scheduleRuleFingerprint;
}

export function restorePersistedState(
  value: unknown,
  fallback: AppState
): AppState | null {
  const issues: StateRestorationIssue[] = [];
  lastRestorationReport = { issues };
  if (!isPersistedState(value)) {
    issues.push({
      collection: "state",
      reason: "根对象缺失或版本不受支持",
    });
    return null;
  }
  const positionRules = restoredCollection(
    value.positionRules,
    fallback.positionRules,
    (items) => restorePositionRules(items, value.version === 1)
  );
  const restoredHistory = migrateLegacyHistoryMetadata(
    restoredCollection(value.history, fallback.history, restoreHistory),
    positionRules
  );
  const next: AppState = {
    version: 8,
    shared: structuredClone(fallback.shared),
    groups: structuredClone(fallback.groups),
    activeGroupId: "A",
    staff: restoredCollection(value.staff, fallback.staff, restoreStaff),
    flights: restoredCollection(
      value.flights,
      fallback.flights,
      restoreFlights
    ),
    templates: restoredCollection(
      value.templates,
      fallback.templates,
      restoreTemplates
    ),
    weeklyFlightPlans:
      value.version < 5
        ? createEmptyWeeklyFlightPlans()
        : restoreWeeklyFlightPlans(value.weeklyFlightPlans),
    positionRules,
    history: restoredHistory,
    dutyRosterOverrides: restoredCollection(
      value.dutyRosterOverrides,
      fallback.dutyRosterOverrides,
      restoreDutyRosterOverrides
    ),
    latePriorityFrequencyAdjustments: restoreLatePriorityFrequencyAdjustments(
      value.latePriorityFrequencyAdjustments
    ),
    ordinaryPriorityFrequencyAdjustments:
      restoreOrdinaryPriorityFrequencyAdjustments(
        value.ordinaryPriorityFrequencyAdjustments
      ),
    assignments: [],
    activeScheduleDate:
      value.activeScheduleDate === null ||
      typeof value.activeScheduleDate === "string"
        ? value.activeScheduleDate
        : fallback.activeScheduleDate,
    schedulePolicyStale:
      typeof value.schedulePolicyStale === "boolean"
        ? value.schedulePolicyStale
        : fallback.schedulePolicyStale,
    scheduleRuleFingerprint:
      typeof value.scheduleRuleFingerprint === "string"
        ? value.scheduleRuleFingerprint
        : undefined,
    settings: migrateSettings(value, fallback, positionRules),
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : fallback.updatedAt,
  };
  try {
    const persistedAssignments = Array.isArray(value.assignments)
      ? value.assignments
      : fallback.assignments;
    const hadPersistedAssignments = persistedAssignments.length > 0;
    next.assignments = restoreAssignments(next, persistedAssignments, issues);
    const beforeUnavailableRemoval = next.assignments.length;
    removeUnavailableStaffAssignments(next);
    if (next.assignments.length < beforeUnavailableRemoval) {
      issues.push({
        collection: "assignments",
        reason: `${beforeUnavailableRemoval - next.assignments.length} 条记录因人员不可用未恢复`,
      });
    }
    normalizeSupervisorAssignments(next);
    if (hadPersistedAssignments && !next.assignments.length) {
      next.activeScheduleDate = null;
      next.schedulePolicyStale = false;
      next.scheduleRuleFingerprint = undefined;
    } else if (next.assignments.length) {
      const currentFingerprint = scheduleRuleFingerprint(next);
      next.schedulePolicyStale =
        next.schedulePolicyStale ||
        !next.scheduleRuleFingerprint ||
        next.scheduleRuleFingerprint !== currentFingerprint;
    }
  } catch (error) {
    issues.push({
      collection: "state",
      reason: `整体恢复失败：${error instanceof Error ? error.message : String(error)}`,
    });
    next.assignments = [];
    next.activeScheduleDate = null;
    next.schedulePolicyStale = false;
    next.scheduleRuleFingerprint = undefined;
  }
  if (!next.assignments.length) {
    next.scheduleRuleFingerprint = undefined;
  }
  next.shared = sharedScheduleDataFromState(next);
  if (value.version >= 6 && isRecord(value.groups)) {
    const persistedActiveGroup = value.activeGroupId === "B" ? "B" : "A";
    const groupA =
      persistedActiveGroup === "A"
        ? groupWorkspaceFromState(next)
        : restoreGroupWorkspace(
            value.groups.A,
            groupWorkspaceFromState(next),
            next,
            issues
          );
    const groupB = restoreGroupWorkspace(
      value.groups.B,
      emptyGroupWorkspace(),
      next,
      issues
    );
    next.groups = { A: groupA, B: groupB };
    next.activeGroupId = persistedActiveGroup;
    projectActiveGroup(next);
  } else {
    next.groups = {
      A: groupWorkspaceFromState(next),
      B: emptyGroupWorkspace(),
    };
    next.activeGroupId = "A";
  }
  return next;
}
