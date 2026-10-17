import type { WorkbookImport } from "../infrastructure/excel";
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
import {
  createEmptyWeeklyFlightPlans,
  normalizeWeeklyFlightNo,
  replaceWeeklyFlightPlan,
} from "../domain/flights/weekly-flight-plan";

export type ImportMode = "all" | "config" | "history";

export interface AppliedWorkbookImport {
  changedConfig: boolean;
  recognized: string;
  historySummary?: HistoryImportSummary;
  rejected?: number;
  errors?: string[];
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

function mergePositionRuleQualifications(
  current: AppState["positionRules"],
  imported: AppState["positionRules"],
  activeStaffIds: Set<string>,
  otherStaffIds: Set<string>
): AppState["positionRules"] {
  const ruleKey = (rule: AppState["positionRules"][number]) =>
    `${rule.flightNo.trim().toUpperCase()}|${rule.name.trim()}|${rule.category}`;
  const currentByKey = new Map(current.map((rule) => [ruleKey(rule), rule]));
  return imported.map((rule) => {
    const existing = currentByKey.get(ruleKey(rule));
    return {
      ...rule,
      qualifiedStaffIds: rule.manual
        ? rule.qualifiedStaffIds
        : [
            ...(existing?.qualifiedStaffIds ?? []).filter((staffId) =>
              otherStaffIds.has(staffId)
            ),
            ...rule.qualifiedStaffIds.filter((staffId) =>
              activeStaffIds.has(staffId)
            ),
          ],
    };
  });
}

function mergeActiveGroupPersonnelRules(
  current: AppState["settings"]["sameFlightStaffExclusions"],
  imported: AppState["settings"]["sameFlightStaffExclusions"],
  activeStaffIds: Set<string>,
  otherStaffIds: Set<string>
): AppState["settings"]["sameFlightStaffExclusions"] {
  return [
    ...current.filter(
      (rule) =>
        otherStaffIds.has(rule.firstStaffId) &&
        otherStaffIds.has(rule.secondStaffId)
    ),
    ...imported.filter(
      (rule) =>
        activeStaffIds.has(rule.firstStaffId) &&
        activeStaffIds.has(rule.secondStaffId)
    ),
  ];
}

function mergeActiveGroupCrossFlightPriorityRules(
  current: AppState["settings"]["crossFlightPriorityPolicies"],
  imported: AppState["settings"]["crossFlightPriorityPolicies"],
  activeStaffIds: Set<string>,
  otherStaffIds: Set<string>
): AppState["settings"]["crossFlightPriorityPolicies"] {
  const importedIds = new Set(imported.map((rule) => rule.id));
  const merged = imported.map((rule) => ({
    ...rule,
    staffIds: [
      ...(current
        .find((item) => item.id === rule.id)
        ?.staffIds.filter((staffId) => otherStaffIds.has(staffId)) ?? []),
      ...rule.staffIds.filter((staffId) => activeStaffIds.has(staffId)),
    ],
  }));
  const retainedOtherGroupRows = current.flatMap((rule) => {
    if (importedIds.has(rule.id)) return [];
    const staffIds = rule.staffIds.filter((staffId) =>
      otherStaffIds.has(staffId)
    );
    return staffIds.length ? [{ ...rule, staffIds }] : [];
  });
  return [...merged, ...retainedOtherGroupRows];
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
  mode: ImportMode
): AppliedWorkbookImport {
  const importConfig = mode !== "history";
  if (importConfig && imported.dutyRosterInvalid) {
    return {
      changedConfig: false,
      recognized: "",
      errors: ["值班轮值工作表存在错误，未写入任何值班轮值数据"],
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
  if (importConfig && imported.staff !== undefined) {
    state.staff = imported.staff;
    clearUnqualifiedStandbyOverrides(state);
  }
  if (importConfig && imported.positionRules !== undefined)
    state.positionRules = orderPositionRules(
      mergePositionRuleQualifications(
        state.positionRules,
        imported.positionRules,
        activeStaffIds,
        otherStaffIds
      )
    );
  if (importConfig && imported.templates !== undefined)
    state.templates = imported.templates;
  if (importConfig && imported.settings) {
    const settingsPatch = { ...imported.settings };
    if (imported.settings.sameFlightStaffExclusions !== undefined)
      settingsPatch.sameFlightStaffExclusions = mergeActiveGroupPersonnelRules(
        state.settings.sameFlightStaffExclusions,
        imported.settings.sameFlightStaffExclusions,
        activeStaffIds,
        otherStaffIds
      );
    if (imported.settings.crossFlightPriorityPolicies !== undefined)
      settingsPatch.crossFlightPriorityPolicies =
        mergeActiveGroupCrossFlightPriorityRules(
          state.settings.crossFlightPriorityPolicies,
          imported.settings.crossFlightPriorityPolicies,
          activeStaffIds,
          otherStaffIds
        );
    state.settings = applyScheduleSettingsPatch(state.settings, settingsPatch);
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
    importConfig &&
    imported.flights !== undefined &&
    imported.templates === undefined
  ) {
    state.templates = imported.flights.map(
      ({ id, bookedPassengers: _bookedPassengers, ...flight }) => ({
        ...structuredClone(flight),
        id: createId("template"),
      })
    );
  }
  if (importConfig && imported.weeklyFlightPlans) {
    const availableFlightNos = new Set(
      state.templates.map((template) =>
        normalizeWeeklyFlightNo(template.flightNo)
      )
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
  }
  if (mode === "all" && imported.flights !== undefined)
    state.flights = imported.flights;
  if (importHistory && imported.history)
    mergeHistoryImport(state, imported.history);
  const changedConfig =
    importConfig &&
    Boolean(
      imported.staff !== undefined ||
      imported.flights !== undefined ||
      imported.templates !== undefined ||
      imported.weeklyFlightPlans ||
      imported.positionRules !== undefined ||
      imported.settings ||
      imported.latePriorityFrequencyAdjustments !== undefined ||
      imported.dutyRosterOverrides !== undefined
    );
  if (changedConfig) {
    clearActiveSchedule(state);
  }
  const recognized = [
    importConfig &&
      imported.staff !== undefined &&
      `${imported.staff.length} 人`,
    importConfig &&
      imported.flights !== undefined &&
      `${imported.flights.length} 个航班计划`,
    importConfig &&
      imported.templates !== undefined &&
      `${imported.templates.length} 个航班模板`,
    importConfig && imported.weeklyFlightPlans && "每周航班计划",
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
  return { changedConfig, recognized, historySummary };
}
