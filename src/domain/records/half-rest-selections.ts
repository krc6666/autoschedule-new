import type { Staff, HalfRestSelection } from "../../model";
import type { HalfRestMode } from "../shared/schedule-run-preferences";

interface HalfRestSelectionState {
  staff: Staff[];
  halfRestSelections: HalfRestSelection[];
}

export function normalizeHalfRestSelections(
  value: unknown
): HalfRestSelection[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, HalfRestSelection>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) ||
      new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !==
        row.date ||
      !row.modes ||
      typeof row.modes !== "object" ||
      Array.isArray(row.modes)
    )
      continue;
    const entries = Object.entries(row.modes);
    if (
      entries.some(
        ([id, mode]) =>
          !id.trim() || (mode !== "early-finish" && mode !== "late-start")
      )
    )
      continue;
    byDate.set(row.date, {
      date: row.date,
      modes: Object.fromEntries(entries) as Record<string, HalfRestMode>,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function halfRestSelectionForDate(
  state: HalfRestSelectionState,
  date: string
) {
  const saved =
    state.halfRestSelections?.find((row) => row.date === date)?.modes ?? {};
  const allowed = new Set(
    state.staff
      .filter((p) => p.staffType === "常规" && p.status === "正常")
      .map((p) => p.id)
  );
  const halfRestModes = Object.fromEntries(
    Object.entries(saved).filter(([id]) => allowed.has(id))
  );
  return { halfRestStaffIds: Object.keys(halfRestModes), halfRestModes };
}

export function setHalfRestSelection(
  state: HalfRestSelectionState,
  date: string,
  ids: readonly string[],
  modes: Readonly<Record<string, HalfRestMode>> = {}
): void {
  const allowed = new Set(
    state.staff
      .filter((p) => p.staffType === "常规" && p.status === "正常")
      .map((p) => p.id)
  );
  const selection = {
    date,
    modes: Object.fromEntries(
      [...new Set(ids)]
        .filter((id) => allowed.has(id))
        .map((id) => [
          id,
          modes[id] === "late-start" ? "late-start" : "early-finish",
        ])
    ),
  };
  state.halfRestSelections = normalizeHalfRestSelections([
    ...(state.halfRestSelections ?? []).filter((row) => row.date !== date),
    selection,
  ]);
}
