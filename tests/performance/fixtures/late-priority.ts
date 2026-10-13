import { createDefaultState } from "../../../src/defaults";
import type { Assignment } from "../../../src/model";

export function createLatePriorityPressureState() {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 15).map((person, index) => ({
    ...person,
    id: `P${index}`,
    name: `测试${index}`,
    status: "正常" as const,
    staffType: "常规" as const,
    nightShift: true,
  }));
  state.history = [];
  state.assignments = [];
  state.latePriorityFrequencyAdjustments = [];
  state.dutyRosterOverrides = [];
  state.settings.positionRotationEnabled = true;
  state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
  state.flights = ["TR121", "TW616"].map((flightNo, index) => ({
    id: `F${index}`,
    flightNo,
    startTime: "22:00",
    endTime: "00:00",
    positions: ["督导", "H01", "H02", "H03"],
    bookedPassengers: 200,
    remark: "",
  }));
  const base = state.positionRules[0]!;
  state.positionRules = state.flights.flatMap((flight) =>
    flight.positions.map((name, index) => ({
      ...base,
      id: `${flight.id}R${index}`,
      flightNo: flight.flightNo,
      name,
      category: "常规" as const,
      manual: false,
      minPassengers: 0,
      remark: ["", "一号", "申报", "送资料"][index]!,
      qualifiedStaffIds: state.staff.map((person) => person.id),
    }))
  );
  state.history = Array.from({ length: 900 }, (_, index) => {
    const person = state.staff[index % state.staff.length]!;
    const rule =
      state.positionRules[
        Math.floor(index / state.staff.length) % state.positionRules.length
      ]!;
    return {
      id: `H${index}`,
      date: `2026-10-${String(1 + Math.floor(index / 120) * 2).padStart(2, "0")}`,
      staffId: person.id,
      staffName: person.name,
      flightNo: rule.flightNo,
      position: rule.name,
      remark: rule.remark,
      startTime: "22:00",
      endTime: "00:00",
      workHours: 2,
      fatiguePoints: 4,
    };
  });
  const assignments = state.positionRules.map<Assignment>((rule, index) => ({
    id: `A${index}`,
    flightId: state.flights.find((flight) => flight.flightNo === rule.flightNo)!
      .id,
    flightNo: rule.flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: state.staff[index]!.id,
    staffName: state.staff[index]!.name,
    startTime: "22:00",
    endTime: "00:00",
    workHours: 2,
    fatiguePoints: 4,
    status: "assigned",
    remark: rule.remark,
    manualRemark: "",
  }));
  return { state, assignments, date: "2026-10-15" };
}
