import type { Flight, FlightTemplate, PositionRule } from "../../model";
import { normalizeWeeklyFlightNo } from "./weekly-flight-plan";

export function configuredFlightNumbers(
  rules: readonly PositionRule[]
): string[] {
  return [
    ...new Set(
      rules.map((r) => normalizeWeeklyFlightNo(r.flightNo)).filter(Boolean)
    ),
  ].sort();
}

/** The template library may contain spare seasons; planning uses actual configured flights. */
export function configuredSeasonFlights<T extends { flightNo: string }>(
  flights: readonly T[],
  rules: readonly PositionRule[]
): T[] {
  const active = new Set(configuredFlightNumbers(rules));
  return flights.filter((f) => active.has(normalizeWeeklyFlightNo(f.flightNo)));
}

export function configuredSeasonTemplates(
  templates: readonly FlightTemplate[],
  rules: readonly PositionRule[],
  currentFlights: readonly Flight[] = []
): FlightTemplate[] {
  return configuredFlightNumbers(rules).map((flightNo) => {
    const template = templates.find(
      (t) => normalizeWeeklyFlightNo(t.flightNo) === flightNo
    );
    if (template) return template;
    const current = currentFlights.find(
      (f) => normalizeWeeklyFlightNo(f.flightNo) === flightNo
    );
    return {
      id: `configured:${flightNo}`,
      flightNo,
      startTime: current?.startTime ?? "",
      endTime: current?.endTime ?? "",
      remark: current?.remark ?? "请补齐航班模板资料",
      positions: [],
    };
  });
}

/** Current-group rules own this list; stored flight lists are transfer snapshots. */
export function configuredFlightPositions(rules: readonly PositionRule[]) {
  const names = new Map<string, string[]>();
  for (const rule of rules) {
    const flightNo = normalizeWeeklyFlightNo(rule.flightNo);
    const name = rule.name.trim();
    if (!flightNo || !name) continue;
    const positions = names.get(flightNo) ?? [];
    if (!positions.includes(name)) positions.push(name);
    names.set(flightNo, positions);
  }
  return (flightNo: string): string[] => [
    ...(names.get(normalizeWeeklyFlightNo(flightNo)) ?? []),
  ];
}

export function withConfiguredFlightPositions<T extends { flightNo: string }>(
  flights: readonly T[],
  rules: readonly PositionRule[]
): (T & { positions: string[] })[] {
  const positions = configuredFlightPositions(rules);
  return flights.map((flight) => ({
    ...flight,
    positions: positions(flight.flightNo),
  }));
}
