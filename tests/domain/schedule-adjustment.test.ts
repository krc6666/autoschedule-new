import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import type { AppState, Assignment } from "../../src/model";
import {
  moveSupervisorWithinFlight,
  normalizeSupervisorAssignments,
} from "../../src/domain/assignments/schedule-adjustment";
import { timeConflictAssignmentIds } from "../../src/domain/assignments/assignment-time-conflicts";
import { createMobileSupervisorCoverageScheduleGuard } from "../../src/domain/kernel/schedule-guard";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";

function stateWithSupervisor(): AppState {
  const state = createDefaultState();
  const [supervisor, counterWorker] = state.staff;
  state.staff = [supervisor!, counterWorker!];
  state.flights = [
    {
      id: "f1",
      flightNo: "F1",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "supervisor",
      flightNo: "F1",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: [supervisor!.id],
      fatiguePoints: 5,
    },
    {
      ...base,
      id: "h04",
      flightNo: "F1",
      name: "H04",
      category: "常规",
      qualifiedStaffIds: [],
      fatiguePoints: 7,
    },
    {
      ...base,
      id: "h03",
      flightNo: "F1",
      name: "H03",
      category: "常规",
      qualifiedStaffIds: [counterWorker!.id],
      fatiguePoints: 6,
    },
  ];
  const assignment = (
    id: string,
    ruleId: string,
    position: string,
    staffId: string | null,
    status: Assignment["status"]
  ): Assignment => ({
    id,
    flightId: "f1",
    flightNo: "F1",
    positionRuleId: ruleId,
    position,
    staffId,
    staffName: staffId
      ? state.staff.find((person) => person.id === staffId)!.name
      : "",
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 2,
    remark: "",
    manualRemark: "",
    status,
  });
  state.assignments = [
    assignment(
      "supervisor-assignment",
      "supervisor",
      "督导",
      supervisor!.id,
      "assigned"
    ),
    assignment("h04-assignment", "h04", "H04", null, "unfilled"),
    assignment("h03-assignment", "h03", "H03", counterWorker!.id, "assigned"),
  ];
  return state;
}

describe("督导同航班机动补位", () => {
  it("拒绝人工把机动督导补到其他航班，即使配置关系且时段不冲突", () => {
    const state = stateWithSupervisor();
    state.flights.push({
      id: "f2",
      flightNo: "F2",
      startTime: "12:00",
      endTime: "14:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    });
    const targetRule = state.positionRules.find((rule) => rule.id === "h04")!;
    targetRule.flightNo = "F2";
    targetRule.coverageRole = "supervisor-fill";
    const target = state.assignments.find(
      (assignment) => assignment.id === "h04-assignment"
    )!;
    target.flightId = "f2";
    target.flightNo = "F2";
    target.startTime = "12:00";
    target.endTime = "14:00";
    state.settings.mobileSupervisorFillRules = [
      {
        id: "f1-f2-fill",
        enabled: true,
        sourceFlightNo: "F1",
        sourcePositionKeyword: "督导",
        targetFlightNo: "F2",
        targetPositionKeyword: "H04",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h04-assignment"
      )
    ).toContain("同一航班");
    expect(target).toMatchObject({ staffId: null, status: "unfilled" });
    expect(target.supervisorSourceAssignmentId).toBeUndefined();
  });

  it("拒绝人工把机动督导补到时段重叠的跨航班岗位", () => {
    const state = stateWithSupervisor();
    state.flights.push({
      id: "f2",
      flightNo: "F2",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    });
    const targetRule = state.positionRules.find((rule) => rule.id === "h04")!;
    targetRule.flightNo = "F2";
    targetRule.coverageRole = "supervisor-fill";
    const target = state.assignments.find(
      (assignment) => assignment.id === "h04-assignment"
    )!;
    target.flightId = "f2";
    target.flightNo = "F2";
    target.startTime = "08:00";
    target.endTime = "10:00";
    state.settings.mobileSupervisorFillRules = [
      {
        id: "f1-f2-fill",
        enabled: true,
        sourceFlightNo: "F1",
        sourcePositionKeyword: "督导",
        targetFlightNo: "F2",
        targetPositionKeyword: "H04",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h04-assignment"
      )
    ).toContain("同一航班");
    expect(target).toMatchObject({ staffId: null, status: "unfilled" });
  });

  it("人工入口和最终守卫拒绝旧跨航班补位，即使时段不冲突", () => {
    const state = stateWithSupervisor();
    state.flights.push({
      id: "f2",
      flightNo: "F2",
      startTime: "12:00",
      endTime: "14:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    });
    const targetRule = state.positionRules.find((rule) => rule.id === "h04")!;
    targetRule.flightNo = "F2";
    targetRule.coverageRole = "supervisor-fill";
    const target = state.assignments.find(
      (assignment) => assignment.id === "h04-assignment"
    )!;
    target.flightId = "f2";
    target.flightNo = "F2";
    target.startTime = "12:00";
    target.endTime = "14:00";
    state.settings.mobileSupervisorFillRules = [
      {
        id: "f1-f2-fill",
        enabled: true,
        sourceFlightNo: "F1",
        sourcePositionKeyword: "督导",
        targetFlightNo: "F2",
        targetPositionKeyword: "H04",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h04-assignment"
      )
    ).toContain("同一航班");
    expect(target.staffId).toBeNull();
    const source = state.assignments.find(
      (assignment) => assignment.id === "supervisor-assignment"
    )!;
    Object.assign(target, {
      staffId: source.staffId,
      staffName: source.staffName,
      status: "assigned",
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "f1-f2-fill",
      workHours: 0,
      fatiguePoints: 0,
    });
    const session = createScheduleSafetySession({
      phase: "final",
      state,
      date: "2026-09-28",
      runFacts: createScheduleRunFacts(state, "2026-09-28"),
      guards: [createMobileSupervisorCoverageScheduleGuard()],
    });

    expect(() => session.assertAssignmentsSafe(state.assignments)).toThrow(
      /督导补位关联无效/
    );
  });

  it("最终守卫拒绝同航班督导补位缺失补位规则关联", () => {
    const state = stateWithSupervisor();
    const targetRule = state.positionRules.find((rule) => rule.id === "h04")!;
    targetRule.coverageRole = "supervisor-fill";
    state.settings.mobileSupervisorFillRules = [
      {
        id: "f1-h04-fill",
        enabled: true,
        sourceFlightNo: "F1",
        sourcePositionKeyword: "督导",
        targetFlightNo: "F1",
        targetPositionKeyword: "H04",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h04-assignment"
      )
    ).toBeNull();
    const target = state.assignments.find(
      (assignment) => assignment.id === "h04-assignment"
    )!;
    expect(target.supervisorFillRuleId).toBe("f1-h04-fill");
    const session = createScheduleSafetySession({
      phase: "final",
      state,
      date: "2026-09-28",
      runFacts: createScheduleRunFacts(state, "2026-09-28"),
      guards: [createMobileSupervisorCoverageScheduleGuard()],
    });
    const broken = state.assignments.map((assignment) => ({ ...assignment }));
    delete broken.find((assignment) => assignment.id === target.id)!
      .supervisorFillRuleId;

    expect(() => session.assertAssignmentsSafe(broken)).toThrow(/补位关联/);
  });

  it("保留顶部督导并允许补到无资质的空柜台", () => {
    const state = stateWithSupervisor();

    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h04-assignment"
      )
    ).toBeNull();

    expect(
      state.assignments.find((item) => item.id === "supervisor-assignment")
    ).toMatchObject({ status: "assigned", workHours: 2 });
    expect(
      state.assignments.find((item) => item.id === "h04-assignment")
    ).toMatchObject({
      staffId: state.staff[0]!.id,
      status: "assigned",
      workHours: 0,
      fatiguePoints: 7,
      supervisorSourceAssignmentId: "supervisor-assignment",
    });
  });

  it("移动关联柜台时保持顶部督导并清空原柜台", () => {
    const state = stateWithSupervisor();
    moveSupervisorWithinFlight(
      state,
      "supervisor-assignment",
      "h04-assignment"
    );
    state.assignments.find((item) => item.id === "h03-assignment")!.staffId =
      null;
    state.assignments.find((item) => item.id === "h03-assignment")!.staffName =
      "";
    state.assignments.find((item) => item.id === "h03-assignment")!.status =
      "unfilled";

    expect(
      moveSupervisorWithinFlight(state, "h04-assignment", "h03-assignment")
    ).toBeNull();
    expect(
      state.assignments.find((item) => item.id === "h04-assignment")
    ).toMatchObject({ staffId: null, status: "unfilled" });
    expect(
      state.assignments.find((item) => item.id === "h03-assignment")
    ).toMatchObject({
      supervisorSourceAssignmentId: "supervisor-assignment",
      workHours: 0,
    });
  });

  it("拒绝跨航班、顶部目标和已有人员的目标", () => {
    const state = stateWithSupervisor();

    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h03-assignment"
      )
    ).toContain("已有人员");
    expect(
      moveSupervisorWithinFlight(
        state,
        "h03-assignment",
        "supervisor-assignment"
      )
    ).toContain("仅督导");
  });

  it("顶部督导变更时同步所有关联柜台", () => {
    const state = stateWithSupervisor();
    moveSupervisorWithinFlight(
      state,
      "supervisor-assignment",
      "h04-assignment"
    );
    const supervisor = state.assignments.find(
      (item) => item.id === "supervisor-assignment"
    )!;
    supervisor.staffId = state.staff[1]!.id;
    supervisor.staffName = state.staff[1]!.name;

    normalizeSupervisorAssignments(state);

    expect(
      state.assignments.find((item) => item.id === "h04-assignment")
    ).toMatchObject({
      staffId: state.staff[1]!.id,
      staffName: state.staff[1]!.name,
    });
  });

  it("手工连环调整后为配置的督导补位恢复关联，不标记同航班紫色冲突", () => {
    const state = stateWithSupervisor();
    const target = state.assignments.find(
      (item) => item.id === "h04-assignment"
    )!;
    const targetRule = state.positionRules.find((rule) => rule.id === "h04")!;
    targetRule.coverageRole = "supervisor-fill";
    state.settings.mobileSupervisorFillRules = [
      {
        id: "f1-h04-fill",
        enabled: true,
        sourceFlightNo: "F1",
        sourcePositionKeyword: "督导",
        targetFlightNo: "F1",
        targetPositionKeyword: "H04",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    target.staffId = state.staff[0]!.id;
    target.staffName = state.staff[0]!.name;
    target.status = "assigned";

    normalizeSupervisorAssignments(state);

    expect(target).toMatchObject({
      staffId: state.staff[0]!.id,
      supervisorSourceAssignmentId: "supervisor-assignment",
      supervisorFillRuleId: "f1-h04-fill",
      workHours: 0,
      fatiguePoints: 0,
    });
    expect(timeConflictAssignmentIds(state, state.assignments)).not.toContain(
      target.id
    );
  });

  it("normalization clears an orphan supervisor fill rule", () => {
    const state = stateWithSupervisor();
    const target = state.assignments.find(
      (assignment) => assignment.id === "h04-assignment"
    )!;
    target.supervisorFillRuleId = "stale-fill-rule";

    normalizeSupervisorAssignments(state);

    expect(target.supervisorSourceAssignmentId).toBeUndefined();
    expect(target.supervisorFillRuleId).toBeUndefined();
  });

  it("normalization clears a stale rule from a recorded supervisor link", () => {
    const state = stateWithSupervisor();
    const target = state.assignments.find(
      (assignment) => assignment.id === "h04-assignment"
    )!;
    target.staffId = state.staff[0]!.id;
    target.staffName = state.staff[0]!.name;
    target.status = "assigned";
    target.workHours = 0;
    target.supervisorSourceAssignmentId = "supervisor-assignment";
    target.supervisorFillRuleId = "stale-fill-rule";

    normalizeSupervisorAssignments(state);

    expect(target.supervisorSourceAssignmentId).toBe("supervisor-assignment");
    expect(target.supervisorFillRuleId).toBeUndefined();
  });

  it("拒绝兼任规则禁止的备注岗位并清理旧违规关联", () => {
    const state = stateWithSupervisor();
    const target = state.assignments.find(
      (item) => item.id === "h04-assignment"
    )!;
    target.remark = "一号";

    expect(
      moveSupervisorWithinFlight(
        state,
        "supervisor-assignment",
        "h04-assignment"
      )
    ).toContain("机动督导不能兼任 F1/H04");

    target.staffId = state.staff[0]!.id;
    target.staffName = state.staff[0]!.name;
    target.status = "assigned";
    target.workHours = 0;
    target.supervisorSourceAssignmentId = "supervisor-assignment";
    normalizeSupervisorAssignments(state);
    expect(target).toMatchObject({
      staffId: null,
      staffName: "",
      status: "unfilled",
    });
    expect(target.supervisorSourceAssignmentId).toBeUndefined();
  });
});
