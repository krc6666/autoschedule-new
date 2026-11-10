import type { Flight, FlightTemplate, PositionRule } from "../../model";
import { normalizeWeeklyFlightNo } from "./weekly-flight-plan";
import { createId, normalizeText } from "../../utils";

function positionKey(flightNo: string, position: string): string {
  return `${normalizeWeeklyFlightNo(flightNo)}\u0000${normalizeText(position).toUpperCase()}`;
}

export function addMissingTemplatePositionRules(
  existing: readonly PositionRule[],
  templates: readonly FlightTemplate[]
): { rules: PositionRule[]; added: number } {
  const rules = [...existing];
  const known = new Set(
    rules.map((rule) => positionKey(rule.flightNo, rule.name))
  );
  let added = 0;

  for (const template of templates) {
    const flightNo = normalizeWeeklyFlightNo(template.flightNo);
    if (!flightNo) continue;
    for (const rawPosition of template.positions) {
      const name = normalizeText(rawPosition);
      if (!name) continue;
      const key = positionKey(flightNo, name);
      if (known.has(key)) continue;
      known.add(key);
      rules.push({
        id: createId("position"),
        flightNo,
        name,
        category: "常规",
        remark: "",
        qualifiedStaffIds: [],
        manual: false,
        fatiguePoints: 1,
        minPassengers: 0,
        earlyReleaseMinutes: 0,
      });
      added += 1;
    }
  }

  return { rules, added };
}

export function addMissingRuleFlightTemplates(
  existing: readonly FlightTemplate[],
  flightRules: readonly PositionRule[],
  allFlightRules: readonly PositionRule[] = flightRules,
  sourceFlights: readonly Pick<
    Flight,
    "flightNo" | "startTime" | "endTime" | "remark"
  >[] = []
): { templates: FlightTemplate[]; added: FlightTemplate[] } {
  const templates = [...existing];
  const known = new Set(
    templates.map((template) => normalizeWeeklyFlightNo(template.flightNo))
  );
  const ruleFlightNos = new Map<string, string>();
  for (const rule of flightRules) {
    const flightNo = normalizeWeeklyFlightNo(rule.flightNo);
    if (flightNo && !known.has(flightNo)) ruleFlightNos.set(flightNo, flightNo);
  }

  const rulesByFlight = new Map<string, PositionRule[]>();
  for (const rule of allFlightRules) {
    const flightNo = normalizeWeeklyFlightNo(rule.flightNo);
    if (!ruleFlightNos.has(flightNo)) continue;
    const current = rulesByFlight.get(flightNo) ?? [];
    current.push(rule);
    rulesByFlight.set(flightNo, current);
  }

  const added: FlightTemplate[] = [];
  for (const flightNo of ruleFlightNos.values()) {
    const positions: string[] = [];
    const knownPositions = new Set<string>();
    for (const rule of rulesByFlight.get(flightNo) ?? []) {
      const name = normalizeText(rule.name);
      const key = name.toUpperCase();
      if (!name || knownPositions.has(key)) continue;
      knownPositions.add(key);
      positions.push(name);
    }
    const source = sourceFlights.find(
      (flight) => normalizeWeeklyFlightNo(flight.flightNo) === flightNo
    );
    const template: FlightTemplate = {
      id: createId("template"),
      flightNo,
      startTime: source?.startTime ?? "",
      endTime: source?.endTime ?? "",
      positions,
      remark: source?.remark ?? "",
    };
    known.add(flightNo);
    templates.push(template);
    added.push(template);
  }

  return { templates, added };
}
