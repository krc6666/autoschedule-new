import type { AppState } from "../../model";

/**
 * Bump this when the meaning of a scheduling rule changes in code without a
 * corresponding persisted configuration change.
 */
export const SCHEDULE_RULE_FINGERPRINT_VERSION = "rules-v3";

type FingerprintState = Pick<
  AppState,
  | "staff"
  | "flightSeasonOverrides"
  | "flights"
  | "positionRules"
  | "dutyRosterOverrides"
  | "latePriorityFrequencyAdjustments"
  | "settings"
> &
  Partial<Pick<AppState, "ordinaryPriorityFrequencyAdjustments">>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)])
  );
}

/**
 * Produces a compact, deterministic FNV-64 fingerprint for a canonical value.
 * The version is part of the public value so callers can invalidate old
 * fingerprints when the meaning of their payload changes.
 */
export function fnv64Fingerprint(value: unknown, version: string): string {
  const serialized = JSON.stringify(canonicalize(value)) ?? "undefined";
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${version}:${hash.toString(16).padStart(16, "0")}`;
}

export function scheduleRuleFingerprint(state: FingerprintState): string {
  return fnv64Fingerprint(
    {
      version: SCHEDULE_RULE_FINGERPRINT_VERSION,
      ...(Object.keys(state.flightSeasonOverrides ?? {}).length
        ? { flightSeasonOverrides: state.flightSeasonOverrides }
        : {}),
      staff: [...state.staff]
        .map((person) => ({
          id: person.id,
          staffType: person.staffType,
          teamLeader: person.teamLeader,
          cxPreflightQualified: person.cxPreflightQualified,
          dutyQualified: person.dutyQualified,
          standbyQualified: person.standbyQualified,
          nightShift: person.nightShift,
          status: person.status,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      flights: [...state.flights]
        .map((flight) => ({ ...flight, positions: [...flight.positions] }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      positionRules: [...state.positionRules]
        .map((rule) => ({
          ...rule,
          qualifiedStaffIds: [...rule.qualifiedStaffIds].sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      dutyRosterOverrides: [...state.dutyRosterOverrides].sort((left, right) =>
        left.date.localeCompare(right.date)
      ),
      latePriorityFrequencyAdjustments: [
        ...state.latePriorityFrequencyAdjustments,
      ].sort((left, right) =>
        `${left.month}|${left.staffId}|${left.flightNo}|${left.kind}`.localeCompare(
          `${right.month}|${right.staffId}|${right.flightNo}|${right.kind}`
        )
      ),
      ordinaryPriorityFrequencyAdjustments: [
        ...(state.ordinaryPriorityFrequencyAdjustments ?? []),
      ].sort((left, right) =>
        `${left.month}|${left.staffId}|${left.airlineCode}|${left.position}`.localeCompare(
          `${right.month}|${right.staffId}|${right.airlineCode}|${right.position}`
        )
      ),
      settings: state.settings,
    },
    SCHEDULE_RULE_FINGERPRINT_VERSION
  );
}
