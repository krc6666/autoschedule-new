import { describe, expect, it } from "vitest";

import type { Assignment, PositionRule } from "../../src/model";
import { createOrdinarySchedulingState } from "../helpers/scheduling-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { assignMobileSupervisorByCounterCoverage } from "../../src/domain/assignments/ke166-assignment";
import { finalizeMobileSupervisors } from "../../src/domain/assignments/ke166-supervisor-finalizer";
import { createMobileSupervisorCoverageScheduleGuard } from "../../src/domain/kernel/schedule-guard";
import { createScheduleLedger } from "../../src/domain/kernel/schedule-ledger";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { evaluateSupervisorFillFacts } from "../../src/domain/coverage/supervisor-fill-facts";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import {
  buildCurrentScheduleFlightCandidates,
  materializeCurrentScheduleFlights,
} from "../../src/domain/flights/next-workday-flight-plan";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";
import {
  fillConfiguredSupervisorTargets,
  prepareConfiguredSupervisorFillUnderShortage,
} from "../../src/domain/assignments/supervisor-fill";

const DATE = "2026-09-23";

function singleFlightState() {
  const state = createOrdinarySchedulingState();
  state.staff = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 3);
  state.staff.forEach((person) => {
    person.dutyQualified = false;
    person.nightShift = true;
  });
  state.flights = [
    {
      id: "cx931",
      flightNo: "CX931",
      startTime: "21:00",
      endTime: "23:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  state.history = [];
  state.assignments = [];
  state.dutyRosterOverrides = [
    {
      date: DATE,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.workloadBalanceEnabled = false;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.positionTransitionPolicies = [];
  state.settings.ordinaryPriorityPositions = [];
  return state;
}

function rules(
  base: PositionRule,
  supervisorIds: string[],
  counterIds: string[],
  counterRemark = ""
): PositionRule[] {
  return [
    {
      ...base,
      id: "cx931-supervisor",
      flightNo: "CX931",
      name: "督导",
      category: "机动督导",
      remark: "",
      minPassengers: 0,
      fatiguePoints: 5,
      qualifiedStaffIds: supervisorIds,
    },
    {
      ...base,
      id: "cx931-counter",
      flightNo: "CX931",
      name: "G09",
      category: "常规",
      remark: counterRemark,
      minPassengers: 0,
      fatiguePoints: 7,
      qualifiedStaffIds: counterIds,
    },
  ];
}

describe("all-flight mobile-supervisor scheduling", { timeout: 15_000 }, () => {
  function configuredSupervisorFillState(includeRegularCandidate: boolean) {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const regular = state.staff[1]!;
    state.staff = includeRegularCandidate
      ? [supervisor, regular]
      : [supervisor];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "21:00",
        endTime: "23:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "机动督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        qualifiedStaffIds: includeRegularCandidate ? [regular.id] : [],
        fatiguePoints: 7,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "机动督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    return { state, supervisor, regular };
  }

  it("uses a renamed flight through preparation, final supervisor fill, safety credential and export", async () => {
    const { state, supervisor } = configuredSupervisorFillState(false);
    const flight = state.flights[0]!;
    flight.flightNo = "TWB616";
    state.templates = [{ ...flight, id: "renamed-template" }];
    state.positionRules.forEach((rule) => {
      rule.flightNo = "TWB616";
    });
    const fill = state.settings.mobileSupervisorFillRules[0]!;
    fill.sourceFlightNo = fill.targetFlightNo = "TWB616";
    expect(
      updateConfigurationField(
        state,
        "template",
        "renamed-template",
        "flightNo",
        "TW616"
      )
    ).toBe("updated");
    const choices = buildCurrentScheduleFlightCandidates(
      state.templates,
      state.flights
    );
    state.flights = materializeCurrentScheduleFlights(
      choices,
      choices.filter((item) => item.selectedByDefault).map((item) => item.id)
    );
    const result = await generateSchedule(state, DATE);
    expect(result.assignments).toHaveLength(2);
    expect(
      result.assignments.every((assignment) => assignment.flightNo === "TW616")
    ).toBe(true);
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const target = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;
    expect(target).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: fill.id,
      workHours: 0,
      fatiguePoints: 0,
    });
    expect(result.safetyCredential).toBeDefined();
    state.assignments = result.assignments;
    const exported = JSON.stringify(buildScheduleWorkbook(state, DATE).Sheets);
    expect(exported).toContain("TW616");
    expect(exported).not.toContain("TWB616");
  });

  it("fills a configured supervisor-fill target only when no safe regular candidate exists", async () => {
    const { state, supervisor } = configuredSupervisorFillState(false);

    const result = await generateSchedule(state, DATE);
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const target = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;

    expect(source).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      workHours: 2,
    });
    expect(target).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      workHours: 0,
      fatiguePoints: 0,
      supervisorSourceAssignmentId: source.id,
    });
    expect(
      result.assignments.reduce(
        (total, assignment) => total + assignment.fatiguePoints,
        0
      )
    ).toBe(5);
  });

  it("when short-staffed, binds KE166 supervisor to the configured fill counter instead of another concurrent counter", async () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const regular = state.staff[1]!;
    state.staff = [supervisor, regular];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id, regular.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, regular.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id, regular.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    const result = await generateSchedule(state, DATE);
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const h03 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h03"
    )!;
    const h05 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;

    const snapshot = result.assignments.map((assignment) => ({
      position: assignment.position,
      staffId: assignment.staffId,
      source: assignment.supervisorSourceAssignmentId ?? null,
      fill: assignment.supervisorFillRuleId ?? null,
      hours: assignment.workHours,
    }));

    expect(source.staffId, JSON.stringify(snapshot)).toBe(supervisor.id);
    expect(h05, JSON.stringify(snapshot)).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "ke166-h05-fill",
    });
    expect(h03.staffId, JSON.stringify(snapshot)).not.toBe(supervisor.id);
    expect(h03.staffId, JSON.stringify(snapshot)).toBe(regular.id);
  });

  it("when short-staffed, does not dump an unqualified H05 person onto another counter", () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const h05Only = state.staff[1]!;
    const h03Capable = state.staff[2]!;
    state.staff = [supervisor, h05Only, h03Capable];
    h03Capable.teamLeader = true;
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h03Capable.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id, h05Only.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: h05Only.id,
      staffName: h05Only.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "申报",
      manualRemark: "",
      status: "assigned",
    };
    const assignments = [h03, h05];

    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic"
    );

    expect(chosen?.id).toBe(supervisor.id);
    expect(h05.staffId).toBeNull();
    expect(h03.staffId).toBe(h03Capable.id);
    expect(h03.staffId).not.toBe(h05Only.id);

    const source: Assignment = {
      id: "a-supervisor",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-supervisor",
      position: "督导",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 4,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    fillConfiguredSupervisorTargets(
      state,
      [...assignments, source],
      source,
      "automatic",
      { ignoreSafeRegularCandidate: true }
    );
    expect(h05).toMatchObject({
      staffId: supervisor.id,
      supervisorFillRuleId: "ke166-h05-fill",
      supervisorSourceAssignmentId: source.id,
      workHours: 0,
    });
  });

  it("when short-staffed on many counters, frees H07 for a qualified refill and binds supervisor fill on H05", () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const h05Occupant = state.staff[1]!;
    const h07Capable = state.staff[2]!;
    state.staff = [supervisor, h05Occupant, h07Capable];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h05Occupant.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-h07",
        flightNo: "KE166",
        name: "H07",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h07Capable.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const h07: Assignment = {
      id: "a-h07",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h07",
      position: "H07",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: h05Occupant.id,
      staffName: h05Occupant.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const assignments = [h07, h05];
    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic"
    );
    expect(chosen?.id).toBe(supervisor.id);
    expect(h07.staffId).toBe(h07Capable.id);
    expect(h05.staffId).toBeNull();
    expect(h07.staffId).not.toBe(supervisor.id);

    const source: Assignment = {
      id: "a-supervisor",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-supervisor",
      position: "督导",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 4,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    fillConfiguredSupervisorTargets(
      state,
      [...assignments, source],
      source,
      "automatic",
      { ignoreSafeRegularCandidate: true }
    );
    expect(h05).toMatchObject({
      staffId: supervisor.id,
      supervisorFillRuleId: "ke166-h05-fill",
      workHours: 0,
    });
  });

  it("refuses refill candidates blocked by half-rest isStaffAllowed during shortage prepare", () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const blocked = state.staff[1]!;
    const allowed = state.staff[2]!;
    state.staff = [supervisor, blocked, allowed];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [blocked.id, allowed.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: null,
      staffName: "",
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    };
    const assignments = [h03, h05];
    const supervisorRule = state.positionRules[0]!;
    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic",
      (staffId) => staffId !== blocked.id
    );
    expect(chosen?.id).toBe(supervisor.id);
    expect(h03.staffId).toBe(allowed.id);
    expect(h03.staffId).not.toBe(blocked.id);
  });

  it("generateSchedule keeps H05 with safe regular when an independent supervisor candidate exists", async () => {
    // 合同裁决：独立督导有合法候选 = 人手够，不得为补位抢 H05。
    // S/A/B 三人、两柜台时常见结果是 S 空闲上督、H05=A；这不是短员腾挪路径。
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const h05Only = state.staff[1]!;
    const h03Capable = state.staff[2]!;
    state.staff = [supervisor, h05Only, h03Capable];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h03Capable.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id, h05Only.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    const result = await generateSchedule(state, DATE);
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const h05 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;
    const snapshot = result.assignments.map((assignment) => ({
      position: assignment.position,
      staffId: assignment.staffId,
      source: assignment.supervisorSourceAssignmentId ?? null,
      fill: assignment.supervisorFillRuleId ?? null,
    }));
    expect(source.staffId, JSON.stringify(snapshot)).toBe(supervisor.id);
    expect(h05.staffId, JSON.stringify(snapshot)).toBe(h05Only.id);
    expect(h05.supervisorSourceAssignmentId).toBeUndefined();
    expect(h05.supervisorFillRuleId).toBeUndefined();
  });

  it("generateSchedule prioritizes configured H05 fill before repeated KE166 counter reuse", async () => {
    // 连续督导释放分支也必须先走配置补位；否则旧兼任逻辑会把 S 放到 H03，H05 仍由 A 承担。
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const h05Only = state.staff[1]!;
    const h03Capable = state.staff[2]!;
    state.staff = [supervisor, h05Only, h03Capable];
    state.settings.positionRotationEnabled = true;
    state.flights = [
      {
        id: "early",
        flightNo: "CX937",
        startTime: "06:00",
        endTime: "08:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "early-g09",
        flightNo: "CX937",
        name: "G09",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h03Capable.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [h05Only.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    state.history = [
      {
        id: "previous-ke166-supervisor",
        date: "2026-09-22",
        flightNo: "KE166",
        position: "督导",
        staffId: supervisor.id,
        staffName: supervisor.name,
        startTime: "09:15",
        endTime: "11:15",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, DATE);
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const h03 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h03"
    )!;
    const h05 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;
    const snapshot = result.assignments.map((assignment) => ({
      position: assignment.position,
      staffId: assignment.staffId,
      source: assignment.supervisorSourceAssignmentId ?? null,
      fill: assignment.supervisorFillRuleId ?? null,
    }));
    expect(source.staffId, JSON.stringify(snapshot)).toBe(supervisor.id);
    expect(h05, JSON.stringify(snapshot)).toMatchObject({
      staffId: supervisor.id,
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "ke166-h05-fill",
    });
    expect(h03.staffId, JSON.stringify(snapshot)).toBe(h03Capable.id);
    expect(h03.staffId, JSON.stringify(snapshot)).not.toBe(h05Only.id);
  });

  it("uses a legal same-flight counter chain before falling back from configured H05 fill", async () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const h02Only = state.staff[1]!;
    const h05Only = state.staff[2]!;
    const h03AndH06 = {
      ...h05Only,
      id: "h03-h06-worker",
      name: "H03H06人员",
    };
    const h07GuideWorker = {
      ...h05Only,
      id: "h07-guide-worker",
      name: "H07引导复用人员",
    };
    state.staff = [supervisor, h02Only, h05Only, h03AndH06, h07GuideWorker];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h02",
        flightNo: "KE166",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [h02Only.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h03AndH06.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "",
        qualifiedStaffIds: [supervisor.id, h05Only.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        remark: "申报",
        qualifiedStaffIds: [h05Only.id, h03AndH06.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-h07",
        flightNo: "KE166",
        name: "H07",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [h07GuideWorker.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-guide",
        flightNo: "KE166",
        name: "柜台引导",
        category: "引导",
        remark: "",
        qualifiedStaffIds: [h07GuideWorker.id],
        fatiguePoints: 0,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    state.history = [
      {
        id: "previous-ke166-supervisor",
        date: "2026-09-22",
        flightNo: "KE166",
        position: "督导",
        staffId: supervisor.id,
        staffName: supervisor.name,
        startTime: "09:15",
        endTime: "11:15",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
      },
    ];
    const assignment = (
      id: string,
      ruleId: string,
      position: string,
      person: typeof supervisor
    ): Assignment => ({
      id,
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: ruleId,
      position,
      staffId: person.id,
      staffName: person.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
      manualRemark: "",
      status: "assigned",
    });
    const assignments = [
      assignment("h02", "ke166-h02", "H02", h02Only),
      assignment("h03", "ke166-h03", "H03", supervisor),
      assignment("h05", "ke166-h05", "H05", h05Only),
      assignment("h06", "ke166-h06", "H06", h03AndH06),
      assignment("h07", "ke166-h07", "H07", h07GuideWorker),
      {
        ...assignment("guide", "ke166-guide", "柜台引导", h07GuideWorker),
        workHours: 0,
        fatiguePoints: 0,
      },
    ];

    const result = await finalizeMobileSupervisors({
      solver: defaultHighsSolver,
      state,
      date: DATE,
      assignments,
      preparation: prepareSchedule(
        state,
        DATE,
        evaluateAutomaticHardConstraints
      ),
      lockedAssignmentIds: new Set(),
    });
    const source = result.find(
      (item) => item.positionRuleId === "ke166-supervisor"
    )!;
    const h03 = result.find((item) => item.id === "h03")!;
    const h05 = result.find((item) => item.id === "h05")!;
    const h06 = result.find((item) => item.id === "h06")!;
    const snapshot = result.map((item) => ({
      position: item.position,
      staffId: item.staffId,
      source: item.supervisorSourceAssignmentId ?? null,
      fill: item.supervisorFillRuleId ?? null,
    }));

    expect(h05, JSON.stringify(snapshot)).toMatchObject({
      staffId: supervisor.id,
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "ke166-h05-fill",
    });
    expect(h03.staffId, JSON.stringify(snapshot)).toBe(h03AndH06.id);
    expect(h06.staffId, JSON.stringify(snapshot)).toBe(h05Only.id);
  });

  it("generateSchedule short-staff with only counter-bound staff frees H05 for supervisor fill", async () => {
    // 两人两柜台：无人可独立空闲督导 → 进入短员 prepare；覆盖完整 generateSchedule 链路。
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const regular = state.staff[1]!;
    state.staff = [supervisor, regular];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id, regular.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, regular.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id, regular.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    const result = await generateSchedule(state, DATE);
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const h03 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h03"
    )!;
    const h05 = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;
    const snapshot = result.assignments.map((assignment) => ({
      position: assignment.position,
      staffId: assignment.staffId,
      source: assignment.supervisorSourceAssignmentId ?? null,
      fill: assignment.supervisorFillRuleId ?? null,
    }));

    expect(source.staffId, JSON.stringify(snapshot)).toBeTruthy();
    expect(h05, JSON.stringify(snapshot)).toMatchObject({
      staffId: source.staffId,
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "ke166-h05-fill",
    });
    expect(h03.staffId, JSON.stringify(snapshot)).not.toBe(source.staffId);
  });

  it("prepare rejects a source supervisor blocked by cross-flight time conflict and restores", () => {
    const state = singleFlightState();
    const blocked = state.staff[0]!;
    const freeSupervisor = state.staff[1]!;
    const refill = state.staff[2]!;
    state.staff = [blocked, freeSupervisor, refill];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "other",
        flightNo: "CX937",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [blocked.id, freeSupervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [blocked.id, freeSupervisor.id, refill.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [blocked.id, freeSupervisor.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "other-g18",
        flightNo: "CX937",
        name: "G18",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [blocked.id],
        fatiguePoints: 3,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const other: Assignment = {
      id: "a-other",
      flightId: "other",
      flightNo: "CX937",
      positionRuleId: "other-g18",
      position: "G18",
      staffId: blocked.id,
      staffName: blocked.name,
      startTime: "09:00",
      endTime: "11:00",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
      decisionEvidence: {
        scheduleRunId: "run-keep",
        ruleFingerprint: "fp-keep",
      },
      teamLeaderGapFill: true,
    };
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: freeSupervisor.id,
      staffName: freeSupervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: blocked.id,
      staffName: blocked.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "申报",
      manualRemark: "",
      status: "assigned",
    };
    // Intentionally leave H05 occupied by blocked (also on CX937) is wrong —
    // blocked is on other; H05 should be occupied by someone else for prepare to free.
    h05.staffId = refill.id;
    h05.staffName = refill.name;
    const assignments = [other, h03, h05];
    const before = structuredClone(assignments);

    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic"
    );

    expect(chosen?.id).toBe(freeSupervisor.id);
    expect(chosen?.id).not.toBe(blocked.id);
    expect(h05.staffId).toBeNull();
    expect(h03.staffId).toBe(refill.id);
    expect(other).toMatchObject({
      staffId: blocked.id,
      decisionEvidence: before[0]!.decisionEvidence,
      teamLeaderGapFill: true,
    });
  });

  it("prepare leaves manual-status and below-threshold counters untouched", () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const refill = state.staff[1]!;
    const parked = state.staff[2]!;
    state.staff = [supervisor, refill, parked];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 50,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [supervisor.id, refill.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-h08",
        flightNo: "KE166",
        name: "H08",
        category: "常规",
        coverageRole: "none",
        remark: "",
        minPassengers: 200,
        qualifiedStaffIds: [parked.id, refill.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h09",
        flightNo: "KE166",
        name: "H09",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [parked.id, refill.id],
        fatiguePoints: 3,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: refill.id,
      staffName: refill.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "申报",
      manualRemark: "",
      status: "assigned",
    };
    const lowPassenger: Assignment = {
      id: "a-h08",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h08",
      position: "H08",
      staffId: null,
      staffName: "",
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    };
    const manualSlot: Assignment = {
      id: "a-h09",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h09",
      position: "H09",
      staffId: null,
      staffName: "",
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "人工锁定",
      status: "manual",
      decisionEvidence: {
        scheduleRunId: "manual-run",
        ruleFingerprint: "manual-fp",
      },
    };
    const assignments = [h03, h05, lowPassenger, manualSlot];

    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic"
    );

    expect(chosen?.id).toBe(supervisor.id);
    expect(h05.staffId).toBeNull();
    expect(h03.staffId).toBe(refill.id);
    expect(lowPassenger.staffId).toBeNull();
    expect(manualSlot).toMatchObject({
      staffId: null,
      staffName: "",
      status: "manual",
      manualRemark: "人工锁定",
      decisionEvidence: {
        scheduleRunId: "manual-run",
        ruleFingerprint: "manual-fp",
      },
    });
  });

  it("prepare rejects a source supervisor blocked only by minimum flight transition and restores", () => {
    const state = singleFlightState();
    const tightGap = state.staff[0]!;
    const freeSupervisor = state.staff[1]!;
    const refill = state.staff[2]!;
    state.staff = [tightGap, freeSupervisor, refill];
    state.settings.minimumRegularTransitionMinutes = 90;
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "early",
        flightNo: "CX937",
        startTime: "06:45",
        endTime: "08:45",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [tightGap.id, freeSupervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [tightGap.id, freeSupervisor.id, refill.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [tightGap.id, freeSupervisor.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "early-g18",
        flightNo: "CX937",
        name: "G18",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [tightGap.id],
        fatiguePoints: 3,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    // 08:45→09:15 间隔 30 分钟，小于 90；与 KE166 无时段重叠。
    const early: Assignment = {
      id: "a-early",
      flightId: "early",
      flightNo: "CX937",
      positionRuleId: "early-g18",
      position: "G18",
      staffId: tightGap.id,
      staffName: tightGap.name,
      startTime: "06:45",
      endTime: "08:45",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
      decisionEvidence: {
        scheduleRunId: "gap-run",
        ruleFingerprint: "gap-fp",
      },
    };
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: freeSupervisor.id,
      staffName: freeSupervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: refill.id,
      staffName: refill.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "申报",
      manualRemark: "",
      status: "assigned",
    };
    const assignments = [early, h03, h05];

    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic"
    );

    expect(chosen?.id).toBe(freeSupervisor.id);
    expect(chosen?.id).not.toBe(tightGap.id);
    expect(early).toMatchObject({
      staffId: tightGap.id,
      decisionEvidence: {
        scheduleRunId: "gap-run",
        ruleFingerprint: "gap-fp",
      },
    });
  });

  it("finalizeMobileSupervisors passes real halfRest facts so banned refill stays off counters", async () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const halfRestBlocked = state.staff[1]!;
    const allowedRefill = state.staff[2]!;
    // Need a fourth person to hold H05 initially.
    const h05Holder = {
      ...allowedRefill,
      id: "h05-holder",
      name: "H05占位",
    };
    state.staff = [supervisor, halfRestBlocked, allowedRefill, h05Holder];
    state.staff.forEach((person) => {
      person.teamLeader = false;
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [
          supervisor.id,
          halfRestBlocked.id,
          allowedRefill.id,
        ],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id, h05Holder.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const preferences = {
      halfRestStaffIds: [halfRestBlocked.id],
      halfRestModes: { [halfRestBlocked.id]: "late-start" as const },
    };
    const preparation = prepareSchedule(
      state,
      DATE,
      evaluateAutomaticHardConstraints,
      preferences
    );
    expect(
      preparation.runFacts.halfRest.activeStaffIds.has(halfRestBlocked.id)
    ).toBe(true);

    const assignments: Assignment[] = [
      {
        id: "a-h03",
        flightId: "ke166",
        flightNo: "KE166",
        positionRuleId: "ke166-h03",
        position: "H03",
        staffId: supervisor.id,
        staffName: supervisor.name,
        startTime: "09:15",
        endTime: "11:15",
        workHours: 2,
        fatiguePoints: 3,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "a-h05",
        flightId: "ke166",
        flightNo: "KE166",
        positionRuleId: "ke166-h05",
        position: "H05",
        staffId: h05Holder.id,
        staffName: h05Holder.name,
        startTime: "09:15",
        endTime: "11:15",
        workHours: 2,
        fatiguePoints: 2,
        remark: "申报",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const result = await finalizeMobileSupervisors({
      solver: defaultHighsSolver,
      state,
      date: DATE,
      assignments,
      preparation,
      lockedAssignmentIds: new Set(),
    });

    const source = result.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    const h03 = result.find(
      (assignment) => assignment.positionRuleId === "ke166-h03"
    )!;
    const h05 = result.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;
    const snapshot = result.map((assignment) => ({
      position: assignment.position,
      staffId: assignment.staffId,
      source: assignment.supervisorSourceAssignmentId ?? null,
      fill: assignment.supervisorFillRuleId ?? null,
    }));

    expect(source.staffId, JSON.stringify(snapshot)).toBe(supervisor.id);
    expect(h05, JSON.stringify(snapshot)).toMatchObject({
      staffId: supervisor.id,
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "ke166-h05-fill",
    });
    expect(h03.staffId, JSON.stringify(snapshot)).toBe(allowedRefill.id);
    expect(h03.staffId, JSON.stringify(snapshot)).not.toBe(halfRestBlocked.id);
  });

  it("prepare failure restores state and records the generic-coverage fallback reason", async () => {
    const state = singleFlightState();
    const supervisor = state.staff[0]!;
    const other = state.staff[1]!;
    state.staff = [supervisor, other];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        // No one can legally take H03 after supervisor is cleared → prepare must fail.
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [supervisor.id, other.id],
        fatiguePoints: 2,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
      decisionTrace: [
        schedulingDecision("mobile-supervisor", "selected", "keep-me"),
      ],
      systemNotes: ["note-keep"],
      decisionEvidence: {
        scheduleRunId: "run-1",
        ruleFingerprint: "fp-1",
      },
      teamLeaderGapFill: true,
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: other.id,
      staffName: other.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "申报",
      manualRemark: "",
      status: "assigned",
    };
    const assignments = [h03, h05];
    const before = structuredClone(assignments);
    let failureReason = "";

    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic",
      undefined,
      (reason) => {
        failureReason = reason;
      }
    );

    expect(chosen).toBeNull();
    expect(assignments).toEqual(before);
    expect(failureReason).toContain("其他普通柜台没有合法替补");

    const preparation = prepareSchedule(
      state,
      DATE,
      evaluateAutomaticHardConstraints
    );
    const finalized = await finalizeMobileSupervisors({
      solver: defaultHighsSolver,
      state,
      date: DATE,
      assignments,
      preparation,
      lockedAssignmentIds: new Set(),
    });
    const source = finalized.find(
      (assignment) => assignment.positionRuleId === "ke166-supervisor"
    )!;
    expect(
      source.decisionTrace?.some(
        (decision) =>
          decision.outcome === "fallback" &&
          decision.message.includes("其他普通柜台没有合法替补")
      )
    ).toBe(true);
  });

  it("rejects orphan supervisorFillRuleId without a source link", () => {
    const state = singleFlightState();
    const worker = state.staff[0]!;
    state.staff = [worker];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "CX931",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [worker.id],
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "CX931",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "",
        qualifiedStaffIds: [worker.id],
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "fill-rule",
        enabled: true,
        sourceFlightNo: "CX931",
        sourcePositionKeyword: "督导",
        targetFlightNo: "CX931",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const runFacts = createScheduleRunFacts(state, DATE);
    const ledger = createScheduleLedger([], {
      safetySession: createScheduleSafetySession({
        phase: "final",
        state,
        date: DATE,
        runFacts,
        guards: [createMobileSupervisorCoverageScheduleGuard()],
      }),
    });
    expect(() =>
      ledger.commit({
        type: "replace",
        assignments: [
          {
            id: "orphan-fill",
            flightId: "cx931",
            flightNo: "CX931",
            positionRuleId: "ke166-h05",
            position: "H05",
            staffId: worker.id,
            staffName: worker.name,
            startTime: "21:00",
            endTime: "23:00",
            workHours: 0,
            fatiguePoints: 0,
            remark: "",
            manualRemark: "",
            status: "assigned",
            supervisorFillRuleId: "fill-rule",
          },
        ],
      })
    ).toThrow(/督导补位关联缺少来源/);
  });

  it("rejects supervisor-fill whose source assignment id does not exist", () => {
    const state = singleFlightState();
    const worker = state.staff[0]!;
    state.staff = [worker];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "CX931",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [worker.id],
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "CX931",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "",
        qualifiedStaffIds: [worker.id],
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "fill-rule",
        enabled: true,
        sourceFlightNo: "CX931",
        sourcePositionKeyword: "督导",
        targetFlightNo: "CX931",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const runFacts = createScheduleRunFacts(state, DATE);
    const ledger = createScheduleLedger([], {
      safetySession: createScheduleSafetySession({
        phase: "final",
        state,
        date: DATE,
        runFacts,
        guards: [createMobileSupervisorCoverageScheduleGuard()],
      }),
    });
    expect(() =>
      ledger.commit({
        type: "replace",
        assignments: [
          {
            id: "dangling-fill",
            flightId: "cx931",
            flightNo: "CX931",
            positionRuleId: "ke166-h05",
            position: "H05",
            staffId: worker.id,
            staffName: worker.name,
            startTime: "21:00",
            endTime: "23:00",
            workHours: 0,
            fatiguePoints: 0,
            remark: "",
            manualRemark: "",
            status: "assigned",
            supervisorSourceAssignmentId: "missing-supervisor",
            supervisorFillRuleId: "fill-rule",
          },
        ],
      })
    ).toThrow(/督导补位关联无效/);
  });

  it("rejects supervisor-fill whose fill rule id does not match a valid recorded link", () => {
    const state = singleFlightState();
    const worker = state.staff[0]!;
    state.staff = [worker];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "CX931",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [worker.id],
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "CX931",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "",
        qualifiedStaffIds: [worker.id],
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "fill-rule",
        enabled: true,
        sourceFlightNo: "CX931",
        sourcePositionKeyword: "督导",
        targetFlightNo: "CX931",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const runFacts = createScheduleRunFacts(state, DATE);
    const ledger = createScheduleLedger([], {
      safetySession: createScheduleSafetySession({
        phase: "final",
        state,
        date: DATE,
        runFacts,
        guards: [createMobileSupervisorCoverageScheduleGuard()],
      }),
    });
    expect(() =>
      ledger.commit({
        type: "replace",
        assignments: [
          {
            id: "src",
            flightId: "cx931",
            flightNo: "CX931",
            positionRuleId: "ke166-supervisor",
            position: "督导",
            staffId: worker.id,
            staffName: worker.name,
            startTime: "21:00",
            endTime: "23:00",
            workHours: 2,
            fatiguePoints: 5,
            remark: "",
            manualRemark: "",
            status: "assigned",
          },
          {
            id: "bad-rule-fill",
            flightId: "cx931",
            flightNo: "CX931",
            positionRuleId: "ke166-h05",
            position: "H05",
            staffId: worker.id,
            staffName: worker.name,
            startTime: "21:00",
            endTime: "23:00",
            workHours: 0,
            fatiguePoints: 0,
            remark: "",
            manualRemark: "",
            status: "assigned",
            supervisorSourceAssignmentId: "src",
            supervisorFillRuleId: "wrong-rule-id",
          },
        ],
      })
    ).toThrow(/督导补位关联无效/);
  });

  it("prepare rejects a source supervisor who would exceed daily hours and restores", () => {
    const state = singleFlightState();
    const overloaded = state.staff[0]!;
    const freeSupervisor = state.staff[1]!;
    const refill = state.staff[2]!;
    state.staff = [overloaded, freeSupervisor, refill];
    state.settings.maxDailyHours = 2;
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:15",
        endTime: "11:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "early",
        flightNo: "CX937",
        startTime: "06:00",
        endTime: "08:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        remark: "",
        qualifiedStaffIds: [overloaded.id, freeSupervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        coverageRole: "none",
        remark: "",
        qualifiedStaffIds: [overloaded.id, freeSupervisor.id, refill.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke166-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        coverageRole: "supervisor-fill",
        remark: "申报",
        qualifiedStaffIds: [overloaded.id, freeSupervisor.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "early-g18",
        flightNo: "CX937",
        name: "G18",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [overloaded.id],
        fatiguePoints: 3,
      },
    ];
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const supervisorRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const early: Assignment = {
      id: "a-early",
      flightId: "early",
      flightNo: "CX937",
      positionRuleId: "early-g18",
      position: "G18",
      staffId: overloaded.id,
      staffName: overloaded.name,
      startTime: "06:00",
      endTime: "08:00",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
      decisionEvidence: {
        scheduleRunId: "keep-run",
        ruleFingerprint: "keep-fp",
      },
    };
    const h03: Assignment = {
      id: "a-h03",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h03",
      position: "H03",
      staffId: freeSupervisor.id,
      staffName: freeSupervisor.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const h05: Assignment = {
      id: "a-h05",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: "ke166-h05",
      position: "H05",
      staffId: refill.id,
      staffName: refill.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "申报",
      manualRemark: "",
      status: "assigned",
    };
    const assignments = [early, h03, h05];

    const chosen = prepareConfiguredSupervisorFillUnderShortage(
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      new Set(),
      "automatic"
    );

    expect(chosen?.id).toBe(freeSupervisor.id);
    expect(chosen?.id).not.toBe(overloaded.id);
    expect(early).toMatchObject({
      staffId: overloaded.id,
      decisionEvidence: {
        scheduleRunId: "keep-run",
        ruleFingerprint: "keep-fp",
      },
    });
  });

  it("keeps a configured supervisor-fill target with its safe regular worker", async () => {
    const { state, regular } = configuredSupervisorFillState(true);

    const result = await generateSchedule(state, DATE);
    const target = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;

    expect(target).toMatchObject({
      staffId: regular.id,
      status: "assigned",
      workHours: 2,
    });
    expect(target.supervisorSourceAssignmentId).toBeUndefined();
  });

  it("does not fill an unconfigured empty counter", async () => {
    const { state } = configuredSupervisorFillState(false);
    state.settings.mobileSupervisorFillRules = [];

    const result = await generateSchedule(state, DATE);
    const target = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;

    expect(target).toMatchObject({ staffId: null, status: "unfilled" });
    expect(target.supervisorSourceAssignmentId).toBeUndefined();
  });

  it("treats a same-flight exclusion as making the regular candidate unsafe", () => {
    const { state, supervisor, regular } = configuredSupervisorFillState(true);
    state.settings.sameFlightStaffExclusions = [
      {
        id: "supervisor-regular-exclusion",
        enabled: true,
        firstStaffId: supervisor.id,
        secondStaffId: regular.id,
        flightNo: "KE166",
      },
    ];

    const sourceRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const targetRule = state.positionRules.find(
      (rule) => rule.id === "ke166-h05"
    )!;
    const source: Assignment = {
      id: "supervisor-assignment",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: "21:00",
      endTime: "23:00",
      workHours: 2,
      fatiguePoints: sourceRule.fatiguePoints,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const target: Assignment = {
      ...source,
      id: "target-assignment",
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: null,
      staffName: "",
      workHours: 2,
      fatiguePoints: targetRule.fatiguePoints,
      status: "unfilled",
    };

    expect(
      evaluateSupervisorFillFacts(
        state,
        [source, target],
        source,
        target,
        "automatic"
      )
    ).toMatchObject({ allowed: true, hasSafeRegularCandidate: false });
  });

  it("keeps an overlapping cross-flight supervisor-fill target unfilled", async () => {
    const { state } = configuredSupervisorFillState(false);
    state.flights.push({
      id: "target-flight",
      flightNo: "TR121",
      startTime: "21:00",
      endTime: "23:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    });
    const targetRule = state.positionRules.find(
      (rule) => rule.id === "ke166-h05"
    )!;
    targetRule.flightNo = "TR121";
    state.settings.mobileSupervisorFillRules[0]!.targetFlightNo = "TR121";

    const result = await generateSchedule(state, DATE);
    const target = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ke166-h05"
    )!;

    expect(target).toMatchObject({ staffId: null, status: "unfilled" });
    expect(target.supervisorSourceAssignmentId).toBeUndefined();
    expect(result.warnings).toContain("TR121 / H05 无可用人员");
  });

  it("ignores a legal guide display when a cross-flight supervisor fill starts after release", () => {
    const { state, supervisor } = configuredSupervisorFillState(false);
    const sourceFlight = state.flights.find((flight) => flight.id === "ke166")!;
    const targetFlight = {
      ...sourceFlight,
      id: "target-flight",
      flightNo: "TR121",
      startTime: "22:00",
      endTime: "23:30",
    };
    state.flights.push(targetFlight);
    const sourceRule = state.positionRules.find(
      (rule) => rule.id === "ke166-supervisor"
    )!;
    const targetRule = state.positionRules.find(
      (rule) => rule.id === "ke166-h05"
    )!;
    targetRule.flightNo = targetFlight.flightNo;
    state.settings.mobileSupervisorFillRules[0]!.targetFlightNo =
      targetFlight.flightNo;
    const guideRule: PositionRule = {
      ...targetRule,
      id: "ke166-guide",
      flightNo: sourceFlight.flightNo,
      name: "柜台引导",
      category: "引导",
      coverageRole: "none",
      qualifiedStaffIds: [],
    };
    state.positionRules.push(guideRule);
    const source: Assignment = {
      id: "released-supervisor",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: supervisor.id,
      staffName: supervisor.name,
      startTime: sourceFlight.startTime,
      endTime: "21:30",
      workHours: 0.5,
      fatiguePoints: sourceRule.fatiguePoints,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const guide: Assignment = {
      ...source,
      id: "ke166-guide-assignment",
      positionRuleId: guideRule.id,
      position: guideRule.name,
      endTime: sourceFlight.endTime,
      workHours: 0,
      fatiguePoints: 0,
    };
    const target: Assignment = {
      ...source,
      id: "tr121-h05",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      staffId: null,
      staffName: "",
      workHours: 1.5,
      fatiguePoints: targetRule.fatiguePoints,
      status: "unfilled",
    };

    expect(
      evaluateSupervisorFillFacts(
        state,
        [source, guide, target],
        source,
        target,
        "manual",
        { ignoreSafeRegularCandidate: true }
      )
    ).toMatchObject({ allowed: true });
  });

  it("automatically binds a non-KE166 supervisor to an allowed counter when staffing is short", async () => {
    const state = singleFlightState();
    const worker = state.staff[0]!;
    state.staff = [worker];
    state.positionRules = rules(
      state.positionRules[0]!,
      [worker.id],
      [worker.id]
    );

    const result = await generateSchedule(state, DATE);
    const supervisor = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-supervisor"
    )!;
    const counter = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-counter"
    )!;

    expect(supervisor).toMatchObject({
      staffId: worker.id,
      status: "assigned",
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(counter).toMatchObject({
      staffId: worker.id,
      status: "assigned",
      workHours: 0,
      fatiguePoints: 7,
      supervisorSourceAssignmentId: supervisor.id,
    });
    expect(
      result.assignments.reduce((total, assignment) => {
        return total + assignment.workHours;
      }, 0)
    ).toBe(2);
    expect(
      result.assignments.reduce((total, assignment) => {
        return total + assignment.fatiguePoints;
      }, 0)
    ).toBe(12);
  });

  it("keeps a non-KE166 supervisor independent when an idle candidate exists", async () => {
    const state = singleFlightState();
    const counterWorker = state.staff[0]!;
    const independentSupervisor = state.staff[1]!;
    state.staff = [counterWorker, independentSupervisor];
    state.positionRules = rules(
      state.positionRules[0]!,
      [counterWorker.id, independentSupervisor.id],
      [counterWorker.id]
    );

    const result = await generateSchedule(state, DATE);
    const supervisor = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-supervisor"
    )!;
    const counter = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-counter"
    )!;

    expect(supervisor).toMatchObject({
      staffId: independentSupervisor.id,
      workHours: 2,
    });
    expect(counter).toMatchObject({
      staffId: counterWorker.id,
      workHours: 2,
    });
    expect(counter.supervisorSourceAssignmentId).toBeUndefined();
  });

  it("rebuilds and clears a previous manual supervisor binding on rerun", async () => {
    const state = singleFlightState();
    const counterWorker = state.staff[0]!;
    const independentSupervisor = state.staff[1]!;
    state.staff = [counterWorker, independentSupervisor];
    state.positionRules = rules(
      state.positionRules[0]!,
      [counterWorker.id, independentSupervisor.id],
      [counterWorker.id]
    );
    state.assignments = [
      {
        id: "manual-supervisor",
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: "cx931-supervisor",
        position: "督导",
        staffId: counterWorker.id,
        staffName: counterWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
        manualRemark: "人工兼任",
        status: "assigned",
      },
      {
        id: "manual-counter",
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: "cx931-counter",
        position: "G09",
        staffId: counterWorker.id,
        staffName: counterWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 0,
        fatiguePoints: 7,
        remark: "",
        manualRemark: "人工兼任",
        status: "assigned",
        supervisorSourceAssignmentId: "manual-supervisor",
      },
    ];

    const result = await generateSchedule(state, DATE);
    const supervisor = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-supervisor"
    )!;
    const counter = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-counter"
    )!;

    expect(supervisor).toMatchObject({
      staffId: independentSupervisor.id,
      workHours: 2,
      manualRemark: "",
    });
    expect(counter).toMatchObject({
      staffId: counterWorker.id,
      workHours: 2,
      manualRemark: "",
    });
    expect(counter.supervisorSourceAssignmentId).toBeUndefined();
    expect(result.assignments.map((assignment) => assignment.id)).not.toEqual(
      expect.arrayContaining(["manual-supervisor", "manual-counter"])
    );
  });

  it("does not bind a non-KE166 supervisor to a forbidden counter", async () => {
    const state = singleFlightState();
    const worker = state.staff[0]!;
    state.staff = [worker];
    state.positionRules = rules(
      state.positionRules[0]!,
      [worker.id],
      [worker.id],
      "申报"
    );

    const result = await generateSchedule(state, DATE);
    const supervisor = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-supervisor"
    )!;
    const counter = result.assignments.find(
      (assignment) => assignment.positionRuleId === "cx931-counter"
    )!;

    expect(counter).toMatchObject({ staffId: worker.id, workHours: 2 });
    expect(counter.supervisorSourceAssignmentId).toBeUndefined();
    expect(supervisor).toMatchObject({ staffId: null, status: "unfilled" });
    expect(result.warnings).toContain("CX931 / 督导 无可用人员");
  });

  it("uses the existing safe reassignment before binding a non-KE166 supervisor", async () => {
    const state = singleFlightState();
    const supervisorWorker = state.staff[0]!;
    const relayWorker = state.staff[1]!;
    state.staff = [supervisorWorker, relayWorker];
    state.settings.mobileSupervisorCoverageRules = [
      {
        id: "forbid-blocked-counter",
        enabled: true,
        flightNo: "CX931",
        matchField: "remark",
        keyword: "不兼任",
        mode: "forbid",
      },
    ];
    const base = state.positionRules[0]!;
    const supervisorRule: PositionRule = {
      ...base,
      id: "cx931-supervisor",
      flightNo: "CX931",
      name: "督导",
      category: "机动督导",
      remark: "",
      minPassengers: 0,
      qualifiedStaffIds: [supervisorWorker.id],
    };
    const blockedCounterRule: PositionRule = {
      ...base,
      id: "cx931-g08",
      flightNo: "CX931",
      name: "G08",
      category: "常规",
      remark: "不兼任",
      minPassengers: 0,
      qualifiedStaffIds: [supervisorWorker.id, relayWorker.id],
    };
    const allowedCounterRule: PositionRule = {
      ...base,
      id: "cx931-g09",
      flightNo: "CX931",
      name: "G09",
      category: "常规",
      remark: "",
      minPassengers: 0,
      qualifiedStaffIds: [supervisorWorker.id, relayWorker.id],
    };
    state.positionRules = [
      supervisorRule,
      blockedCounterRule,
      allowedCounterRule,
    ];
    const assignments: Assignment[] = [
      {
        id: "g08-assignment",
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: blockedCounterRule.id,
        position: blockedCounterRule.name,
        staffId: supervisorWorker.id,
        staffName: supervisorWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 2,
        fatiguePoints: blockedCounterRule.fatiguePoints,
        remark: blockedCounterRule.remark,
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "g09-assignment",
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: allowedCounterRule.id,
        position: allowedCounterRule.name,
        staffId: relayWorker.id,
        staffName: relayWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 2,
        fatiguePoints: allowedCounterRule.fatiguePoints,
        remark: allowedCounterRule.remark,
        manualRemark: "",
        status: "assigned",
      },
    ];

    const supervisor = await assignMobileSupervisorByCounterCoverage(
      defaultHighsSolver,
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      DATE
    );

    expect(supervisor).toMatchObject({
      staffId: supervisorWorker.id,
      status: "assigned",
    });
    expect(
      assignments.find((item) => item.id === "g08-assignment")
    ).toMatchObject({
      staffId: relayWorker.id,
      workHours: 2,
    });
    expect(
      assignments.find((item) => item.id === "g09-assignment")
    ).toMatchObject({
      staffId: supervisorWorker.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisor!.id,
    });
  });

  it("does not apply the KE166 consecutive-supervisor preference to another flight", async () => {
    const state = singleFlightState();
    const firstWorker = state.staff[0]!;
    const secondWorker = state.staff[1]!;
    state.staff = [firstWorker, secondWorker];
    const base = state.positionRules[0]!;
    const supervisorRule: PositionRule = {
      ...base,
      id: "cx931-supervisor",
      flightNo: "CX931",
      name: "督导",
      category: "机动督导",
      remark: "",
      minPassengers: 0,
      qualifiedStaffIds: [firstWorker.id, secondWorker.id],
    };
    const counterRules = ["G08", "G09"].map<PositionRule>((name, index) => ({
      ...base,
      id: `cx931-counter-${index}`,
      flightNo: "CX931",
      name,
      category: "常规",
      remark: "",
      minPassengers: 0,
      fatiguePoints: 1,
      qualifiedStaffIds: [firstWorker.id, secondWorker.id],
    }));
    state.positionRules = [supervisorRule, ...counterRules];
    state.history = [
      {
        id: "previous-supervisor",
        date: "2026-09-21",
        flightNo: "CX931",
        position: "督导",
        staffId: firstWorker.id,
        staffName: firstWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
      },
    ];
    const assignments: Assignment[] = counterRules.map((rule, index) => {
      const person = index === 0 ? firstWorker : secondWorker;
      return {
        id: `counter-assignment-${index}`,
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: rule.id,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      };
    });

    const supervisor = await assignMobileSupervisorByCounterCoverage(
      defaultHighsSolver,
      state,
      assignments,
      state.flights[0]!,
      supervisorRule,
      DATE
    );

    expect(supervisor?.staffId).toBe(firstWorker.id);
    expect(assignments[0]).toMatchObject({
      staffId: firstWorker.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisor!.id,
    });
  });

  it("rejects a later write that breaks a valid mobile-supervisor link", () => {
    const state = singleFlightState();
    const supervisorWorker = state.staff[0]!;
    const otherWorker = state.staff[1]!;
    state.staff = [supervisorWorker, otherWorker];
    state.positionRules = rules(
      state.positionRules[0]!,
      [supervisorWorker.id],
      [supervisorWorker.id, otherWorker.id]
    );
    const valid: Assignment[] = [
      {
        id: "supervisor-assignment",
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: "cx931-supervisor",
        position: "督导",
        staffId: supervisorWorker.id,
        staffName: supervisorWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "counter-assignment",
        flightId: "cx931",
        flightNo: "CX931",
        positionRuleId: "cx931-counter",
        position: "G09",
        staffId: supervisorWorker.id,
        staffName: supervisorWorker.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 0,
        fatiguePoints: 7,
        remark: "",
        manualRemark: "",
        status: "assigned",
        supervisorSourceAssignmentId: "supervisor-assignment",
      },
    ];
    const ledger = createScheduleLedger(valid, {
      safetySession: createScheduleSafetySession({
        phase: "partial",
        state,
        date: DATE,
        runFacts: createScheduleRunFacts(state, DATE),
        guards: [createMobileSupervisorCoverageScheduleGuard()],
      }),
    });
    const broken = valid.map((assignment) => ({ ...assignment }));
    broken[1]!.staffId = otherWorker.id;
    broken[1]!.staffName = otherWorker.name;

    expect(() =>
      ledger.commit({ type: "replace", assignments: broken })
    ).toThrow(/机动督导.*同一人员/);
    expect(ledger.snapshot()).toEqual(valid);

    const unlinked = valid.map((assignment) => ({ ...assignment }));
    delete unlinked[1]!.supervisorSourceAssignmentId;
    expect(() =>
      ledger.commit({ type: "replace", assignments: unlinked })
    ).toThrow(/机动督导.*兼任关联/);
    expect(ledger.snapshot()).toEqual(valid);
  });

  it("allows a guide to reuse a KE166 supervisor without a counter link", () => {
    const state = singleFlightState();
    const supervisorWorker = state.staff[0]!;
    state.staff = [supervisorWorker];
    const base = state.positionRules[0]!;
    const supervisorRule: PositionRule = {
      ...base,
      id: "ke166-supervisor",
      flightNo: "CX931",
      name: "机动督导",
      category: "机动督导",
      remark: "",
      minPassengers: 0,
      qualifiedStaffIds: [supervisorWorker.id],
    };
    const counterRule: PositionRule = {
      ...base,
      id: "cx931-counter",
      flightNo: "CX931",
      name: "G09",
      category: "常规",
      remark: "",
      minPassengers: 0,
      qualifiedStaffIds: [supervisorWorker.id],
    };
    const guideRule: PositionRule = {
      ...base,
      id: "cx931-guide",
      flightNo: "CX931",
      name: "柜台引导",
      category: "引导",
      remark: "",
      minPassengers: 0,
      qualifiedStaffIds: [],
    };
    state.positionRules = [supervisorRule, counterRule, guideRule];
    const assignment = (
      id: string,
      positionRuleId: string,
      position: string,
      workHours: number,
      supervisorSourceAssignmentId?: string
    ): Assignment => ({
      id,
      flightId: "cx931",
      flightNo: "CX931",
      positionRuleId,
      position,
      staffId: supervisorWorker.id,
      staffName: supervisorWorker.name,
      startTime: "21:00",
      endTime: "23:00",
      workHours,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
      ...(supervisorSourceAssignmentId ? { supervisorSourceAssignmentId } : {}),
    });
    const valid = [
      assignment("supervisor", supervisorRule.id, supervisorRule.name, 2),
      assignment("counter", counterRule.id, counterRule.name, 0, "supervisor"),
      assignment("guide", guideRule.id, guideRule.name, 0),
    ];
    const ledger = createScheduleLedger(valid, {
      safetySession: createScheduleSafetySession({
        phase: "partial",
        state,
        date: DATE,
        runFacts: createScheduleRunFacts(state, DATE),
        guards: [createMobileSupervisorCoverageScheduleGuard()],
      }),
    });

    expect(() =>
      ledger.commit({ type: "replace", assignments: valid })
    ).not.toThrow();
    expect(ledger.snapshot()).toEqual(valid);
  });
});
