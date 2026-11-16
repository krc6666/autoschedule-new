import type { OrdinaryPriorityPosition, PositionRule } from "../../model";
import { airlineCode } from "../rules/airline-rotation";
import { normalizedPolicyValue } from "./schedule-protection";

interface OrdinaryPriorityMatcher {
  positionsByAirline: ReadonlyMap<string, ReadonlySet<string>>;
  ruleResults: WeakMap<
    object,
    { flightNo: string; name: string; result: boolean }
  >;
}

const ordinaryPriorityPositionSetCache = new WeakMap<
  readonly OrdinaryPriorityPosition[],
  OrdinaryPriorityMatcher
>();

export function ordinaryPositionReference(value: string): string {
  return normalizedPolicyValue(value).replaceAll(/\s+/g, " ");
}

export const PRIORITY_ROTATION_POSITION_KEYWORDS = [
  "一号",
  "申报",
  "督导",
  "控制",
  "送资料",
] as const;

export function ordinaryPriorityPositionKey(
  flightNo: string,
  position: string,
  _remark: string
): string {
  return `${airlineCode(flightNo)}\u0000${ordinaryPositionReference(position)}`;
}

export function ordinaryPriorityConfigurationKey(
  airline: string,
  position: string
): string {
  return `${String(airline).trim().toUpperCase()}\u0000${ordinaryPositionReference(position)}`;
}

export function normalizeOrdinaryPriorityPositions(
  positions: readonly Partial<OrdinaryPriorityPosition>[]
): OrdinaryPriorityPosition[] {
  const unique = new Map<string, OrdinaryPriorityPosition>();
  for (const item of positions) {
    const airline = String(item.airlineCode ?? "")
      .trim()
      .toUpperCase();
    const position = String(item.position ?? "").trim();
    if (!airline || !position) continue;
    const normalized = { airlineCode: airline, position };
    unique.set(
      `${airline}\u0000${ordinaryPositionReference(position)}`,
      normalized
    );
  }
  return [...unique.values()];
}

export function isOrdinaryPriorityPosition(
  rule: Pick<PositionRule, "category" | "flightNo" | "name" | "remark">,
  configured: readonly OrdinaryPriorityPosition[]
): boolean {
  if (
    rule.category !== "常规" &&
    rule.category !== "分流" &&
    rule.category !== "机动督导"
  )
    return false;
  let matcher = ordinaryPriorityPositionSetCache.get(configured);
  if (!matcher) {
    const positionsByAirline = new Map<string, Set<string>>();
    for (const item of configured) {
      const positions =
        positionsByAirline.get(item.airlineCode.toUpperCase()) ??
        new Set<string>();
      positions.add(ordinaryPositionReference(item.position));
      positionsByAirline.set(item.airlineCode.toUpperCase(), positions);
    }
    matcher = { positionsByAirline, ruleResults: new WeakMap() };
    ordinaryPriorityPositionSetCache.set(configured, matcher);
  }
  const cached = matcher.ruleResults.get(rule);
  if (cached?.flightNo === rule.flightNo && cached.name === rule.name)
    return cached.result;
  const positions = matcher.positionsByAirline.get(airlineCode(rule.flightNo));
  const result = Boolean(positions?.has(ordinaryPositionReference(rule.name)));
  matcher.ruleResults.set(rule, {
    flightNo: rule.flightNo,
    name: rule.name,
    result,
  });
  return result;
}

export function isPriorityRotationPosition(
  rule: Pick<PositionRule, "category" | "name" | "remark">
): boolean {
  if (rule.category !== "常规") return false;
  const searchable = `${rule.name} ${rule.remark}`;
  return PRIORITY_ROTATION_POSITION_KEYWORDS.some((keyword) =>
    searchable.includes(keyword)
  );
}

export function isSameDayCxPriorityPosition(
  rule: Pick<PositionRule, "category" | "name" | "remark">
): boolean {
  if (rule.category !== "常规") return false;
  return (
    isPriorityRotationPosition(rule) || /^(?:G18|G20)$/i.test(rule.name.trim())
  );
}

export function isDutyReliefPriorityPosition(
  flightNo: string,
  rule: Pick<PositionRule, "category" | "name" | "remark">
): boolean {
  return (
    isPriorityRotationPosition(rule) ||
    (/^CX(?:\s|\d)/i.test(flightNo.trim()) && isSameDayCxPriorityPosition(rule))
  );
}

export function isHighFatigueOrdinaryRotationPosition(
  rule: Pick<PositionRule, "category" | "name" | "remark" | "fatiguePoints"> &
    Partial<Pick<PositionRule, "flightNo">>,
  fatigueThreshold: number,
  configured: readonly OrdinaryPriorityPosition[] = []
): boolean {
  return (
    rule.category === "常规" &&
    !isOrdinaryPriorityPosition(
      { ...rule, flightNo: rule.flightNo ?? "" },
      configured
    ) &&
    Number.isFinite(fatigueThreshold) &&
    rule.fatiguePoints >= fatigueThreshold
  );
}
