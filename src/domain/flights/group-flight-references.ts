import type { PositionRule, ScheduleSettings } from "../../model";
import { orderPositionRules } from "../../utils";
import { normalizeWeeklyFlightNo } from "./weekly-flight-plan";

function slots<T, K extends keyof T>(items: readonly T[], key: K) {
  return items.map((item) => ({
    value: String(item[key]),
    write: (value: string) => {
      item[key] = value as T[K];
    },
  }));
}

function ruleCollection<T>(
  items: T[],
  keys: readonly (keyof T)[],
  replace: (kept: T[]) => void
) {
  return {
    slots: keys.flatMap((key) => slots(items, key)),
    remove: (flightNo: string) => {
      const kept = items.filter((item) =>
        keys.every(
          (key) => normalizeWeeklyFlightNo(String(item[key])) !== flightNo
        )
      );
      replace(kept);
      return kept.length !== items.length;
    },
  };
}

/** One field list owns review, rename and removal; historical ledgers are absent. */
function collections(settings: ScheduleSettings) {
  return [
    {
      slots: settings.latePriorityFlightNumbers.map((value, index) => ({
        value,
        write: (next: string) => {
          settings.latePriorityFlightNumbers[index] = next;
        },
      })),
      remove: (flightNo: string) => {
        const before = settings.latePriorityFlightNumbers;
        settings.latePriorityFlightNumbers = before.filter(
          (no) => normalizeWeeklyFlightNo(no) !== flightNo
        );
        return before.length !== settings.latePriorityFlightNumbers.length;
      },
    },
    ruleCollection(
      settings.positionTransitionPolicies,
      ["sourceFlightNo", "targetFlightNo"],
      (rows) => {
        settings.positionTransitionPolicies = rows;
      }
    ),
    ruleCollection(settings.dutyPositionPriorities, ["flightNo"], (rows) => {
      settings.dutyPositionPriorities = rows;
    }),
    ruleCollection(
      settings.nextWorkdayRecoveryTargets,
      ["flightNo"],
      (rows) => {
        settings.nextWorkdayRecoveryTargets = rows;
      }
    ),
    ruleCollection(
      settings.lateShiftRecoveryPositionRules,
      ["flightNo"],
      (rows) => {
        settings.lateShiftRecoveryPositionRules = rows;
      }
    ),
    ruleCollection(
      settings.mobileSupervisorCoverageRules,
      ["flightNo"],
      (rows) => {
        settings.mobileSupervisorCoverageRules = rows;
      }
    ),
    ruleCollection(
      settings.mobileSupervisorFillRules,
      ["sourceFlightNo", "targetFlightNo"],
      (rows) => {
        settings.mobileSupervisorFillRules = rows;
      }
    ),
    ruleCollection(
      settings.crossWorkdayQualificationReservations,
      ["flightNo"],
      (rows) => {
        settings.crossWorkdayQualificationReservations = rows;
      }
    ),
    ruleCollection(
      settings.crossFlightPriorityPolicies,
      ["flightNo"],
      (rows) => {
        settings.crossFlightPriorityPolicies = rows;
      }
    ),
    ruleCollection(settings.sameFlightStaffExclusions, ["flightNo"], (rows) => {
      settings.sameFlightStaffExclusions = rows;
    }),
    ruleCollection(
      settings.teamLeaderGapFillPositionPolicies,
      ["flightNo"],
      (rows) => {
        settings.teamLeaderGapFillPositionPolicies = rows;
      }
    ),
  ];
}

function references(
  positionRules: readonly PositionRule[],
  settings: ScheduleSettings
) {
  return [
    ...slots(positionRules, "flightNo"),
    ...collections(settings).flatMap((c) => c.slots),
  ];
}

export function removeFlightScopedReferences(
  settings: ScheduleSettings,
  flightNo: string
): boolean {
  const normalized = normalizeWeeklyFlightNo(flightNo);
  if (!normalized) return false;
  let changed = false;
  for (const collection of collections(settings)) {
    const removed = collection.remove(normalized);
    changed = removed || changed;
  }
  return changed;
}

export function groupFlightReferenceNumbers(
  positionRules: readonly PositionRule[],
  settings: ScheduleSettings
): string[] {
  return references(positionRules, settings).map((slot) => slot.value);
}

export function renameGroupFlightReferences(
  positionRules: PositionRule[],
  settings: ScheduleSettings,
  rename: (flightNo: string) => string
): void {
  for (const slot of references(positionRules, settings))
    slot.write(rename(slot.value));
  const ordered = orderPositionRules(positionRules);
  positionRules.splice(0, positionRules.length, ...ordered);
}
