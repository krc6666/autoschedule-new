import type { Flight, FlightTemplate, PositionRule } from "../../model";
import { normalizeWeeklyFlightNo } from "./weekly-flight-plan";

export function normalizeFlightSeasonOverrides(
  value: unknown
): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, enabled]) => {
      const no = normalizeWeeklyFlightNo(key);
      return no && typeof enabled === "boolean" ? [[no, enabled]] : [];
    })
  );
}

export function renameFlightSeasonOverride(
  workspace: { flightSeasonOverrides?: Record<string, boolean> },
  previous: string,
  next: string
) {
  const choices = normalizeFlightSeasonOverrides(
    workspace.flightSeasonOverrides
  );
  const oldNo = normalizeWeeklyFlightNo(previous);
  const newNo = normalizeWeeklyFlightNo(next);
  if (oldNo === newNo || choices[oldNo] === undefined) return;
  choices[newNo] = choices[oldNo]!;
  delete choices[oldNo];
  workspace.flightSeasonOverrides = choices;
}

/** Revalidate a picker draft against current season and jobs before any calculation. */
export function seasonFlightSelectionError(
  state: {
    positionRules: PositionRule[];
    flightSeasonOverrides?: Record<string, boolean>;
  },
  flights: readonly Flight[]
): string {
  const active = new Set(
    configuredFlightNumbers(state.positionRules, state.flightSeasonOverrides)
  );
  for (const flight of flights) {
    const no = normalizeWeeklyFlightNo(flight.flightNo);
    if (!active.has(no)) return `${no} 已不在本组本季航班中，请重新选择`;
    if (
      !state.positionRules.some(
        (r) => normalizeWeeklyFlightNo(r.flightNo) === no
      )
    )
      return `${no} 尚未配置本组岗位及资质，请先完成岗位配置`;
    if (
      ![flight.startTime, flight.endTime].every((v) =>
        /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)
      )
    )
      return `${no} 开始或结束时间不完整，请先补齐`;
  }
  return "";
}

export function configuredFlightNumbers(
  rules: readonly PositionRule[],
  overrides?: Record<string, boolean>
): string[] {
  const choices = normalizeFlightSeasonOverrides(overrides);
  return [
    ...new Set(
      [
        ...rules.map((r) => normalizeWeeklyFlightNo(r.flightNo)),
        ...Object.keys(choices).filter((no) => choices[no]),
      ].filter((no) => Boolean(no) && choices[no] !== false)
    ),
  ].sort();
}

/** The template library may contain spare seasons; planning uses actual configured flights. */
export function configuredSeasonFlights<T extends { flightNo: string }>(
  flights: readonly T[],
  rules: readonly PositionRule[],
  overrides?: Record<string, boolean>
): T[] {
  const active = new Set(configuredFlightNumbers(rules, overrides));
  return flights.filter((f) => active.has(normalizeWeeklyFlightNo(f.flightNo)));
}

export function configuredSeasonTemplates(
  templates: readonly FlightTemplate[],
  rules: readonly PositionRule[],
  currentFlights: readonly Flight[] = [],
  overrides?: Record<string, boolean>
): FlightTemplate[] {
  return configuredFlightNumbers(rules, overrides).map((flightNo) => {
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
