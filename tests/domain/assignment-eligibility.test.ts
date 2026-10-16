import { describe, expect, it } from "vitest";

import type { Assignment, PositionRule, Staff } from "../../src/model";
import {
  analyzeAutomaticEligibilityPool,
  availableStaffForManualAssignment,
  diagnoseAutomaticAssignmentEligibility,
  diagnoseManualAssignmentEligibility,
  eligibleStaffForRule,
} from "../../src/domain/candidates/assignment-eligibility";
import { createSchedulingScenario } from "../helpers/scheduling-scenario";
import { evaluateManualAssignment } from "../../src/domain/candidates/manual-assignment-override";

describe("assignment eligibility diagnostics", () => {
  it("returns only fully eligible and currently idle staff for a manual position", () => {
    const state = createSchedulingScenario();
    const flight = state.flights[0]!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo && item.category === "常规"
    )!;
    const [available, busy, unqualified] = state.staff.slice(0, 3);
    state.staff = [available!, busy!, unqualified!];
    rule.qualifiedStaffIds = [available!.id, busy!.id];
    const target: Assignment = {
      id: "target-assignment",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: null,
      staffName: "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 0,
      fatiguePoints: rule.fatiguePoints,
      remark: rule.remark,
      manualRemark: "",
      status: "unfilled",
    };
    const busyAssignment: Assignment = {
      ...target,
      id: "busy-assignment",
      staffId: busy!.id,
      staffName: busy!.name,
      status: "assigned",
      positionRuleId: rule.id,
    };
    state.assignments = [target, busyAssignment];

    expect(availableStaffForManualAssignment(state, target.id)).toEqual([
      available,
    ]);
  });

  it.each([
    ["控制", "控制"],
    ["控制", "一号"],
    ["一号", "控制"],
    ["一号", "一号"],
  ])(
    "allows same-airline %s then %s with a warning for manual assignment",
    (sourceRemark, targetRemark) => {
      const state = createSchedulingScenario();
      const person = {
        ...state.staff[0]!,
        id: "priority-worker",
        name: "重点岗位人员",
        status: "正常" as const,
        staffType: "常规" as const,
        nightShift: true,
      };
      const sourceFlight = {
        ...state.flights[0]!,
        id: "fd-morning",
        flightNo: "FD101",
        startTime: "08:00",
        endTime: "10:00",
      };
      const targetFlight = {
        ...sourceFlight,
        id: "fd-later",
        flightNo: "FD202",
        startTime: "15:00",
        endTime: "17:00",
      };
      const sourceRule: PositionRule = {
        ...state.positionRules[0]!,
        id: "fd-source-rule",
        flightNo: sourceFlight.flightNo,
        name: "G08",
        remark: sourceRemark,
        category: "常规",
        qualifiedStaffIds: [person.id],
      };
      const targetRule: PositionRule = {
        ...sourceRule,
        id: "fd-target-rule",
        flightNo: targetFlight.flightNo,
        name: "G17",
        remark: targetRemark,
      };
      const sourceAssignment: Assignment = {
        id: "fd-source-assignment",
        flightId: sourceFlight.id,
        flightNo: sourceFlight.flightNo,
        positionRuleId: sourceRule.id,
        position: sourceRule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: sourceFlight.startTime,
        endTime: sourceFlight.endTime,
        workHours: 2,
        fatiguePoints: 1,
        remark: sourceRule.remark,
        manualRemark: "",
        status: "assigned",
      };
      const targetAssignment: Assignment = {
        ...sourceAssignment,
        id: "fd-target-assignment",
        flightId: targetFlight.id,
        flightNo: targetFlight.flightNo,
        positionRuleId: targetRule.id,
        position: targetRule.name,
        staffId: null,
        staffName: "",
        startTime: targetFlight.startTime,
        endTime: targetFlight.endTime,
        remark: targetRule.remark,
        status: "unfilled",
      };
      state.staff = [person];
      state.flights = [sourceFlight, targetFlight];
      state.positionRules = [sourceRule, targetRule];
      state.assignments = [sourceAssignment, targetAssignment];
      state.settings.minimumRegularTransitionMinutes = 0;

      expect(
        diagnoseAutomaticAssignmentEligibility({
          state,
          assignments: [sourceAssignment],
          flight: targetFlight,
          rule: targetRule,
          person,
          workHours: targetAssignment.workHours,
        }).violations[0]?.code
      ).toBe("same-airline-priority");
      expect(
        diagnoseManualAssignmentEligibility(
          state,
          targetAssignment.id,
          person.id
        ).violations[0]?.code
      ).toBe("same-airline-priority");
      expect(
        evaluateManualAssignment(state, targetAssignment.id, person.id)
      ).toMatchObject({
        allowed: true,
        warnings: [expect.objectContaining({ code: "same-airline-priority" })],
      });

      targetFlight.flightNo =
        targetRule.flightNo =
        targetAssignment.flightNo =
          "CX202";
      expect(
        diagnoseAutomaticAssignmentEligibility({
          state,
          assignments: [sourceAssignment],
          flight: targetFlight,
          rule: targetRule,
          person,
          workHours: targetAssignment.workHours,
        }).eligible
      ).toBe(true);
    }
  );

  it("allows a manual same-airline control/number-one placement with a warning", () => {
    const state = createSchedulingScenario();
    const person = {
      ...state.staff[0]!,
      id: "priority-worker",
      name: "重点岗位人员",
      status: "正常" as const,
      staffType: "常规" as const,
      nightShift: true,
    };
    const sourceFlight = {
      ...state.flights[0]!,
      id: "cx-morning",
      flightNo: "CX100",
      startTime: "08:00",
      endTime: "10:00",
    };
    const targetFlight = {
      ...sourceFlight,
      id: "cx-evening",
      flightNo: "CX200",
      startTime: "15:00",
      endTime: "17:00",
    };
    const sourceRule: PositionRule = {
      ...state.positionRules[0]!,
      id: "cx-control",
      flightNo: sourceFlight.flightNo,
      name: "G08",
      remark: "控制",
      category: "常规",
      qualifiedStaffIds: [person.id],
    };
    const targetRule: PositionRule = {
      ...sourceRule,
      id: "cx-number-one",
      flightNo: targetFlight.flightNo,
      name: "G17",
      remark: "一号",
    };
    const sourceAssignment: Assignment = {
      id: "cx-source",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: sourceFlight.startTime,
      endTime: sourceFlight.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: sourceRule.remark,
      manualRemark: "",
      status: "assigned",
    };
    const targetAssignment: Assignment = {
      ...sourceAssignment,
      id: "cx-target",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: null,
      staffName: "",
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      remark: targetRule.remark,
      status: "unfilled",
    };
    state.staff = [person];
    state.flights = [sourceFlight, targetFlight];
    state.positionRules = [sourceRule, targetRule];
    state.assignments = [sourceAssignment, targetAssignment];
    state.settings.minimumRegularTransitionMinutes = 0;

    expect(
      evaluateManualAssignment(state, targetAssignment.id, person.id)
    ).toMatchObject({
      allowed: true,
      warnings: [expect.objectContaining({ code: "same-airline-priority" })],
    });
  });

  it("uses the same hard facts for automatic and manual decisions", () => {
    const state = createSchedulingScenario();
    const person: Staff = {
      ...state.staff[0]!,
      id: "worker",
      name: "测试人员",
      status: "正常",
      staffType: "常规",
      nightShift: true,
    };
    const flight = {
      ...state.flights[0]!,
      id: "target-flight",
      flightNo: "TARGET",
      startTime: "10:00",
      endTime: "12:00",
    };
    const rule = {
      ...state.positionRules[0]!,
      id: "target-rule",
      flightNo: flight.flightNo,
      name: "G01",
      qualifiedStaffIds: [person.id],
    };
    const target: Assignment = {
      id: "target-assignment",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: null,
      staffName: "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    };
    state.staff = [person];
    state.flights = [flight];
    state.positionRules = [rule];
    state.assignments = [target];
    state.settings.minimumRegularTransitionMinutes = 0;

    const automaticCode = (assignments: Assignment[] = []) =>
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments,
        flight,
        rule,
        person,
        workHours: target.workHours,
      }).violations[0]?.code;
    const manualCode = () =>
      diagnoseManualAssignmentEligibility(state, target.id, person.id)
        .violations[0]?.code;

    person.status = "病假";
    expect([automaticCode(), manualCode()]).toEqual([
      "staff-unavailable",
      "staff-unavailable",
    ]);

    person.status = "正常";
    rule.qualifiedStaffIds = [];
    expect([automaticCode(), manualCode()]).toEqual([
      "position-qualification",
      "position-qualification",
    ]);

    rule.qualifiedStaffIds = [person.id];
    person.nightShift = false;
    flight.startTime = target.startTime = "22:00";
    flight.endTime = target.endTime = "23:00";
    expect([automaticCode(), manualCode()]).toEqual([
      "night-shift",
      "night-shift",
    ]);

    person.nightShift = true;
    flight.startTime = target.startTime = "10:00";
    flight.endTime = target.endTime = "12:00";
    const conflict: Assignment = {
      ...target,
      id: "conflict",
      flightId: "other-flight",
      flightNo: "OTHER",
      staffId: person.id,
      staffName: person.name,
      startTime: "11:00",
      endTime: "13:00",
      status: "assigned",
    };
    state.assignments = [target, conflict];
    expect([automaticCode([conflict]), manualCode()]).toEqual([
      "time-conflict",
      "time-conflict",
    ]);

    const longWork: Assignment = {
      ...conflict,
      id: "long-work",
      startTime: "02:00",
      endTime: "09:00",
      workHours: 7,
    };
    state.assignments = [target, longWork];
    state.settings.maxDailyHours = 8;
    expect([automaticCode([longWork]), manualCode()]).toEqual([
      "daily-hours",
      "daily-hours",
    ]);
  });

  it("enforces the global minimum flight transition for automatic and manual assignments", () => {
    const state = createSchedulingScenario();
    const person = {
      ...state.staff[0]!,
      id: "worker",
      name: "测试人员",
      status: "正常" as const,
      staffType: "常规" as const,
      nightShift: true,
    };
    const sourceFlight = {
      ...state.flights[0]!,
      id: "source-flight",
      flightNo: "AA100",
      startTime: "08:00",
      endTime: "10:00",
    };
    const targetFlight = {
      ...state.flights[0]!,
      id: "target-flight",
      flightNo: "BB200",
      startTime: "11:29",
      endTime: "12:29",
    };
    const sourceRule = {
      ...state.positionRules[0]!,
      id: "source-rule",
      flightNo: sourceFlight.flightNo,
      name: "G01",
      category: "常规" as const,
      qualifiedStaffIds: [person.id],
      earlyReleaseMinutes: 0,
    };
    const targetRule = {
      ...sourceRule,
      id: "target-rule",
      flightNo: targetFlight.flightNo,
      name: "H01",
    };
    const sourceAssignment: Assignment = {
      id: "source-assignment",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: sourceFlight.startTime,
      endTime: sourceFlight.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const targetAssignment: Assignment = {
      ...sourceAssignment,
      id: "target-assignment",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: null,
      staffName: "",
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      workHours: 1,
      status: "unfilled",
    };
    state.staff = [person];
    state.flights = [sourceFlight, targetFlight];
    state.positionRules = [sourceRule, targetRule];
    state.assignments = [sourceAssignment, targetAssignment];
    state.settings.minimumRegularTransitionMinutes = 90;

    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [sourceAssignment],
        flight: targetFlight,
        rule: targetRule,
        person,
      }).violations[0]
    ).toMatchObject({
      code: "minimum-flight-transition",
      message: `测试人员与上一航班间隔只有 89 分钟，少于要求的 90 分钟。涉及航班：${sourceFlight.flightNo}→${targetFlight.flightNo}`,
    });
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .violations[0]
    ).toMatchObject({ code: "minimum-flight-transition" });

    targetFlight.startTime = "11:30";
    targetFlight.endTime = "12:30";
    targetAssignment.startTime = targetFlight.startTime;
    targetAssignment.endTime = targetFlight.endTime;
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .eligible
    ).toBe(true);
  });

  it("uses configured early release when checking a diversion transition", () => {
    const state = createSchedulingScenario();
    const person = {
      ...state.staff[0]!,
      id: "worker",
      name: "测试人员",
      status: "正常" as const,
      staffType: "常规" as const,
      nightShift: true,
    };
    const sourceFlight = {
      ...state.flights[0]!,
      id: "source-flight",
      flightNo: "AA100",
      startTime: "13:00",
      endTime: "15:00",
    };
    const targetFlight = {
      ...state.flights[0]!,
      id: "target-flight",
      flightNo: "BB200",
      startTime: "15:59",
      endTime: "16:59",
    };
    const sourceRule = {
      ...state.positionRules[0]!,
      id: "source-rule",
      flightNo: sourceFlight.flightNo,
      name: "分流",
      category: "分流" as const,
      qualifiedStaffIds: [person.id],
      earlyReleaseMinutes: 30,
    };
    const targetRule = {
      ...sourceRule,
      id: "target-rule",
      flightNo: targetFlight.flightNo,
      name: "H01",
      category: "常规" as const,
      earlyReleaseMinutes: 0,
    };
    const sourceAssignment: Assignment = {
      id: "source-assignment",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: sourceFlight.startTime,
      endTime: sourceFlight.endTime,
      workHours: 1.5,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const targetAssignment: Assignment = {
      ...sourceAssignment,
      id: "target-assignment",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: null,
      staffName: "",
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      workHours: 1,
      status: "unfilled",
    };
    state.staff = [person];
    state.flights = [sourceFlight, targetFlight];
    state.positionRules = [sourceRule, targetRule];
    state.assignments = [sourceAssignment, targetAssignment];
    state.settings.minimumRegularTransitionMinutes = 90;

    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .violations[0]
    ).toMatchObject({ code: "minimum-flight-transition" });

    targetFlight.startTime = "16:00";
    targetFlight.endTime = "17:00";
    targetAssignment.startTime = targetFlight.startTime;
    targetAssignment.endTime = targetFlight.endTime;
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .eligible
    ).toBe(true);
  });

  it("exempts only a valid afternoon diversion transfer from the global transition gap", () => {
    const state = createSchedulingScenario();
    const person: Staff = {
      ...state.staff[0]!,
      id: "worker",
      name: "测试人员",
      status: "正常" as const,
      staffType: "常规" as const,
      nightShift: true,
    };
    const sourceFlight = {
      ...state.flights[0]!,
      id: "source-flight",
      flightNo: "AA100",
      startTime: "21:05",
      endTime: "23:05",
    };
    const targetFlight = {
      ...state.flights[0]!,
      id: "target-flight",
      flightNo: "BB200",
      startTime: "22:10",
      endTime: "00:10",
    };
    const sourceRule: PositionRule = {
      ...state.positionRules[0]!,
      id: "source-rule",
      flightNo: sourceFlight.flightNo,
      name: "G09",
      category: "分流" as const,
      qualifiedStaffIds: [person.id],
      earlyReleaseMinutes: 60,
    };
    const targetRule = {
      ...sourceRule,
      id: "target-rule",
      flightNo: targetFlight.flightNo,
      name: "G13",
      category: "常规" as const,
      earlyReleaseMinutes: 0,
    };
    const sourceAssignment: Assignment = {
      id: "source-assignment",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: sourceFlight.startTime,
      endTime: sourceFlight.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const targetAssignment: Assignment = {
      ...sourceAssignment,
      id: "target-assignment",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: null,
      staffName: "",
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      workHours: 2,
      status: "unfilled",
    };
    state.staff = [person];
    state.flights = [sourceFlight, targetFlight];
    state.positionRules = [sourceRule, targetRule];
    state.assignments = [sourceAssignment, targetAssignment];
    state.settings.minimumRegularTransitionMinutes = 90;

    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [sourceAssignment],
        flight: targetFlight,
        rule: targetRule,
        person,
      }).eligible
    ).toBe(true);
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .eligible
    ).toBe(true);

    sourceRule.category = "常规";
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .eligible
    ).toBe(false);

    sourceRule.category = "分流";
    sourceFlight.startTime = "08:05";
    sourceFlight.endTime = "10:05";
    sourceAssignment.startTime = sourceFlight.startTime;
    sourceAssignment.endTime = sourceFlight.endTime;
    targetFlight.startTime = "09:10";
    targetFlight.endTime = "11:10";
    targetAssignment.startTime = targetFlight.startTime;
    targetAssignment.endTime = targetFlight.endTime;
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .eligible
    ).toBe(false);

    sourceFlight.startTime = "13:00";
    sourceFlight.endTime = "15:00";
    sourceAssignment.startTime = sourceFlight.startTime;
    sourceAssignment.endTime = sourceFlight.endTime;
    targetFlight.startTime = "13:59";
    targetFlight.endTime = "15:59";
    targetAssignment.startTime = targetFlight.startTime;
    targetAssignment.endTime = targetFlight.endTime;
    expect(
      diagnoseManualAssignmentEligibility(state, targetAssignment.id, person.id)
        .eligible
    ).toBe(false);

    sourceFlight.startTime = "21:05";
    sourceFlight.endTime = "23:05";
    sourceAssignment.startTime = sourceFlight.startTime;
    sourceAssignment.endTime = sourceFlight.endTime;
    targetFlight.startTime = "22:10";
    targetFlight.endTime = "00:10";
    targetAssignment.startTime = targetFlight.startTime;
    targetAssignment.endTime = targetFlight.endTime;

    targetRule.qualifiedStaffIds = [];
    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [sourceAssignment],
        flight: targetFlight,
        rule: targetRule,
        person,
      }).violations[0]?.code
    ).toBe("position-qualification");

    targetRule.qualifiedStaffIds = [person.id];
    person.status = "休假";
    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [sourceAssignment],
        flight: targetFlight,
        rule: targetRule,
        person,
      }).violations[0]?.code
    ).toBe("staff-unavailable");

    person.status = "正常";
    person.nightShift = false;
    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [sourceAssignment],
        flight: targetFlight,
        rule: targetRule,
        person,
      }).violations[0]?.code
    ).toBe("night-shift");

    person.nightShift = true;
    state.settings.maxDailyHours = 3;
    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [sourceAssignment],
        flight: targetFlight,
        rule: targetRule,
        person,
      }).violations[0]?.code
    ).toBe("daily-hours");
  });

  it("uses one staged diagnosis for filtering and shortage evidence", () => {
    const state = createSchedulingScenario();
    const flight = state.flights.find((item) => item.flightNo === "TR121")!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "H02"
    )!;
    const base = state.staff[0]!;
    const staff = (id: string, overrides: Partial<Staff> = {}): Staff => ({
      ...base,
      id,
      name: id,
      status: "正常",
      staffType: "常规",
      nightShift: true,
      ...overrides,
    });
    const absent = staff("absent", { status: "休假" });
    const noNight = staff("no-night", { nightShift: false });
    const conflicted = staff("conflicted");
    const overHours = staff("over-hours");
    const available = staff("available");
    state.staff = [absent, noNight, conflicted, overHours, available];
    rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    state.settings.maxDailyHours = 8;
    const assignments: Assignment[] = [
      {
        id: "conflict",
        flightId: "other-night",
        flightNo: "F200",
        positionRuleId: null,
        position: "G01",
        staffId: conflicted.id,
        staffName: conflicted.name,
        startTime: "22:30",
        endTime: "23:30",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "hours",
        flightId: "other-day",
        flightNo: "F300",
        positionRuleId: null,
        position: "G02",
        staffId: overHours.id,
        staffName: overHours.name,
        startTime: "08:00",
        endTime: "16:00",
        workHours: 8,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const pool = analyzeAutomaticEligibilityPool({
      state,
      assignments,
      flight,
      rule,
    });

    expect(pool.configured).toHaveLength(5);
    expect(pool.available).toHaveLength(4);
    expect(pool.nightCapable).toHaveLength(3);
    expect(pool.conflictFree).toHaveLength(2);
    expect(pool.withinHours.map((person) => person.id)).toEqual([available.id]);
    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments,
        flight,
        rule,
        person: conflicted,
      }).violations.map((violation) => violation.code)
    ).toContain("time-conflict");
  });

  it("keeps the base qualification pool independent from current assignments and work-hour capacity", () => {
    const state = createSchedulingScenario();
    const person = state.staff.find(
      (item) => item.status === "正常" && item.nightShift
    )!;
    const flight = {
      ...state.flights[0]!,
      startTime: "08:00",
      endTime: "21:00",
    };
    const rule = {
      ...state.positionRules[0]!,
      flightNo: flight.flightNo,
      qualifiedStaffIds: [person.id],
    };
    state.staff = [person];
    state.settings.maxDailyHours = 8;

    expect(eligibleStaffForRule(state, flight, rule)).toEqual([person]);
    expect(
      analyzeAutomaticEligibilityPool({ state, assignments: [], flight, rule })
        .withinHours
    ).toEqual([]);
  });

  it("allows administrative fallback when the only regular worker fails the hard flight transition", () => {
    const state = createSchedulingScenario();
    const regular = {
      ...state.staff[0]!,
      id: "regular",
      name: "常规人员",
      staffType: "常规" as const,
    };
    const administrative = {
      ...state.staff[1]!,
      id: "administrative",
      name: "行政人员",
      staffType: "行政支援" as const,
    };
    const targetFlight = {
      ...state.flights[0]!,
      id: "target-flight",
      flightNo: "TARGET",
      startTime: "10:00",
      endTime: "11:00",
    };
    const futureFlight = {
      ...state.flights[0]!,
      id: "future-flight",
      flightNo: "FUTURE",
      startTime: "11:30",
      endTime: "12:30",
    };
    const targetRule = {
      ...state.positionRules[0]!,
      id: "target-rule",
      flightNo: targetFlight.flightNo,
      name: "MID",
      qualifiedStaffIds: [regular.id, administrative.id],
    };
    const futureRule = {
      ...state.positionRules[0]!,
      id: "future-rule",
      flightNo: futureFlight.flightNo,
      name: "LATE",
      qualifiedStaffIds: [regular.id],
    };
    const targetAssignment: Assignment = {
      id: "target-assignment",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: null,
      staffName: "",
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    };
    const futureAssignment: Assignment = {
      ...targetAssignment,
      id: "future-assignment",
      flightId: futureFlight.id,
      flightNo: futureFlight.flightNo,
      positionRuleId: futureRule.id,
      position: futureRule.name,
      staffId: regular.id,
      staffName: regular.name,
      startTime: futureFlight.startTime,
      endTime: futureFlight.endTime,
      status: "assigned",
    };
    state.settings.adminSupportEnabled = true;
    state.settings.positionTransitionPolicies = [
      {
        id: "target-before-future",
        name: "目标岗位到未来岗位的衔接",
        enabled: true,
        sourceFlightNo: targetFlight.flightNo,
        sourcePositions: [targetRule.name],
        targetFlightNo: futureFlight.flightNo,
        targetPosition: futureRule.name,
        minimumGapMinutes: 60,
        mode: "forbid",
      },
    ];
    state.staff = [regular, administrative];
    state.flights = [targetFlight, futureFlight];
    state.positionRules = [targetRule, futureRule];
    state.assignments = [targetAssignment, futureAssignment];

    expect(
      diagnoseAutomaticAssignmentEligibility({
        state,
        assignments: [futureAssignment],
        flight: targetFlight,
        rule: targetRule,
        person: regular,
        workHours: targetAssignment.workHours,
        transitionMode: "forbid",
      }).violations[0]?.code
    ).toBe("position-transition");
    expect(
      diagnoseManualAssignmentEligibility(
        state,
        targetAssignment.id,
        administrative.id
      ).violations[0]?.code
    ).toBeUndefined();
  });
});
