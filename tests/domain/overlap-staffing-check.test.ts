import { describe, expect, it } from "vitest";
import { buildOverlapStaffingCheck } from "../../src/domain/feedback/overlap-staffing-check";
import { overlapStaffingFixture } from "../helpers/overlap-staffing-fixture";

describe("overlap staffing check", () => {
  it("lists overlapping shortages, idle people and direct checks without changing state", () => {
    const state = overlapStaffingFixture();
    const before = structuredClone(state);
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.status).toBe("checked");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({
      startTime: "09:00",
      endTime: "10:00",
      flightNumbers: ["AA101", "BB102"],
    });
    expect(result.windows[0]!.idleStaff.map((person) => person.name)).toEqual([
      "员工乙",
      "员工丙",
      "员工丁",
    ]);
    expect(result.windows[0]!.targets[0]).toMatchObject({
      assignmentId: "t0",
      kind: "vacancy",
      directStaffNames: ["员工乙", "员工丙", "员工丁"],
    });
    expect(state).toEqual(before);
  });

  it.each(["touch", "filled", "low-demand", "passive-manual"])(
    "does not warn for %s",
    (mode) => {
      const state = overlapStaffingFixture();
      if (mode === "touch")
        state.flights[1]!.startTime = state.assignments[1]!.startTime = "10:00";
      if (mode === "filled")
        Object.assign(state.assignments[0]!, {
          status: "assigned",
          staffId: "p1",
          staffName: "员工乙",
        });
      if (mode === "low-demand") state.positionRules[0]!.minPassengers = 101;
      if (mode === "passive-manual") {
        state.flights[0]!.startTime = state.assignments[0]!.startTime = "12:00";
        state.flights[0]!.endTime = state.assignments[0]!.endTime = "14:00";
        state.flights[1]!.startTime = state.assignments[1]!.startTime = "13:00";
        state.flights[1]!.endTime = state.assignments[1]!.endTime = "15:00";
        state.positionRules[0]!.manual = true;
        state.assignments[0]!.status = "manual";
      }
      expect(buildOverlapStaffingCheck(state, "2026-11-18").windows).toEqual(
        []
      );
    }
  );

  it("checks actual supervisor fill even when no vacancy remains", () => {
    const state = overlapStaffingFixture();
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "supervisor",
      name: "机动督导",
      category: "机动督导",
    });
    state.assignments.push({
      ...state.assignments[0]!,
      id: "source",
      positionRuleId: "supervisor",
      position: "机动督导",
      staffId: "p1",
      staffName: "员工乙",
      status: "assigned",
    });
    Object.assign(state.assignments[0]!, {
      staffId: "p1",
      staffName: "员工乙",
      status: "assigned",
      workHours: 0,
      supervisorSourceAssignmentId: "source",
    });
    state.settings.mobileSupervisorFillRules = [];
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.windows[0]!.targets[0]).toMatchObject({
      kind: "supervisor-fill",
      directStaffNames: ["员工丙", "员工丁"],
    });
    expect(
      result.windows[0]!.idleStaff.map((person) => person.id)
    ).not.toContain("p1");
  });

  it("separates time-idle staff from qualified and half-rest eligible candidates", () => {
    const state = overlapStaffingFixture();
    state.staff[3]!.status = "病假";
    state.positionRules[0]!.qualifiedStaffIds = ["p2"];
    state.halfRestSelections = [
      { date: "2026-11-18", modes: { p2: "late-start" } },
    ];
    const target = buildOverlapStaffingCheck(state, "2026-11-18").windows[0]!
      .targets[0]!;
    expect(target.directStaffNames).toEqual([]);
    expect(
      target.blockedStaff
        .find((person) => person.name === "员工乙")
        ?.reasons.join(";")
    ).toContain("资质");
    expect(
      target.blockedStaff
        .find((person) => person.name === "员工丙")
        ?.reasons.join(";")
    ).toContain("半休");
    expect(target.blockedStaff.some((person) => person.name === "员工丁")).toBe(
      false
    );
  });

  it("does not mistake freedom only during the overlap for freedom for the entire target", () => {
    const state = overlapStaffingFixture();
    state.assignments.push({
      ...state.assignments[1]!,
      id: "earlier",
      flightId: "c",
      flightNo: "CC103",
      staffId: "p1",
      staffName: "员工乙",
      startTime: "07:00",
      endTime: "09:00",
    });
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.windows[0]!.idleStaff.map((person) => person.id)).toContain(
      "p1"
    );
    expect(result.windows[0]!.targets[0]!.directStaffNames).not.toContain(
      "员工乙"
    );
    expect(
      result.windows[0]!.targets[0]!.blockedStaff.find(
        (person) => person.name === "员工乙"
      )?.reasons.join(";")
    ).toContain("冲突");
  });

  it("keeps staffing evidence when there are no idle people", () => {
    const state = overlapStaffingFixture();
    state.staff = [state.staff[0]!];
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.idleStaff).toEqual([]);
    expect(result.windows[0]!.targets[0]!.directStaffNames).toEqual([]);
  });

  it("uses operational-day intervals across midnight", () => {
    const state = overlapStaffingFixture();
    state.flights[0]!.startTime = state.assignments[0]!.startTime = "23:00";
    state.flights[0]!.endTime = state.assignments[0]!.endTime = "01:00";
    state.flights[1]!.startTime = state.assignments[1]!.startTime = "00:30";
    state.flights[1]!.endTime = state.assignments[1]!.endTime = "02:00";
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.windows[0]).toMatchObject({
      startTime: "次日00:30",
      endTime: "次日01:00",
    });
  });

  it("never infers missing positions or supervisor links from archived history", () => {
    const state = overlapStaffingFixture();
    state.history = [
      {
        ...state.assignments[1]!,
        id: "archived",
        date: "2026-11-16",
        staffId: "p0",
        historyCoverage: "complete",
      },
    ];
    const result = buildOverlapStaffingCheck(state, "2026-11-16");
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("历史");
    expect(result.windows).toEqual([]);
    expect(buildOverlapStaffingCheck(state, "2026-11-18", true).status).toBe(
      "unavailable"
    );
    expect(buildOverlapStaffingCheck(state, "2026-11-14").status).toBe(
      "unavailable"
    );
  });

  it("splits three-flight chains into real overlaps instead of a transitive all-day group", () => {
    const state = overlapStaffingFixture();
    state.flights.push({
      ...state.flights[0]!,
      id: "c",
      flightNo: "CC103",
      startTime: "10:00",
      endTime: "12:00",
    });
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "r2",
      flightNo: "CC103",
    });
    state.assignments.push({
      ...state.assignments[0]!,
      id: "t2",
      flightId: "c",
      flightNo: "CC103",
      positionRuleId: "r2",
      startTime: "10:00",
      endTime: "12:00",
    });
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.windows.map((window) => window.flightNumbers)).toEqual([
      ["AA101", "BB102"],
      ["BB102", "CC103"],
    ]);
    expect(
      result.windows.map((window) => [window.startTime, window.endTime])
    ).toEqual([
      ["09:00", "10:00"],
      ["10:00", "11:00"],
    ]);
  });

  it("rechecks full work hours when replacing a zero-hour supervisor fill", () => {
    const state = overlapStaffingFixture();
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "supervisor",
      name: "机动督导",
      category: "机动督导",
    });
    state.assignments.push({
      ...state.assignments[0]!,
      id: "source",
      positionRuleId: "supervisor",
      position: "机动督导",
      staffId: "p1",
      staffName: "员工乙",
      status: "assigned",
    });
    Object.assign(state.assignments[0]!, {
      staffId: "p1",
      staffName: "员工乙",
      status: "assigned",
      workHours: 0,
      supervisorSourceAssignmentId: "source",
    });
    state.assignments.push({
      ...state.assignments[1]!,
      id: "later",
      flightId: "c",
      flightNo: "CC103",
      startTime: "15:00",
      endTime: "17:00",
      staffId: "p2",
      staffName: "员工丙",
      workHours: 2,
    });
    state.settings.maxDailyHours = 3;
    const target = buildOverlapStaffingCheck(state, "2026-11-18").windows[0]!
      .targets[0]!;
    expect(target.directStaffNames).not.toContain("员工丙");
    expect(
      target.blockedStaff
        .find((person) => person.name === "员工丙")
        ?.reasons.join(";")
    ).toContain("工时");
  });

  it("keeps minimum transition, team-leader and current staff-status boundaries", () => {
    const state = overlapStaffingFixture();
    state.settings.minimumRegularTransitionMinutes = 90;
    state.staff[3]!.teamLeader = true;
    state.assignments.push({
      ...state.assignments[1]!,
      id: "earlier",
      flightId: "c",
      flightNo: "CC103",
      startTime: "06:00",
      endTime: "07:30",
      staffId: "p1",
      staffName: "员工乙",
    });
    const target = buildOverlapStaffingCheck(state, "2026-11-18").windows[0]!
      .targets[0]!;
    expect(target.directStaffNames).toEqual(["员工丙"]);
    expect(
      target.blockedStaff
        .find((person) => person.name === "员工乙")
        ?.reasons.join(";")
    ).toContain("少于要求的 90 分钟");
    expect(
      target.blockedStaff
        .find((person) => person.name === "员工丁")
        ?.reasons.join(";")
    ).toContain("分队长");
    state.staff[2]!.staffType = "行政支援";
    expect(
      buildOverlapStaffingCheck(state, "2026-11-18").windows[0]!.idleStaff.map(
        (person) => person.id
      )
    ).not.toContain("p2");
  });

  it("shows no complete conclusion when operational times are missing", () => {
    const state = overlapStaffingFixture();
    state.flights[1]!.endTime = "";
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("起止时间");
  });

  it("does not classify an ordinary guide reuse as supervisor fill", () => {
    const state = overlapStaffingFixture();
    Object.assign(state.assignments[0]!, {
      status: "assigned",
      staffId: "p1",
      staffName: "员工乙",
    });
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "guide",
      category: "引导",
      name: "柜台引导",
    });
    state.assignments.push({
      ...state.assignments[0]!,
      id: "guide",
      positionRuleId: "guide",
      position: "柜台引导",
      workHours: 0,
    });
    expect(buildOverlapStaffingCheck(state, "2026-11-18").windows).toEqual([]);
  });

  it("retains strict recovery restrictions from the existing coverage safety policy", () => {
    const state = overlapStaffingFixture();
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "late",
        enabled: true,
        flightNo: "ZZ999",
        matchField: "position",
        keyword: "重点",
        nextWorkdayCutoffTime: "23:59",
      },
    ];
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "target",
        enabled: true,
        flightNo: "AA101",
        positionKeyword: "G01",
      },
    ];
    state.history = [
      {
        id: "late",
        date: "2026-11-16",
        flightNo: "ZZ999",
        position: "重点",
        staffId: "p1",
        staffName: "员工乙",
        startTime: "21:00",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        historyCoverage: "complete",
      },
    ];
    const target = buildOverlapStaffingCheck(state, "2026-11-18").windows[0]!
      .targets[0]!;
    expect(target.directStaffNames).not.toContain("员工乙");
    expect(
      target.blockedStaff
        .find((person) => person.name === "员工乙")
        ?.reasons.join(";")
    ).toContain("严格跨工作日恢复");
  });

  it("handles a dense roster without treating one free person as many simultaneous workers", () => {
    const state = overlapStaffingFixture();
    state.staff = [state.staff[1]!];
    state.flights = Array.from({ length: 25 }, (_, index) => ({
      ...state.flights[0]!,
      id: `f${index}`,
      flightNo: `TEST${index}`,
    }));
    state.positionRules = state.flights.map((flight, index) => ({
      ...state.positionRules[0]!,
      id: `r${index}`,
      flightNo: flight.flightNo,
    }));
    state.assignments = state.flights.map((flight, index) => ({
      ...state.assignments[0]!,
      id: `t${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: `r${index}`,
    }));
    const result = buildOverlapStaffingCheck(state, "2026-11-18");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.idleStaff).toHaveLength(1);
    expect(result.windows[0]!.targets).toHaveLength(25);
    expect(
      result.windows[0]!.targets.every(
        (target) => target.directStaffNames.length === 1
      )
    ).toBe(true);
  });
});
