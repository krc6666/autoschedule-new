import { createDefaultState } from "../../src/defaults";

export function seasonalState() {
  const state = createDefaultState();
  state.templates = [
    {
      ...state.templates[0]!,
      id: "new",
      flightNo: "NEW100",
      startTime: "13:00",
      endTime: "15:00",
    },
  ];
  state.shared.templates = state.templates;
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "a-new",
      flightNo: "NEW100",
      name: "H02",
    },
  ];
  state.groups.A.positionRules = state.positionRules;
  state.flights = [];
  state.groups.B.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "b-old",
      flightNo: "OLD100",
      name: "H03",
    },
  ];
  state.groups.B.flights = [
    {
      ...state.groups.A.flights[0]!,
      id: "b-flight",
      flightNo: "OLD100",
      startTime: "10:00",
      endTime: "12:00",
      bookedPassengers: 123,
    },
  ];
  return state;
}
