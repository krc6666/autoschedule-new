import type { AppState, Flight, FlightTemplate } from "../../model";
import { configuredSeasonTemplates } from "./configured-flight-positions";

export interface QueriedFlightReference {
  flightNo: string;
}

export interface FlightPlanReconciliation<
  TFlight extends QueriedFlightReference = QueriedFlightReference,
> {
  onlineFlights: Array<{
    flight: TFlight;
    template: FlightTemplate | null;
    currentFlight: Flight | null;
  }>;
  retained: Array<{ flight: Flight; onlineFlight: TFlight }>;
  additions: Array<{ flight: TFlight; template: FlightTemplate }>;
  unmatched: TFlight[];
  removals: Flight[];
  removalAllowed: boolean;
  removalBlockedReason: string;
}

function normalizedFlightNo(flightNo: string): string {
  return flightNo.trim().toUpperCase();
}

export function buildFlightPlanReconciliation<
  TFlight extends QueriedFlightReference,
>(
  state: Pick<
    AppState,
    "flights" | "templates" | "positionRules" | "flightSeasonOverrides"
  >,
  currentScheduleDate: string,
  result: { date: string; flights: TFlight[] }
): FlightPlanReconciliation<TFlight> {
  const currentByFlightNo = new Map<string, Flight>();
  state.flights.forEach((flight) =>
    currentByFlightNo.set(normalizedFlightNo(flight.flightNo), flight)
  );
  const templateByFlightNo = new Map<string, FlightTemplate>();
  configuredSeasonTemplates(
    state.templates,
    state.positionRules,
    state.flights,
    state.flightSeasonOverrides
  ).forEach((template) =>
    templateByFlightNo.set(normalizedFlightNo(template.flightNo), template)
  );

  const seenOnlineFlightNos = new Set<string>();
  const onlineFlights: FlightPlanReconciliation<TFlight>["onlineFlights"] = [];
  for (const flight of result.flights) {
    const flightNo = normalizedFlightNo(flight.flightNo);
    if (!flightNo || seenOnlineFlightNos.has(flightNo)) continue;
    seenOnlineFlightNos.add(flightNo);
    onlineFlights.push({
      flight,
      template: templateByFlightNo.get(flightNo) ?? null,
      currentFlight: currentByFlightNo.get(flightNo) ?? null,
    });
  }

  const retained = onlineFlights
    .filter((item): item is typeof item & { currentFlight: Flight } =>
      Boolean(item.currentFlight)
    )
    .map((item) => ({ flight: item.currentFlight, onlineFlight: item.flight }));
  const additions = onlineFlights
    .filter(
      (item): item is typeof item & { template: FlightTemplate } =>
        Boolean(item.template) && !item.currentFlight
    )
    .map((item) => ({ flight: item.flight, template: item.template }));
  const unmatched = onlineFlights
    .filter((item) => !item.template && !item.currentFlight)
    .map((item) => item.flight);
  const removals = state.flights.filter(
    (flight) => !seenOnlineFlightNos.has(normalizedFlightNo(flight.flightNo))
  );

  let removalBlockedReason = "";
  if (result.date !== currentScheduleDate) {
    removalBlockedReason = `查询日期与当前排班日期不一致（查询 ${result.date}，当前 ${currentScheduleDate}），为避免误删，不能批量删减。`;
  } else if (!onlineFlights.length) {
    removalBlockedReason =
      "查询结果为空，无法确认线上数据是否完整，不能批量删减。";
  }

  return {
    onlineFlights,
    retained,
    additions,
    unmatched,
    removals,
    removalAllowed: !removalBlockedReason,
    removalBlockedReason,
  };
}
