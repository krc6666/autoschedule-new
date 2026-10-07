import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { AppState, Flight, PositionRule } from "../../src/model";
import { generateSchedule } from "../helpers/generate-schedule";

const SCHEDULE_DATE = "2026-08-23";

function flight(
  id: string,
  flightNo: string,
  startTime: string,
  endTime: string
): Flight {
  return {
    id,
    flightNo,
    startTime,
    endTime,
    bookedPassengers: 100,
    positions: [],
    remark: "",
  };
}

function obligationState(
  morningQualification: "all" | "protected-only"
): AppState {
  const state = createDefaultState();
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  const [protectedBase, alternateBase] = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 2);
  const protectedWorker = {
    ...protectedBase!,
    id: "protected-worker",
    name: "受保护人员",
    dutyQualified: false,
    nightShift: true,
    teamLeader: false,
  };
  const alternate = {
    ...alternateBase!,
    id: "alternate-worker",
    name: "替代人员",
    dutyQualified: false,
    nightShift: true,
    teamLeader: false,
  };
  state.staff = [protectedWorker, alternate];
  state.flights = [
    flight("morning", "MORNING100", "08:00", "10:00"),
    flight("tr", "TR121", "21:55", "23:55"),
    flight("tw", "TW616", "21:55", "23:55"),
  ];
  const baseRule = state.positionRules[0]!;
  const allStaffIds = state.staff.map((person) => person.id);
  const rule = (
    id: string,
    flightNo: string,
    name: string,
    fatiguePoints: number,
    qualifiedStaffIds: string[]
  ): PositionRule => ({
    ...baseRule,
    id,
    flightNo,
    name,
    category: "常规",
    remark: "",
    fatiguePoints,
    qualifiedStaffIds,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
    manual: false,
  });
  state.positionRules = [
    rule(
      "morning-h03",
      "MORNING100",
      "H03",
      6,
      morningQualification === "all" ? allStaffIds : [protectedWorker.id]
    ),
    rule("tr-position", "TR121", "H03", 1, allStaffIds),
    rule("tw-position", "TW616", "T03", 1, allStaffIds),
  ];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
  state.settings.positionRotationEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.lateShiftRecoveryPositionRules.find(
    (item) => item.matchField === "remark" && item.keyword === "一号"
  )!.nextWorkdayCutoffTime = "12:00";
  state.history = [
    {
      id: "protected-previous-late",
      date: "2026-08-21",
      flightNo: "TR121",
      position: "H02",
      staffId: protectedWorker.id,
      staffName: protectedWorker.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 10,
      remark: "一号",
    },
  ];
  state.dutyRosterOverrides = [
    {
      date: SCHEDULE_DATE,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  return state;
}

describe("same-day late obligation", { timeout: 15_000 }, () => {
  it("gives an unavoidable previous-late worker the lightest late position", async () => {
    const state = obligationState("all");
    const [protectedWorker, lateAlternate] = state.staff;
    const morningWorker = {
      ...lateAlternate!,
      id: "morning-worker",
      name: "早班替代人员",
    };
    state.staff.push(morningWorker);
    state.flights = [
      flight("morning", "MORNING100", "08:00", "10:00"),
      flight("tr", "TR121", "21:55", "23:55"),
    ];
    const baseRule = state.positionRules[0]!;
    state.positionRules = [
      {
        ...baseRule,
        id: "morning-position",
        flightNo: "MORNING100",
        name: "早班岗位",
        qualifiedStaffIds: [morningWorker!.id],
        fatiguePoints: 1,
      },
      {
        ...baseRule,
        id: "tr-heavy",
        flightNo: "TR121",
        name: "H06",
        remark: "一号",
        qualifiedStaffIds: [protectedWorker!.id, lateAlternate!.id],
        fatiguePoints: 8,
      },
      {
        ...baseRule,
        id: "tr-light",
        flightNo: "TR121",
        name: "H08",
        remark: "一号",
        qualifiedStaffIds: [protectedWorker!.id, lateAlternate!.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.settings.lateShiftRecoveryPositionRules =
      state.settings.lateShiftRecoveryPositionRules.map((rule) =>
        rule.matchField === "remark" && rule.keyword === "一号"
          ? { ...rule, nextWorkdayCutoffTime: "12:00" }
          : rule
      );
    state.history = [
      {
        ...state.history[0]!,
        flightNo: "TR121",
        position: "H02",
        staffId: protectedWorker!.id,
        staffName: protectedWorker!.name,
        startTime: "21:55",
        endTime: "23:55",
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    const result = await generateSchedule(state, SCHEDULE_DATE);
    const protectedLate = result.assignments.find(
      (assignment) =>
        assignment.staffId === protectedWorker!.id &&
        assignment.flightNo === "TR121"
    );

    expect(result.unfilledCount).toBe(0);
    expect(protectedLate).toMatchObject({ position: "H08" });
  });

  it("keeps a protected worker off pre-noon work when overlapping late flights require both workers", async () => {
    const state = obligationState("all");
    const [protectedWorker, alternate] = state.staff;

    const result = await generateSchedule(state, SCHEDULE_DATE);
    const lateAssignments = result.assignments.filter((assignment) =>
      ["TR121", "TW616"].includes(assignment.flightNo)
    );
    const protectedAssignments = result.assignments.filter(
      (assignment) => assignment.staffId === protectedWorker!.id
    );

    expect(result.unfilledCount).toBe(0);
    expect(
      new Set(lateAssignments.map((assignment) => assignment.staffId))
    ).toEqual(new Set([protectedWorker!.id, alternate!.id]));
    expect(
      protectedAssignments.some(
        (assignment) => assignment.flightNo === "MORNING100"
      )
    ).toBe(false);
  });

  it("keeps the pre-noon position filled when the protected worker is its only qualified worker", async () => {
    const state = obligationState("protected-only");
    const protectedWorker = state.staff[0]!;

    const result = await generateSchedule(state, SCHEDULE_DATE);
    const morning = result.assignments.find(
      (assignment) => assignment.flightNo === "MORNING100"
    );
    const protectedLateAssignments = result.assignments.filter(
      (assignment) =>
        assignment.staffId === protectedWorker.id &&
        ["TR121", "TW616"].includes(assignment.flightNo)
    );

    expect(result.unfilledCount).toBe(0);
    expect(morning).toMatchObject({
      status: "assigned",
      staffId: protectedWorker.id,
    });
    expect(protectedLateAssignments).toHaveLength(1);
  });

  it("restores before-cutoff priority when enough other workers cover every late flight", async () => {
    const state = obligationState("all");
    const [protectedWorker, alternate] = state.staff;
    const lateAlternate = {
      ...alternate!,
      id: "late-alternate-worker",
      name: "晚班替代人员",
    };
    state.staff.push(lateAlternate);
    state.positionRules
      .filter((rule) => ["TR121", "TW616"].includes(rule.flightNo))
      .forEach((rule) => rule.qualifiedStaffIds.push(lateAlternate.id));

    const result = await generateSchedule(state, SCHEDULE_DATE);
    const protectedAssignments = result.assignments.filter(
      (assignment) => assignment.staffId === protectedWorker!.id
    );

    expect(result.unfilledCount).toBe(0);
    expect(protectedAssignments).toHaveLength(1);
    expect(protectedAssignments[0]).toMatchObject({
      flightNo: "MORNING100",
      status: "assigned",
    });
  });

  it("keeps the earlier-cutoff protected worker on morning work when one protected worker must cover late", async () => {
    const state = obligationState("all");
    const [earlierCutoffWorker, laterCutoffWorker] = state.staff;
    const lateAlternate = {
      ...laterCutoffWorker!,
      id: "late-alternate-worker",
      name: "晚班替代人员",
    };
    state.staff.push(lateAlternate);
    state.positionRules
      .filter((rule) => ["TR121", "TW616"].includes(rule.flightNo))
      .forEach((rule) => rule.qualifiedStaffIds.push(lateAlternate.id));
    state.settings.lateShiftRecoveryPositionRules.find(
      (item) => item.matchField === "remark" && item.keyword === "申报"
    )!.nextWorkdayCutoffTime = "14:00";
    state.history.push({
      id: "later-cutoff-previous-late",
      date: "2026-08-21",
      flightNo: "TR121",
      position: "H04",
      staffId: laterCutoffWorker!.id,
      staffName: laterCutoffWorker!.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 7,
      remark: "申报",
    });

    const result = await generateSchedule(state, SCHEDULE_DATE);
    const morning = result.assignments.find(
      (assignment) => assignment.flightNo === "MORNING100"
    );
    const laterCutoffLateAssignments = result.assignments.filter(
      (assignment) =>
        assignment.staffId === laterCutoffWorker!.id &&
        ["TR121", "TW616"].includes(assignment.flightNo)
    );

    expect(result.unfilledCount).toBe(0);
    expect(morning).toMatchObject({ staffId: earlierCutoffWorker!.id });
    expect(laterCutoffLateAssignments).toHaveLength(1);
  });

  it("keeps the earlier-cutoff worker off morning work when both protected workers must cover late", async () => {
    const state = obligationState("all");
    const [earlierCutoffWorker, laterCutoffWorker] = state.staff;
    state.history[0]!.fatiguePoints = 1;
    state.settings.lateShiftRecoveryPositionRules.find(
      (item) => item.matchField === "remark" && item.keyword === "申报"
    )!.nextWorkdayCutoffTime = "14:00";
    state.history.push({
      id: "later-cutoff-previous-late",
      date: "2026-08-21",
      flightNo: "TR121",
      position: "H04",
      staffId: laterCutoffWorker!.id,
      staffName: laterCutoffWorker!.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 10,
      remark: "申报",
    });

    const result = await generateSchedule(state, SCHEDULE_DATE);
    const morning = result.assignments.find(
      (assignment) => assignment.flightNo === "MORNING100"
    );
    const earlierCutoffLateAssignments = result.assignments.filter(
      (assignment) =>
        assignment.staffId === earlierCutoffWorker!.id &&
        ["TR121", "TW616"].includes(assignment.flightNo)
    );

    expect(result.unfilledCount).toBe(0);
    expect(morning).toMatchObject({ staffId: laterCutoffWorker!.id });
    expect(earlierCutoffLateAssignments).toHaveLength(1);
  });
});
