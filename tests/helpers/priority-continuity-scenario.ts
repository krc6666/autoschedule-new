import type { HistoryRecord } from "../../src/model";
import { continuityScenario } from "./staff-work-continuity-scenario";

export function priorityContinuityScenario() {
  const state = continuityScenario();
  const flightNumbers = ["CX100", "MF100", "TW100", "KE160"];
  state.flights.forEach((flight, i) => {
    flight.flightNo = flightNumbers[i]!;
    state.positionRules[i]!.flightNo = flight.flightNo;
    state.assignments[i]!.flightNo = flight.flightNo;
  });
  state.positionRules[3]!.name = "督导";
  state.assignments[3]!.position = "督导";
  state.templates = structuredClone(state.flights);
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "KE", position: "督导" },
  ];
  state.settings.airlineMixPolicies = [];
  state.settings.positionRotationEnabled = true;
  const history = (
    date: string,
    staffId: string,
    flightNo: string,
    position: string
  ): HistoryRecord => ({
    id: `${date}-${staffId}-${position}`,
    date,
    staffId,
    staffName: staffId,
    flightNo,
    position,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
  });
  state.history = [
    ...["2026-11-06", "2026-11-08", "2026-11-10"].map((date) =>
      history(date, "peer-b", "KE999", "督导")
    ),
    history("2026-11-12", "peer-a", "CX999", "G10"),
  ];
  return state;
}
