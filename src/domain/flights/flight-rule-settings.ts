import type { ScheduleSettings } from "../../model";
import { FLIGHT_RULE_REFERENCE_FIELDS } from "./group-flight-references";
import {
  flightIdentities,
  flightIdentityKey,
  type FlightIdentityFacts,
} from "./flight-identities";
import { normalizeWeeklyFlightNo as normalize } from "./weekly-flight-plan";

const caches = new WeakMap<object, WeakMap<object, Map<string, object>>>();

/** Read-only execution projection. Stored rules keep their original provenance.
 * Actual flight IDs, times and position versions are never collapsed here. */
export function flightRuleSettings<S extends object>(
  state: FlightIdentityFacts & { settings: S },
  date?: string
): S {
  const catalog = flightIdentities(state);
  if (!catalog.length) return state.settings;
  date ??= state.flightIdentityDate;
  const cacheable = Object.isFrozen(state.settings) && Object.isFrozen(catalog);
  const cached = cacheable
    ? caches
        .get(state.settings)
        ?.get(catalog)
        ?.get(date ?? "")
    : undefined;
  if (cached) return cached as S;
  const aliases = (reference: string): string[] => {
    if (!reference) return [reference];
    const key = flightIdentityKey(state, reference);
    const identity = catalog.find((i) => `@${i.id.toUpperCase()}` === key);
    if (!identity) return [reference];
    return [
      ...new Set(
        identity.aliases
          .filter(
            (a) =>
              !date ||
              ((!a.from || a.from <= date) && (!a.until || date <= a.until))
          )
          .map((a) => normalize(a.flightNo))
      ),
    ];
  };
  const sourceSettings = state.settings as Partial<ScheduleSettings>;
  const result = { ...sourceSettings };
  if (sourceSettings.latePriorityFlightNumbers)
    result.latePriorityFlightNumbers = [
      ...new Set(sourceSettings.latePriorityFlightNumbers.flatMap(aliases)),
    ];
  if (sourceSettings.relaxedShiftFlightNumbers)
    result.relaxedShiftFlightNumbers = [
      ...new Set(sourceSettings.relaxedShiftFlightNumbers.flatMap(aliases)),
    ];
  for (const [collection, fields] of Object.entries(
    FLIGHT_RULE_REFERENCE_FIELDS
  )) {
    const source =
      sourceSettings[collection as keyof typeof FLIGHT_RULE_REFERENCE_FIELDS];
    if (!source) continue;
    const expanded = source.flatMap((item) => {
      const row = item as unknown as Record<string, unknown>;
      let rows: Record<string, unknown>[] = [row];
      const sameTarget =
        collection === "mobileSupervisorFillRules" &&
        fields.length === 2 &&
        row[fields[0]!] &&
        row[fields[1]!] &&
        flightIdentityKey(state, String(row[fields[0]!])) ===
          flightIdentityKey(state, String(row[fields[1]!]));
      if (sameTarget)
        return aliases(String(row[fields[0]!])).map((no) => ({
          ...row,
          [fields[0]!]: no,
          [fields[1]!]: no,
        }));
      for (const field of fields)
        rows = rows.flatMap((r) =>
          aliases(String(row[field] ?? "")).map((no) => ({ ...r, [field]: no }))
        );
      return rows;
    });
    // Keys and target fields come from the exhaustive typed reference registry.
    const seen = new Set<string>();
    Object.assign(result, {
      [collection]: expanded.filter((row) => {
        const { id: _id, ...facts } = row;
        const key = JSON.stringify(facts);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    });
  }
  if (cacheable) {
    const byCatalog =
      caches.get(state.settings) ?? new WeakMap<object, Map<string, object>>();
    const byDate = byCatalog.get(catalog) ?? new Map<string, object>();
    byDate.set(date ?? "", result);
    byCatalog.set(catalog, byDate);
    caches.set(state.settings, byCatalog);
  }
  return result as S;
}
