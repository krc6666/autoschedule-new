import { createDefaultState } from "../../src/defaults";
import type { Assignment, HistoryRecord } from "../../src/model";

export function relaxedMatrixFixture() {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 5).map((p, i) => ({
    ...p,
    id: `person-${i}`,
    name: ["甲", "乙", "丙", "丁", "戊"][i]!,
    status: "正常",
    staffType: "常规",
    dutyQualified: false,
  }));
  state.activeScheduleDate = "2026-11-18";
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.earlyDepartureCutoffTime = "22:00";
  state.settings.afternoonRestStartTime = "12:00";
  state.settings.afternoonRestEndTime = "18:00";
  Object.assign(state.settings, {
    relaxedShiftFlightNumbers: ["MF8001", "CX937"],
  });
  const tasks = [
    ["MF8001", "08:00", "10:00", 0],
    ["CX937", "19:00", "21:00", 1],
    ["PM1", "14:00", "16:00", 2],
    ["NOON", "12:00", "13:00", 3],
    ["CROSS", "11:50", "13:00", 4],
  ] as const;
  state.flights = tasks.map(([flightNo, startTime, endTime]) => ({
    id: flightNo,
    flightNo,
    startTime,
    endTime,
    positions: ["柜台"],
    bookedPassengers: 0,
    remark: "",
  }));
  state.templates = state.flights.map(({ bookedPassengers: _, ...f }) => f);
  state.positionRules.push(
    ...state.flights.map((f) => ({
      ...state.positionRules[0]!,
      id: `rule-${f.flightNo}`,
      flightNo: f.flightNo,
      name: "柜台",
      qualifiedStaffIds: state.staff.map((p) => p.id),
      remark: "",
      category: "常规" as const,
      manual: false,
    }))
  );
  state.assignments = tasks.map(
    ([flightNo, startTime, endTime, index]): Assignment => ({
      id: `task-${index}`,
      flightId: flightNo,
      flightNo,
      positionRuleId: `rule-${flightNo}`,
      position: "柜台",
      staffId: state.staff[index]!.id,
      staffName: state.staff[index]!.name,
      startTime,
      endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    })
  );
  return state;
}

export function matrixHistory(task: Assignment, date: string): HistoryRecord {
  return {
    ...task,
    id: `${task.id}-${date}`,
    date,
    staffId: task.staffId!,
    historyCoverage: "complete",
  };
}
