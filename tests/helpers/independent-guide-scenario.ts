import { createDefaultState } from "../../src/defaults";
import { makeUnfilled } from "../../src/domain/flights/schedule-position-rules";

export const GUIDE_DATE = "2026-11-18";

export function independentGuideScenario() {
  const state = createDefaultState();
  state.staff = [0, 1, 2].map((i) => ({
    ...state.staff[i]!,
    id: `p${i}`,
    name: `人员${i}`,
    staffType: "常规" as const,
    status: "正常" as const,
    nightShift: true,
    teamLeader: false,
    dutyQualified: false,
    cxPreflightQualified: false,
    standbyQualified: false,
  }));
  state.flights = [
    {
      id: "flight",
      flightNo: "AB123",
      startTime: "08:00",
      endTime: "10:00",
      positions: [],
      bookedPassengers: 100,
      remark: "",
    },
  ];
  state.templates = state.flights.map((f) => ({ ...f }));
  const base = state.positionRules[0]!;
  state.positionRules = ["G02", "G01", "柜台引导"].map((name, i) => ({
    ...base,
    id: `r${i}`,
    flightNo: "AB123",
    name,
    category: i === 2 ? ("引导" as const) : ("常规" as const),
    fatiguePoints: i === 2 ? 5 : 1,
    qualifiedStaffIds: ["p0", "p1", "p2"],
    manual: false,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
    remark: "",
  }));
  state.assignments = state.positionRules.map((rule, i) => ({
    ...makeUnfilled(state.flights[0]!, rule.name, rule),
    id: `a${i}`,
    staffId: `p${Math.min(i, 1)}`,
    staffName: `人员${Math.min(i, 1)}`,
    status: "assigned" as const,
    workHours: i === 2 ? 0 : 2,
    fatiguePoints: i === 2 ? 0 : 1,
  }));
  state.history = [];
  state.dutyRosterOverrides = [];
  state.activeScheduleDate = GUIDE_DATE;
  state.settings.positionTransitionPolicies = [];
  return state;
}
