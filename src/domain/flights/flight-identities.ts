import type { FlightIdentity, SharedScheduleData } from "../../model";
import { normalizeWeeklyFlightNo as normalize } from "./weekly-flight-plan";

/** Shared directory in the app; explicit immutable projection in the Worker. */
export interface FlightIdentityFacts {
  shared?: SharedScheduleData;
  flightIdentities?: FlightIdentity[];
  flightIdentityDate?: string;
}

const EMPTY_FLIGHT_IDENTITIES: readonly FlightIdentity[] = Object.freeze([]);

export function flightIdentities(
  context: FlightIdentityFacts
): readonly FlightIdentity[] {
  return (
    context.shared?.flightIdentities ??
    context.flightIdentities ??
    EMPTY_FLIGHT_IDENTITIES
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** A single validator serves edits, JSON restoration, Excel and cloud boundaries. */
export function validateFlightIdentities(value: unknown): string[] {
  if (!Array.isArray(value)) return ["航班档案必须为列表"];
  const errors: string[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  const intervals = new Map<
    string,
    Array<{ id: string; from: string; until: string }>
  >();
  value.forEach((item: unknown, index) => {
    if (!item || typeof item !== "object") {
      errors.push(`航班档案第${index + 1}项无效`);
      return;
    }
    const row = item as Partial<FlightIdentity>;
    if (
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(row.id) ||
      ids.has(row.id.toUpperCase())
    )
      errors.push(`航班档案编号无效或重复：${String(row.id)}`);
    ids.add(typeof row.id === "string" ? row.id.toUpperCase() : "");
    const label =
      typeof row.displayName === "string" ? normalize(row.displayName) : "";
    if (!label || label.startsWith("@") || labels.has(label))
      errors.push("航班档案名称为空或重复");
    labels.add(label);
    if (!Array.isArray(row.aliases) || !row.aliases.length) {
      errors.push(`${label}没有名称归属`);
      return;
    }
    for (const alias of row.aliases) {
      if (
        !alias ||
        typeof alias.flightNo !== "string" ||
        !normalize(alias.flightNo) ||
        normalize(alias.flightNo).startsWith("@")
      ) {
        errors.push(`${label}包含无效原航班号`);
        continue;
      }
      if (
        (alias.from !== undefined && !validDate(alias.from)) ||
        (alias.until !== undefined && !validDate(alias.until)) ||
        (alias.from && alias.until && alias.from > alias.until)
      )
        errors.push(`${alias.flightNo}的生效日期无效`);
      const no = normalize(alias.flightNo);
      if (
        alias.positionSourceFlightNo !== undefined &&
        (typeof alias.positionSourceFlightNo !== "string" ||
          !row.aliases.some(
            (a) =>
              a &&
              typeof a.flightNo === "string" &&
              normalize(a.flightNo) === normalize(alias.positionSourceFlightNo!)
          ))
      )
        errors.push(`${no}的岗位来源不在同一档案中`);
      const from = alias.from ?? "0000-01-01",
        until = alias.until ?? "9999-12-31";
      const previous = intervals.get(no) ?? [];
      if (previous.some((p) => p.from <= until && from <= p.until))
        errors.push(`${no}的归属日期重叠`);
      previous.push({ id: row.id ?? "", from, until });
      intervals.set(no, previous);
    }
  });
  return [...new Set(errors)];
}

export function flightIdentityKey(
  context: FlightIdentityFacts,
  flightNo: string,
  date?: string
): string {
  const no = normalize(flightNo);
  const directory = flightIdentities(context);
  if (!directory.length) return no;
  if (no.startsWith("@")) {
    const identity = directory.find((i) => `@${i.id}`.toUpperCase() === no);
    return identity ? `@${identity.id.toUpperCase()}` : no;
  }
  const found = directory.filter((i) =>
    i.aliases.some(
      (a) =>
        normalize(a.flightNo) === no &&
        (!date ||
          ((!a.from || a.from <= date) && (!a.until || date <= a.until)))
    )
  );
  return found.length === 1 ? `@${found[0]!.id.toUpperCase()}` : no;
}

export function flightIdentityLabel(
  context: FlightIdentityFacts,
  reference: string,
  date?: string
): string {
  const key = flightIdentityKey(context, reference, date);
  return (
    flightIdentities(context).find((i) => `@${i.id.toUpperCase()}` === key)
      ?.displayName ?? reference
  );
}

export function validateFlightIdentityReferences(
  context: FlightIdentityFacts,
  references: readonly string[]
): string[] {
  const ids = new Set(
    flightIdentities(context).map((i) => `@${i.id.toUpperCase()}`)
  );
  return [
    ...new Set(
      references
        .map(normalize)
        .filter((reference) => reference.startsWith("@") && !ids.has(reference))
    ),
  ].map((reference) => `航班档案引用不存在：${reference}`);
}

export function sameFlightIdentity(
  context: FlightIdentityFacts,
  left: string,
  right: string,
  leftDate?: string,
  rightDate = leftDate
): boolean {
  return (
    flightIdentityKey(context, left, leftDate) ===
    flightIdentityKey(context, right, rightDate)
  );
}

/** Rule reference has no execution date; actual event is resolved at its own date. */
export function flightRuleMatches(
  context: FlightIdentityFacts,
  reference: string,
  actual: string,
  date = context.flightIdentityDate
): boolean {
  return sameFlightIdentity(context, reference, actual, undefined, date);
}

export function flightHasSpecialRule(
  context: FlightIdentityFacts,
  flightNo: string,
  special: "KE166" | "TR121",
  date?: string
): boolean {
  // Preserve pre-directory spelling tolerance, without changing generic normalization.
  return (
    flightNo.toUpperCase().replaceAll(/[^A-Z0-9]/g, "") === special ||
    flightRuleMatches(context, special, flightNo, date)
  );
}

export function flightPositionSource(
  context: FlightIdentityFacts,
  flightNo: string,
  date = context.flightIdentityDate
): string {
  const key = flightIdentityKey(context, flightNo, date);
  const identity = flightIdentities(context).find(
    (i) => `@${i.id.toUpperCase()}` === key
  );
  const aliases =
    identity?.aliases.filter(
      (a) =>
        normalize(a.flightNo) === normalize(flightNo) &&
        (!date ||
          ((!a.from || a.from <= date) && (!a.until || date <= a.until)))
    ) ?? [];
  return aliases.length === 1
    ? (aliases[0]!.positionSourceFlightNo ?? flightNo)
    : flightNo;
}
