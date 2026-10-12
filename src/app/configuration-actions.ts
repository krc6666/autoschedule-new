import { isAuxiliaryCategory } from "../domain/flights/schedule-position-rules";
import type { FlightPlanReconciliation } from "../domain/flights/flight-plan-reconciliation";
import type { AppState, Flight, FlightTemplate, IsoWeekday } from "../model";
import { clearActiveSchedule } from "../domain/kernel/schedule-lifecycle";
import { clearUnqualifiedStandbyOverrides } from "../domain/duty-roster/roster";
import {
  createId,
  normalizeText,
  orderPositionRules,
  sortFlightCountersDescending,
  splitList,
} from "../utils";
import {
  normalizeWeeklyFlightNo,
  replaceWeeklyFlightNumber,
  replaceWeeklyFlightPlan,
} from "../domain/flights/weekly-flight-plan";
import {
  removeTeamLeaderGapFillPositionReference,
  replaceTeamLeaderGapFillPositionReference,
} from "../domain/coverage/team-leader-gap-fill-protection";

export type ConfigurationValue = string | number | boolean;

const clearSchedule = clearActiveSchedule;

function renameActiveFlightReferences(
  state: AppState,
  previousFlightNo: string,
  nextFlightNo: string
): void {
  const previous = normalizeWeeklyFlightNo(previousFlightNo);
  const next = nextFlightNo.trim().toUpperCase();
  if (!previous || !next || previous === normalizeWeeklyFlightNo(next)) return;
  state.positionRules.forEach((rule) => {
    if (normalizeWeeklyFlightNo(rule.flightNo) === previous)
      rule.flightNo = next;
  });
  state.settings.mobileSupervisorFillRules.forEach((policy) => {
    if (normalizeWeeklyFlightNo(policy.sourceFlightNo) === previous)
      policy.sourceFlightNo = next;
    if (normalizeWeeklyFlightNo(policy.targetFlightNo) === previous)
      policy.targetFlightNo = next;
  });
}

function createFlightFromTemplate(
  template: FlightTemplate,
  flightNo = template.flightNo
): Flight {
  return {
    id: createId("flight"),
    flightNo,
    startTime: template.startTime,
    endTime: template.endTime,
    bookedPassengers: 0,
    positions: [...template.positions],
    remark: template.remark,
  };
}

export function addFlight(state: AppState): void {
  const flight: Flight = {
    id: createId("flight"),
    flightNo: "NEW",
    startTime: "08:00",
    endTime: "10:00",
    bookedPassengers: 0,
    positions: [],
    remark: "",
  };
  state.flights.push(flight);
  clearSchedule(state);
}

export function deleteFlight(state: AppState, id: string): boolean {
  const before = state.flights.length;
  state.flights = state.flights.filter((item) => item.id !== id);
  if (state.flights.length === before) return false;
  clearSchedule(state);
  return true;
}

export function addTemplate(state: AppState): void {
  const template: FlightTemplate = {
    id: createId("template"),
    flightNo: "NEW",
    startTime: "08:00",
    endTime: "10:00",
    positions: [],
    remark: "",
  };
  state.templates.push(template);
}

export function deleteTemplate(state: AppState, id: string): void {
  const deleted = state.templates.find((item) => item.id === id);
  state.templates = state.templates.filter((item) => item.id !== id);
  if (
    deleted &&
    !state.templates.some(
      (item) =>
        normalizeWeeklyFlightNo(item.flightNo) ===
        normalizeWeeklyFlightNo(deleted.flightNo)
    )
  )
    state.weeklyFlightPlans = replaceWeeklyFlightNumber(
      state.weeklyFlightPlans,
      deleted.flightNo,
      ""
    );
}

export function setWeeklyFlightPlanFlight(
  state: AppState,
  weekday: IsoWeekday,
  flightNo: string,
  selected: boolean
): boolean {
  const normalized = normalizeWeeklyFlightNo(flightNo);
  if (
    !normalized ||
    !state.templates.some(
      (template) => normalizeWeeklyFlightNo(template.flightNo) === normalized
    )
  )
    return false;
  const current =
    state.weeklyFlightPlans.find((entry) => entry.weekday === weekday)
      ?.flightNos ?? [];
  const currentSet = new Set(current.map(normalizeWeeklyFlightNo));
  if (currentSet.has(normalized) === selected) return false;
  selected ? currentSet.add(normalized) : currentSet.delete(normalized);
  state.weeklyFlightPlans = replaceWeeklyFlightPlan(
    state.weeklyFlightPlans,
    weekday,
    [...currentSet]
  );
  return true;
}

export function addTemplateFlight(state: AppState, id: string): boolean {
  const template = state.templates.find((item) => item.id === id);
  if (!template) return false;
  state.flights.push(createFlightFromTemplate(template));
  clearSchedule(state);
  return true;
}

export function addFlightsFromTemplates(
  state: AppState,
  templateIds: string[]
): { added: number; skipped: number } {
  const existingFlightNumbers = new Set(
    state.flights.map((flight) => flight.flightNo.trim().toUpperCase())
  );
  const requestedTemplateIds = new Set<string>();
  let added = 0;
  let skipped = 0;
  for (const templateId of templateIds) {
    if (requestedTemplateIds.has(templateId)) {
      skipped += 1;
      continue;
    }
    requestedTemplateIds.add(templateId);
    const template = state.templates.find((item) => item.id === templateId);
    const flightNo = template?.flightNo.trim().toUpperCase() ?? "";
    if (!template || !flightNo || existingFlightNumbers.has(flightNo)) {
      skipped += 1;
      continue;
    }
    state.flights.push(createFlightFromTemplate(template, flightNo));
    existingFlightNumbers.add(flightNo);
    added += 1;
  }
  if (added) clearSchedule(state);
  return { added, skipped };
}

export function applyFlightPlanReconciliation(
  state: AppState,
  reconciliation: FlightPlanReconciliation,
  templateIds: string[],
  flightIds: string[]
): { added: number; removed: number; skipped: number } {
  const allowedTemplateIds = new Set(
    reconciliation.additions.map((item) => item.template.id)
  );
  const allowedFlightIds = reconciliation.removalAllowed
    ? new Set(reconciliation.removals.map((flight) => flight.id))
    : new Set<string>();
  const selectedTemplateIds = [...new Set(templateIds)];
  const selectedFlightIds = [...new Set(flightIds)];
  const validTemplateIds = selectedTemplateIds.filter((id) =>
    allowedTemplateIds.has(id)
  );
  const validFlightIds = new Set(
    selectedFlightIds.filter((id) => allowedFlightIds.has(id))
  );
  const skippedSelections =
    selectedTemplateIds.length -
    validTemplateIds.length +
    selectedFlightIds.length -
    validFlightIds.size;

  const beforeRemovalCount = state.flights.length;
  if (validFlightIds.size) {
    state.flights = state.flights.filter(
      (flight) => !validFlightIds.has(flight.id)
    );
  }
  const removed = beforeRemovalCount - state.flights.length;
  const additionResult = addFlightsFromTemplates(state, validTemplateIds);
  if (removed && !additionResult.added) clearSchedule(state);
  return {
    added: additionResult.added,
    removed,
    skipped: skippedSelections + additionResult.skipped,
  };
}

export function addStaff(state: AppState): void {
  const numericIds = Object.values(state.groups)
    .flatMap((group) => group.staff)
    .map((item) => Number(item.id))
    .filter(Number.isFinite);
  const id = String(Math.max(0, ...numericIds) + 1);
  state.staff.push({
    id,
    name: "新人员",
    staffType: "常规",
    teamLeader: false,
    cxPreflightQualified: false,
    dutyQualified: true,
    standbyQualified: true,
    nightShift: true,
    status: "正常",
    remark: "",
  });
}

export function addAdministrativeStaff(state: AppState): void {
  const allStaffIds = new Set(
    Object.values(state.groups).flatMap((group) =>
      group.staff.map((person) => person.id)
    )
  );
  let sequence = 1;
  while (allStaffIds.has(`A${sequence}`)) sequence += 1;
  state.staff.push({
    id: `A${sequence}`,
    name: `行政支援${sequence}`,
    staffType: "行政支援",
    teamLeader: false,
    cxPreflightQualified: false,
    dutyQualified: false,
    standbyQualified: false,
    nightShift: true,
    status: "正常",
    remark: "",
  });
}

export function deleteStaff(state: AppState, id: string): boolean {
  const before = state.staff.length;
  state.staff = state.staff.filter((item) => item.id !== id);
  if (state.staff.length === before) return false;
  state.positionRules.forEach((rule) => {
    rule.qualifiedStaffIds = rule.qualifiedStaffIds.filter(
      (staffId) => staffId !== id
    );
  });
  state.latePriorityFrequencyAdjustments =
    state.latePriorityFrequencyAdjustments.filter(
      (adjustment) => adjustment.staffId !== id
    );
  state.settings.sameFlightStaffExclusions =
    state.settings.sameFlightStaffExclusions.filter(
      (rule) => rule.firstStaffId !== id && rule.secondStaffId !== id
    );
  state.settings.crossFlightPriorityPolicies.forEach((rule) => {
    rule.staffIds = rule.staffIds.filter((staffId) => staffId !== id);
  });
  state.dutyRosterOverrides = state.dutyRosterOverrides.map((item) => ({
    ...item,
    cxPreflightStaffId:
      item.cxPreflightStaffId === id ? null : item.cxPreflightStaffId,
    dutyStaffId: item.dutyStaffId === id ? null : item.dutyStaffId,
    standbyStaffIds: item.standbyStaffIds.map((staffId) =>
      staffId === id ? null : staffId
    ) as [string | null, string | null],
  }));
  state.assignments = state.assignments.map((item) => {
    if (item.staffId !== id) return item;
    const rule = item.positionRuleId
      ? state.positionRules.find(
          (ruleItem) => ruleItem.id === item.positionRuleId
        )
      : undefined;
    return {
      ...item,
      staffId: null,
      staffName: "",
      status:
        isAuxiliaryCategory(rule?.category) || !item.positionRuleId
          ? "manual"
          : "unfilled",
    };
  });
  return true;
}

export function addPositions(
  state: AppState,
  flightNo: string,
  requestedCount: number
): number {
  if (!flightNo) return 0;
  const count = Math.max(1, Math.min(30, requestedCount || 1));
  const existingNames = new Set(
    state.positionRules
      .filter((item) => item.flightNo === flightNo)
      .map((item) => item.name)
  );
  let nextNumber = 1;
  for (let index = 0; index < count; index += 1) {
    while (existingNames.has(`新岗位${nextNumber}`)) nextNumber += 1;
    const name = `新岗位${nextNumber}`;
    existingNames.add(name);
    state.positionRules.push({
      id: createId("position"),
      flightNo,
      name,
      category: "常规",
      coverageRole: "none",
      remark: "",
      qualifiedStaffIds: [],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    });
    nextNumber += 1;
  }
  clearSchedule(state);
  return count;
}

export function copyPositionRules(
  state: AppState,
  sourceFlightNo: string,
  targetFlightNo: string,
  overwrite = false
): boolean {
  const source = normalizeWeeklyFlightNo(sourceFlightNo);
  const target = normalizeWeeklyFlightNo(targetFlightNo);
  const targetLabel = targetFlightNo.trim().toUpperCase();
  if (!source || !target || source === target) return false;
  const sourceRules = state.positionRules.filter(
    (rule) => normalizeWeeklyFlightNo(rule.flightNo) === source
  );
  if (!sourceRules.length) return false;
  const targetRules = state.positionRules.filter(
    (rule) => normalizeWeeklyFlightNo(rule.flightNo) === target
  );
  if (targetRules.length && !overwrite) return false;

  const copied = sourceRules.map((rule) => ({
    ...rule,
    id: createId("position"),
    flightNo: targetLabel,
    qualifiedStaffIds: [...rule.qualifiedStaffIds],
  }));
  state.positionRules = orderPositionRules([
    ...state.positionRules.filter(
      (rule) => normalizeWeeklyFlightNo(rule.flightNo) !== target
    ),
    ...copied,
  ]);
  clearSchedule(state);
  return true;
}

export function deletePosition(state: AppState, id: string): boolean {
  const deleted = state.positionRules.find((item) => item.id === id);
  const before = state.positionRules.length;
  state.positionRules = state.positionRules.filter((item) => item.id !== id);
  if (state.positionRules.length === before) return false;
  if (deleted)
    state.settings.teamLeaderGapFillPositionPolicies =
      removeTeamLeaderGapFillPositionReference(
        state.settings.teamLeaderGapFillPositionPolicies,
        deleted
      );
  if (deleted)
    state.settings.mobileSupervisorFillRules =
      state.settings.mobileSupervisorFillRules.filter(
        (rule) =>
          !(
            rule.sourceFlightNo === deleted.flightNo &&
            rule.sourcePositionKeyword === deleted.name
          ) &&
          !(
            rule.targetFlightNo === deleted.flightNo &&
            rule.targetPositionKeyword === deleted.name
          )
      );
  clearSchedule(state);
  return true;
}

export function movePosition(
  state: AppState,
  id: string,
  direction: -1 | 1
): boolean {
  const rule = state.positionRules.find((item) => item.id === id);
  if (!rule) return false;
  const siblingIndexes = state.positionRules
    .map((item, index) => (item.flightNo === rule.flightNo ? index : -1))
    .filter((index) => index >= 0);
  const currentSiblingIndex = siblingIndexes.indexOf(
    state.positionRules.indexOf(rule)
  );
  const targetIndex = siblingIndexes[currentSiblingIndex + direction];
  if (targetIndex === undefined) return false;
  const currentIndex = state.positionRules.indexOf(rule);
  [state.positionRules[currentIndex], state.positionRules[targetIndex]] = [
    state.positionRules[targetIndex]!,
    state.positionRules[currentIndex]!,
  ];
  state.positionRules = orderPositionRules(state.positionRules);
  clearSchedule(state);
  return true;
}

export function sortCountersDescending(
  state: AppState,
  flightNo: string
): boolean {
  if (!flightNo) return false;
  state.positionRules = sortFlightCountersDescending(
    state.positionRules,
    flightNo
  );
  clearSchedule(state);
  return true;
}

export function saveQualified(
  state: AppState,
  id: string,
  manual: boolean,
  staffIds: string[]
): boolean {
  const rule = state.positionRules.find((item) => item.id === id);
  if (!rule) return false;
  const currentStaffIds = new Set(state.staff.map((person) => person.id));
  const otherGroupStaffIds = new Set(
    Object.entries(state.groups)
      .filter(([groupId]) => groupId !== state.activeGroupId)
      .flatMap(([, group]) => group.staff.map((person) => person.id))
  );
  rule.manual = manual;
  rule.qualifiedStaffIds = [
    ...rule.qualifiedStaffIds.filter(
      (staffId) =>
        !currentStaffIds.has(staffId) && otherGroupStaffIds.has(staffId)
    ),
    ...staffIds.filter((staffId) => currentStaffIds.has(staffId)),
  ];
  clearSchedule(state);
  return true;
}

export function updateConfigurationField(
  state: AppState,
  entity: string,
  id: string,
  field: string,
  value: ConfigurationValue
): "updated" | "missing" | "duplicate" {
  if (entity === "settings") {
    const key = field as keyof AppState["settings"];
    (state.settings[key] as string | number) = value as string | number;
    clearSchedule(state);
    return "updated";
  }
  if (entity === "flight") {
    const flight = state.flights.find((item) => item.id === id);
    if (!flight) return "missing";
    const previousFlightNo = flight.flightNo;
    if (field === "positions") flight.positions = splitList(value);
    else {
      const nextValue =
        typeof value === "string" && field === "flightNo"
          ? value.toUpperCase()
          : value;
      (flight as unknown as Record<string, unknown>)[field] = nextValue;
      if (field === "flightNo" && typeof nextValue === "string") {
        renameActiveFlightReferences(state, previousFlightNo, nextValue);
        const template = state.templates.find(
          (item) => item.flightNo.toUpperCase() === nextValue
        );
        if (template) {
          flight.startTime = template.startTime;
          flight.endTime = template.endTime;
          flight.positions = [...template.positions];
          flight.remark = template.remark;
        }
      }
    }
    clearSchedule(state);
    return "updated";
  }
  if (entity === "position") {
    const rule = state.positionRules.find((item) => item.id === id);
    if (!rule) return "missing";
    const previousReference = { flightNo: rule.flightNo, name: rule.name };
    (rule as unknown as Record<string, unknown>)[field] =
      typeof value === "string" && field === "flightNo"
        ? value.toUpperCase()
        : value;
    if (field === "category") {
      if (value === "分流" && !rule.earlyReleaseMinutes)
        rule.earlyReleaseMinutes = 60;
      if (value !== "分流") rule.earlyReleaseMinutes = 0;
      if (value === "引导" || value === "机动督导") rule.manual = false;
      if (value === "引导") rule.qualifiedStaffIds = [];
      if (value !== "常规") rule.coverageRole = "none";
    }
    if (field === "coverageRole")
      rule.coverageRole =
        value === "supervisor-fill" ? "supervisor-fill" : "none";
    if (field === "name" || field === "flightNo")
      state.positionRules = orderPositionRules(state.positionRules);
    if (field === "name" || field === "flightNo")
      state.settings.teamLeaderGapFillPositionPolicies =
        replaceTeamLeaderGapFillPositionReference(
          state.settings.teamLeaderGapFillPositionPolicies,
          previousReference,
          rule
        );
    if (field === "name" || field === "flightNo") {
      state.settings.mobileSupervisorFillRules.forEach((policy) => {
        if (
          policy.sourceFlightNo === previousReference.flightNo &&
          policy.sourcePositionKeyword === previousReference.name
        ) {
          policy.sourceFlightNo = rule.flightNo;
          policy.sourcePositionKeyword = rule.name;
        }
        if (
          policy.targetFlightNo === previousReference.flightNo &&
          policy.targetPositionKeyword === previousReference.name
        ) {
          policy.targetFlightNo = rule.flightNo;
          policy.targetPositionKeyword = rule.name;
        }
      });
    }
    clearSchedule(state);
    return "updated";
  }
  if (entity === "template") {
    const template = state.templates.find((item) => item.id === id);
    if (!template) return "missing";
    const previousFlightNo = template.flightNo;
    if (field === "flightNo" && typeof value === "string") {
      const next = value.trim().toUpperCase();
      const normalizedNext = normalizeWeeklyFlightNo(next);
      if (
        !next ||
        state.templates.some(
          (item) =>
            item.id !== id &&
            normalizeWeeklyFlightNo(item.flightNo) === normalizedNext
        )
      )
        return "duplicate";
    }
    if (field === "positions") template.positions = splitList(value);
    else
      (template as unknown as Record<string, unknown>)[field] =
        typeof value === "string" && field === "flightNo"
          ? value.toUpperCase()
          : value;
    if (field === "flightNo" && typeof value === "string") {
      state.weeklyFlightPlans = replaceWeeklyFlightNumber(
        state.weeklyFlightPlans,
        previousFlightNo,
        value
      );
      const previous = normalizeWeeklyFlightNo(previousFlightNo);
      const next = value.trim().toUpperCase();
      state.positionRules.forEach((rule) => {
        if (normalizeWeeklyFlightNo(rule.flightNo) === previous)
          rule.flightNo = next;
      });
      state.positionRules = orderPositionRules(state.positionRules);
      const rename = (flightNo: string) =>
        normalizeWeeklyFlightNo(flightNo) === previous ? next : flightNo;
      state.settings.latePriorityFlightNumbers =
        state.settings.latePriorityFlightNumbers.map(rename);
      state.settings.positionTransitionPolicies.forEach((policy) => {
        policy.sourceFlightNo = rename(policy.sourceFlightNo);
        policy.targetFlightNo = rename(policy.targetFlightNo);
      });
      state.settings.dutyPositionPriorities.forEach(
        (policy) => (policy.flightNo = rename(policy.flightNo))
      );
      state.settings.nextWorkdayRecoveryTargets.forEach(
        (policy) => (policy.flightNo = rename(policy.flightNo))
      );
      state.settings.lateShiftRecoveryPositionRules.forEach(
        (policy) => (policy.flightNo = rename(policy.flightNo))
      );
      state.settings.mobileSupervisorCoverageRules.forEach(
        (policy) => (policy.flightNo = rename(policy.flightNo))
      );
      state.settings.mobileSupervisorFillRules.forEach((policy) => {
        policy.sourceFlightNo = rename(policy.sourceFlightNo);
        policy.targetFlightNo = rename(policy.targetFlightNo);
      });
      state.settings.crossWorkdayQualificationReservations.forEach(
        (policy) => (policy.flightNo = rename(policy.flightNo))
      );
      state.settings.crossFlightPriorityPolicies.forEach(
        (policy) => (policy.flightNo = rename(policy.flightNo))
      );
      state.settings.sameFlightStaffExclusions.forEach(
        (rule) => (rule.flightNo = rename(rule.flightNo))
      );
      state.settings.teamLeaderGapFillPositionPolicies =
        state.settings.teamLeaderGapFillPositionPolicies.map((policy) => ({
          ...policy,
          flightNo: rename(policy.flightNo),
        }));
      state.latePriorityFrequencyAdjustments.forEach(
        (adjustment) => (adjustment.flightNo = rename(adjustment.flightNo))
      );
      clearSchedule(state);
    }
    return "updated";
  }
  if (entity === "staff") {
    const person = state.staff.find((item) => item.id === id);
    if (!person) return "missing";
    if (field === "name") {
      const nextName = normalizeText(value) || person.name;
      person.name = nextName;
      state.assignments.forEach((item) => {
        if (item.staffId === id) item.staffName = nextName;
      });
      state.history.forEach((item) => {
        if (item.staffId === id) item.staffName = nextName;
      });
      return "updated";
    }
    if (field === "id" && typeof value === "string" && value !== id) {
      if (
        Object.values(state.groups).some((group) =>
          group.staff.some((item) => item.id === value)
        )
      )
        return "duplicate";
      state.positionRules.forEach((rule) => {
        rule.qualifiedStaffIds = rule.qualifiedStaffIds.map((staffId) =>
          staffId === id ? value : staffId
        );
      });
      state.assignments.forEach((item) => {
        if (item.staffId === id) item.staffId = value;
      });
      state.history.forEach((item) => {
        if (item.staffId === id) item.staffId = value;
      });
      state.dutyRosterOverrides.forEach((item) => {
        if (item.cxPreflightStaffId === id) item.cxPreflightStaffId = value;
        if (item.dutyStaffId === id) item.dutyStaffId = value;
        item.standbyStaffIds = item.standbyStaffIds.map((staffId) =>
          staffId === id ? value : staffId
        ) as [string | null, string | null];
      });
      state.settings.sameFlightStaffExclusions.forEach((rule) => {
        if (rule.firstStaffId === id) rule.firstStaffId = value;
        if (rule.secondStaffId === id) rule.secondStaffId = value;
      });
      state.settings.crossFlightPriorityPolicies.forEach((rule) => {
        rule.staffIds = rule.staffIds.map((staffId) =>
          staffId === id ? value : staffId
        );
      });
    }
    (person as unknown as Record<string, unknown>)[field] = value;
    if (field === "staffType" && value === "行政支援") {
      person.teamLeader = false;
      person.cxPreflightQualified = false;
      person.dutyQualified = false;
      person.standbyQualified = false;
    }
    if (field === "teamLeader" && person.staffType === "行政支援")
      person.teamLeader = false;
    if (field === "standbyQualified" || field === "staffType")
      clearUnqualifiedStandbyOverrides(state);
    clearSchedule(state);
    return "updated";
  }
  return "missing";
}
