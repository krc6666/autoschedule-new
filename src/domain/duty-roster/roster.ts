import type { DutyRosterOverride, Staff } from "../../model";
import type { DutyRosterFacts } from "../shared/scheduling-facts";
import { previousWorkdayLateProtection } from "../reviews/cross-day-recovery";
import { addIsoDays } from "../shared/time";

export type DutyRosterSlot =
  "cx-preflight" | "duty" | "standby-0" | "standby-1";

export interface DutyRosterAssignment extends DutyRosterOverride {
  adjusted: boolean;
  recoveryAdjusted?: boolean;
  originalDutyStaffId?: string | null;
  recoverySwapDate?: string;
  recoveryAdjustmentRole?: "protected-replaced" | "future-counterpart";
}

export interface DutyRosterPersonStats {
  staff: Staff;
  cxPreflightDates: string[];
  dutyDates: string[];
  standbyDates: string[];
}

function parseDate(
  value: string
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

export function monthlyDutyDates(date: string): string[] {
  const parsed = parseDate(date);
  if (!parsed) return [];
  const dayCount = new Date(
    Date.UTC(parsed.year, parsed.month, 0)
  ).getUTCDate();
  return Array.from({ length: dayCount }, (_, index) => index + 1)
    .filter((day) => day % 2 === parsed.day % 2)
    .map(
      (day) =>
        `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    );
}

function monthlyRotationSeed(date: string): number {
  const parsed = parseDate(date);
  return parsed ? parsed.year * 12 + parsed.month - 1 : 0;
}

export function rosterEligibleStaff(state: DutyRosterFacts): Staff[] {
  return state.staff.filter(
    (person) => person.staffType === "常规" && person.status === "正常"
  );
}

/** Manual monthly roster selection: qualification is required, current leave status is not. */
export function rosterQualifiedStaff(state: DutyRosterFacts): Staff[] {
  return state.staff.filter((person) => person.staffType === "常规");
}

export function cxPreflightRosterStaff(state: DutyRosterFacts): Staff[] {
  return rosterQualifiedStaff(state).filter(
    (person) => person.cxPreflightQualified
  );
}

export function dutyRosterStaff(state: DutyRosterFacts): Staff[] {
  return rosterQualifiedStaff(state).filter((person) => person.dutyQualified);
}

export function standbyRosterStaff(state: DutyRosterFacts): Staff[] {
  return rosterQualifiedStaff(state).filter(
    (person) => person.standbyQualified
  );
}

export function cxPreflightEligibleStaff(state: DutyRosterFacts): Staff[] {
  return rosterEligibleStaff(state).filter(
    (person) => person.cxPreflightQualified
  );
}

export function dutyQualifiedStaff(state: DutyRosterFacts): Staff[] {
  return rosterEligibleStaff(state).filter((person) => person.dutyQualified);
}

export function standbyQualifiedStaff(state: DutyRosterFacts): Staff[] {
  return rosterEligibleStaff(state).filter((person) => person.standbyQualified);
}

export function clearUnqualifiedStandbyOverrides(state: DutyRosterFacts): void {
  const qualifiedIds = new Set(
    state.staff
      .filter(
        (person) => person.staffType === "常规" && person.standbyQualified
      )
      .map((person) => person.id)
  );
  state.dutyRosterOverrides = state.dutyRosterOverrides.filter((override) =>
    override.standbyStaffIds.every(
      (staffId) => !staffId || qualifiedIds.has(staffId)
    )
  );
}

function rotateStaff(pool: Staff[], start: number): Staff[] {
  if (!pool.length) return [];
  const offset = ((start % pool.length) + pool.length) % pool.length;
  return [...pool.slice(offset), ...pool.slice(0, offset)];
}

function assignSingleSlotRounds(
  dates: string[],
  pool: Staff[],
  rotationStart: number,
  excludedStaffByDate: Array<string | null>
): Array<string | null> {
  const assignmentsByDate: Array<string | null> = dates.map(() => null);
  const counts = new Map(pool.map((person) => [person.id, 0]));
  const remainingDates = new Set(dates.map((_, index) => index));

  for (
    let round = 1;
    remainingDates.size && round <= dates.length + 1;
    round += 1
  ) {
    const candidates = rotateStaff(pool, rotationStart + round - 1).filter(
      (person) => (counts.get(person.id) ?? 0) < round
    );
    const matchedByDate = new Map<number, string>();
    const tryAssign = (staffId: string, visitedDates: Set<number>): boolean => {
      for (const dateIndex of remainingDates) {
        if (
          excludedStaffByDate[dateIndex] === staffId ||
          visitedDates.has(dateIndex)
        )
          continue;
        visitedDates.add(dateIndex);
        const current = matchedByDate.get(dateIndex);
        if (!current || tryAssign(current, visitedDates)) {
          matchedByDate.set(dateIndex, staffId);
          return true;
        }
      }
      return false;
    };
    candidates.forEach((person) => {
      tryAssign(person.id, new Set());
    });
    if (!matchedByDate.size) continue;
    matchedByDate.forEach((staffId, dateIndex) => {
      assignmentsByDate[dateIndex] = staffId;
      counts.set(staffId, (counts.get(staffId) ?? 0) + 1);
      remainingDates.delete(dateIndex);
    });
  }
  return assignmentsByDate;
}

function assignStandbyRounds(
  dates: string[],
  dutyByDate: Array<string | null>,
  standbyPool: Staff[],
  rotationStart: number
): Array<[string | null, string | null]> {
  const standbyByDate: Array<[string | null, string | null]> = dates.map(() => [
    null,
    null,
  ]);
  const counts = new Map(standbyPool.map((person) => [person.id, 0]));
  const assignedDates = new Map(
    standbyPool.map((person) => [person.id, new Set<number>()])
  );
  const remainingSlots = new Set(
    Array.from({ length: dates.length * 2 }, (_, index) => index)
  );

  for (
    let round = 1;
    remainingSlots.size && round <= dates.length * 2 + 1;
    round += 1
  ) {
    const candidates = rotateStaff(
      standbyPool,
      rotationStart + round - 1
    ).filter((person) => (counts.get(person.id) ?? 0) < round);
    const matchedBySlot = new Map<number, string>();
    const tryAssign = (staffId: string, visitedSlots: Set<number>): boolean => {
      for (const slotIndex of remainingSlots) {
        const dateIndex = Math.floor(slotIndex / 2);
        if (
          dutyByDate[dateIndex] === staffId ||
          assignedDates.get(staffId)?.has(dateIndex) ||
          visitedSlots.has(slotIndex)
        )
          continue;
        visitedSlots.add(slotIndex);
        const current = matchedBySlot.get(slotIndex);
        if (!current || tryAssign(current, visitedSlots)) {
          matchedBySlot.set(slotIndex, staffId);
          return true;
        }
      }
      return false;
    };
    candidates.forEach((person) => {
      tryAssign(person.id, new Set());
    });
    if (!matchedBySlot.size) continue;
    matchedBySlot.forEach((staffId, slotIndex) => {
      const dateIndex = Math.floor(slotIndex / 2);
      const position = slotIndex % 2;
      standbyByDate[dateIndex]![position] = staffId;
      counts.set(staffId, (counts.get(staffId) ?? 0) + 1);
      assignedDates.get(staffId)?.add(dateIndex);
      remainingSlots.delete(slotIndex);
    });
  }
  return standbyByDate;
}

function defaultMonthlyDutyRoster(
  state: DutyRosterFacts,
  date: string
): DutyRosterAssignment[] {
  const dates = monthlyDutyDates(date);
  const cxPool = cxPreflightEligibleStaff(state);
  const dutyPool = dutyQualifiedStaff(state);
  const standbyPool = standbyQualifiedStaff(state);
  const rotationSeed = monthlyRotationSeed(date);
  const dutyRotationStart = dutyPool.length
    ? rotationSeed % dutyPool.length
    : 0;
  const cxRotationStart = cxPool.length ? rotationSeed % cxPool.length : 0;
  const standbyRotationStart = standbyPool.length
    ? (rotationSeed * 2) % standbyPool.length
    : 0;
  const dutyByDate = assignSingleSlotRounds(
    dates,
    dutyPool,
    dutyRotationStart,
    dates.map(() => null)
  );
  const cxByDate = assignSingleSlotRounds(
    dates,
    cxPool,
    cxRotationStart,
    dutyByDate
  );
  const standbyByDate = assignStandbyRounds(
    dates,
    dutyByDate,
    standbyPool,
    standbyRotationStart
  );
  return dates.map((item, ordinal) => {
    const cxPreflightStaffId = cxByDate[ordinal] ?? null;
    const dutyStaffId = dutyByDate[ordinal] ?? null;
    const standbyStaffIds = standbyByDate[ordinal] ?? [null, null];
    return {
      date: item,
      cxPreflightStaffId,
      dutyStaffId,
      standbyStaffIds,
      adjusted: false,
    };
  });
}

function conflictsWithOtherRosterSlots(
  row: DutyRosterAssignment,
  staffId: string
): boolean {
  return (
    row.cxPreflightStaffId === staffId || row.standbyStaffIds.includes(staffId)
  );
}

function applyLateShiftRecoveryDutySwaps(
  state: DutyRosterFacts,
  rows: DutyRosterAssignment[]
): DutyRosterAssignment[] {
  if (!state.settings.lateShiftRecoveryEnabled) return rows;
  const overriddenDates = new Set(
    state.dutyRosterOverrides
      .filter((item) => validOverride(state, item))
      .map((item) => item.date)
  );
  const protectedByDate = new Map(
    rows.map((row) => {
      const protection = previousWorkdayLateProtection(state, row.date);
      return [
        row.date,
        protection.previousDate === addIsoDays(row.date, -2)
          ? protection.protectedStaffIds
          : new Set<string>(),
      ] as const;
    })
  );
  const result = rows.map((row) => ({
    ...row,
    standbyStaffIds: [...row.standbyStaffIds] as [string | null, string | null],
  }));

  for (let index = 0; index < result.length; index += 1) {
    const current = result[index]!;
    const currentDuty = current.dutyStaffId;
    if (
      !currentDuty ||
      overriddenDates.has(current.date) ||
      !protectedByDate.get(current.date)?.has(currentDuty)
    )
      continue;
    const replacementIndex = result.findIndex((future, futureIndex) => {
      if (
        futureIndex <= index ||
        overriddenDates.has(future.date) ||
        !future.dutyStaffId ||
        future.dutyStaffId === currentDuty
      )
        return false;
      if (protectedByDate.get(current.date)?.has(future.dutyStaffId))
        return false;
      if (protectedByDate.get(future.date)?.has(currentDuty)) return false;
      return (
        !conflictsWithOtherRosterSlots(current, future.dutyStaffId) &&
        !conflictsWithOtherRosterSlots(future, currentDuty)
      );
    });
    if (replacementIndex < 0) continue;
    const future = result[replacementIndex]!;
    const replacementDuty = future.dutyStaffId;
    current.dutyStaffId = replacementDuty;
    current.recoveryAdjusted = true;
    current.originalDutyStaffId = currentDuty;
    current.recoverySwapDate = future.date;
    current.recoveryAdjustmentRole = "protected-replaced";
    future.dutyStaffId = currentDuty;
    future.recoveryAdjusted = true;
    future.originalDutyStaffId = replacementDuty;
    future.recoverySwapDate = current.date;
    future.recoveryAdjustmentRole = "future-counterpart";
  }
  return result;
}

function resolvedMonthlyDutyRoster(
  state: DutyRosterFacts,
  date: string
): DutyRosterAssignment[] {
  return applyLateShiftRecoveryDutySwaps(
    state,
    defaultMonthlyDutyRoster(state, date)
  ).map((automatic) => {
    const override = state.dutyRosterOverrides.find(
      (item) => item.date === automatic.date
    );
    if (!override || !validOverride(state, override)) return automatic;
    return {
      ...override,
      standbyStaffIds: [...override.standbyStaffIds],
      adjusted: true,
      recoveryAdjusted: false,
      originalDutyStaffId: null,
    };
  });
}

function validOverride(
  state: DutyRosterFacts,
  override: DutyRosterOverride
): boolean {
  const cxIds = new Set(
    cxPreflightRosterStaff(state).map((person) => person.id)
  );
  const dutyIds = new Set(dutyRosterStaff(state).map((person) => person.id));
  const standbyQualifiedIds = new Set(
    standbyRosterStaff(state).map((person) => person.id)
  );
  if (override.cxPreflightStaffId && !cxIds.has(override.cxPreflightStaffId))
    return false;
  if (override.dutyStaffId && !dutyIds.has(override.dutyStaffId)) return false;
  if (
    override.dutyStaffId &&
    [override.cxPreflightStaffId, ...override.standbyStaffIds].includes(
      override.dutyStaffId
    )
  )
    return false;
  const standbyIds = override.standbyStaffIds.filter((id): id is string =>
    Boolean(id)
  );
  if (new Set(standbyIds).size !== standbyIds.length) return false;
  return standbyIds.every((id) => standbyQualifiedIds.has(id));
}

export function getDutyRosterForDate(
  state: DutyRosterFacts,
  date: string
): DutyRosterAssignment {
  return (
    resolvedMonthlyDutyRoster(state, date).find(
      (item) => item.date === date
    ) ?? {
      date,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
      adjusted: false,
    }
  );
}

export function getMonthlyDutyRoster(
  state: DutyRosterFacts,
  date: string
): DutyRosterAssignment[] {
  return resolvedMonthlyDutyRoster(state, date);
}

export function getMonthlyDutyRosterStats(
  state: DutyRosterFacts,
  date: string
): DutyRosterPersonStats[] {
  const rows = getMonthlyDutyRoster(state, date);
  return rosterQualifiedStaff(state).map((staff) => ({
    staff,
    cxPreflightDates: rows
      .filter((row) => row.cxPreflightStaffId === staff.id)
      .map((row) => row.date),
    dutyDates: rows
      .filter((row) => row.dutyStaffId === staff.id)
      .map((row) => row.date),
    standbyDates: rows
      .filter((row) => row.standbyStaffIds.includes(staff.id))
      .map((row) => {
        const parsed = parseDate(row.date);
        if (!parsed) return row.date;
        const nextDate = new Date(
          Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1)
        );
        return `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDate.getUTCDate()).padStart(2, "0")}`;
      }),
  }));
}

export function updateDutyRosterSlot(
  state: DutyRosterFacts,
  date: string,
  slot: DutyRosterSlot,
  staffId: string
): string | null {
  const current = getDutyRosterForDate(state, date);
  const regularIds = new Set(
    rosterQualifiedStaff(state).map((person) => person.id)
  );
  const cxIds = new Set(
    cxPreflightRosterStaff(state).map((person) => person.id)
  );
  const dutyIds = new Set(dutyRosterStaff(state).map((person) => person.id));
  const standbyIds = new Set(
    standbyRosterStaff(state).map((person) => person.id)
  );
  if (slot === "cx-preflight") {
    if (!cxIds.has(staffId)) return "该人员不具备CX航前资质或当前不可用";
    if (current.dutyStaffId === staffId) return "CX航前不能与值班由同一人承担";
    current.cxPreflightStaffId = staffId;
  } else {
    if (!regularIds.has(staffId)) return "值班和备勤只能选择状态正常的常规人员";
    if (slot === "duty" && !dutyIds.has(staffId))
      return "该人员不具备值班资质或当前不可用";
    if (slot !== "duty" && !standbyIds.has(staffId))
      return "该人员不具备备勤资质或当前不可用";
    if (slot === "duty" && staffId === current.cxPreflightStaffId)
      return "值班不能与CX航前由同一人承担";
    const values: [string | null, string | null, string | null] = [
      current.dutyStaffId,
      current.standbyStaffIds[0],
      current.standbyStaffIds[1],
    ];
    const targetIndex = slot === "duty" ? 0 : slot === "standby-0" ? 1 : 2;
    const sourceIndex = values.indexOf(staffId);
    if (sourceIndex >= 0 && sourceIndex !== targetIndex) {
      const targetValue = values[targetIndex] ?? null;
      values[targetIndex] = values[sourceIndex] ?? null;
      values[sourceIndex] = targetValue;
    } else values[targetIndex] = staffId;
    if (new Set(values.filter(Boolean)).size !== values.filter(Boolean).length)
      return "值班和两名备勤不能重复";
    if (values[0] && !dutyIds.has(values[0]))
      return "调整后值班人员不具备值班资质";
    if (values.slice(1).some((id) => id && !standbyIds.has(id)))
      return "调整后备勤人员不具备备勤资质";
    current.dutyStaffId = values[0];
    current.standbyStaffIds = [values[1], values[2]];
  }
  const override: DutyRosterOverride = {
    date,
    cxPreflightStaffId: current.cxPreflightStaffId,
    dutyStaffId: current.dutyStaffId,
    standbyStaffIds: [...current.standbyStaffIds],
  };
  state.dutyRosterOverrides = [
    ...state.dutyRosterOverrides.filter((item) => item.date !== date),
    override,
  ];
  return null;
}

export function clearDutyRosterOverride(
  state: DutyRosterFacts,
  date: string
): void {
  state.dutyRosterOverrides = state.dutyRosterOverrides.filter(
    (item) => item.date !== date
  );
}

export function clearMonthlyDutyRosterOverrides(
  state: DutyRosterFacts,
  date: string
): void {
  const month = date.slice(0, 7);
  state.dutyRosterOverrides = state.dutyRosterOverrides.filter(
    (item) => item.date.slice(0, 7) !== month
  );
}

export function dutyFatigueByStaff(
  state: DutyRosterFacts,
  date: string
): Map<string, number> {
  const dutyStaffId = getDutyRosterForDate(state, date).dutyStaffId;
  return dutyStaffId
    ? new Map([[dutyStaffId, state.settings.dutyFatiguePoints]])
    : new Map();
}

export function dutyRosterStatusIssues(
  state: DutyRosterFacts,
  date: string
): string[] {
  const roster = getDutyRosterForDate(state, date);
  const slots: Array<[string, string | null]> = [
    ["CX 航前", roster.cxPreflightStaffId],
    ["主值班", roster.dutyStaffId],
    ["次日备勤一", roster.standbyStaffIds[0]],
    ["次日备勤二", roster.standbyStaffIds[1]],
  ];
  return slots.flatMap(([label, staffId]) => {
    if (!staffId) return [];
    const person = state.staff.find((item) => item.id === staffId);
    return person && person.status !== "正常"
      ? [`${label}人员${person.name}当前为${person.status}`]
      : [];
  });
}
