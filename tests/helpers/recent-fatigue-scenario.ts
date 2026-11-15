import { createDefaultState } from "../../src/defaults";
import type { AppState, Assignment, HistoryRecord } from "../../src/model";

export const RECENT_FATIGUE_DATE = "2026-11-07";

export function recentFatigueScenario(): AppState {
  const state = createDefaultState();
  const person = state.staff[0]!;
  state.staff = ["甲", "乙"].map((name, index) => ({
    ...person,
    id: `p${index}`,
    name,
    status: "正常",
    staffType: "常规",
    teamLeader: false,
    dutyQualified: false,
    cxPreflightQualified: false,
    standbyQualified: false,
    nightShift: true,
  }));
  state.flights = [
    {
      ...state.flights[0]!,
      id: "flight",
      flightNo: "AB100",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: ["轻岗", "重岗"],
      remark: "",
    },
  ];
  const rule = state.positionRules[0]!;
  state.positionRules = [6, 10].map((fatiguePoints, index) => ({
    ...rule,
    id: `r${index}`,
    flightNo: "AB100",
    name: state.flights[0]!.positions[index]!,
    category: "常规",
    remark: "",
    fatiguePoints,
    qualifiedStaffIds: ["p0", "p1"],
    minPassengers: 0,
    manual: false,
    earlyReleaseMinutes: 0,
  }));
  state.settings.positionRotationEnabled = false;
  state.settings.rollingLoadMaxFatigue = 100;
  state.settings.positionTransitionPolicies = [];
  state.settings.ordinaryPriorityPositions = [];
  state.settings.crossWorkdayQualificationReservations = [];
  state.settings.dutyFatiguePoints = 0;
  state.settings.historyWindowDays = 7;
  state.settings.workloadBalanceEnabled = true;
  state.settings.maxTodayFatigueDifference = 4;
  state.assignments = [];
  state.activeScheduleDate = RECENT_FATIGUE_DATE;
  state.dutyRosterOverrides = [];
  state.history = state.staff.map((p, index): HistoryRecord => ({
    id: `old-${index}`,
    date: "2026-11-05",
    staffId: p.id,
    staffName: p.name,
    flightNo: "OLD100",
    position: "旧岗位",
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: index === 0 ? 10 : 6,
    remark: "",
  }));
  return state;
}

export function denseRecentFatigueScenario(): AppState {
  const state = recentFatigueScenario();
  const baseFlight = state.flights[0]!;
  const baseRules = state.positionRules;
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  state.flights = ["07", "10", "13", "16"].map((hour, index) => ({
    ...baseFlight,
    id: `f${index}`,
    flightNo: `AB10${index}`,
    startTime: `${hour}:00`,
    endTime: `${Number(hour) + 1}:00`.padStart(5, "0"),
    positions: ["岗1", "岗2"],
  }));
  state.positionRules = state.flights.flatMap((flight, index) =>
    baseRules.map((rule, r) => ({
      ...rule,
      id: `${flight.id}-r${r}`,
      flightNo: flight.flightNo,
      name: flight.positions[r]!,
      fatiguePoints: index < 2 && r === 1 ? 3 : 1,
    }))
  );
  return state;
}

export function fatigueAssignments(
  state: AppState,
  points: readonly number[]
): Assignment[] {
  return state.positionRules.map((rule, index) => {
    const person = state.staff[points.indexOf(rule.fatiguePoints)]!;
    return {
      id: `a${index}`,
      flightId: "flight",
      flightNo: "AB100",
      positionRuleId: rule.id,
      position: rule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: rule.fatiguePoints,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
  });
}
