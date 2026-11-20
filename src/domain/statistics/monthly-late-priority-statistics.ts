import { flightRuleSettings } from "../flights/flight-rule-settings";
import type { HistoryRecord, PositionRule, Staff } from "../../model";
import {
  flightIdentities,
  flightIdentityKey,
  flightRuleMatches,
} from "../flights/flight-identities";
import type { SchedulingFacts } from "../shared/scheduling-facts";
import {
  latePriorityHistoryRule,
  latePriorityRecordSemantics,
} from "./late-priority-record-semantics";
import {
  baselineStaffId,
  hasQualificationOverride,
  monthlyCountRecords,
} from "./manual-count-evidence";
import {
  endsAfterLateShiftThreshold,
  latePriorityKindForLabel,
  latePriorityKindLabel,
  latePriorityFrequencyKinds,
  LATE_PRIORITY_ALLOWED_DIFFERENCE,
  LATE_PRIORITY_FREQUENCY_ORDER,
  normalizeLatePriorityFlightNumber,
  type LatePriorityKindLabel,
} from "../reviews/late-priority-policy";
import {
  latePriorityFlightInScope,
  normalizeLatePriorityFlightNumbers,
} from "./late-priority-flight-scope";

export type LatePriorityStatisticsCategory = LatePriorityKindLabel;
export const LATE_PRIORITY_STATISTICS_CATEGORIES: readonly LatePriorityStatisticsCategory[] =
  LATE_PRIORITY_FREQUENCY_ORDER.map(latePriorityKindLabel);

export interface LatePriorityStatisticsDetail {
  date: string;
  flightNo: string;
  position: string;
}

export interface MonthlyLatePriorityCategoryStatistics {
  qualified: boolean;
  details: LatePriorityStatisticsDetail[];
  visibleDetails: LatePriorityStatisticsDetail[];
  manualCorrection: number;
  effectiveCount: number;
  baseCount: number;
}

export function canAdjustLatePriorityCategory(
  value: MonthlyLatePriorityCategoryStatistics
): boolean {
  return (
    value.qualified ||
    value.details.length > 0 ||
    value.baseCount > 0 ||
    value.manualCorrection !== 0
  );
}

export interface MonthlyLatePriorityStatisticsRow {
  staff: Staff;
  totalCount: number;
  qualificationOverrideCount: number;
  qualificationUnrecordedCount: number;
  categories: Record<
    LatePriorityStatisticsCategory,
    MonthlyLatePriorityCategoryStatistics
  >;
  flights: Record<string, MonthlyLatePriorityFlightStatistics>;
}

export interface MonthlyLatePriorityFlightStatistics {
  flightNo: string;
  totalCount: number;
  applicableCategories: LatePriorityStatisticsCategory[];
  categories: Record<
    LatePriorityStatisticsCategory,
    MonthlyLatePriorityCategoryStatistics
  >;
}

export interface MonthlyLatePriorityStatistics {
  month: string;
  warnings?: string[];
  flightNumbers: string[];
  rows: MonthlyLatePriorityStatisticsRow[];
  ranges: Record<
    LatePriorityStatisticsCategory,
    { min: number; max: number; difference: number; allowedDifference: number }
  >;
}

/** Count and clamp each original ledger first, then group the resulting events.
 * This preserves old resets/corrections and two actual flights on the same date. */
export function buildMonthlyLatePriorityStatistics(
  state: SchedulingFacts,
  date: string
): MonthlyLatePriorityStatistics {
  const source = buildSourceMonthlyLatePriorityStatistics(state, date);
  if (!flightIdentities(state).length) return source;
  const warnings: string[] = [];
  const numbers = new Set(latePriorityStatisticsFlightNumbers(state));
  const rows = source.rows;
  for (const adjustment of state.latePriorityFrequencyAdjustments) {
    if (
      !adjustment.flightNo.startsWith("@") ||
      adjustment.month !== source.month ||
      !numbers.has(flightIdentityKey(state, adjustment.flightNo)) ||
      rows.some((r) => r.staff.id === adjustment.staffId)
    )
      continue;
    const staff = state.staff.find(
      (s) => s.id === adjustment.staffId && s.staffType === "常规"
    );
    if (staff)
      rows.push({
        staff,
        totalCount: 0,
        qualificationOverrideCount: 0,
        qualificationUnrecordedCount: 0,
        categories: emptyCategories(),
        flights: {},
      });
  }
  for (const row of rows) {
    const grouped: Record<string, MonthlyLatePriorityFlightStatistics> = {};
    const ensure = (key: string) =>
      (grouped[key] ??= {
        flightNo: key,
        totalCount: 0,
        applicableCategories: [],
        categories: emptyCategories(),
      });
    for (const original of Object.values(row.flights)) {
      const eventKeys = new Set(
        Object.values(original.categories).flatMap((c) =>
          c.details.map((d) => flightIdentityKey(state, d.flightNo, d.date))
        )
      );
      if (!eventKeys.size)
        eventKeys.add(flightIdentityKey(state, original.flightNo, date));
      const ambiguousCorrection =
        eventKeys.size > 1 &&
        Object.values(original.categories).some(
          (c) =>
            c.manualCorrection !== 0 ||
            c.visibleDetails.length !== c.details.length
        );
      if (ambiguousCorrection) {
        warnings.push(
          `${original.flightNo}本月有跨档案记录及人工次数，请先明确次数归属；暂按原号保留`
        );
        eventKeys.clear();
        eventKeys.add(original.flightNo);
      }
      for (const key of eventKeys) {
        numbers.add(key);
        const target = ensure(key);
        target.applicableCategories = [
          ...new Set([
            ...target.applicableCategories,
            ...original.applicableCategories,
          ]),
        ];
        for (const category of LATE_PRIORITY_STATISTICS_CATEGORIES) {
          const before = original.categories[category],
            cell = target.categories[category];
          const details =
            eventKeys.size === 1
              ? before.details
              : before.details.filter(
                  (d) => flightIdentityKey(state, d.flightNo, d.date) === key
                );
          const visible =
            eventKeys.size === 1
              ? before.visibleDetails
              : before.visibleDetails.filter(
                  (d) => flightIdentityKey(state, d.flightNo, d.date) === key
                );
          cell.qualified ||= before.qualified;
          cell.details.push(...details);
          cell.visibleDetails.push(...visible);
          cell.baseCount +=
            eventKeys.size === 1 ? before.baseCount : details.length;
          cell.manualCorrection +=
            eventKeys.size === 1 ? before.manualCorrection : 0;
          cell.effectiveCount +=
            eventKeys.size === 1 ? before.effectiveCount : details.length;
        }
      }
    }
    for (const key of numbers) {
      const flight = ensure(key);
      for (const category of LATE_PRIORITY_STATISTICS_CATEGORIES) {
        const cell = flight.categories[category];
        const adjustments = state.latePriorityFrequencyAdjustments.filter(
          (a) =>
            a.month === source.month &&
            a.staffId === row.staff.id &&
            a.flightNo.startsWith("@") &&
            flightIdentityKey(state, a.flightNo) === key &&
            a.kind === latePriorityKindForLabel(category)
        );
        if (adjustments.length) {
          const reset = adjustments.reduce(
            (sum, a) => sum + (a.resetBaseline ?? 0),
            0
          );
          cell.visibleDetails = sortedDetails(cell.visibleDetails).slice(reset);
          cell.baseCount = Math.max(0, cell.baseCount - reset);
          cell.effectiveCount = Math.max(
            0,
            cell.effectiveCount +
              adjustments.reduce((sum, a) => sum + a.delta, 0)
          );
          cell.manualCorrection = cell.effectiveCount - cell.baseCount;
          if (!flight.applicableCategories.includes(category))
            flight.applicableCategories.push(category);
        }
        cell.details = sortedDetails(cell.details);
        cell.visibleDetails = sortedDetails(cell.visibleDetails);
      }
      flight.totalCount = LATE_PRIORITY_STATISTICS_CATEGORIES.reduce(
        (sum, c) => sum + flight.categories[c].effectiveCount,
        0
      );
    }
    row.flights = grouped;
    for (const category of LATE_PRIORITY_STATISTICS_CATEGORIES) {
      const cells = Object.values(grouped).map((f) => f.categories[category]);
      row.categories[category] = {
        qualified: cells.some((c) => c.qualified),
        details: sortedDetails(cells.flatMap((c) => c.details)),
        visibleDetails: sortedDetails(cells.flatMap((c) => c.visibleDetails)),
        baseCount: cells.reduce((s, c) => s + c.baseCount, 0),
        manualCorrection: cells.reduce((s, c) => s + c.manualCorrection, 0),
        effectiveCount: cells.reduce((s, c) => s + c.effectiveCount, 0),
      };
    }
    row.totalCount = Object.values(grouped).reduce(
      (sum, f) => sum + f.totalCount,
      0
    );
  }
  // Every row has all visible columns, including a column discovered in another row.
  for (const row of rows)
    for (const key of numbers)
      row.flights[key] ??= {
        flightNo: key,
        totalCount: 0,
        applicableCategories: [],
        categories: emptyCategories(),
      };
  return {
    month: source.month,
    flightNumbers: [...numbers],
    rows,
    warnings: [...new Set(warnings)],
    ranges: Object.fromEntries(
      LATE_PRIORITY_STATISTICS_CATEGORIES.map((category) => [
        category,
        statisticsRange(rows, category),
      ])
    ) as MonthlyLatePriorityStatistics["ranges"],
  };
}

function categoryKinds(
  target: Pick<PositionRule, "name" | "remark">
): LatePriorityStatisticsCategory[] {
  const kinds = latePriorityFrequencyKinds(target);
  return LATE_PRIORITY_STATISTICS_CATEGORIES.filter((category) =>
    kinds.includes(latePriorityKindForLabel(category))
  );
}

function flightCategories(
  rules: readonly PositionRule[],
  flightNo: string,
  state: SchedulingFacts
): LatePriorityStatisticsCategory[] {
  return LATE_PRIORITY_STATISTICS_CATEGORIES.filter((category) =>
    rules.some(
      (rule) =>
        flightRuleMatches(state, rule.flightNo, flightNo) &&
        categoryKinds(rule).includes(category)
    )
  );
}

function scopedRules(state: SchedulingFacts): PositionRule[] {
  return state.positionRules.filter(
    (rule) =>
      latePriorityFlightInScope(
        state.settings.latePriorityFlightNumbers,
        rule.flightNo,
        state
      ) && categoryKinds(rule).length > 0
  );
}

function emptyCategories(): MonthlyLatePriorityStatisticsRow["categories"] {
  return Object.fromEntries(
    LATE_PRIORITY_STATISTICS_CATEGORIES.map((category) => [
      category,
      {
        qualified: false,
        details: [],
        visibleDetails: [],
        manualCorrection: 0,
        effectiveCount: 0,
        baseCount: 0,
      },
    ])
  ) as unknown as MonthlyLatePriorityStatisticsRow["categories"];
}

function detailKey(
  staffId: string,
  category: LatePriorityStatisticsCategory,
  detail: LatePriorityStatisticsDetail
): string {
  return [
    staffId,
    detail.date,
    normalizeLatePriorityFlightNumber(detail.flightNo),
    category,
  ].join("\u0000");
}

function sortedDetails(
  details: readonly LatePriorityStatisticsDetail[]
): LatePriorityStatisticsDetail[] {
  return [...details].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.flightNo.localeCompare(right.flightNo) ||
      left.position.localeCompare(right.position)
  );
}

function statisticsRange(
  rows: readonly MonthlyLatePriorityStatisticsRow[],
  category: LatePriorityStatisticsCategory
): MonthlyLatePriorityStatistics["ranges"][LatePriorityStatisticsCategory] {
  const counts = rows
    .filter((row) => row.categories[category].qualified)
    .map((row) => row.categories[category].effectiveCount);
  const min = counts.length ? Math.min(...counts) : 0;
  const max = counts.length ? Math.max(...counts) : 0;
  return {
    min,
    max,
    difference: max - min,
    allowedDifference:
      LATE_PRIORITY_ALLOWED_DIFFERENCE[latePriorityKindForLabel(category)],
  };
}

function actualTotalCount(row: MonthlyLatePriorityStatisticsRow): number {
  return LATE_PRIORITY_STATISTICS_CATEGORIES.reduce(
    (sum, category) => sum + row.categories[category].details.length,
    0
  );
}

export function latePriorityStatisticsFlightNumbers(
  state: SchedulingFacts
): string[] {
  return normalizeLatePriorityFlightNumbers(
    state.settings.latePriorityFlightNumbers.map((no) =>
      flightIdentityKey(state, no)
    )
  );
}

function buildSourceMonthlyLatePriorityStatistics(
  state: SchedulingFacts,
  date: string
): MonthlyLatePriorityStatistics {
  const month = date.slice(0, 7);
  const flightNumbers = normalizeLatePriorityFlightNumbers([
    ...flightRuleSettings(state).latePriorityFlightNumbers,
    ...state.history
      .filter((r) =>
        latePriorityFlightInScope(
          state.settings.latePriorityFlightNumbers,
          r.flightNo,
          state,
          r.date
        )
      )
      .map((r) => r.flightNo),
  ]).filter((no) => !no.startsWith("@"));
  const rules = scopedRules(state);
  const countRecords = monthlyCountRecords(state, date);
  const recordCategories = new Map(
    countRecords.map((record) => [
      record,
      latePriorityFlightInScope(
        state.settings.latePriorityFlightNumbers,
        record.flightNo,
        state,
        record.date
      ) && endsAfterLateShiftThreshold(record, state.settings.lateShiftEndTime)
        ? categoryKinds(
            latePriorityRecordSemantics(
              record,
              latePriorityHistoryRule(state, state.positionRules, record)
            )
          )
        : [],
    ])
  );
  const applicableCategoriesByFlight = new Map(
    flightNumbers.map((flightNo) => {
      const configuredCategories = flightCategories(rules, flightNo, state);
      return [
        flightNo,
        LATE_PRIORITY_STATISTICS_CATEGORIES.filter(
          (category) =>
            configuredCategories.includes(category) ||
            countRecords.some(
              (record) =>
                normalizeLatePriorityFlightNumber(record.flightNo) ===
                  flightNo && recordCategories.get(record)!.includes(category)
            )
        ),
      ];
    })
  );
  const eligibleStaff = state.staff.filter(
    (person) =>
      person.staffType === "常规" &&
      ((person.status === "正常" &&
        rules.some((rule) => rule.qualifiedStaffIds.includes(person.id))) ||
        countRecords.some(
          (r) =>
            (r.staffId === person.id || baselineStaffId(r) === person.id) &&
            recordCategories.get(r)!.length > 0
        ) ||
        state.latePriorityFrequencyAdjustments.some(
          (a) =>
            a.month === month &&
            a.staffId === person.id &&
            flightNumbers.includes(
              normalizeLatePriorityFlightNumber(a.flightNo)
            )
        ))
  );
  const rowByStaffId = new Map<string, MonthlyLatePriorityStatisticsRow>(
    eligibleStaff.map((staff) => [
      staff.id,
      {
        staff,
        totalCount: 0,
        qualificationOverrideCount: 0,
        qualificationUnrecordedCount: 0,
        categories: emptyCategories(),
        flights: {},
      },
    ])
  );
  for (const row of rowByStaffId.values()) {
    for (const category of LATE_PRIORITY_STATISTICS_CATEGORIES) {
      row.categories[category].qualified =
        row.staff.status === "正常" &&
        rules.some(
          (rule) =>
            categoryKinds(rule).includes(category) &&
            rule.qualifiedStaffIds.includes(row.staff.id)
        );
    }
  }
  const seen = new Set<string>();
  const addDetail = (
    staffId: string,
    category: LatePriorityStatisticsCategory,
    detail: LatePriorityStatisticsDetail
  ): void => {
    const row = rowByStaffId.get(staffId);
    if (!row) return;
    const key = detailKey(staffId, category, detail);
    if (seen.has(key)) return;
    seen.add(key);
    row.categories[category].details.push(detail);
  };
  const baselineDetails = new Map<string, Set<string>>();
  const qualificationEvidence = new Map<
    string,
    { staffId: string; override: boolean; unrecorded: boolean }
  >();
  const addHistoricalRecord = (record: HistoryRecord): void => {
    for (const category of recordCategories.get(record)!) {
      const baselineId = baselineStaffId(record);
      if (baselineId) {
        const key = [
          baselineId,
          normalizeLatePriorityFlightNumber(record.flightNo),
          category,
        ].join("\u0000");
        const details = baselineDetails.get(key) ?? new Set<string>();
        details.add(
          detailKey(baselineId, category, {
            date: record.date,
            flightNo: record.flightNo,
            position: record.position,
          })
        );
        baselineDetails.set(key, details);
      }
      addDetail(record.staffId, category, {
        date: record.date,
        flightNo: record.flightNo,
        position: record.position,
      });
      const evidenceKey = detailKey(record.staffId, category, {
        date: record.date,
        flightNo: record.flightNo,
        position: record.position,
      });
      const evidence = qualificationEvidence.get(evidenceKey) ?? {
        staffId: record.staffId,
        override: false,
        unrecorded: false,
      };
      evidence.override ||= hasQualificationOverride(record);
      evidence.unrecorded ||=
        !record.countBaseline && !record.manualOverrideWarnings;
      qualificationEvidence.set(evidenceKey, evidence);
    }
  };
  countRecords.forEach(addHistoricalRecord);
  for (const evidence of qualificationEvidence.values()) {
    const row = rowByStaffId.get(evidence.staffId);
    if (!row) continue;
    if (evidence.override) row.qualificationOverrideCount++;
    else if (evidence.unrecorded) row.qualificationUnrecordedCount++;
  }

  const staffOrder = new Map(
    state.staff.map((person, index) => [person.id, index])
  );
  const rows = [...rowByStaffId.values()]
    .map((row) => {
      for (const category of LATE_PRIORITY_STATISTICS_CATEGORIES) {
        row.categories[category].details = sortedDetails(
          row.categories[category].details
        );
        const kind = latePriorityKindForLabel(category);
        const remainingBaseline = new Map<string, number>();
        for (const adjustment of state.latePriorityFrequencyAdjustments ?? []) {
          if (
            adjustment.month !== month ||
            adjustment.staffId !== row.staff.id ||
            adjustment.kind !== kind ||
            !flightNumbers.includes(
              normalizeLatePriorityFlightNumber(adjustment.flightNo)
            )
          )
            continue;
          const flightNo = normalizeLatePriorityFlightNumber(
            adjustment.flightNo
          );
          remainingBaseline.set(
            flightNo,
            (remainingBaseline.get(flightNo) ?? 0) +
              (adjustment.resetBaseline ?? 0)
          );
        }
        row.categories[category].visibleDetails = row.categories[
          category
        ].details.filter((detail) => {
          const flightNo = normalizeLatePriorityFlightNumber(detail.flightNo);
          const remaining = remainingBaseline.get(flightNo) ?? 0;
          if (remaining <= 0) return true;
          remainingBaseline.set(flightNo, remaining - 1);
          return false;
        });
      }
      row.flights = Object.fromEntries(
        flightNumbers.map((flightNo) => {
          const applicableCategories =
            applicableCategoriesByFlight.get(flightNo)!;
          const categories = Object.fromEntries(
            LATE_PRIORITY_STATISTICS_CATEGORIES.map((category) => {
              const categoryStatistics = row.categories[category];
              const kind = latePriorityKindForLabel(category);
              const qualified =
                row.staff.status === "正常" &&
                rules.some(
                  (rule) =>
                    flightRuleMatches(state, rule.flightNo, flightNo) &&
                    categoryKinds(rule).includes(category) &&
                    rule.qualifiedStaffIds.includes(row.staff.id)
                );
              const details = categoryStatistics.details.filter(
                (detail) =>
                  normalizeLatePriorityFlightNumber(detail.flightNo) ===
                  flightNo
              );
              const visibleDetails = categoryStatistics.visibleDetails.filter(
                (detail) =>
                  normalizeLatePriorityFlightNumber(detail.flightNo) ===
                  flightNo
              );
              const numericCorrection = applicableCategories.includes(category)
                ? (state.latePriorityFrequencyAdjustments ?? [])
                    .filter(
                      (item) =>
                        item.month === month &&
                        item.staffId === row.staff.id &&
                        item.kind === kind &&
                        normalizeLatePriorityFlightNumber(item.flightNo) ===
                          flightNo
                    )
                    .reduce(
                      (sum, item) =>
                        sum + item.delta + (item.resetBaseline ?? 0),
                      0
                    )
                : 0;
              const resetCount = (state.latePriorityFrequencyAdjustments ?? [])
                .filter(
                  (a) =>
                    a.month === month &&
                    a.staffId === row.staff.id &&
                    a.kind === kind &&
                    normalizeLatePriorityFlightNumber(a.flightNo) === flightNo
                )
                .reduce((sum, a) => sum + (a.resetBaseline ?? 0), 0);
              const baseCount = Math.max(
                0,
                (baselineDetails.get(
                  [row.staff.id, flightNo, category].join("\u0000")
                )?.size ?? 0) - resetCount
              );
              const manualCorrection =
                visibleDetails.length - baseCount + numericCorrection;
              return [
                category,
                {
                  qualified,
                  details,
                  visibleDetails,
                  manualCorrection,
                  baseCount,
                  effectiveCount: Math.max(0, baseCount + manualCorrection),
                },
              ];
            })
          ) as unknown as MonthlyLatePriorityFlightStatistics["categories"];
          return [
            flightNo,
            {
              flightNo,
              applicableCategories,
              categories,
              totalCount: LATE_PRIORITY_STATISTICS_CATEGORIES.reduce(
                (sum, category) => sum + categories[category].effectiveCount,
                0
              ),
            },
          ];
        })
      ) as Record<string, MonthlyLatePriorityFlightStatistics>;
      for (const category of LATE_PRIORITY_STATISTICS_CATEGORIES) {
        const cells = Object.values(row.flights).map(
          (f) => f.categories[category]
        );
        row.categories[category].baseCount = cells.reduce(
          (s, c) => s + c.baseCount,
          0
        );
        row.categories[category].manualCorrection = cells.reduce(
          (s, c) => s + c.manualCorrection,
          0
        );
        row.categories[category].effectiveCount = cells.reduce(
          (s, c) => s + c.effectiveCount,
          0
        );
      }
      row.totalCount = LATE_PRIORITY_STATISTICS_CATEGORIES.reduce(
        (sum, category) => sum + row.categories[category].effectiveCount,
        0
      );
      return row;
    })
    .sort(
      (left, right) =>
        actualTotalCount(left) - actualTotalCount(right) ||
        (staffOrder.get(left.staff.id) ?? Number.MAX_SAFE_INTEGER) -
          (staffOrder.get(right.staff.id) ?? Number.MAX_SAFE_INTEGER)
    );
  return {
    month,
    flightNumbers,
    rows,
    ranges: Object.fromEntries(
      LATE_PRIORITY_STATISTICS_CATEGORIES.map((category) => [
        category,
        statisticsRange(rows, category),
      ])
    ) as MonthlyLatePriorityStatistics["ranges"],
  };
}
