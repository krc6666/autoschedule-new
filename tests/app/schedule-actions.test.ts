import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";
import type { AppState, Assignment } from "../../src/model";
import {
  assignStaff,
  createTemporaryAssignment,
  updateAssignmentField,
} from "../../src/app/schedule-actions";
import { generateSchedule } from "../helpers/generate-schedule";

function supervisorSchedule(): AppState {
  const state = createDefaultState();
  const person = state.staff[0]!;
  person.name = "张奇";
  state.staff = [person];
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
      id: "supervisor",
      flightNo: "KE166",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: [person.id],
      fatiguePoints: 5,
    },
    {
      ...base,
      id: "h04",
      flightNo: "KE166",
      name: "H04",
      category: "常规",
      qualifiedStaffIds: [],
      fatiguePoints: 7,
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
    flightId: "ke166",
    flightNo: "KE166",
    positionRuleId: ruleId,
    position,
    staffId,
    staffName: staffId ? person.name : "",
    startTime: "09:15",
    endTime: "11:15",
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
      person.id,
      "assigned"
    ),
    assignment("h04-assignment", "h04", "H04", null, "unfilled"),
  ];
  return state;
}

describe("督导机动补位编辑", () => {
  it("clears an assignment without immediately reusing the person", () => {
    const state = supervisorSchedule();
    const target = state.assignments.find(
      (item) => item.id === "h04-assignment"
    )!;
    target.staffId = state.staff[0]!.id;
    target.staffName = state.staff[0]!.name;
    target.status = "assigned";
    target.supervisorSourceAssignmentId = "supervisor-assignment";

    const result = assignStaff(state, target.id, "");

    expect(result).toMatchObject({ changed: true });
    expect(target).toMatchObject({
      staffId: null,
      staffName: "",
      status: "unfilled",
    });
  });

  it("拖动顶部督导到空柜台时保留顶部并跳过目标资质限制", () => {
    const state = supervisorSchedule();
    const result = assignStaff(
      state,
      "h04-assignment",
      state.staff[0]!.id,
      "supervisor-assignment"
    );

    expect(result).toMatchObject({
      changed: true,
      message: "督导已机动补位至目标岗位",
    });
    expect(
      state.assignments.find((item) => item.id === "supervisor-assignment")
    ).toMatchObject({ staffName: "张奇", workHours: 2 });
    expect(
      state.assignments.find((item) => item.id === "h04-assignment")
    ).toMatchObject({
      staffName: "张奇",
      workHours: 0,
      fatiguePoints: 7,
      supervisorSourceAssignmentId: "supervisor-assignment",
    });
    expect(
      buildScheduleFeedback(state, "2026-07-22").find(
        (item) => item.key === "coverage"
      )?.text
    ).toContain("督导机动补位：张奇兼任KE166/H04");
  });

  it("拖动顶部督导到配置 H05 时忽略同航班的引导复用", () => {
    const state = supervisorSchedule();
    const supervisor = state.staff[0]!;
    const target = state.assignments.find(
      (item) => item.id === "h04-assignment"
    )!;
    const targetRule = state.positionRules.find((rule) => rule.id === "h04")!;
    target.position = "H05";
    targetRule.name = "H05";
    targetRule.coverageRole = "supervisor-fill";
    state.positionRules.push({
      ...targetRule,
      id: "guide",
      name: "柜台引导",
      category: "引导",
      coverageRole: "none",
      qualifiedStaffIds: [],
    });
    state.assignments.push({
      ...target,
      id: "guide-assignment",
      positionRuleId: "guide",
      position: "柜台引导",
      staffId: supervisor.id,
      staffName: supervisor.name,
      status: "assigned",
      workHours: 0,
      fatiguePoints: 0,
    });
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

    expect(
      assignStaff(state, target.id, supervisor.id, "supervisor-assignment")
    ).toMatchObject({ changed: true });
    expect(target).toMatchObject({
      staffId: supervisor.id,
      supervisorSourceAssignmentId: "supervisor-assignment",
      supervisorFillRuleId: "ke166-h05-fill",
    });
  });

  it("拒绝把督导拖入已有人员的柜台", () => {
    const state = supervisorSchedule();
    const target = state.assignments.find(
      (item) => item.id === "h04-assignment"
    )!;
    target.staffId = state.staff[0]!.id;
    target.staffName = state.staff[0]!.name;
    target.status = "assigned";

    expect(
      assignStaff(
        state,
        "h04-assignment",
        state.staff[0]!.id,
        "supervisor-assignment"
      )
    ).toMatchObject({
      changed: false,
      error: "目标岗位已有人员，请先清空 H04",
    });
  });

  it("人工拖拽不能绕过机动督导兼任范围", () => {
    const state = supervisorSchedule();
    state.assignments.find((item) => item.id === "h04-assignment")!.remark =
      "申报";

    expect(
      assignStaff(
        state,
        "h04-assignment",
        state.staff[0]!.id,
        "supervisor-assignment"
      )
    ).toMatchObject({
      changed: false,
      error: expect.stringContaining("机动督导不能兼任 KE166/H04"),
    });
  });
});

describe("人工调整后的规则证据", () => {
  it("允许人工突破同航班人员互斥并报警，自动重排后恢复互斥", async () => {
    const state = createDefaultState();
    const [first, second] = state.staff.filter(
      (person) => person.status === "正常"
    );
    const flight = {
      ...state.flights[0]!,
      id: "flight-f100",
      flightNo: "F100",
      startTime: "08:00",
      endTime: "10:00",
      positions: ["G01", "G02"],
    };
    const rules = ["G01", "G02"].map((name, index) => ({
      ...state.positionRules[0]!,
      id: `rule-${name.toLowerCase()}`,
      flightNo: flight.flightNo,
      name,
      category: "常规" as const,
      remark: "",
      qualifiedStaffIds: [index === 0 ? first!.id : second!.id],
      fatiguePoints: 1,
    }));
    state.staff = [first!, second!];
    state.flights = [flight];
    state.templates = [];
    state.positionRules = rules;
    state.activeScheduleDate = "2026-09-15";
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.sameFlightStaffExclusions = [
      {
        id: "pair-1",
        enabled: true,
        firstStaffId: first!.id,
        secondStaffId: second!.id,
        flightNo: "",
      },
    ];
    state.assignments = rules.map((rule, index) => ({
      id: `assignment-${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: index === 0 ? first!.id : null,
      staffName: index === 0 ? first!.name : "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: index === 0 ? 2 : 0,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: index === 0 ? ("assigned" as const) : ("unfilled" as const),
    }));

    const manual = assignStaff(state, "assignment-1", second!.id);

    expect(manual).toMatchObject({
      changed: true,
      warning: expect.stringContaining(
        `${first!.name}与${second!.name}不能同时安排在F100`
      ),
    });
    expect(state.assignments[1]?.manualOverrideWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "same-flight-staff-exclusion",
          message: expect.stringContaining("本次为人工突破"),
        }),
      ])
    );

    const automatic = await generateSchedule(state, "2026-09-15");
    expect(
      automatic.assignments.filter(
        (assignment) => assignment.status === "assigned"
      )
    ).toHaveLength(1);
    expect(
      automatic.assignments.flatMap(
        (assignment) => assignment.manualOverrideWarnings ?? []
      )
    ).toEqual([]);
  });
  it("临时岗位只接受已配置人员并保留人员编号用于统计", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    const flight = state.flights[0]!;

    expect(
      createTemporaryAssignment(
        state,
        flight.id,
        "临时柜台",
        person.name,
        "primary",
        0
      )
    ).toMatchObject({ changed: true });
    expect(state.assignments[0]).toMatchObject({
      staffId: person.id,
      staffName: person.name,
      status: "assigned",
    });

    const count = state.assignments.length;
    expect(
      createTemporaryAssignment(
        state,
        flight.id,
        "临时柜台",
        "系统外人员",
        "primary",
        1
      )
    ).toMatchObject({
      changed: false,
      error: "人员不存在：系统外人员",
    });
    expect(state.assignments).toHaveLength(count);
  });

  it("人工突破次班截止保护时直接落位并持续警告", () => {
    const state = createDefaultState();
    const person = state.staff[0]!;
    const flight = state.flights[0]!;
    flight.startTime = "15:00";
    flight.endTime = "17:00";
    const rule = {
      ...state.positionRules.find((item) => item.flightNo === flight.flightNo)!,
      id: "cutoff-target",
      category: "常规" as const,
      qualifiedStaffIds: [person.id],
    };
    state.staff = [person];
    state.positionRules = [rule];
    state.activeScheduleDate = "2026-08-23";
    state.assignments = [
      {
        id: "cutoff-assignment",
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
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "late-number-one",
        enabled: true,
        flightNo: "TR121",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "12:00",
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-08-21",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    expect(assignStaff(state, "cutoff-assignment", person.id)).toMatchObject({
      changed: true,
      warning: expect.stringContaining("12:00 截止保护"),
    });
    expect(
      state.assignments[0]?.manualOverrideWarnings?.[0]?.message
    ).toContain("12:00 截止保护");
  });

  it("允许人工安排无资质人员并保留持续警告，病休人员仍被拒绝", () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    const flight = state.flights[0]!;
    const rule = {
      ...state.positionRules.find((item) => item.flightNo === flight.flightNo)!,
      id: "manual-override-target",
      qualifiedStaffIds: [],
    };
    state.staff = [person];
    state.positionRules = [rule];
    state.assignments = [
      {
        id: "manual-override-assignment",
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
      },
    ];

    expect(
      assignStaff(state, state.assignments[0]!.id, person.id)
    ).toMatchObject({
      changed: true,
      warning: expect.stringContaining(
        "不具备岗位资质：不在“CX937/督导”资质名单"
      ),
    });
    expect(state.assignments[0]).toMatchObject({
      staffId: person.id,
      manualOverrideWarnings: [
        expect.objectContaining({ code: "position-qualification" }),
      ],
    });

    person.status = "病假";
    expect(
      assignStaff(state, state.assignments[0]!.id, person.id)
    ).toMatchObject({
      changed: false,
      error: expect.stringContaining("病假"),
    });
  });

  it("双向换位存在阻止项时保持原岗位不变", () => {
    const state = createDefaultState();
    const [first, second] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    first!.nightShift = true;
    second!.nightShift = false;
    const dayFlight = {
      ...state.flights[0]!,
      id: "day",
      flightNo: "DAY",
      startTime: "08:00",
      endTime: "10:00",
    };
    const nightFlight = {
      ...dayFlight,
      id: "night",
      flightNo: "NIGHT",
      startTime: "22:00",
      endTime: "23:00",
    };
    const base = state.positionRules[0]!;
    const dayRule = {
      ...base,
      id: "day-rule",
      flightNo: "DAY",
      qualifiedStaffIds: [first!.id, second!.id],
    };
    const nightRule = {
      ...base,
      id: "night-rule",
      flightNo: "NIGHT",
      qualifiedStaffIds: [first!.id, second!.id],
    };
    state.staff = [first!, second!];
    state.flights = [dayFlight, nightFlight];
    state.positionRules = [dayRule, nightRule];
    state.assignments = [
      {
        id: "day-assignment",
        flightId: "day",
        flightNo: "DAY",
        positionRuleId: dayRule.id,
        position: dayRule.name,
        staffId: second!.id,
        staffName: second!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "night-assignment",
        flightId: "night",
        flightNo: "NIGHT",
        positionRuleId: nightRule.id,
        position: nightRule.name,
        staffId: first!.id,
        staffName: first!.name,
        startTime: "22:00",
        endTime: "23:00",
        workHours: 1,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    const before = structuredClone(state.assignments);

    expect(
      assignStaff(state, "night-assignment", second!.id, "day-assignment")
    ).toMatchObject({
      changed: false,
      error: expect.stringContaining("不可上夜班"),
    });
    expect(state.assignments).toEqual(before);
  });

  it("允许人工把已承担两次的人员继续拖到TR121一号", () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    person.nightShift = true;
    state.staff = [person];
    state.activeScheduleDate = "2026-09-21";
    state.flights = [
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const rule = {
      ...state.positionRules[0]!,
      id: "tr121-number-one",
      flightNo: "TR121",
      name: "H02",
      remark: "一号",
      category: "常规" as const,
      qualifiedStaffIds: [person.id],
    };
    state.positionRules = [rule];
    state.history = ["2026-09-01", "2026-09-03"].map((date, index) => ({
      id: `number-one-${index}`,
      date,
      flightNo: "TR121",
      position: "H02",
      staffId: person.id,
      staffName: person.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 5,
      remark: "一号",
    }));
    state.assignments = [
      {
        id: "target",
        flightId: "tr121",
        flightNo: "TR121",
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
        manualRemark: "",
        status: "unfilled",
      },
    ];

    expect(assignStaff(state, "target", person.id)).toMatchObject({
      changed: true,
    });
    expect(state.assignments[0]).toMatchObject({
      staffId: person.id,
      status: "assigned",
    });
  });

  it("换人后清除目标岗位的旧自动决策，反馈不再展示过期理由", () => {
    const state = createDefaultState();
    const [original, replacement] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    const flight = state.flights[0]!;
    const baseRule = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo
    )!;
    const rule = {
      ...baseRule,
      id: "editable-rule",
      qualifiedStaffIds: [original!.id, replacement!.id],
    };
    state.positionRules = [rule];
    state.assignments = [
      {
        id: "assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: original!.id,
        staffName: original!.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "assigned",
        decisionTrace: [
          schedulingDecision(
            "position-frequency-review",
            "selected",
            "这是已经过期的自动排班理由"
          ),
        ],
      },
    ];

    expect(assignStaff(state, "assignment", replacement!.id)).toMatchObject({
      changed: true,
    });
    expect(state.assignments[0]!.decisionTrace).toBeUndefined();
    expect(
      buildScheduleFeedback(state, "2026-07-18")
        .map((item) => item.text)
        .join("\n")
    ).not.toContain("这是已经过期的自动排班理由");
  });

  it("重点岗位换人后立即移除琥珀异常，换回连续人员时重新生成当前原因", () => {
    const state = createDefaultState();
    const [repeated, replacement] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [repeated!, replacement!];
    state.activeScheduleDate = "2026-08-03";
    const flight = state.flights[0]!;
    const base = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo
    )!;
    const rule = {
      ...base,
      id: "priority",
      name: "G20",
      remark: "一号",
      qualifiedStaffIds: [repeated!.id, replacement!.id],
    };
    state.positionRules = [rule];
    state.history = [
      {
        id: "previous",
        date: "2026-08-01",
        flightNo: flight.flightNo,
        position: "G20",
        staffId: repeated!.id,
        staffName: repeated!.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 4,
        remark: "一号",
      },
    ];
    state.assignments = [
      {
        id: "assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: "G20",
        staffId: repeated!.id,
        staffName: repeated!.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 4,
        remark: "一号",
        manualRemark: "",
        status: "assigned",
        decisionTrace: [
          schedulingDecision("position-rotation", "fallback", "旧异常"),
        ],
      },
    ];

    expect(assignStaff(state, "assignment", replacement!.id).changed).toBe(
      true
    );
    expect(
      state.assignments[0]!.decisionTrace?.some(
        (decision) => decision.ruleId === "position-rotation"
      )
    ).not.toBe(true);

    expect(assignStaff(state, "assignment", repeated!.id).changed).toBe(true);
    expect(state.assignments[0]!.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-rotation",
          outcome: "fallback",
          message: expect.stringContaining("当前为人工安排"),
        }),
      ])
    );
  });

  it("人工调整其他岗位后仍重建KE166机动督导整组的连续异常", () => {
    const state = supervisorSchedule();
    const supervisor = state.assignments.find(
      (item) => item.id === "supervisor-assignment"
    )!;
    const boundCounter = state.assignments.find(
      (item) => item.id === "h04-assignment"
    )!;
    state.activeScheduleDate = "2026-08-03";
    state.history = [
      {
        id: "previous-ke166-supervisor",
        date: "2026-08-01",
        flightNo: "KE166",
        position: "督导",
        staffId: supervisor.staffId!,
        staffName: supervisor.staffName,
        startTime: "09:15",
        endTime: "11:15",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
    ];
    boundCounter.staffId = supervisor.staffId;
    boundCounter.staffName = supervisor.staffName;
    boundCounter.status = "assigned";
    boundCounter.workHours = 0;
    boundCounter.supervisorSourceAssignmentId = supervisor.id;
    supervisor.decisionTrace = [
      schedulingDecision("position-rotation", "fallback", "旧KE166异常"),
    ];
    boundCounter.decisionTrace = [
      schedulingDecision("position-rotation", "fallback", "旧KE166异常"),
    ];
    state.assignments.push({
      id: "temporary",
      flightId: "ke166",
      flightNo: "KE166",
      positionRuleId: null,
      position: "临时岗位",
      staffId: null,
      staffName: "",
      startTime: "09:15",
      endTime: "11:15",
      workHours: 0,
      fatiguePoints: 0,
      remark: "",
      manualRemark: "",
      status: "manual",
    });

    expect(
      updateAssignmentField(
        state,
        "temporary",
        "staffName",
        state.staff[0]!.name
      ).changed
    ).toBe(true);
    for (const assignment of [supervisor, boundCounter]) {
      expect(assignment.decisionTrace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "position-rotation",
            outcome: "fallback",
            message: expect.stringContaining("当前为人工安排"),
          }),
        ])
      );
      expect(
        assignment.decisionTrace?.map((decision) => decision.message)
      ).not.toContain("旧KE166异常");
    }
  });
});

describe("引导人员人工调整", () => {
  function guideSchedule(): AppState {
    const state = createDefaultState();
    const [upper, lower, outsider] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [upper!, lower!, outsider!];
    state.flights = [
      {
        id: "flight",
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
        id: "upper",
        flightNo: "F1",
        name: "G02",
        category: "常规",
        qualifiedStaffIds: [upper!.id],
      },
      {
        ...base,
        id: "lower",
        flightNo: "F1",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [lower!.id],
      },
      {
        ...base,
        id: "guide",
        flightNo: "F1",
        name: "柜台引导",
        category: "引导",
        qualifiedStaffIds: [],
        fatiguePoints: 5,
      },
    ];
    state.assignments = [
      {
        id: "upper-assignment",
        flightId: "flight",
        flightNo: "F1",
        positionRuleId: "upper",
        position: "G02",
        staffId: upper!.id,
        staffName: upper!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "lower-assignment",
        flightId: "flight",
        flightNo: "F1",
        positionRuleId: "lower",
        position: "G01",
        staffId: lower!.id,
        staffName: lower!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "guide-assignment",
        flightId: "flight",
        flightNo: "F1",
        positionRuleId: "guide",
        position: "柜台引导",
        staffId: lower!.id,
        staffName: lower!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    return state;
  }

  it("允许改为同航班已上岗的其他正常常规人员，并保持零工时零疲劳", () => {
    const state = guideSchedule();
    const guide = state.assignments.find(
      (assignment) => assignment.id === "guide-assignment"
    )!;
    const upper = state.staff[0]!;

    expect(
      updateAssignmentField(state, guide.id, "staffName", upper.name)
    ).toMatchObject({ changed: true });
    expect(guide).toMatchObject({
      staffId: upper.id,
      staffName: upper.name,
      status: "manual",
      workHours: 0,
      fatiguePoints: 0,
    });
  });

  it("允许复用同航班分流岗位上的常规人员", () => {
    const state = guideSchedule();
    const guide = state.assignments.find(
      (assignment) => assignment.id === "guide-assignment"
    )!;
    const lower = state.staff[1]!;
    state.positionRules.find((rule) => rule.id === "lower")!.category = "分流";
    guide.staffId = state.staff[0]!.id;
    guide.staffName = state.staff[0]!.name;

    expect(
      updateAssignmentField(state, guide.id, "staffName", lower.name)
    ).toMatchObject({ changed: true });
    expect(guide).toMatchObject({
      staffId: lower.id,
      staffName: lower.name,
      status: "manual",
      workHours: 0,
      fatiguePoints: 0,
    });
  });

  it("拒绝未参加该航班和不存在的引导人员", () => {
    const state = guideSchedule();
    const guide = state.assignments.find(
      (assignment) => assignment.id === "guide-assignment"
    )!;
    const outsider = state.staff[2]!;

    expect(
      updateAssignmentField(state, guide.id, "staffName", outsider.name).error
    ).toContain("未在该航班承担可复用岗位");
    expect(
      updateAssignmentField(state, guide.id, "staffName", "不存在人员").error
    ).toContain("只能复用同一航班");
  });

  it("允许复用行政支援岗位上的常规人员", () => {
    const state = guideSchedule();
    state.settings.adminSupportEnabled = true;
    const guide = state.assignments.find(
      (assignment) => assignment.id === "guide-assignment"
    )!;
    const lower = state.staff[1]!;
    state.positionRules.find((rule) => rule.id === "lower")!.category =
      "行政支援";
    guide.staffId = state.staff[0]!.id;
    guide.staffName = state.staff[0]!.name;

    expect(
      updateAssignmentField(state, guide.id, "staffName", lower.name)
    ).toMatchObject({ changed: true });
    expect(guide).toMatchObject({
      staffId: lower.id,
      staffName: lower.name,
      status: "manual",
    });
  });

  it("行政支援岗位填入常规人员后优先刷新引导", () => {
    const state = guideSchedule();
    state.settings.adminSupportEnabled = true;
    const guide = state.assignments.find(
      (assignment) => assignment.id === "guide-assignment"
    )!;
    const supportWorker = state.staff[2]!;
    const base = state.positionRules[0]!;
    state.positionRules.splice(2, 0, {
      ...base,
      id: "administrative",
      flightNo: "F1",
      name: "行政补位",
      category: "行政支援",
      qualifiedStaffIds: [supportWorker.id],
    });
    state.assignments.splice(2, 0, {
      id: "administrative-assignment",
      flightId: "flight",
      flightNo: "F1",
      positionRuleId: "administrative",
      position: "行政补位",
      staffId: null,
      staffName: "",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "manual",
    });

    expect(
      assignStaff(state, "administrative-assignment", supportWorker.id)
    ).toMatchObject({ changed: true });
    expect(guide).toMatchObject({
      staffId: supportWorker.id,
      staffName: supportWorker.name,
      status: "assigned",
    });
  });

  it("拒绝行政支援人员成为引导", () => {
    const state = guideSchedule();
    const guide = state.assignments.find(
      (assignment) => assignment.id === "guide-assignment"
    )!;
    const lower = state.staff[1]!;
    lower.staffType = "行政支援";
    state.settings.adminSupportEnabled = true;
    guide.staffId = state.staff[0]!.id;
    guide.staffName = state.staff[0]!.name;

    const result = updateAssignmentField(
      state,
      guide.id,
      "staffName",
      lower.name
    );
    expect(result.changed).toBe(false);
    expect(result.error).toBeTruthy();
    expect(guide.staffId).toBe(state.staff[0]!.id);
  });
});
