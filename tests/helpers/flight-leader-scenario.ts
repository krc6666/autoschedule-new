import { createDefaultState } from "../../src/defaults";
import type { Assignment, Flight, PositionRule } from "../../src/model";

export const LEADER_DATE = "2026-11-22";

export function flightLeaderScenario(
  flightCount = 2,
  jobsPerFlight = 2,
  leaderCount = flightCount
) {
  const state = createDefaultState();
  const prototype = state.staff[0]!;
  state.staff = Array.from({ length: flightCount * jobsPerFlight }, (_, i) => ({
    ...prototype,
    id: `worker-${i}`,
    name: `人员${i + 1}`,
    staffType: "常规" as const,
    teamLeader: false,
    flightLeaderQualified: i < leaderCount,
    dutyQualified: false,
    cxPreflightQualified: false,
    standbyQualified: false,
    nightShift: true,
    status: "正常" as const,
    remark: "",
  }));
  Object.assign(state.settings, {
    flightLeaderCoverageEnabled: true,
    minimumFlightLeaders: 1,
    dailyPrimaryPositionUniqueEnabled: false,
    minimumRegularTransitionMinutes: 0,
    highLoadProtectionEnabled: false,
    rollingLoadProtectionEnabled: false,
    positionRotationEnabled: false,
    workloadBalanceEnabled: false,
    lateShiftRecoveryEnabled: false,
    earlyDepartureBalanceEnabled: false,
    afternoonRestBalanceEnabled: false,
    lateAirlineRotationEnabled: false,
    airlineMixPolicies: [],
    crossFlightPriorityPolicies: [],
    crossWorkdayQualificationReservations: [],
    positionTransitionPolicies: [],
    sameFlightStaffExclusions: [],
    dutyPositionPriorities: [],
    ordinaryPriorityPositions: [],
  });
  state.flights = Array.from({ length: flightCount }, (_, i): Flight => ({
    id: `flight-${i}`,
    flightNo: `ZZ${100 + i}`,
    startTime: "08:00",
    endTime: "10:00",
    bookedPassengers: 100,
    positions: Array.from({ length: jobsPerFlight }, (_, n) => `柜台${n + 1}`),
    remark: "",
  }));
  state.templates = structuredClone(state.flights);
  state.positionRules = state.flights.flatMap((f, i) =>
    Array.from({ length: jobsPerFlight }, (_, n): PositionRule => ({
      id: `rule-${i}-${n}`,
      flightNo: f.flightNo,
      name: `柜台${n + 1}`,
      category: "常规",
      remark: "",
      qualifiedStaffIds: state.staff.map((p) => p.id),
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }))
  );
  state.assignments = state.positionRules.map((r, i): Assignment => {
    const f = state.flights[Math.floor(i / jobsPerFlight)]!;
    const p = state.staff[i]!;
    return {
      id: `row-${i}`,
      flightId: f.id,
      flightNo: f.flightNo,
      positionRuleId: r.id,
      position: r.name,
      staffId: p.id,
      staffName: p.name,
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
  });
  state.history = [];
  state.dutyRosterOverrides = [];
  state.latePriorityFrequencyAdjustments = [];
  state.ordinaryPriorityFrequencyAdjustments = [];
  state.activeScheduleDate = LEADER_DATE;
  state.schedulePolicyStale = false;
  return state;
}
