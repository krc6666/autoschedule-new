import {
  flightPlanReviewSummaries,
  type FlightPlanReviewSummary,
  normalizeFlightPlanConfirmations,
} from "../domain/flights/flight-plan-review";
import { migrateLegacySupervisorFillConfiguration } from "../domain/coverage/supervisor-fill-configuration";
import type { WorkbookImport } from "../infrastructure/excel";
import { compileWorkbookConfigurationRestore } from "../infrastructure/workbook-configuration-contract";
import type { DutyRosterImportPreview } from "../infrastructure/duty-roster-excel";
import type { LegacyScheduleImportPreview } from "../infrastructure/legacy-schedule-excel";
import {
  clearUnqualifiedStandbyOverrides,
  getDutyRosterForDate,
} from "../domain/duty-roster/roster";
import { applyScheduleSettingsPatch } from "../domain/rules/schedule-settings";
import { clearActiveSchedule } from "../domain/kernel/schedule-lifecycle";
import type { AppState, HistoryRecord } from "../model";
import { createId, orderPositionRules } from "../utils";
import { normalizeHalfRestSelections } from "../domain/records/half-rest-selections";
import {
  createEmptyWeeklyFlightPlans,
  normalizeWeeklyFlightNo,
  replaceWeeklyFlightPlan,
} from "../domain/flights/weekly-flight-plan";
import { synchronizeImportedRuleFlightsToTemplates } from "./template-position-rule-sync";

export type ImportMode = "all" | "config" | "history";

export interface AppliedWorkbookImport {
  flightPlanReview?: FlightPlanReviewSummary[];
  changedConfig: boolean;
  recognized: string;
  weeklyPlanPreview?: WeeklyPlanImportPreview;
  historySummary?: HistoryImportSummary;
  rejected?: number;
  errors?: string[];
  restoreDefaults?: string[];
}

export interface WeeklyPlanImportPreview {
  plans: AppState["weeklyFlightPlans"];
  unavailableFlightNos: string[];
}

export interface WorkbookImportOptions {
  replaceSharedTemplates?: boolean;
  restoreFlightConfiguration?: boolean;
}

export interface HistoryImportSummary {
  total: number;
  added: number;
  replaced: number;
  unmatchedStaff: number;
}

function historyKey(
  record: Pick<
    HistoryRecord,
    "date" | "flightNo" | "position" | "staffId" | "staffName"
  >
): string {
  return JSON.stringify([
    record.date,
    record.flightNo,
    record.position,
    record.staffId ? "id" : "name",
    record.staffId || record.staffName,
  ]);
}

function summarizeHistoryImport(
  state: AppState,
  records: readonly HistoryRecord[],
  importedStaff: AppState["staff"] | undefined
): HistoryImportSummary {
  const existingKeys = new Set(state.history.map(historyKey));
  const incomingKeys = new Set<string>();
  let added = 0;
  let replaced = 0;
  for (const record of records) {
    const key = historyKey(record);
    if (existingKeys.has(key) || incomingKeys.has(key)) replaced += 1;
    else added += 1;
    incomingKeys.add(key);
  }
  const staffIds = new Set(
    (importedStaff ?? state.staff).map((person) => person.id)
  );
  return {
    total: records.length,
    added,
    replaced,
    unmatchedStaff: records.filter(
      (record) => !record.staffId || !staffIds.has(record.staffId)
    ).length,
  };
}

function mergeHistoryImport(
  state: AppState,
  records: readonly HistoryRecord[]
): void {
  const incomingByKey = new Map<string, HistoryRecord>();
  for (const record of records) incomingByKey.set(historyKey(record), record);
  const incomingKeys = new Set(incomingByKey.keys());
  state.history = [
    ...state.history.filter((record) => !incomingKeys.has(historyKey(record))),
    ...incomingByKey.values(),
  ];
}

export function applyLegacyScheduleImport(
  state: AppState,
  preview: LegacyScheduleImportPreview,
  targetDate?: string
): {
  imported: number;
  skipped: number;
} {
  const existing = new Map(
    state.history.map((record) => [historyKey(record), record])
  );
  const incoming = preview.records.filter(
    (record) => record.status === "ready" && record.staffId && record.staffName
  );
  let imported = 0;
  for (const record of incoming) {
    const date = targetDate || record.date;
    const {
      rawText: _rawText,
      sourceSheet: _sourceSheet,
      sourceCell: _sourceCell,
      status: _status,
      issue: _issue,
      ...historyRecord
    } = record;
    const key = historyKey({ ...record, date });
    const existingRecord = existing.get(key);
    if (existingRecord) {
      if (existingRecord.id.startsWith("legacy-history-")) {
        Object.assign(existingRecord, {
          ...historyRecord,
          date,
          historyCoverage: "late-priority-only" as const,
        });
      }
      continue;
    }
    state.history.push({
      ...historyRecord,
      date,
      historyCoverage: "late-priority-only",
    });
    existing.set(key, state.history.at(-1)!);
    imported += 1;
  }
  return {
    imported,
    skipped: preview.records.length - imported,
  };
}

export function validateDutyRosterImport(
  preview: DutyRosterImportPreview
): DutyRosterImportPreview {
  const errors = [...new Set(preview.errors)];
  return {
    ...preview,
    errors,
    canApply: preview.recognizedAssignments > 0 && !errors.length,
  };
}

export function applyDutyRosterImport(
  state: AppState,
  preview: DutyRosterImportPreview
): { importedDays: number; importedAssignments: number } {
  const validated = validateDutyRosterImport(preview);
  if (!validated.canApply) return { importedDays: 0, importedAssignments: 0 };
  const existingByDate = new Map(
    preview.rows.map((row) => [row.date, getDutyRosterForDate(state, row.date)])
  );
  state.dutyRosterOverrides = [
    ...state.dutyRosterOverrides.filter(
      (existing) => !preview.rows.some((row) => row.date === existing.date)
    ),
    ...preview.rows.map((row) => ({
      date: row.date,
      cxPreflightStaffId:
        existingByDate.get(row.date)?.cxPreflightStaffId ?? null,
      dutyStaffId:
        row.dutyIncluded === false
          ? (existingByDate.get(row.date)?.dutyStaffId ?? null)
          : row.dutyStaffId,
      standbyStaffIds:
        row.standbyIncluded === false
          ? ([
              ...(existingByDate.get(row.date)?.standbyStaffIds ?? [
                null,
                null,
              ]),
            ] as [string | null, string | null])
          : ([...row.standbyStaffIds] as [string | null, string | null]),
    })),
  ];
  return {
    importedDays: preview.rows.length,
    importedAssignments: preview.recognizedAssignments,
  };
}

export function applyWorkbookImport(
  state: AppState,
  imported: WorkbookImport,
  mode: ImportMode,
  options: WorkbookImportOptions = {}
): AppliedWorkbookImport {
  const importConfig = mode !== "history";
  const restoreFlightConfiguration =
    importConfig && options.restoreFlightConfiguration === true;
  const replaceSharedTemplates =
    restoreFlightConfiguration || options.replaceSharedTemplates === true;
  let restoreDefaults: string[] | undefined;
  if (restoreFlightConfiguration) {
    const compiled = compileWorkbookConfigurationRestore(imported);
    const { errors } = compiled;
    if (errors.length)
      return {
        changedConfig: false,
        recognized: "",
        errors: [
          ...errors,
          "本次未写入任何数据；请在原电脑用当前版本重新导出完整配置，或取消完整恢复后按部分配置导入",
        ],
      };
    imported = compiled.imported;
    restoreDefaults = compiled.restoreDefaults;
  }
  if (importConfig && imported.dutyRosterInvalid) {
    return {
      changedConfig: false,
      recognized: "",
      errors: ["值班轮值工作表存在错误，未写入任何值班轮值数据"],
    };
  }
  if (importConfig && imported.leaveTypes !== undefined) {
    const ids = new Set(imported.leaveTypes.map((type) => type.id));
    const missingReferences = (imported.staff ?? state.staff).filter(
      (person) => person.leaveTypeId && !ids.has(person.leaveTypeId)
    );
    if (missingReferences.length)
      return {
        changedConfig: false,
        recognized: "",
        rejected: missingReferences.length,
        errors: [
          "休假类别表缺少人员正在使用的类别编号，本次配置未写入；请补齐类别或先修改人员状态",
        ],
      };
  }
  const importHistory = imported.history !== undefined;
  const historySummary = importHistory
    ? summarizeHistoryImport(state, imported.history ?? [], imported.staff)
    : undefined;
  const activeStaffIds = new Set(
    (imported.staff ?? state.staff).map((person) => person.id)
  );
  const otherGroupId = state.activeGroupId === "A" ? "B" : "A";
  const otherStaffIds = new Set(
    state.groups[otherGroupId].staff.map((person) => person.id)
  );
  if (importConfig && imported.staff !== undefined) {
    const duplicateStaffIds = [
      ...new Set(
        imported.staff
          .filter((person) => otherStaffIds.has(person.id))
          .map((person) => person.id)
      ),
    ];
    if (duplicateStaffIds.length)
      return {
        changedConfig: false,
        recognized: "",
        rejected: duplicateStaffIds.length,
        errors: [
          `人员编号已属于另一组：${duplicateStaffIds.join("、")}，本次导入未写入`,
        ],
      };
  }
  if (importConfig && imported.flightPlanConfirmations !== undefined)
    state.flightPlanConfirmations = normalizeFlightPlanConfirmations(
      imported.flightPlanConfirmations
    );
  if (importConfig && imported.leaveTypes !== undefined)
    state.leaveTypes = structuredClone(imported.leaveTypes);
  if (importConfig && imported.staff !== undefined) {
    state.staff = imported.staff;
    clearUnqualifiedStandbyOverrides(state);
  }
  if (importConfig && imported.positionRules !== undefined)
    state.positionRules = orderPositionRules(
      imported.positionRules.map((rule) => ({
        ...rule,
        qualifiedStaffIds: rule.manual
          ? rule.qualifiedStaffIds
          : rule.qualifiedStaffIds.filter((staffId) =>
              activeStaffIds.has(staffId)
            ),
      }))
    );
  if (
    importConfig &&
    replaceSharedTemplates &&
    imported.templates !== undefined
  ) {
    state.templates = imported.templates;
    state.shared.templates = state.templates;
  }
  if (importConfig && imported.settings) {
    const settingsPatch = { ...imported.settings };
    if (imported.settings.sameFlightStaffExclusions !== undefined)
      settingsPatch.sameFlightStaffExclusions =
        imported.settings.sameFlightStaffExclusions.filter(
          (rule) =>
            activeStaffIds.has(rule.firstStaffId) &&
            activeStaffIds.has(rule.secondStaffId)
        );
    if (imported.settings.crossFlightPriorityPolicies !== undefined)
      settingsPatch.crossFlightPriorityPolicies =
        imported.settings.crossFlightPriorityPolicies.map((rule) => ({
          ...rule,
          staffIds: rule.staffIds.filter((staffId) =>
            activeStaffIds.has(staffId)
          ),
        }));
    state.settings = applyScheduleSettingsPatch(state.settings, settingsPatch);
  }
  if (
    importConfig &&
    (imported.positionRules !== undefined ||
      imported.settings?.mobileSupervisorFillRules !== undefined)
  ) {
    // Missing relationship sheets retain current canonical relationships. Legacy
    // position flags can add a pending item, never silently enable a new link.
    const relations = state.settings.mobileSupervisorFillRules;
    if (imported.settings?.mobileSupervisorFillRules === undefined)
      relations.forEach((rule) => {
        rule.requiresConfirmation ??= false;
      });
    migrateLegacySupervisorFillConfiguration(state.positionRules, relations);
  }
  if (importConfig && imported.latePriorityFrequencyAdjustments !== undefined)
    state.latePriorityFrequencyAdjustments =
      imported.latePriorityFrequencyAdjustments;
  if (
    importConfig &&
    imported.ordinaryPriorityFrequencyAdjustments !== undefined
  )
    state.ordinaryPriorityFrequencyAdjustments =
      imported.ordinaryPriorityFrequencyAdjustments;
  if (importConfig && imported.dutyRosterOverrides !== undefined)
    state.dutyRosterOverrides = structuredClone(imported.dutyRosterOverrides);
  if (
    imported.halfRestSelections !== undefined &&
    (importConfig || importHistory)
  ) {
    const incoming = normalizeHalfRestSelections(imported.halfRestSelections);
    const dates = new Set(incoming.map((row) => row.date));
    state.halfRestSelections = importConfig
      ? incoming
      : normalizeHalfRestSelections([
          ...(state.halfRestSelections ?? []).filter(
            (row) => !dates.has(row.date)
          ),
          ...incoming,
        ]);
  }
  if (
    importConfig &&
    replaceSharedTemplates &&
    imported.flights !== undefined &&
    imported.templates === undefined
  ) {
    state.templates = imported.flights.map(
      ({ id, bookedPassengers: _bookedPassengers, ...flight }) => ({
        ...structuredClone(flight),
        id: createId("template"),
      })
    );
    state.shared.templates = state.templates;
  }
  if (
    (mode === "all" || restoreFlightConfiguration) &&
    imported.flights !== undefined
  )
    state.flights = imported.flights;
  const addedRuleFlightTemplates =
    importConfig &&
    !restoreFlightConfiguration &&
    imported.positionRules !== undefined
      ? synchronizeImportedRuleFlightsToTemplates(
          state,
          state.positionRules,
          imported.flights ?? [],
          imported.templates ?? []
        )
      : [];
  let weeklyPlanPreview: WeeklyPlanImportPreview | undefined;
  if (importConfig && imported.weeklyFlightPlans !== undefined) {
    const availableFlightNos = new Set(
      state.templates.map((template) =>
        normalizeWeeklyFlightNo(template.flightNo)
      )
    );
    const importedFlightNos = new Set(
      imported.weeklyFlightPlans
        .flatMap((entry) => entry.flightNos)
        .map(normalizeWeeklyFlightNo)
        .filter(Boolean)
    );
    state.weeklyFlightPlans = imported.weeklyFlightPlans.reduce(
      (plans, entry) =>
        replaceWeeklyFlightPlan(
          plans,
          entry.weekday,
          entry.flightNos.filter((flightNo) =>
            availableFlightNos.has(normalizeWeeklyFlightNo(flightNo))
          )
        ),
      createEmptyWeeklyFlightPlans()
    );
    state.shared.weeklyFlightPlans = state.weeklyFlightPlans;
    weeklyPlanPreview = {
      plans: structuredClone(state.weeklyFlightPlans),
      unavailableFlightNos: [...importedFlightNos].filter(
        (flightNo) => !availableFlightNos.has(flightNo)
      ),
    };
  }
  if (importHistory && imported.history)
    mergeHistoryImport(state, imported.history);
  const changedConfig =
    importConfig &&
    Boolean(
      imported.staff !== undefined ||
      imported.leaveTypes !== undefined ||
      ((mode === "all" || restoreFlightConfiguration) &&
        imported.flights !== undefined) ||
      (replaceSharedTemplates &&
        (imported.templates !== undefined ||
          (imported.flights !== undefined &&
            imported.templates === undefined))) ||
      imported.weeklyFlightPlans !== undefined ||
      imported.positionRules !== undefined ||
      imported.settings ||
      imported.latePriorityFrequencyAdjustments !== undefined ||
      imported.ordinaryPriorityFrequencyAdjustments !== undefined ||
      imported.halfRestSelections !== undefined ||
      imported.flightPlanConfirmations !== undefined ||
      imported.dutyRosterOverrides !== undefined
    );
  if (changedConfig) {
    clearActiveSchedule(state);
  }
  const recognized = [
    importConfig &&
      imported.flightPlanConfirmations !== undefined &&
      `${imported.flightPlanConfirmations.length} 条航班换季确认`,
    imported.halfRestSelections !== undefined &&
      `${imported.halfRestSelections.length} 个工作日半休标记`,
    importConfig &&
      imported.leaveTypes !== undefined &&
      `${imported.leaveTypes.length} 个休假类别`,
    importConfig &&
      imported.staff !== undefined &&
      `${imported.staff.length} 人`,
    importConfig &&
      (mode === "all" || restoreFlightConfiguration) &&
      imported.flights !== undefined &&
      `${imported.flights.length} 个航班计划`,
    importConfig &&
      replaceSharedTemplates &&
      imported.templates !== undefined &&
      `${imported.templates.length} 个航班模板`,
    importConfig &&
      addedRuleFlightTemplates.length > 0 &&
      `${addedRuleFlightTemplates.length} 个岗位航班补入共用模板`,
    importConfig &&
      replaceSharedTemplates &&
      imported.flights !== undefined &&
      imported.templates === undefined &&
      `${imported.flights.length} 个航班模板`,
    importConfig && imported.weeklyFlightPlans !== undefined && "每周航班计划",
    importConfig &&
      imported.positionRules !== undefined &&
      `${imported.positionRules.length} 条岗位规则`,
    importConfig && imported.settings && "规则配置",
    importConfig &&
      imported.latePriorityFrequencyAdjustments &&
      "末班重点次数修正",
    importConfig &&
      imported.dutyRosterOverrides !== undefined &&
      `${imported.dutyRosterOverrides.length} 条值班轮值`,
    importHistory &&
      imported.history?.length &&
      `${imported.history.length} 条历史负荷`,
  ]
    .filter(Boolean)
    .join("、");
  return {
    changedConfig,
    recognized,
    ...(weeklyPlanPreview ? { weeklyPlanPreview } : {}),
    historySummary,
    flightPlanReview: importConfig ? flightPlanReviewSummaries(state) : [],
    ...(restoreDefaults?.length ? { restoreDefaults } : {}),
  };
}
