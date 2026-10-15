import { markActiveScheduleStale } from "../domain/kernel/schedule-lifecycle";
import {
  latePriorityKindForLabel,
  latePriorityKindLabel,
  type LatePriorityFrequencyKind,
} from "../domain/reviews/late-priority-policy";
import {
  buildMonthlyLatePriorityStatistics,
  canAdjustLatePriorityCategory,
} from "../domain/statistics/monthly-late-priority-statistics";
import { mergeLatePriorityFrequencyAdjustments } from "../domain/statistics/late-priority-frequency-adjustment";
import type { AppState } from "../model";
import { mergeOrdinaryPriorityFrequencyAdjustments } from "../domain/statistics/ordinary-priority-frequency-adjustment";
import { ordinaryPriorityConfigurationKey } from "../domain/reviews/position-rotation-policy";
import type { LatePriorityCountsImportPreview } from "../infrastructure/late-priority-counts-excel";
import { buildOrdinaryPriorityStatistics } from "../domain/statistics/ordinary-priority-statistics";

function normalizedFlightNo(flightNo: string): string {
  return flightNo.trim().toUpperCase().replaceAll(/\s+/g, "");
}

export function applyLatePriorityCountsImport(
  state: AppState,
  preview: LatePriorityCountsImportPreview
): boolean {
  if (!preview.canApply || preview.errors.length || !preview.targets.length)
    return false;
  const statistics = buildMonthlyLatePriorityStatistics(
    state,
    preview.referenceDate
  );
  const rowByStaffId = new Map(
    statistics.rows.map((row) => [row.staff.id, row])
  );
  if (
    preview.month !== statistics.month ||
    preview.flightNumbers.length !== statistics.flightNumbers.length ||
    preview.flightNumbers.some(
      (flightNo, index) =>
        normalizedFlightNo(flightNo) !== statistics.flightNumbers[index]
    )
  )
    return false;
  const expectedKeys = new Set(
    statistics.rows.flatMap((row) =>
      statistics.flightNumbers.flatMap((flightNo) =>
        row.flights[flightNo]!.applicableCategories.map((category) =>
          [row.staff.id, flightNo, category].join("\u0000")
        )
      )
    )
  );
  const targetKeys = new Set(
    preview.targets.map((target) =>
      [
        target.staffId,
        normalizedFlightNo(target.flightNo),
        target.category,
      ].join("\u0000")
    )
  );
  if (
    targetKeys.size !== preview.targets.length ||
    targetKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !targetKeys.has(key))
  )
    return false;
  const importedFlights = new Set(
    preview.flightNumbers.map(normalizedFlightNo)
  );
  const preserved = state.latePriorityFrequencyAdjustments.filter(
    (item) =>
      item.month !== preview.month ||
      !importedFlights.has(normalizedFlightNo(item.flightNo))
  );
  const imported = preview.targets.flatMap((target) => {
    const actualCount =
      rowByStaffId.get(target.staffId)?.flights[target.flightNo]?.categories[
        target.category
      ].details.length ?? 0;
    const delta = target.finalCount - actualCount;
    if (!delta) return [];
    return [
      {
        month: preview.month,
        staffId: target.staffId,
        flightNo: target.flightNo,
        kind: latePriorityKindForLabel(target.category),
        delta,
      },
    ];
  });
  const next = mergeLatePriorityFrequencyAdjustments([
    ...preserved,
    ...imported,
  ]);
  if (
    JSON.stringify(next) ===
    JSON.stringify(state.latePriorityFrequencyAdjustments)
  )
    return false;
  state.latePriorityFrequencyAdjustments = next;
  markActiveScheduleStale(state);
  return true;
}

export function updateLatePriorityFrequencyAdjustment(
  state: AppState,
  month: string,
  staffId: string,
  flightNo: string,
  kind: LatePriorityFrequencyKind,
  delta: number
): boolean {
  let normalizedDelta = Math.trunc(delta);
  if (!Number.isFinite(normalizedDelta)) return false;
  if (!normalizedDelta || !/^\d{4}-\d{2}$/.test(month) || !staffId || !flightNo)
    return false;
  const normalizedFlightNo = flightNo
    .trim()
    .toUpperCase()
    .replaceAll(/\s+/g, "");
  const category = latePriorityKindLabel(kind);
  const row = buildMonthlyLatePriorityStatistics(
    state,
    state.activeScheduleDate?.startsWith(month)
      ? state.activeScheduleDate
      : `${month}-01`
  ).rows.find((item) => item.staff.id === staffId);
  const flight = row?.flights[normalizedFlightNo];
  if (
    !flight?.applicableCategories.includes(category) ||
    !canAdjustLatePriorityCategory(flight.categories[category])
  )
    return false;
  if (normalizedDelta < 0) {
    normalizedDelta = Math.max(
      normalizedDelta,
      -flight.categories[category].effectiveCount
    );
    if (!normalizedDelta) return false;
  }
  const existing = state.latePriorityFrequencyAdjustments.find(
    (item) =>
      item.month === month &&
      item.staffId === staffId &&
      item.flightNo === normalizedFlightNo &&
      item.kind === kind
  );
  normalizedDelta +=
    flight.categories[category].effectiveCount -
    (flight.categories[category].baseCount +
      flight.categories[category].manualCorrection);
  if (existing) existing.delta += normalizedDelta;
  else
    state.latePriorityFrequencyAdjustments.push({
      month,
      staffId,
      flightNo: normalizedFlightNo,
      kind,
      delta: normalizedDelta,
    });
  state.latePriorityFrequencyAdjustments =
    mergeLatePriorityFrequencyAdjustments(
      state.latePriorityFrequencyAdjustments
    );
  markActiveScheduleStale(state);
  return true;
}

export function resetMonthlyLatePriorityFrequencyCounts(
  state: AppState,
  date: string
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const month = date.slice(0, 7);
  const statistics = buildMonthlyLatePriorityStatistics(state, date);
  const scopeFlights = new Set(statistics.flightNumbers);
  const kindByCategory = {
    督导: "supervisor",
    一号: "number-one",
    申报: "declaration",
    送资料: "delivery",
  } as const;
  const counts = new Map<string, number>();
  for (const row of statistics.rows) {
    for (const [category, categoryStatistics] of Object.entries(
      row.categories
    ) as Array<
      [
        keyof typeof kindByCategory,
        (typeof row.categories)[keyof typeof row.categories],
      ]
    >) {
      for (const detail of categoryStatistics.details) {
        const key = [
          row.staff.id,
          normalizedFlightNo(detail.flightNo),
          kindByCategory[category],
        ].join("\u0000");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const preserved = state.latePriorityFrequencyAdjustments.filter(
    (item) =>
      item.month !== month ||
      !scopeFlights.has(normalizedFlightNo(item.flightNo))
  );
  const resetAdjustments = [...counts].map(([key, count]) => {
    const [staffId, flightNo, kind] = key.split("\u0000") as [
      string,
      string,
      LatePriorityFrequencyKind,
    ];
    return {
      month,
      staffId,
      flightNo,
      kind,
      delta: -count,
      resetBaseline: count,
    };
  });
  const before = JSON.stringify(state.latePriorityFrequencyAdjustments);
  state.latePriorityFrequencyAdjustments =
    mergeLatePriorityFrequencyAdjustments([...preserved, ...resetAdjustments]);
  if (JSON.stringify(state.latePriorityFrequencyAdjustments) === before)
    return false;
  markActiveScheduleStale(state);
  return true;
}

export function updateOrdinaryPriorityFrequencyAdjustment(
  state: AppState,
  month: string,
  staffId: string,
  airlineCode: string,
  position: string,
  delta: number
): boolean {
  let normalizedDelta = Math.trunc(delta);
  if (!Number.isFinite(normalizedDelta)) return false;
  if (!normalizedDelta || !/^\d{4}-\d{2}$/.test(month)) return false;
  const key = ordinaryPriorityConfigurationKey(airlineCode, position);
  const configured = state.settings.ordinaryPriorityPositions.some(
    (item) =>
      ordinaryPriorityConfigurationKey(item.airlineCode, item.position) === key
  );
  if (!configured || !state.staff.some((person) => person.id === staffId))
    return false;
  const row = buildOrdinaryPriorityStatistics(
    state,
    state.activeScheduleDate?.startsWith(month)
      ? state.activeScheduleDate
      : `${month}-01`
  ).find(
    (r) =>
      r.staff.id === staffId &&
      ordinaryPriorityConfigurationKey(r.airlineCode, r.position) === key
  );
  const count = row?.effectiveCount ?? 0;
  normalizedDelta = Math.max(normalizedDelta, -count);
  if (!normalizedDelta) return false;
  if (row)
    normalizedDelta +=
      row.effectiveCount - (row.actualCount + row.manualCorrection);
  const existing = state.ordinaryPriorityFrequencyAdjustments.find(
    (item) =>
      item.month === month &&
      item.staffId === staffId &&
      ordinaryPriorityConfigurationKey(item.airlineCode, item.position) === key
  );
  if (existing) existing.delta += normalizedDelta;
  else
    state.ordinaryPriorityFrequencyAdjustments.push({
      month,
      staffId,
      airlineCode: airlineCode.trim().toUpperCase(),
      position: position.trim(),
      delta: normalizedDelta,
    });
  state.ordinaryPriorityFrequencyAdjustments =
    mergeOrdinaryPriorityFrequencyAdjustments(
      state.ordinaryPriorityFrequencyAdjustments
    );
  markActiveScheduleStale(state);
  return true;
}
