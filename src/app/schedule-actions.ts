import {
  evaluateManualAssignment,
  manualOverrideWarningMessage,
  replaceManualOverrideWarnings,
} from "../domain/candidates/manual-assignment-override";
import {
  applyEarlyReleaseForStaff,
  isDiversionTransfer,
} from "../domain/assignments/assignment-timing";
import { clearAutomaticAssignmentEvidence } from "../domain/assignments/assignment-evidence";
import { captureCountBaseline } from "../domain/statistics/manual-count-evidence";
import {
  activeFlightRules,
  compareGuideSourceAssignments,
  guideSourceStaff,
  isAuxiliaryCategory,
  isGuideAssignment,
} from "../domain/flights/schedule-position-rules";
import {
  clearSupervisorLink,
  moveSupervisorWithinFlight,
  normalizeSupervisorAssignments,
} from "../domain/assignments/schedule-adjustment";
import { refreshPositionRotationEvidence } from "../domain/reviews/position-rotation-evidence";
import {
  isNextWorkdayCutoffConflict,
  nextWorkdayCutoffProtection,
} from "../domain/reviews/cross-day-recovery";
import type { AppState } from "../model";
import type { Flight, HistoryRecord, ScheduleResult } from "../model";
import { replaceHistoryForDate } from "./history-actions";
import { installGeneratedSchedule } from "../domain/kernel/schedule-lifecycle";
import { createId, normalizeText } from "../utils";

export interface ScheduleEditResult {
  changed: boolean;
  message?: string;
  error?: string;
  warning?: string;
}

export function installArchivedNextWorkdaySchedule(
  state: AppState,
  currentDate: string,
  records: HistoryRecord[],
  nextDate: string,
  flights: Flight[],
  result: ScheduleResult
): void {
  replaceHistoryForDate(state, currentDate, records);
  state.flights = flights;
  installGeneratedSchedule(state, nextDate, result);
}

function refreshManualRuleEvidence(state: AppState): void {
  refreshPositionRotationEvidence(state, state.activeScheduleDate);
}

function finalManualWarnings(
  state: AppState,
  assignmentId: string,
  staffId: string,
  ignoreAssignmentId?: string
) {
  const warnings = evaluateManualAssignment(
    state,
    assignmentId,
    staffId,
    ignoreAssignmentId
  ).warnings;
  const assignment = state.assignments.find((item) => item.id === assignmentId);
  const rule = assignment?.positionRuleId
    ? state.positionRules.find((item) => item.id === assignment.positionRuleId)
    : undefined;
  const date = state.activeScheduleDate;
  if (
    assignment &&
    rule?.category === "常规" &&
    date &&
    isNextWorkdayCutoffConflict(state, staffId, assignment.startTime, date)
  ) {
    const person = state.staff.find((item) => item.id === staffId);
    const protection = nextWorkdayCutoffProtection(state, staffId, date);
    if (person && protection) {
      warnings.push({
        code: "position-transition",
        message: `${person.name}属于上一班末班重点岗位人员，本次人工安排突破次班 ${protection.cutoffTime} 截止保护`,
      });
    }
  }
  return warnings;
}

export function createTemporaryAssignment(
  state: AppState,
  flightId: string,
  position: string,
  staffName: string,
  layoutGroup: "primary" | "bottom",
  layoutIndex: number
): ScheduleEditResult {
  const flight = state.flights.find((item) => item.id === flightId);
  if (!flight) return { changed: false, error: "航班不存在" };
  const normalizedStaffName = normalizeText(staffName);
  const person = normalizedStaffName
    ? state.staff.find((item) => item.name === normalizedStaffName)
    : undefined;
  if (normalizedStaffName && !person)
    return { changed: false, error: `人员不存在：${normalizedStaffName}` };
  const assignment = {
    id: createId("assignment"),
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: null,
    position: normalizeText(position) || "临时岗位",
    staffId: null,
    staffName: "",
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 0,
    fatiguePoints: 0,
    remark: "",
    manualRemark: "",
    status: "manual" as const,
    layoutGroup,
    layoutIndex,
  };
  state.assignments.push(assignment);
  if (!person) return { changed: true, message: "已增加临时岗位" };
  const result = assignStaff(state, assignment.id, person.id);
  if (!result.changed) {
    state.assignments = state.assignments.filter(
      (item) => item.id !== assignment.id
    );
  }
  return result;
}

function refreshSameFlightGuides(state: AppState, flightIds: string[]): void {
  normalizeSupervisorAssignments(state);
  for (const flightId of new Set(flightIds)) {
    const guideAssignments = state.assignments.filter(
      (item) => item.flightId === flightId && isGuideAssignment(state, item)
    );
    const flight = state.flights.find((item) => item.id === flightId);
    const displayIndex = new Map(
      (flight ? activeFlightRules(state, flight) : []).map((rule, index) => [
        rule.id,
        index,
      ])
    );
    guideAssignments.sort(
      (left, right) =>
        (displayIndex.get(left.positionRuleId ?? "") ?? 0) -
        (displayIndex.get(right.positionRuleId ?? "") ?? 0)
    );
    const usedStaffIds = new Set<string>();
    for (const guide of guideAssignments) {
      const candidates = state.assignments
        .filter((item) => item.flightId === flightId && item.id !== guide.id)
        .map((item) => ({
          assignment: item,
          person: guideSourceStaff(state, item),
        }))
        .filter(
          (
            item
          ): item is typeof item & {
            person: NonNullable<typeof item.person>;
          } => Boolean(item.person && !usedStaffIds.has(item.person.id))
        )
        .sort((left, right) =>
          compareGuideSourceAssignments(
            state,
            displayIndex,
            left.assignment,
            right.assignment
          )
        );
      const manualSelection =
        guide.status === "manual" && guide.staffId
          ? candidates.find(
              (candidate) => candidate.person.id === guide.staffId
            )
          : undefined;
      if (manualSelection) {
        guide.staffName = manualSelection.person.name;
        guide.workHours = 0;
        guide.fatiguePoints = 0;
        usedStaffIds.add(manualSelection.person.id);
        continue;
      }
      const selected = candidates[0]?.person;
      guide.staffId = selected?.id ?? null;
      guide.staffName = selected?.name ?? "";
      guide.status = selected ? "assigned" : "unfilled";
      guide.workHours = 0;
      guide.fatiguePoints = 0;
      clearAutomaticAssignmentEvidence(guide);
      if (selected) usedStaffIds.add(selected.id);
    }
  }
}

export function assignStaff(
  state: AppState,
  assignmentId: string,
  staffId: string,
  sourceAssignmentId?: string
): ScheduleEditResult {
  const assignment = state.assignments.find((item) => item.id === assignmentId);
  if (!assignment || sourceAssignmentId === assignmentId)
    return { changed: false };
  if (!staffId) {
    captureCountBaseline(assignment);
    const rule = assignment.positionRuleId
      ? state.positionRules.find(
          (item) => item.id === assignment.positionRuleId
        )
      : undefined;
    clearSupervisorLink(state, assignment);
    assignment.staffId = null;
    assignment.staffName = "";
    assignment.status =
      rule?.manual ||
      isAuxiliaryCategory(rule?.category) ||
      !assignment.positionRuleId
        ? "manual"
        : "unfilled";
    clearAutomaticAssignmentEvidence(assignment);
    delete assignment.manualOverrideWarnings;
    // Explicitly clearing a cell must not immediately refill it through the
    // same-flight guide reuse pass. Linked reuse cells are cleared together.
    for (const linked of state.assignments) {
      if (linked.supervisorSourceAssignmentId !== assignment.id) continue;
      clearSupervisorLink(state, linked);
    }
    refreshManualRuleEvidence(state);
    return { changed: true, message: "岗位已设为待补位" };
  }
  const source = sourceAssignmentId
    ? state.assignments.find((item) => item.id === sourceAssignmentId)
    : undefined;
  if (source) {
    const previousSource = { ...source };
    const previousTarget = { ...assignment };
    const error = moveSupervisorWithinFlight(state, source.id, assignment.id);
    if (!error) {
      captureCountBaseline(assignment, previousTarget);
      if (source.staffId !== previousSource.staffId)
        captureCountBaseline(source, previousSource);
      refreshSameFlightGuides(state, [assignment.flightId]);
      refreshManualRuleEvidence(state);
      return { changed: true, message: "督导已机动补位至目标岗位" };
    }
    const sourceRule = source.positionRuleId
      ? state.positionRules.find((item) => item.id === source.positionRuleId)
      : undefined;
    if (
      sourceRule?.category === "机动督导" ||
      source.supervisorSourceAssignmentId
    )
      return { changed: false, error };
  }
  const targetStaffId = assignment.staffId;
  const targetStaffName = assignment.staffName;
  const copySource = Boolean(
    sourceAssignmentId &&
    (isGuideAssignment(state, assignment) ||
      (!targetStaffId &&
        isDiversionTransfer(state, sourceAssignmentId, assignmentId)))
  );
  const evaluation = evaluateManualAssignment(
    state,
    assignmentId,
    staffId,
    copySource ? undefined : sourceAssignmentId
  );
  const blocker = evaluation.blockers[0];
  if (blocker) return { changed: false, error: blocker.message };
  const person = state.staff.find((item) => item.id === staffId);
  if (!person) return { changed: false };
  if (source && !copySource && targetStaffId) {
    const reverseEvaluation = evaluateManualAssignment(
      state,
      source.id,
      targetStaffId,
      assignment.id
    );
    const reverseBlocker = reverseEvaluation.blockers[0];
    if (reverseBlocker)
      return { changed: false, error: `无法交换：${reverseBlocker.message}` };
  }
  captureCountBaseline(assignment);
  if (source && !copySource) captureCountBaseline(source);
  clearSupervisorLink(state, assignment);
  assignment.staffId = person.id;
  assignment.staffName = person.name;
  const guideAssignment = isGuideAssignment(state, assignment);
  assignment.status = guideAssignment ? "manual" : "assigned";
  if (guideAssignment) {
    assignment.workHours = 0;
    assignment.fatiguePoints = 0;
  }
  clearAutomaticAssignmentEvidence(assignment);
  if (source && !copySource) {
    clearSupervisorLink(state, source);
    if (targetStaffId) {
      source.staffId = targetStaffId;
      source.staffName = targetStaffName;
      source.status = "assigned";
      clearAutomaticAssignmentEvidence(source);
    } else {
      const sourceRule = source.positionRuleId
        ? state.positionRules.find((item) => item.id === source.positionRuleId)
        : undefined;
      source.staffId = null;
      source.staffName = "";
      source.status =
        sourceRule?.manual ||
        isAuxiliaryCategory(sourceRule?.category) ||
        !source.positionRuleId
          ? "manual"
          : "unfilled";
      clearAutomaticAssignmentEvidence(source);
    }
  }
  applyEarlyReleaseForStaff(state, assignment.id, person.id);
  if (source && targetStaffId && !copySource)
    applyEarlyReleaseForStaff(state, source.id, targetStaffId);
  replaceManualOverrideWarnings(
    assignment,
    finalManualWarnings(
      state,
      assignment.id,
      person.id,
      copySource ? undefined : sourceAssignmentId
    )
  );
  if (source && !copySource) {
    if (targetStaffId) {
      replaceManualOverrideWarnings(
        source,
        finalManualWarnings(state, source.id, targetStaffId, assignment.id)
      );
    } else {
      delete source.manualOverrideWarnings;
    }
  }
  refreshSameFlightGuides(state, [
    assignment.flightId,
    ...(source ? [source.flightId] : []),
  ]);
  refreshManualRuleEvidence(state);
  const warning = manualOverrideWarningMessage(
    source && !copySource ? [assignment, source] : [assignment]
  );
  return {
    changed: true,
    message:
      source && targetStaffId && !copySource
        ? "人员岗位已交换"
        : copySource
          ? isGuideAssignment(state, assignment)
            ? "引导人员已复用"
            : "分流人员已转派"
          : "人员分配已更新",
    warning,
  };
}

export function updateAssignmentField(
  state: AppState,
  id: string,
  field: string,
  value: string | number | boolean
): ScheduleEditResult {
  const assignment = state.assignments.find((item) => item.id === id);
  if (!assignment) return { changed: false };
  if (field === "manualRemark") {
    assignment.manualRemark = normalizeText(value);
    return { changed: true };
  }
  if (field === "position" && !assignment.positionRuleId) {
    assignment.position = normalizeText(value) || "临时岗位";
    return { changed: true };
  }
  if (field !== "staffName") return { changed: false };

  const staffName = normalizeText(value);
  const rule = assignment.positionRuleId
    ? state.positionRules.find((item) => item.id === assignment.positionRuleId)
    : undefined;
  if (!staffName) return assignStaff(state, id, "");
  const person = state.staff.find((item) => item.name === staffName);
  if (!person && rule?.category === "引导") {
    return {
      changed: false,
      error: "引导岗位只能复用同一航班中已经上岗的常规人员",
    };
  }
  if (!person) return { changed: false, error: `人员不存在：${staffName}` };
  return assignStaff(state, id, person.id);
}

export function deleteTemporaryAssignment(
  state: AppState,
  id: string
): boolean {
  const assignment = state.assignments.find((item) => item.id === id);
  if (!assignment || assignment.positionRuleId) return false;
  state.assignments = state.assignments.filter((item) => item.id !== id);
  return true;
}
