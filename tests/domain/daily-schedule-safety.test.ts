import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { generateSchedule } from "../../src/domain/kernel/scheduling-kernel";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";
import type { AssignmentTask } from "../../src/domain/flights/schedule-tasks";
import type {
  AppState,
  Assignment,
  Flight,
  PositionRule,
} from "../../src/model";
import type {
  SolverPort,
  SolverProblem,
} from "../../src/domain/solver/solver-port";

class TimeLimitedCompleteScheduleSolver implements SolverPort {
  async solve(problem: SolverProblem) {
    const stopped = problem.objectives.find(
      (objective) => objective.optimality === "best-effort"
    )!;
    return {
      termination: "time-limited-feasible" as const,
      selectedVariableIds: new Set(
        problem.variables
          .filter((variable) => variable.id.startsWith("vacancy:"))
          .map((variable) => variable.id)
      ),
      objectiveValues: new Map<string, number>(),
      bestEffort: {
        stoppedAtObjectiveId: stopped.id,
        completedObjectiveIds: problem.objectives
          .filter((objective) => objective.optimality !== "best-effort")
          .map((objective) => objective.id),
        solutionSource: "current-incumbent" as const,
      },
    };
  }
}

function finalSafetyFixture(kind: "ke166" | "team-leader") {
  const state = createDefaultState();
  const person = {
    ...state.staff[0]!,
    id: "qualified-worker",
    name: "测试人员",
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: kind === "team-leader",
    nightShift: true,
  };
  state.staff = [person];
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.positionTransitionPolicies = [];
  state.settings.minimumRegularTransitionMinutes = 0;

  const flights: Flight[] =
    kind === "ke166"
      ? [
          {
            id: "ke",
            flightNo: "KE166",
            startTime: "20:00",
            endTime: "22:00",
            bookedPassengers: 200,
            positions: ["H02", "机动督导"],
            remark: "",
          },
        ]
      : [
          {
            id: "left",
            flightNo: "AA100",
            startTime: "08:00",
            endTime: "10:00",
            bookedPassengers: 200,
            positions: ["督导"],
            remark: "",
          },
          {
            id: "right",
            flightNo: "BB200",
            startTime: "09:30",
            endTime: "11:30",
            bookedPassengers: 200,
            positions: ["督导"],
            remark: "",
          },
        ];
  const rules: PositionRule[] = flights.flatMap((flight, flightIndex) =>
    flight.positions.map((position, positionIndex) => ({
      id: `rule-${flightIndex}-${positionIndex}`,
      flightNo: flight.flightNo,
      name: position,
      category:
        kind === "ke166" && position === "机动督导"
          ? ("机动督导" as const)
          : ("常规" as const),
      remark: position,
      qualifiedStaffIds: [person.id],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }))
  );
  state.flights = flights;
  state.positionRules = rules;
  const tasks: AssignmentTask[] = rules.map((rule) => {
    const flight = flights.find((item) => item.flightNo === rule.flightNo)!;
    return { key: `${flight.id}:${rule.id}`, flight, rule };
  });
  const concurrencyDecision = schedulingDecision(
    "team-leader-concurrent-supervision",
    "selected",
    "分队长并行督导补缺已通过安全重排"
  );
  const assignments: Assignment[] = tasks.map((task, index) => ({
    id: kind === "ke166" && index === 1 ? "supervisor" : `assignment-${index}`,
    flightId: task.flight.id,
    flightNo: task.flight.flightNo,
    positionRuleId: task.rule.id,
    position: task.rule.name,
    staffId: person.id,
    staffName: person.name,
    startTime: task.flight.startTime,
    endTime: task.flight.endTime,
    workHours: kind === "ke166" && index === 0 ? 0 : 2,
    fatiguePoints: 1,
    remark: task.rule.remark,
    manualRemark: "",
    status: "assigned",
    ...(kind === "team-leader" ? { decisionTrace: [concurrencyDecision] } : {}),
  }));
  if (kind === "ke166")
    assignments[0]!.supervisorSourceAssignmentId = "supervisor";
  return { state: state as AppState, tasks, assignments };
}

describe("daily schedule final safety review", () => {
  it("allows a later same-airline control or number-one assignment after post-review changes", () => {
    const state = createDefaultState();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    const person = {
      ...state.staff[0]!,
      id: "same-airline-worker",
      name: "同航司人员",
      status: "正常" as const,
      staffType: "常规" as const,
      nightShift: true,
    };
    state.staff = [person];
    state.flights = [
      {
        id: "fd-morning",
        flightNo: "FD101",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 200,
        positions: ["G18"],
        remark: "",
      },
      {
        id: "fd-later",
        flightNo: "FD202",
        startTime: "15:00",
        endTime: "17:00",
        bookedPassengers: 200,
        positions: ["G20"],
        remark: "",
      },
    ];
    state.positionRules = state.flights.map((flight, index) => ({
      id: `fd-rule-${index}`,
      flightNo: flight.flightNo,
      name: flight.positions[0]!,
      category: "常规" as const,
      remark: index === 0 ? "控制" : "一号",
      qualifiedStaffIds: [person.id],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const tasks: AssignmentTask[] = state.positionRules.map((rule) => {
      const flight = state.flights.find(
        (item) => item.flightNo === rule.flightNo
      )!;
      return { key: `${flight.id}:${rule.id}`, flight, rule };
    });
    const assignments: Assignment[] = tasks
      .map<Assignment>((task, index) => ({
        id: `fd-assignment-${index}`,
        flightId: task.flight.id,
        flightNo: task.flight.flightNo,
        positionRuleId: task.rule.id,
        position: task.rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: task.flight.startTime,
        endTime: task.flight.endTime,
        workHours: 2,
        fatiguePoints: 1,
        remark: task.rule.remark,
        manualRemark: "",
        status: "assigned",
      }))
      .reverse();

    expect(() =>
      assertDailyScheduleSafety({
        state,
        date: "2026-08-13",
        tasks,
        assignments,
        evaluateEligibility: evaluateAutomaticHardConstraints,
      })
    ).not.toThrow();
  });

  it.each(["ke166", "team-leader"] as const)(
    "accepts the existing %s controlled concurrency after finalization",
    (kind) => {
      const fixture = finalSafetyFixture(kind);

      expect(() =>
        assertDailyScheduleSafety({
          ...fixture,
          date: "2026-08-13",
          evaluateEligibility: evaluateAutomaticHardConstraints,
          allowFinalizedConcurrency: true,
        })
      ).not.toThrow();
    }
  );

  it("still rejects the same overlapping assignments before a controlled exception is finalized", () => {
    const fixture = finalSafetyFixture("team-leader");

    expect(() =>
      assertDailyScheduleSafety({
        ...fixture,
        date: "2026-08-13",
        evaluateEligibility: evaluateAutomaticHardConstraints,
      })
    ).toThrow("最终安全复核未通过");
  });

  it("rejects a final morning assignment for a late-start half-rest worker", () => {
    const state = createDefaultState();
    const person = {
      ...state.staff[0]!,
      id: "half-rest-worker",
      name: "half-rest-worker",
      nightShift: true,
    };
    state.staff = [person as (typeof state.staff)[number]];
    state.flights = [
      {
        id: "morning",
        flightNo: "AM100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: ["A1"],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "morning-rule",
        flightNo: "AM100",
        name: "A1",
        qualifiedStaffIds: [person.id],
      },
    ];
    const task: AssignmentTask = {
      key: "morning:morning-rule",
      flight: state.flights[0]!,
      rule: state.positionRules[0]!,
    };
    const assignment: Assignment = {
      id: "morning-assignment",
      flightId: "morning",
      flightNo: "AM100",
      positionRuleId: "morning-rule",
      position: "A1",
      staffId: person.id,
      staffName: person.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    expect(() =>
      assertDailyScheduleSafety({
        state,
        date: "2026-08-13",
        tasks: [task],
        assignments: [assignment],
        evaluateEligibility: () => ({ eligible: true, violations: [] }),
        halfRestFacts: {
          requestedStaffIds: [person.id],
          activeStaffIds: new Set([person.id]),
          minimumWorkStaffIds: new Set([person.id]),
          ignoredWarnings: [],
          modesByStaffId: new Map([[person.id, "late-start"]]),
          earlyFinishStaffIds: new Set(),
          lateStartStaffIds: new Set([person.id]),
        },
      })
    ).toThrow("半休时段");
  });

  it("rejects an all-day-empty non-team-leader half-rest result", () => {
    const state = createDefaultState();
    const person = {
      ...state.staff[0]!,
      id: "half-rest-worker",
      name: "half-rest-worker",
      teamLeader: false,
    };
    state.staff = [person];
    state.flights = [
      {
        id: "morning",
        flightNo: "AM100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: ["A1"],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "morning-rule",
        flightNo: "AM100",
        name: "A1",
        qualifiedStaffIds: [person.id],
      },
    ];
    const task: AssignmentTask = {
      key: "morning:morning-rule",
      flight: state.flights[0]!,
      rule: state.positionRules[0]!,
    };
    const assignment: Assignment = {
      id: "morning-assignment",
      flightId: "morning",
      flightNo: "AM100",
      positionRuleId: "morning-rule",
      position: "A1",
      staffId: null,
      staffName: "",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    };
    expect(() =>
      assertDailyScheduleSafety({
        state,
        date: "2026-08-13",
        tasks: [task],
        assignments: [assignment],
        evaluateEligibility: () => ({ eligible: true, violations: [] }),
        halfRestFacts: {
          requestedStaffIds: [person.id],
          activeStaffIds: new Set([person.id]),
          minimumWorkStaffIds: new Set([person.id]),
          ignoredWarnings: [],
          modesByStaffId: new Map([[person.id, "late-start"]]),
          earlyFinishStaffIds: new Set(),
          lateStartStaffIds: new Set([person.id]),
        },
      })
    ).toThrow("必须至少安排一个");
  });

  it("allows an all-day-empty team-leader half-rest result", () => {
    const state = createDefaultState();
    const person = {
      ...state.staff[0]!,
      id: "team-leader",
      name: "team-leader",
      teamLeader: true,
    };
    state.staff = [person];
    state.flights = [
      {
        id: "morning",
        flightNo: "AM100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: ["A1"],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "morning-rule",
        flightNo: "AM100",
        name: "A1",
        qualifiedStaffIds: [person.id],
      },
    ];
    const task: AssignmentTask = {
      key: "morning:morning-rule",
      flight: state.flights[0]!,
      rule: state.positionRules[0]!,
    };
    const assignment: Assignment = {
      id: "morning-assignment",
      flightId: "morning",
      flightNo: "AM100",
      positionRuleId: "morning-rule",
      position: "A1",
      staffId: null,
      staffName: "",
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    };
    expect(() =>
      assertDailyScheduleSafety({
        state,
        date: "2026-08-13",
        tasks: [task],
        assignments: [assignment],
        evaluateEligibility: () => ({ eligible: true, violations: [] }),
        halfRestFacts: {
          requestedStaffIds: [person.id],
          activeStaffIds: new Set([person.id]),
          minimumWorkStaffIds: new Set(),
          ignoredWarnings: [],
          modesByStaffId: new Map([[person.id, "late-start"]]),
          earlyFinishStaffIds: new Set(),
          lateStartStaffIds: new Set([person.id]),
        },
      })
    ).not.toThrow();
  });

  it("keeps a time-limited schedule usable when coverage cannot give every worker a shift", async () => {
    const state = createDefaultState();
    const workers = [
      {
        ...state.staff[0]!,
        id: "worker-a",
        name: "测试甲",
        status: "正常" as const,
        staffType: "常规" as const,
        teamLeader: false,
        dutyQualified: false,
        nightShift: true,
      },
      {
        ...state.staff[0]!,
        id: "worker-b",
        name: "测试乙",
        status: "正常" as const,
        staffType: "常规" as const,
        teamLeader: false,
        dutyQualified: false,
        nightShift: true,
      },
    ];
    state.staff = workers;
    state.history = [];
    state.dutyRosterOverrides = [];
    state.settings.positionTransitionPolicies = [];
    state.flights = ["AA100", "BB200", "CC300", "DD400"].map(
      (flightNo, index) => ({
        id: `flight-${index}`,
        flightNo,
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 200,
        positions: [`P${index + 1}`],
        remark: "",
      })
    );
    state.positionRules = state.flights.map((flight, index) => ({
      id: `rule-${index}`,
      flightNo: flight.flightNo,
      name: flight.positions[0]!,
      category: "常规" as const,
      remark: "",
      qualifiedStaffIds: workers.map((person) => person.id),
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));

    const result = await generateSchedule(state, "2026-08-03", {
      solver: new TimeLimitedCompleteScheduleSolver(),
    });

    expect(result.unfilledCount).toBe(4);
    expect(result.assignments).toHaveLength(4);
    expect(
      result.assignments.every((assignment) => assignment.status === "unfilled")
    ).toBe(true);
    expect(result.safetyCredential?.phase).toBe("final");
  });
});
