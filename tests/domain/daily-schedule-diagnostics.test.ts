import { describe, expect, it } from "vitest";

import { buildDailyScheduleModel } from "../../src/domain/kernel/daily-schedule-model";
import { diagnoseDailyScheduleFailure } from "../../src/domain/kernel/daily-schedule-diagnostics";
import { optimizeDailySchedule } from "../../src/domain/kernel/daily-schedule-optimizer";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import type { Flight, PositionRule } from "../../src/model";
import type { ScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type { SolverPort } from "../../src/domain/solver/solver-port";
import { createSchedulingScenario } from "../helpers/scheduling-scenario";

function stateFor(
  flights: readonly Flight[],
  ruleOptions?: (rule: PositionRule) => PositionRule
): ScheduleGenerationFacts {
  const state = createSchedulingScenario();
  const person = {
    ...state.staff[0]!,
    id: "worker",
    name: "测试人员",
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: false,
    dutyQualified: false,
    nightShift: true,
  };
  state.staff = [person];
  state.flights = [...flights];
  state.positionRules = flights.flatMap((flight) =>
    flight.positions.map(
      (position, index) =>
        ruleOptions?.({
          ...state.positionRules[0]!,
          id: `${flight.id}-rule-${index}`,
          flightNo: flight.flightNo,
          name: position,
          category: "常规",
          remark: "",
          qualifiedStaffIds: [person.id],
          minPassengers: 0,
          manual: false,
          earlyReleaseMinutes: 0,
        }) ?? {
          ...state.positionRules[0]!,
          id: `${flight.id}-rule-${index}`,
          flightNo: flight.flightNo,
          name: position,
          category: "常规",
          remark: "",
          qualifiedStaffIds: [person.id],
          minPassengers: 0,
          manual: false,
          earlyReleaseMinutes: 0,
        }
    )
  );
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.positionTransitionPolicies = [];
  return state;
}

function flight(
  id: string,
  flightNo: string,
  startTime: string,
  endTime: string,
  positions: string[]
): Flight {
  return {
    id,
    flightNo,
    startTime,
    endTime,
    bookedPassengers: 200,
    positions,
    remark: "",
  };
}

function diagnose(state: ScheduleGenerationFacts) {
  const date = "2026-08-03";
  const preparation = prepareSchedule(
    state,
    date,
    evaluateAutomaticHardConstraints
  );
  const model = buildDailyScheduleModel({
    state,
    date,
    preparation,
    timeoutMs: 150_000,
  })!;
  return diagnoseDailyScheduleFailure({ state, preparation, model });
}

describe("daily schedule failure diagnostics", () => {
  it("names only the half-rest worker who has no allowed-period position", async () => {
    const state = stateFor([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "PM200", "14:00", "16:00", ["B1"]),
    ]);
    state.staff[0]!.name = "人员甲";
    state.staff[0]!.teamLeader = false;
    const blockedWorker = {
      ...state.staff[0]!,
      id: "blocked-worker",
      name: "人员乙",
    };
    state.staff.push(blockedWorker);
    state.positionRules.find(
      (rule) => rule.flightNo === "PM200"
    )!.qualifiedStaffIds = [state.staff[0]!.id, blockedWorker.id];
    const preparation = prepareSchedule(
      state,
      "2026-08-03",
      evaluateAutomaticHardConstraints,
      {
        halfRestStaffIds: [state.staff[0]!.id, blockedWorker.id],
        halfRestModes: {
          [state.staff[0]!.id]: "late-start",
          [blockedWorker.id]: "early-finish",
        },
      }
    );
    const solver: SolverPort = {
      async solve() {
        return {
          termination: "infeasible" as const,
          selectedVariableIds: new Set<string>(),
          objectiveValues: new Map<string, number>(),
        };
      },
    };

    const failure = optimizeDailySchedule({
      solver,
      state,
      date: "2026-08-03",
      preparation,
    });

    await expect(failure).rejects.toThrow(
      "人员乙选择了下午半休，当前上午没有能上的岗位，允许当天无岗。这不会单独阻止整张班表生成"
    );
    await expect(failure).rejects.not.toThrow(/人员甲.*冲突/);
  });

  it("explains when a strict recovery target has no remaining candidate", () => {
    const state = stateFor(
      [flight("target", "CX937", "06:00", "08:00", ["G18"])],
      (rule) => ({ ...rule, remark: "控制" })
    );
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "strict-control",
        enabled: true,
        flightNo: "CX937",
        positionKeyword: "控制",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-one",
        enabled: true,
        flightNo: "TR121",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.history = [
      {
        id: "previous",
        date: "2026-08-02",
        flightNo: "TR121",
        position: "H02",
        staffId: "worker",
        staffName: "测试人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    const diagnosis = diagnose(state);
    expect(diagnosis.join(" ")).toContain("CX937/G18");
    expect(diagnosis.join(" ")).toMatch(/严格.*恢复|优先避开|次班恢复/);
    expect(diagnosis.join(" ")).toContain("允许留空");
    expect(diagnosis.join(" ")).toContain("需要检查程序");
  });

  it("points to the actual task when mandatory strict targets compete for one person", () => {
    const state = stateFor(
      [
        flight("first", "AA100", "08:00", "10:00", ["G01"]),
        flight("second", "BB200", "09:00", "11:00", ["G02"]),
      ],
      (rule) => ({ ...rule, remark: "控制" })
    );
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "strict-aa",
        enabled: true,
        flightNo: "AA100",
        positionKeyword: "控制",
      },
      {
        id: "strict-bb",
        enabled: true,
        flightNo: "BB200",
        positionKeyword: "控制",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-one",
        enabled: true,
        flightNo: "TR121",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.history = [
      {
        id: "previous",
        date: "2026-08-02",
        flightNo: "TR121",
        position: "H02",
        staffId: "previous-worker",
        staffName: "测试人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    const diagnosis = diagnose(state);
    expect(diagnosis.join(" ")).toMatch(/AA100\/G01|BB200\/G02/);
    expect(diagnosis.join(" ")).toMatch(/时间冲突|衔接|不能同时/);
  });

  it("surfaces the same actionable facts through the optimizer failure path", async () => {
    const state = stateFor(
      [flight("target", "CX937", "06:00", "08:00", ["G18"])],
      (rule) => ({ ...rule, remark: "控制" })
    );
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "strict-control",
        enabled: true,
        flightNo: "CX937",
        positionKeyword: "控制",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-one",
        enabled: true,
        flightNo: "TR121",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.history = [
      {
        id: "previous",
        date: "2026-08-02",
        flightNo: "TR121",
        position: "H02",
        staffId: "worker",
        staffName: "测试人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];
    const preparation = prepareSchedule(
      state,
      "2026-08-03",
      evaluateAutomaticHardConstraints
    );
    const solver: SolverPort = {
      async solve() {
        return {
          termination: "infeasible" as const,
          selectedVariableIds: new Set<string>(),
          objectiveValues: new Map<string, number>(),
        };
      },
    };

    await expect(
      optimizeDailySchedule({
        solver,
        state,
        date: "2026-08-03",
        preparation,
      })
    ).rejects.toThrow(/CX937\/G18.*严格次班恢复.*允许留空/);
  });

  it("identifies the daily-hours setting when one person is mandatory for multiple strict tasks", () => {
    const state = stateFor(
      [
        flight("first", "AA100", "06:00", "13:00", ["G01"]),
        flight("second", "BB200", "14:00", "21:00", ["G02"]),
      ],
      (rule) => ({ ...rule, remark: "控制" })
    );
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.maxDailyHours = 12;
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "strict-aa",
        enabled: true,
        flightNo: "AA100",
        positionKeyword: "控制",
      },
      {
        id: "strict-bb",
        enabled: true,
        flightNo: "BB200",
        positionKeyword: "控制",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-one",
        enabled: true,
        flightNo: "TR121",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.history = [
      {
        id: "previous",
        date: "2026-08-02",
        flightNo: "TR121",
        position: "H02",
        staffId: "previous-worker",
        staffName: "上一班人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    const message = diagnose(state).join(" ");

    expect(message).toMatch(/AA100\/G01.*BB200\/G02/);
    expect(message).toContain("14.00 小时");
    expect(message).toContain("每日 12 小时上限");
    expect(message).toMatch(/增加.*合格人员|调整.*时段|工时上限配置/);
  });
});
