import { describe, expect, it, vi } from "vitest";

import { buildDailyScheduleModel } from "../../src/domain/kernel/daily-schedule-model";
import { optimizeDailySchedule } from "../../src/domain/kernel/daily-schedule-optimizer";
import { materializeDailySchedulePlan } from "../../src/domain/kernel/daily-schedule-result";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import {
  createHalfRestFacts,
  excludeCandidateForHalfRest,
} from "../../src/domain/rules/half-rest";
import type { CandidatePriority } from "../../src/domain/candidates/candidate-priority";
import type {
  SolverPort,
  SolverProblem,
} from "../../src/domain/solver/solver-port";
import type { Flight, PositionRule } from "../../src/model";
import type { ScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type { ScheduleRunPreferences } from "../../src/domain/shared/schedule-run-preferences";
import { createSchedulingScenario } from "../helpers/scheduling-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { groupStaffFlightsByNormalizedNumber } from "../../src/domain/statistics/staff-flight-count";

class ModelCaptured extends Error {}

class CapturingSolver implements SolverPort {
  problem: SolverProblem | undefined;

  async solve(problem: SolverProblem): Promise<never> {
    this.problem = problem;
    throw new ModelCaptured();
  }
}

class TimeLimitedFairnessSolver implements SolverPort {
  async solve(problem: SolverProblem) {
    const stoppedObjective = problem.objectives.find(
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
        stoppedAtObjectiveId: stoppedObjective.id,
        completedObjectiveIds: problem.objectives
          .filter((objective) => objective.optimality !== "best-effort")
          .map((objective) => objective.id),
        solutionSource: "current-incumbent" as const,
      },
    };
  }
}

class IncompleteRequiredFairnessSolver implements SolverPort {
  async solve(problem: SolverProblem) {
    return {
      termination: "time-limited-feasible" as const,
      selectedVariableIds: new Set([problem.variables[0]!.id]),
      objectiveValues: new Map<string, number>(),
      bestEffort: {
        stoppedAtObjectiveId: "candidate:workload-balance:target",
        completedObjectiveIds: [],
        solutionSource: "current-incumbent" as const,
      },
    };
  }
}

class DuplicateTaskSelectionSolver implements SolverPort {
  async solve(problem: SolverProblem) {
    return {
      termination: "optimal" as const,
      selectedVariableIds: new Set(
        problem.variables
          .filter((variable) => variable.id.startsWith("staff:"))
          .map((variable) => variable.id)
      ),
      objectiveValues: new Map<string, number>(),
    };
  }
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

function modelState(
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
  const baseRule = state.positionRules[0]!;
  state.staff = [person];
  state.flights = [...flights];
  state.positionRules = flights.flatMap((ownFlight) =>
    ownFlight.positions.map((position, index) => {
      const rule: PositionRule = {
        ...baseRule,
        id: `${ownFlight.id}-rule-${index}`,
        flightNo: ownFlight.flightNo,
        name: position,
        category: "常规",
        remark: "",
        qualifiedStaffIds: [person.id],
        fatiguePoints: 1,
        minPassengers: 0,
        earlyReleaseMinutes: 0,
        manual: false,
      };
      return ruleOptions?.(rule) ?? rule;
    })
  );
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.positionTransitionPolicies = [];
  return state;
}

async function captureProblem(
  state: ScheduleGenerationFacts,
  preferences?: ScheduleRunPreferences
): Promise<SolverProblem> {
  const date = "2026-08-03";
  const solver = new CapturingSolver();
  const preparation = prepareSchedule(
    state,
    date,
    evaluateAutomaticHardConstraints,
    preferences
  );

  await expect(
    optimizeDailySchedule({ solver, state, date, preparation })
  ).rejects.toBeInstanceOf(ModelCaptured);
  return solver.problem!;
}

describe("daily schedule module interfaces", () => {
  it("prefers allowed-period half-rest work without requiring impossible participation", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
    ]);
    state.staff[0]!.teamLeader = false;
    const problem = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
      halfRestModes: { [state.staff[0]!.id]: "late-start" },
    });

    expect(
      problem.constraints.some((item) =>
        item.id.startsWith("half-rest:minimum-work:")
      )
    ).toBe(false);
    expect(
      problem.objectives.some(
        (item) => item.id === "half-rest-morning:participation"
      )
    ).toBe(true);
    expect(problem.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `half-rest:morning-work:${state.staff[0]!.id}`,
          upperBound: 0,
        }),
      ])
    );
  });

  it("allows a team leader selected for half-rest to have no allowed-period assignment", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
    ]);
    state.staff[0]!.teamLeader = false;
    state.staff[0]!.teamLeader = true;
    const problem = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
      halfRestModes: { [state.staff[0]!.id]: "late-start" },
    });

    expect(
      problem.constraints.some(
        (constraint) =>
          constraint.id === `half-rest:minimum-work:${state.staff[0]!.id}`
      )
    ).toBe(false);
  });

  it("does not silently ignore the duty worker when half-rest is selected", () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
    ]);
    const facts = createHalfRestFacts(
      state,
      {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "early-finish" },
      },
      state.staff[0]!.id
    );

    expect(facts.activeStaffIds).toContain(state.staff[0]!.id);
    expect(facts.ignoredWarnings).toEqual([]);
  });

  it("assigns late-start half-rest staff to an eligible afternoon flight", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "PM200", "14:00", "17:00", ["B1"]),
      flight("late", "PM300", "20:00", "23:30", ["C1"]),
    ]);
    const regular = {
      ...state.staff[0]!,
      id: "regular-worker",
      name: "常规人员",
    };
    state.staff.push(regular);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });

    const result = await generateSchedule(state, "2026-08-03", {
      preferences: {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "late-start" },
      },
    });
    const ownFlights = result.assignments
      .filter((assignment) => assignment.staffId === state.staff[0]!.id)
      .map((assignment) => assignment.flightNo);

    expect(ownFlights).toEqual(
      expect.arrayContaining([expect.stringMatching(/^PM(?:200|300)$/)])
    );
    expect(ownFlights).not.toContain("AM100");
  });

  it("does not apply the early-finish objective to late-start staff", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "PM200", "14:00", "17:00", ["B1"]),
      flight("late", "PM300", "20:00", "23:30", ["C1"]),
    ]);
    const regular = {
      ...state.staff[0]!,
      id: "regular-worker",
      name: "常规人员",
    };
    state.staff.push(regular);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });

    const problem = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
      halfRestModes: { [state.staff[0]!.id]: "late-start" },
    });
    const objectiveIds = problem.objectives.map((objective) => objective.id);

    expect(objectiveIds).not.toContain("half-rest-early-finish:latest-end");
  });

  it("allows a late-start half-rest worker on a 12:00-to-17:00 flight", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "PM200", "12:00", "17:00", ["B1"]),
    ]);
    const regular = {
      ...state.staff[0]!,
      id: "regular-worker",
      name: "常规人员",
    };
    state.staff.push(regular);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });

    const result = await generateSchedule(state, "2026-08-03", {
      preferences: {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "late-start" },
      },
    });
    expect(
      result.assignments.some(
        (assignment) =>
          assignment.flightNo === "PM200" &&
          assignment.staffId === state.staff[0]!.id
      )
    ).toBe(true);
  });

  it("keeps the late-start half-rest worker out of pre-noon flights", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "PM200", "12:00", "17:00", ["B1"]),
    ]);
    const result = await generateSchedule(state, "2026-08-03", {
      preferences: {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "late-start" },
      },
    });
    expect(
      result.assignments.some(
        (assignment) =>
          assignment.flightNo === "AM100" &&
          assignment.staffId === state.staff[0]!.id
      )
    ).toBe(false);
  });

  it("backfills a morning vacancy while preserving the late-start worker's later shifts", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("evening", "PM200", "18:00", "20:00", ["B1"]),
      flight("overnight", "AM300", "01:00", "03:00", ["C1"]),
    ]);
    const halfRestWorker = state.staff[0]!;
    halfRestWorker.id = "half-rest-worker";
    halfRestWorker.name = "叶琳";
    halfRestWorker.teamLeader = false;
    const regularWorker = {
      ...halfRestWorker,
      id: "morning-backfill",
      name: "上午补位",
    };
    state.staff = [halfRestWorker, regularWorker];
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds =
        rule.flightNo === "AM100" ? [regularWorker.id] : [halfRestWorker.id];
    });

    const result = await generateSchedule(state, "2026-09-14", {
      preferences: {
        halfRestStaffIds: [halfRestWorker.id],
        halfRestModes: { [halfRestWorker.id]: "late-start" },
      },
    });

    expect(
      result.assignments.find((assignment) => assignment.flightNo === "AM100")
    ).toMatchObject({ staffId: regularWorker.id, status: "assigned" });
    expect(
      result.assignments.find((assignment) => assignment.flightNo === "PM200")
    ).toMatchObject({ staffId: halfRestWorker.id, status: "assigned" });
    expect(
      result.assignments.find((assignment) => assignment.flightNo === "AM300")
    ).toMatchObject({ staffId: halfRestWorker.id, status: "assigned" });
  });

  it("keeps half-rest participation as an objective for non-team-leaders", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "PM200", "12:00", "17:00", ["B1"]),
    ]);
    state.staff[0]!.teamLeader = false;
    const problem = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
      halfRestModes: { [state.staff[0]!.id]: "late-start" },
    });
    expect(
      problem.constraints.some((item) =>
        item.id.startsWith("half-rest:minimum-work:")
      )
    ).toBe(false);
    expect(
      problem.objectives.some(
        (item) => item.id === "half-rest-morning:participation"
      )
    ).toBe(true);
  });

  it("does not add recovery exclusion to late-start afternoon candidates", () => {
    const state = modelState([
      flight("afternoon", "PM200", "12:00", "17:00", ["B1"]),
    ]);
    const staffId = state.staff[0]!.id;
    const facts = createHalfRestFacts(
      state,
      {
        halfRestStaffIds: [staffId],
        halfRestModes: { [staffId]: "late-start" },
      },
      null
    );
    const priority = {
      lateShiftRecovery: {
        protectedMorningTarget: false,
        protectedLatePriorityTarget: true,
      },
      lateShiftCutoff: {
        disposition: "after-cutoff",
        cutoffMinutes: 900,
        previousEndMinutes: 1435,
      },
    } as CandidatePriority;

    expect(
      excludeCandidateForHalfRest({
        facts,
        staffId,
        preNoon: false,
        priority,
      })
    ).toBe(false);
  });

  it("keeps late-start staff out of morning work when no afternoon flight exists", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
    ]);
    state.staff[0]!.teamLeader = false;
    const preparation = prepareSchedule(
      state,
      "2026-08-03",
      evaluateAutomaticHardConstraints,
      {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "late-start" },
      }
    );

    expect(preparation.runFacts.halfRest.activeStaffIds).toContain(
      state.staff[0]!.id
    );
    const result = await generateSchedule(state, "2026-08-03", {
      preferences: {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "late-start" },
      },
    });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.status).toBe("unfilled");
    expect(result.warnings.join("；")).toContain("没有可合法承担的午后岗位");
    expect(result.safetyCredential).toBeDefined();
  });

  it("keeps early-finish staff out of afternoon work when no morning flight exists", async () => {
    const state = modelState([
      flight("afternoon", "PM200", "14:00", "16:00", ["B1"]),
    ]);
    state.staff[0]!.teamLeader = false;
    state.staff[0]!.teamLeader = false;
    const result = await generateSchedule(state, "2026-08-03", {
      preferences: {
        halfRestStaffIds: [state.staff[0]!.id],
        halfRestModes: { [state.staff[0]!.id]: "early-finish" },
      },
    });
    expect(result.assignments[0]!.status).toBe("unfilled");
    expect(result.warnings.join("；")).toContain("没有可合法承担的12点前岗位");
  });

  it("gives every feasible half-rest worker morning work and leaves later shortages explicit", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1", "A2"]),
      flight("afternoon", "PM200", "14:00", "16:00", ["B1", "B2"]),
    ]);
    const secondHalfRest = {
      ...state.staff[0]!,
      id: "half-rest-2",
      name: "半休乙",
    };
    const regular = {
      ...state.staff[0]!,
      id: "regular-worker",
      name: "常规丙",
    };
    state.staff[0]!.name = "半休甲";
    state.staff.push(secondHalfRest, regular);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });

    const baseline = await generateSchedule(state, "2026-08-03");
    const result = await generateSchedule(state, "2026-08-03", {
      preferences: {
        halfRestStaffIds: [state.staff[0]!.id, secondHalfRest.id],
      },
    });
    const selectedIds = new Set([state.staff[0]!.id, secondHalfRest.id]);
    const selectedAssignments = result.assignments.filter(
      (assignment) => assignment.staffId && selectedIds.has(assignment.staffId)
    );
    const halfRestVacancy = result.assignments.find(
      (assignment) =>
        assignment.flightNo === "PM200" && assignment.status === "unfilled"
    );

    expect(baseline.unfilledCount).toBe(0);
    expect(result.unfilledCount).toBe(1);
    expect(
      selectedAssignments
        .filter((assignment) => assignment.startTime.localeCompare("12:00") < 0)
        .map((assignment) => assignment.staffId)
    ).toEqual(expect.arrayContaining([...selectedIds]));
    expect(
      selectedAssignments.every(
        (assignment) => assignment.startTime.localeCompare("12:00") < 0
      )
    ).toBe(true);
    expect(halfRestVacancy?.systemNotes?.join("；")).toContain("半休");
    expect(result.warnings.join("；")).toContain("半休甲、半休乙");
  });

  it("uses a recovery-protected regular worker to backfill a half-rest vacancy", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("late", "PM200", "15:00", "17:00", ["B1"]),
    ]);
    const recovering = {
      ...state.staff[0]!,
      id: "recovering-worker",
      name: "恢复人员",
    };
    state.staff[0]!.name = "半休人员";
    state.staff.push(recovering);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-number-one-cutoff",
        enabled: true,
        flightNo: "OLD900",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "12:00",
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-08-01",
        flightNo: "OLD900",
        position: "H02",
        staffId: recovering.id,
        staffName: recovering.name,
        startTime: "21:00",
        endTime: "23:30",
        workHours: 2.5,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];

    const result = await generateSchedule(state, "2026-08-03", {
      preferences: { halfRestStaffIds: [state.staff[0]!.id] },
    });
    const late = result.assignments.find(
      (assignment) => assignment.flightNo === "PM200"
    );

    expect(late).toMatchObject({
      status: "assigned",
      staffId: recovering.id,
      staffName: recovering.name,
      decisionTrace: expect.arrayContaining([
        expect.objectContaining({
          ruleId: "late-shift-cutoff",
          outcome: "fallback",
        }),
      ]),
    });
    expect(
      late?.decisionTrace?.map((item) => item.message).join("；")
    ).toContain("半休");
    expect(result.unfilledCount).toBe(0);
  });

  it("lets strict recovery yield only to backfill a half-rest vacancy", async () => {
    const state = modelState(
      [
        flight("morning", "AM100", "08:00", "10:00", ["A1"]),
        flight("late", "PM200", "15:00", "17:00", ["B1"]),
      ],
      (rule) => (rule.flightNo === "PM200" ? { ...rule, remark: "控制" } : rule)
    );
    const recovering = {
      ...state.staff[0]!,
      id: "recovering-worker",
      name: "严格恢复人员",
    };
    state.staff[0]!.name = "半休人员";
    state.staff.push(recovering);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "strict-control",
        enabled: true,
        flightNo: "PM200",
        positionKeyword: "控制",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-number-one",
        enabled: true,
        flightNo: "OLD900",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-08-01",
        flightNo: "OLD900",
        position: "H02",
        staffId: recovering.id,
        staffName: recovering.name,
        startTime: "21:00",
        endTime: "23:30",
        workHours: 2.5,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];

    const result = await generateSchedule(state, "2026-08-03", {
      preferences: { halfRestStaffIds: [state.staff[0]!.id] },
    });
    const late = result.assignments.find(
      (assignment) => assignment.flightNo === "PM200"
    );

    expect(late).toMatchObject({
      status: "assigned",
      staffId: recovering.id,
      staffName: recovering.name,
      decisionTrace: expect.arrayContaining([
        expect.objectContaining({
          ruleId: "strict-next-workday-recovery",
          outcome: "fallback",
        }),
      ]),
    });
    expect(
      late?.decisionTrace?.map((item) => item.message).join("；")
    ).toContain("半休");
    expect(result.unfilledCount).toBe(0);

    const available = {
      ...state.staff[0]!,
      id: "available-worker",
      name: "正常补位人员",
    };
    state.staff.push(available);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds.push(available.id);
    });
    const resultWithAlternative = await generateSchedule(state, "2026-08-03", {
      preferences: { halfRestStaffIds: [state.staff[0]!.id] },
    });
    const lateWithAlternative = resultWithAlternative.assignments.find(
      (assignment) => assignment.flightNo === "PM200"
    );

    expect(lateWithAlternative).toMatchObject({
      status: "assigned",
      staffId: available.id,
      staffName: available.name,
    });
    expect(
      lateWithAlternative?.decisionTrace?.some(
        (item) => item.ruleId === "strict-next-workday-recovery"
      )
    ).toBe(false);
  });

  it("keeps recovery when another regular worker can backfill the half-rest vacancy", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("late", "PM200", "15:00", "17:00", ["B1"]),
    ]);
    const recovering = {
      ...state.staff[0]!,
      id: "recovering-worker",
      name: "恢复人员",
    };
    const available = {
      ...state.staff[0]!,
      id: "available-worker",
      name: "正常补位人员",
    };
    state.staff[0]!.name = "半休人员";
    state.staff.push(recovering, available);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous-number-one-cutoff",
        enabled: true,
        flightNo: "OLD900",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "12:00",
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-08-01",
        flightNo: "OLD900",
        position: "H02",
        staffId: recovering.id,
        staffName: recovering.name,
        startTime: "21:00",
        endTime: "23:30",
        workHours: 2.5,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];

    const result = await generateSchedule(state, "2026-08-03", {
      preferences: { halfRestStaffIds: [state.staff[0]!.id] },
    });
    const late = result.assignments.find(
      (assignment) => assignment.flightNo === "PM200"
    );

    expect(late).toMatchObject({
      status: "assigned",
      staffId: available.id,
      staffName: available.name,
    });
    expect(
      result.assignments.some(
        (assignment) => assignment.staffId === recovering.id
      )
    ).toBe(false);
  });

  it("adds bounded half-rest variables and objectives after recovery", async () => {
    const state = modelState([
      flight("morning", "AM100", "08:00", "10:00", ["A1"]),
      flight("late", "PM200", "14:00", "16:00", ["B1"]),
    ]);
    const problem = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
    });
    const objectiveIds = problem.objectives.map((objective) => objective.id);

    expect(
      problem.variables.filter((variable) =>
        variable.id.startsWith("half-rest:")
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "binary" }),
        expect.objectContaining({ type: "continuous", lowerEnvelope: true }),
      ])
    );
    expect(objectiveIds).toContain("half-rest-morning:participation");
    expect(objectiveIds).toContain("half-rest-early-finish:latest-end");
    expect(
      objectiveIds.indexOf("half-rest-morning:participation")
    ).toBeGreaterThan(objectiveIds.indexOf("candidate:late-shift-cutoff"));
    expect(
      problem.objectives.find(
        (objective) => objective.id === "half-rest-morning:participation"
      )?.optimality
    ).toBe("required");
    expect(
      problem.objectives.find(
        (objective) => objective.id === "half-rest-early-finish:latest-end"
      )?.optimality
    ).toBe("best-effort");
    expect(
      problem.constraints.filter((constraint) =>
        constraint.id.startsWith("half-rest:")
      ).length
    ).toBeLessThanOrEqual(4);
  });

  it("uses the confirmed 150-second deadline for the daily solver", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const problem = await captureProblem(
        modelState([flight("only", "AA100", "08:00", "10:00", ["A1"])])
      );

      expect(problem.timeoutMs).toBe(150_000);
    } finally {
      now.mockRestore();
    }
  });

  it("uses the bounded five-minute deadline for the current manual late-priority ledger", async () => {
    const state = modelState([
      flight("late", "LATE100", "21:00", "23:30", ["H04"]),
    ]);
    state.settings.latePriorityFlightNumbers = ["LATE100"];
    state.positionRules[0]!.remark = "申报";
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: state.staff[0]!.id,
        flightNo: "LATE100",
        kind: "declaration",
        delta: 10,
      },
      {
        month: "2026-07",
        staffId: state.staff[0]!.id,
        flightNo: "LATE100",
        kind: "declaration",
        delta: 10,
      },
    ];
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const problem = await captureProblem(state);
      expect(problem.timeoutMs).toBe(300_000);
      state.latePriorityFrequencyAdjustments =
        state.latePriorityFrequencyAdjustments.filter(
          (adjustment) => adjustment.month === "2026-07"
        );
      const historicalOnlyProblem = await captureProblem(state);
      expect(historicalOnlyProblem.timeoutMs).toBe(150_000);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps strict recovery exclusion but allows the target to remain vacant", () => {
    const date = "2026-08-03";
    const state = modelState(
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
        id: "previous-late",
        date: "2026-08-01",
        flightNo: "TR121",
        position: "H02",
        staffId: "worker",
        staffName: "测试人员",
        startTime: "20:00",
        endTime: "23:55",
        workHours: 3.9,
        fatiguePoints: 8,
        remark: "一号",
      },
    ];
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date,
      preparation,
      timeoutMs: 30_000,
    })!;

    expect(model.staffChoices).toEqual([]);
    expect(
      model.problem.constraints.find(
        (constraint) => constraint.id === "assignment:0"
      )?.terms
    ).toEqual([{ variableId: "vacancy:0", coefficient: 1 }]);
  });

  it("does not force a vacancy when protected staff lack the target qualification", () => {
    const date = "2026-08-03";
    const state = modelState(
      [flight("target", "CX937", "06:00", "08:00", ["G18"])],
      (rule) => ({ ...rule, remark: "控制", qualifiedStaffIds: ["other"] })
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
        id: "previous-late",
        date: "2026-08-01",
        flightNo: "TR121",
        position: "H02",
        staffId: "worker",
        staffName: "测试人员",
        startTime: "20:00",
        endTime: "23:55",
        workHours: 3.9,
        fatiguePoints: 8,
        remark: "一号",
      },
    ];
    state.staff.push({ ...state.staff[0]!, id: "other", name: "合格替代" });
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date,
      preparation,
      timeoutMs: 30_000,
    })!;
    expect(
      model.staffChoices.some((choice) => choice.person.id === "other")
    ).toBe(true);
    expect(
      model.problem.constraints.find(
        (constraint) => constraint.id === "assignment:0"
      )?.terms
    ).toHaveLength(2);
  });

  it("adds a cross-flight protection objective for selected staff on the priority flight", () => {
    const state = modelState([
      flight("ke", "KE166", "08:00", "10:00", ["H02"]),
      flight("cx", "CX931", "08:00", "10:00", ["G20"]),
    ]);
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: ["worker"],
      },
      {
        id: "priority-2",
        enabled: true,
        flightNo: "CX931",
        staffIds: ["worker"],
      },
    ];
    const preparation = prepareSchedule(
      state,
      "2026-08-03",
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date: "2026-08-03",
      preparation,
      timeoutMs: 30_000,
    });
    const objective = model?.problem.objectives.find(
      (item) => item.id === "cross-flight-priority:priority-1"
    );
    const retainedVariableId = objective?.terms[0]?.variableId;
    const retainedConstraint = model?.problem.constraints.find(
      (constraint) => constraint.id === `${retainedVariableId}:selected`
    );
    expect(retainedVariableId).toMatch(/^cross-flight-priority-retained:/);
    expect(
      retainedConstraint?.terms.some(
        (term) =>
          term.coefficient === -1 &&
          model?.staffChoices.find((choice) => choice.id === term.variableId)
            ?.task.flight.flightNo === "KE166"
      )
    ).toBe(true);
    expect(objective?.direction).toBe("maximize");
    state.settings.crossFlightPriorityPolicies = [];
    const withoutPolicy = buildDailyScheduleModel({
      state,
      date: "2026-08-03",
      preparation,
      timeoutMs: 30_000,
    });
    expect(
      withoutPolicy?.problem.objectives.some((item) =>
        item.id.startsWith("cross-flight-priority:")
      )
    ).toBe(false);
  });

  it("counts each selected cross-flight priority person only once across reusable assignments", () => {
    const state = modelState([
      flight("ke", "KE166", "08:00", "10:00", ["H03", "H04"]),
      flight("cx", "CX937", "08:00", "10:00", ["G18"]),
    ]);
    state.staff.push({
      ...state.staff[0]!,
      id: "worker-2",
      name: "另一名优先人员",
    });
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = ["worker", "worker-2"];
    });
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: ["worker", "worker-2"],
      },
    ];

    const preparation = prepareSchedule(
      state,
      "2026-10-14",
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date: "2026-10-14",
      preparation,
      timeoutMs: 30_000,
    })!;
    const objective = model.problem.objectives.find(
      (item) => item.id === "cross-flight-priority:priority-1"
    );

    expect(objective?.terms).toHaveLength(2);
    objective?.terms.forEach((term) => {
      expect(
        model.problem.variables.find(
          (variable) => variable.id === term.variableId
        )
      ).toMatchObject({ lowerBound: 0, upperBound: 1 });
    });
  });

  it("assigns selected staff to the priority flight instead of an overlapping alternative", async () => {
    const state = modelState([
      flight("ke", "KE166", "08:00", "10:00", ["H02"]),
      flight("cx", "CX931", "08:00", "10:00", ["G20"]),
    ]);
    state.staff.push({ ...state.staff[0]!, id: "worker-2", name: "替代人员" });
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = ["worker", "worker-2"];
    });
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: ["worker"],
      },
      {
        id: "priority-2",
        enabled: true,
        flightNo: "CX931",
        staffIds: ["worker"],
      },
    ];

    const result = await generateSchedule(state, "2026-08-03");

    expect(
      result.assignments.find((assignment) => assignment.flightNo === "KE166")
        ?.staffId
    ).toBe("worker");
    expect(
      result.assignments.find((assignment) => assignment.flightNo === "CX931")
        ?.staffId
    ).toBe("worker-2");
  });

  it("adds a soft same-airline control/number-one penalty across later flights", () => {
    const state = modelState(
      [
        flight("morning", "FD101", "08:00", "10:00", ["P1"]),
        flight("afternoon", "FD202", "15:00", "17:00", ["P1"]),
      ],
      (rule) => ({
        ...rule,
        remark: "控制",
        qualifiedStaffIds: ["worker", "worker-2"],
      })
    );
    state.staff.push({ ...state.staff[0]!, id: "worker-2", name: "替代人员" });

    const preparation = prepareSchedule(
      state,
      "2026-08-03",
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date: "2026-08-03",
      preparation,
      timeoutMs: 30_000,
    })!;

    const morningChoice = model.staffChoices.find(
      (choice) =>
        choice.task.flight.flightNo === "FD101" && choice.person.id === "worker"
    )!;
    const afternoonChoice = model.staffChoices.find(
      (choice) =>
        choice.task.flight.flightNo === "FD202" && choice.person.id === "worker"
    )!;
    const conflictVariable = model.problem.variables.find(
      (variable) =>
        variable.id.startsWith("same-airline-priority:") &&
        variable.id.includes(morningChoice.id) &&
        variable.id.includes(afternoonChoice.id)
    );
    expect(conflictVariable).toBeDefined();
    expect(
      model.problem.objectives.find(
        (objective) =>
          objective.id === "candidate:same-day-cross-flight-priority"
      )?.terms
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variableId: conflictVariable?.id }),
      ])
    );
  });

  it("protects same-day CX control/number-one assignments before ordinary frequency fairness", async () => {
    const state = modelState(
      [
        flight("early", "CX937（晚）", "09:25", "11:25", ["G20"]),
        flight("late", "CX931", "17:50", "19:50", ["G20"]),
      ],
      (rule) => ({
        ...rule,
        remark: "一号",
        qualifiedStaffIds: ["worker", "worker-2"],
      })
    );
    state.staff.push({
      ...state.staff[0]!,
      id: "worker-2",
      name: "替代人员",
    });
    state.settings.positionRotationEnabled = true;

    const problem = await captureProblem(state);
    const sameDayIndex = problem.objectives.findIndex(
      (objective) => objective.id === "candidate:same-day-cross-flight-priority"
    );
    const firstBestEffortIndex = problem.objectives.findIndex(
      (objective) => objective.optimality === "best-effort"
    );

    expect(sameDayIndex).toBeGreaterThanOrEqual(0);
    expect(firstBestEffortIndex).toBeGreaterThanOrEqual(0);
    expect(sameDayIndex).toBeLessThan(firstBestEffortIndex);
    expect(problem.objectives[sameDayIndex]?.optimality).toBe("required");
  });

  it("records why another overlapping flight yielded to a protected position", () => {
    const state = modelState([
      flight("ke", "KE166", "08:00", "10:00", ["H02"]),
      flight("cx", "CX931", "08:00", "10:00", ["G20"]),
    ]);
    state.staff.push({ ...state.staff[0]!, id: "worker-2", name: "替代人员" });
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = ["worker", "worker-2"];
    });
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: ["worker"],
      },
    ];
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
      timeoutMs: 30_000,
    })!;
    const keChoice = model.staffChoices.find(
      (choice) =>
        choice.task.flight.flightNo === "KE166" && choice.person.id === "worker"
    )!;
    const cxChoice = model.staffChoices.find(
      (choice) =>
        choice.task.flight.flightNo === "CX931" &&
        choice.person.id === "worker-2"
    )!;
    const plan = materializeDailySchedulePlan({
      state,
      date,
      preparation,
      model,
      selectedVariableIds: new Set([keChoice.id, cxChoice.id]),
    });
    expect(
      plan.assignments.find((assignment) => assignment.flightNo === "KE166")
        ?.decisionTrace
    ).toContainEqual(
      expect.objectContaining({
        ruleId: "cross-flight-priority",
        outcome: "preserved",
        message: expect.stringContaining("该人员也能承担同时段的CX931"),
      })
    );
  });

  it("materializes the selected model choice through the result module", () => {
    const date = "2026-08-03";
    const state = modelState([
      flight("only", "AA100", "08:00", "10:00", ["A1"]),
    ]);
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );
    const model = buildDailyScheduleModel({
      state,
      date,
      preparation,
      timeoutMs: 30_000,
    });

    expect(model).not.toBeNull();
    const selectedChoice = model!.staffChoices[0]!;
    const plan = materializeDailySchedulePlan({
      state,
      date,
      preparation,
      model: model!,
      selectedVariableIds: new Set([selectedChoice.id]),
    });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]).toMatchObject({
      flightId: selectedChoice.task.flight.id,
      positionRuleId: selectedChoice.task.rule.id,
      staffId: selectedChoice.person.id,
      status: "assigned",
    });
    expect(plan.lockedAssignmentIds).toEqual(new Set());
    expect(plan.warnings).toEqual([]);
  });

  it("accepts a complete time-limited fairness solution as a structured outcome", async () => {
    const date = "2026-08-03";
    const state = modelState([
      flight("first", "AA100", "08:00", "10:00", ["A1"]),
      flight("second", "BB200", "08:00", "10:00", ["B1"]),
      flight("third", "CC300", "08:00", "10:00", ["C1"]),
      flight("fourth", "DD400", "08:00", "10:00", ["D1"]),
    ]);
    const secondWorker = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二名测试人员",
    };
    state.staff.push(secondWorker);
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(secondWorker.id)
    );
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );

    const plan = await optimizeDailySchedule({
      solver: new TimeLimitedFairnessSolver(),
      state,
      date,
      preparation,
    });

    expect(plan.assignments).toHaveLength(4);
    expect(plan.optimizationQuality).toBe("fairness-time-limited");
  });

  it("rejects a time-limited solution when any required objective is not proven complete", async () => {
    const date = "2026-08-03";
    const state = modelState([
      flight("only", "AA100", "08:00", "10:00", ["A1"]),
    ]);
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );

    await expect(
      optimizeDailySchedule({
        solver: new IncompleteRequiredFairnessSolver(),
        state,
        date,
        preparation,
      })
    ).rejects.toThrow("关键排班规则未全部完成");
  });

  it("rejects a solver selection that materializes more than one result for an automatic task", async () => {
    const date = "2026-08-03";
    const state = modelState([
      flight("only", "AA100", "08:00", "10:00", ["A1"]),
    ]);
    const secondWorker = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二名测试人员",
    };
    state.staff.push(secondWorker);
    state.positionRules[0]!.qualifiedStaffIds.push(secondWorker.id);
    const preparation = prepareSchedule(
      state,
      date,
      evaluateAutomaticHardConstraints
    );

    await expect(
      optimizeDailySchedule({
        solver: new DuplicateTaskSelectionSolver(),
        state,
        date,
        preparation,
      })
    ).rejects.toThrow("最终安全复核未通过");
  });
});

describe("daily schedule conflict constraints", () => {
  it("minimizes diversion usage after completing all configured positions", async () => {
    const problem = await captureProblem(
      modelState(
        [
          flight("left", "AA100", "21:05", "23:05", ["P1"]),
          flight("right", "BB200", "22:10", "00:10", ["P2"]),
        ],
        (rule) =>
          rule.name === "P1"
            ? { ...rule, category: "分流", earlyReleaseMinutes: 60 }
            : rule
      )
    );
    const diversionIndex = problem.objectives.findIndex(
      (objective) =>
        objective.id === "minimum-flight-transition:diversion-usage"
    );
    const vacancyIndex = problem.objectives.findIndex(
      (objective) => objective.id === "all-vacancies"
    );

    expect(diversionIndex).toBeGreaterThan(vacancyIndex);
    expect(problem.objectives[diversionIndex]!.direction).toBe("minimize");
    expect(problem.objectives[diversionIndex]!.terms.length).toBeGreaterThan(0);
  });

  it("adds one hard incompatibility for flight groups below the global transition gap", async () => {
    const state = modelState([
      flight("left", "AA100", "08:00", "10:00", ["A1", "A2"]),
      flight("right", "BB200", "11:29", "13:00", ["B1", "B2"]),
    ]);
    state.settings.minimumRegularTransitionMinutes = 90;

    const problem = await captureProblem(state);
    const constraints = problem.constraints.filter((constraint) =>
      constraint.id.startsWith("minimum-transition:")
    );

    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({ upperBound: 1 });
    expect(constraints[0]!.terms).toHaveLength(4);
  });

  it("compresses two fully incompatible flight groups into one clique", async () => {
    const problem = await captureProblem(
      modelState([
        flight("left", "AA100", "08:00", "10:00", ["A1", "A2"]),
        flight("right", "BB200", "09:00", "11:00", ["B1", "B2"]),
      ])
    );
    const overlapConstraints = problem.constraints.filter((constraint) =>
      constraint.id.startsWith("overlap:")
    );

    expect(overlapConstraints).toHaveLength(1);
    expect(overlapConstraints[0]).toMatchObject({ upperBound: 1 });
    expect(overlapConstraints[0]!.terms).toHaveLength(4);
  });

  it("keeps pair constraints when early release makes only some choices compatible", async () => {
    const problem = await captureProblem(
      modelState(
        [
          flight("left", "AA100", "12:00", "14:00", ["分流", "普通"]),
          flight("right", "BB200", "13:50", "15:50", ["B1", "B2"]),
        ],
        (rule) =>
          rule.name === "分流"
            ? { ...rule, category: "分流", earlyReleaseMinutes: 120 }
            : rule
      )
    );
    const overlapConstraints = problem.constraints.filter((constraint) =>
      constraint.id.startsWith("overlap:")
    );

    expect(overlapConstraints).toHaveLength(2);
    expect(
      overlapConstraints.every((constraint) => constraint.terms.length === 2)
    ).toBe(true);
  });
});

describe("daily schedule solver performance model", () => {
  it("retains the flight-count fallback instead of expanding the large-flight solver graph", async () => {
    const state = modelState(
      Array.from({ length: 6 }, (_, index) =>
        flight(
          `flight-${index}`,
          `AA${100 + index}`,
          `${String(6 + index * 2).padStart(2, "0")}:00`,
          `${String(7 + index * 2).padStart(2, "0")}:00`,
          ["A1", "A2", "A3", "A4"]
        )
      )
    );
    const workers = Array.from({ length: 13 }, (_, index) => ({
      ...state.staff[0]!,
      id: `worker-${index + 2}`,
      name: `测试人员${index + 2}`,
    }));
    state.staff.push(...workers);
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds.push(...workers.map((person) => person.id));
    });

    const problem = await captureProblem(state);

    expect(
      problem.objectives.some(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )
    ).toBe(false);
    const result = await generateSchedule(state, "2026-08-03");
    const grouped = groupStaffFlightsByNormalizedNumber(
      result.assignments.flatMap((assignment) =>
        assignment.status === "assigned" && assignment.staffId
          ? [{ staffId: assignment.staffId, flightNo: assignment.flightNo }]
          : []
      )
    );
    const counts = state.staff.map(
      (person) => grouped.get(person.id)?.size ?? 0
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("keeps the final flight-count spread within one for large candidate sets", async () => {
    const state = modelState([
      flight("first", "AA100", "06:00", "07:00", ["A1", "A2", "A3", "A4"]),
      flight("second", "BB200", "09:00", "10:00", ["B1", "B2", "B3", "B4"]),
      flight("third", "CC300", "12:00", "13:00", ["C1", "C2", "C3", "C4"]),
      flight("fourth", "DD400", "15:00", "16:00", ["D1", "D2", "D3", "D4"]),
      flight("fifth", "EE500", "18:00", "19:00", ["E1", "E2", "E3", "E4"]),
    ]);
    const workers = Array.from({ length: 13 }, (_, index) => ({
      ...state.staff[0]!,
      id: `worker-${index + 2}`,
      name: `测试人员${index + 2}`,
    }));
    state.staff.push(...workers);
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds.push(...workers.map((person) => person.id));
    });

    const result = await generateSchedule(state, "2026-08-03");
    const grouped = groupStaffFlightsByNormalizedNumber(
      result.assignments.flatMap((assignment) =>
        assignment.status === "assigned" && assignment.staffId
          ? [
              {
                staffId: assignment.staffId,
                flightNo: assignment.flightNo,
              },
            ]
          : []
      )
    );
    const counts = state.staff.map(
      (person) => grouped.get(person.id)?.size ?? 0
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(
      result.assignments
        .filter((assignment) => assignment.status === "unfilled")
        .every(
          (assignment) =>
            !assignment.vacancyEvidence ||
            assignment.vacancyEvidence.reason === "daily-flight-count-balance"
        )
    ).toBe(true);
  });

  it("marks recovery and later fairness goals as best effort", async () => {
    const state = modelState([
      flight("first", "AA100", "08:00", "10:00", ["A1"]),
      flight("second", "BB200", "08:00", "10:00", ["B1"]),
      flight("third", "CC300", "08:00", "10:00", ["C1"]),
      flight("fourth", "DD400", "08:00", "10:00", ["D1"]),
    ]);
    const secondWorker = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二名测试人员",
    };
    state.staff.push(secondWorker);
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(secondWorker.id)
    );
    state.history = [
      {
        id: "historical-fatigue",
        date: "2026-08-01",
        flightNo: "OLD100",
        position: "A1",
        staffId: secondWorker.id,
        staffName: secondWorker.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 8,
        remark: "",
      },
    ];

    const problem = await captureProblem(state);
    const bestEffortIds = problem.objectives
      .filter((objective) => objective.optimality === "best-effort")
      .map((objective) => objective.id);

    expect(bestEffortIds).toEqual([
      "candidate:staff-coverage",
      "candidate:daily-flight-count-balance",
      "candidate:cross-workday-load",
      "candidate:workload-balance:target",
      "candidate:workload-balance:today-hours-excess",
      "candidate:workload-balance:rolling-hours-excess",
      "candidate:workload-balance:today-fatigue-excess",
      "candidate:workload-balance:today-hours-spread",
      "candidate:workload-balance:rolling-hours-spread",
      "candidate:workload-balance:today-fatigue-spread",
      "candidate:historical-fatigue",
    ]);
    const firstBestEffortIndex = problem.objectives.findIndex(
      (objective) => objective.optimality === "best-effort"
    );
    expect(firstBestEffortIndex).toBeGreaterThanOrEqual(0);
    expect(
      problem.objectives
        .slice(0, firstBestEffortIndex)
        .every((objective) => objective.optimality === "required")
    ).toBe(true);
    expect(
      problem.objectives
        .slice(firstBestEffortIndex)
        .every((objective) => objective.optimality === "best-effort")
    ).toBe(true);
    expect(
      problem.objectives
        .filter((objective) => objective.optimality === "best-effort")
        .every((objective) => objective.acceptedGap?.relative === 0.05)
    ).toBe(true);
  });

  it("places flight-count balance after staff coverage in model objectives", async () => {
    const state = modelState([
      flight("first", "AA100", "06:00", "07:00", ["A1"]),
      flight("second", "BB200", "09:00", "10:00", ["B1"]),
    ]);
    const secondWorker = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二名测试人员",
    };
    state.staff.push(secondWorker);
    state.settings.rollingLoadProtectionEnabled = true;
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(secondWorker.id)
    );

    const problem = await captureProblem(state);
    const objectiveIds = problem.objectives.map((objective) => objective.id);

    expect(objectiveIds.indexOf("candidate:staff-coverage")).toBeLessThan(
      objectiveIds.indexOf("candidate:daily-flight-count-balance")
    );
    expect(
      problem.objectives.find(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )
    ).toMatchObject({
      optimality: "best-effort",
      acceptedGap: { relative: 0.05 },
    });
    expect(
      problem.objectives.find(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )?.acceptedGap?.absolute
    ).toBeUndefined();
  });

  it("excludes half-rest workers and team leaders from balance when they are not candidates", async () => {
    const state = modelState([
      flight("morning", "AA100", "08:00", "10:00", ["A1"]),
      flight("afternoon", "BB200", "13:00", "15:00", ["B1"]),
    ]);
    const secondWorker = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二名测试人员",
    };
    state.staff.push(secondWorker);
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(secondWorker.id)
    );
    const halfRestDefault = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
    });
    state.settings.dailyFlightCountBalanceExemptHalfRest = false;
    const halfRestIncluded = await captureProblem(state, {
      halfRestStaffIds: [state.staff[0]!.id],
    });

    expect(
      halfRestDefault.objectives.some(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )
    ).toBe(false);
    expect(
      halfRestIncluded.objectives.some(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )
    ).toBe(true);

    state.settings.dailyFlightCountBalanceExemptHalfRest = true;
    state.staff[0]!.teamLeader = true;
    const leaderDefault = await captureProblem(state);
    state.settings.dailyFlightCountBalanceExemptTeamLeaders = false;
    const leaderIncluded = await captureProblem(state);

    expect(
      leaderDefault.objectives.some(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )
    ).toBe(false);
    expect(
      leaderIncluded.objectives.some(
        (objective) => objective.id === "candidate:daily-flight-count-balance"
      )
    ).toBe(false);
  });

  it("splits four safe flights evenly without changing the complete assignment set", async () => {
    const state = modelState([
      flight("first", "AA100", "06:00", "07:00", ["A1"]),
      flight("second", "BB200", "09:00", "10:00", ["B1"]),
      flight("third", "CC300", "12:00", "13:00", ["C1"]),
      flight("fourth", "DD400", "15:00", "16:00", ["D1"]),
    ]);
    const secondWorker = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二名测试人员",
    };
    state.staff.push(secondWorker);
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(secondWorker.id)
    );

    const result = await generateSchedule(state, "2026-08-03");
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.filter((item) => item.staffId === state.staff[0]!.id)
    ).toHaveLength(2);
    expect(
      result.assignments.filter((item) => item.staffId === secondWorker.id)
    ).toHaveLength(2);
  });

  it("keeps every job filled when only one qualified worker is available", async () => {
    const state = modelState([
      flight("first", "AA100", "06:00", "07:00", ["A1"]),
      flight("second", "BB200", "09:00", "10:00", ["B1"]),
      flight("third", "CC300", "12:00", "13:00", ["C1"]),
    ]);
    const unqualified = {
      ...state.staff[0]!,
      id: "unqualified-worker",
      name: "无资质人员",
    };
    state.staff.push(unqualified);

    const result = await generateSchedule(state, "2026-08-03");
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.filter((item) => item.staffId === unqualified.id)
    ).toHaveLength(0);
  });

  it("leaves only a balance-caused vacancy when a complete <=1 spread is impossible", async () => {
    const state = modelState([
      flight("first", "AA100", "06:00", "07:00", ["A1"]),
      flight("second", "BB200", "09:00", "10:00", ["B1"]),
      flight("third", "CC300", "12:00", "13:00", ["C1"]),
      flight("fourth", "DD400", "15:00", "16:00", ["D1"]),
    ]);
    const constrainedWorker = state.staff[0]!;
    const alternate = {
      ...constrainedWorker,
      id: "balance-alternate",
      name: "鍧囪　澶囩敤浜哄憳",
    };
    state.staff.push(alternate);
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds =
        rule.flightNo === "AA100"
          ? [constrainedWorker.id, alternate.id]
          : [constrainedWorker.id];
    });

    const result = await generateSchedule(state, "2026-08-03");

    expect(result.unfilledCount).toBe(1);
    expect(
      result.assignments.filter(
        (item) => item.status === "assigned" && item.staffId === alternate.id
      )
    ).toHaveLength(1);
    const balanceVacancy = result.assignments.find(
      (item) => item.status === "unfilled"
    );
    expect(balanceVacancy?.systemNotes?.join(" ")).toContain("航班数均衡");
    expect(result.warnings.join(" ")).toContain("航班数均衡");
  });

  it("marks a vacancy with no qualified candidate separately from balance fallback", async () => {
    const state = modelState([
      flight("missing", "AA100", "15:00", "16:00", ["A1"]),
    ]);
    state.positionRules[0]!.qualifiedStaffIds = [];

    const result = await generateSchedule(state, "2026-08-03");
    const vacancy = result.assignments.find(
      (assignment) => assignment.status === "unfilled"
    );

    expect(vacancy?.vacancyEvidence).toEqual({
      reason: "no-qualified-candidate",
      blockers: ["没有通过人员状态、资质、时段和安全约束的候选人员"],
    });
    expect(vacancy?.systemNotes?.[0]).toContain("真实无候选人员");
  });

  it("does not use team leaders to satisfy the daily staff coverage objective", async () => {
    const state = modelState([
      flight("only", "AA100", "08:00", "10:00", ["A1"]),
    ]);
    const teamLeader = state.staff[0]!;
    teamLeader.teamLeader = true;
    const regularWorker = {
      ...teamLeader,
      id: "regular-worker",
      name: "普通人员",
      teamLeader: false,
    };
    state.staff.push(regularWorker);
    state.positionRules[0]!.qualifiedStaffIds.push(regularWorker.id);

    const problem = await captureProblem(state);
    const coverage = problem.objectives.find(
      (objective) => objective.id === "candidate:staff-coverage"
    );

    expect(coverage?.terms).toEqual([
      { variableId: `worked:${regularWorker.id}`, coefficient: 1 },
    ]);
    expect(problem.variables).not.toContainEqual({
      id: `worked:${teamLeader.id}`,
    });
  });

  it("places same-day late obligation after high-fatigue continuity and before transition and coverage", async () => {
    const state = modelState(
      [
        flight("early", "EARLY100", "06:00", "07:00", ["H03"]),
        flight("morning", "MORNING100", "08:00", "10:00", ["控制"]),
        flight("late", "NIGHT300", "20:00", "22:00", ["N01"]),
      ],
      (rule) => ({
        ...rule,
        fatiguePoints: rule.flightNo === "EARLY100" ? 6 : 1,
      })
    );
    const protectedWorker = state.staff[0]!;
    protectedWorker.teamLeader = false;
    const alternate = {
      ...protectedWorker,
      id: "alternate-worker",
      name: "替代人员",
    };
    state.staff.push(alternate);
    state.positionRules.forEach((rule) => {
      if (rule.flightNo !== "NIGHT300")
        rule.qualifiedStaffIds.push(alternate.id);
    });
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.positionTransitionPolicies = [
      {
        id: "early-to-morning",
        name: "早班衔接",
        enabled: true,
        sourceFlightNo: "EARLY100",
        sourcePositions: ["H03"],
        targetFlightNo: "MORNING100",
        targetPosition: "控制",
        minimumGapMinutes: 120,
        mode: "prefer",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules.find(
      (item) => item.matchField === "remark" && item.keyword === "一号"
    )!.nextWorkdayCutoffTime = "12:00";
    state.history = [
      {
        id: "previous-early",
        date: "2026-08-01",
        flightNo: "EARLY100",
        position: "H03",
        staffId: protectedWorker.id,
        staffName: protectedWorker.name,
        startTime: "06:00",
        endTime: "07:00",
        workHours: 1,
        fatiguePoints: 6,
        remark: "",
      },
      {
        id: "previous-late",
        date: "2026-08-01",
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

    const problem = await captureProblem(state);
    const objectiveIds = problem.objectives.map((objective) => objective.id);
    const cutoffIndex = objectiveIds.indexOf("candidate:late-shift-cutoff");
    const highFatigueIndex = objectiveIds.indexOf(
      "candidate:high-fatigue-position-consecutive"
    );
    const sameDayIndex = objectiveIds.indexOf(
      "candidate:same-day-late-obligation"
    );
    const splitCutoffOrderIndex = objectiveIds.indexOf(
      "candidate:same-day-late-obligation:split-cutoff-order"
    );
    const beforeCutoffAccessIndex = objectiveIds.indexOf(
      "candidate:same-day-late-obligation:before-cutoff-access"
    );
    const preferredTransitionIndex = objectiveIds.indexOf(
      "candidate:preferred-position-transition"
    );
    const staffCoverageIndex = objectiveIds.indexOf("candidate:staff-coverage");

    expect(cutoffIndex).toBeGreaterThanOrEqual(0);
    expect(highFatigueIndex).toBeGreaterThan(cutoffIndex);
    expect(sameDayIndex).toBeGreaterThan(highFatigueIndex);
    expect(splitCutoffOrderIndex).toBeGreaterThan(sameDayIndex);
    expect(beforeCutoffAccessIndex).toBeGreaterThan(splitCutoffOrderIndex);
    expect(beforeCutoffAccessIndex).toBeLessThan(preferredTransitionIndex);
    expect(sameDayIndex).toBeLessThan(preferredTransitionIndex);
    expect(sameDayIndex).toBeLessThan(staffCoverageIndex);
  });

  it("splits actual morning and evening CX priority assignments when safe", async () => {
    const state = modelState([
      flight("morning-cx", "CX100", "08:00", "10:00", ["G20"]),
      flight("evening-cx", "CX200", "20:00", "22:00", ["G20"]),
    ]);
    const alternate = {
      ...state.staff[0]!,
      id: "alternate-worker",
      name: "替代人员",
    };
    state.staff.push(alternate);
    state.positionRules[0]!.qualifiedStaffIds.push(alternate.id);
    state.positionRules[1]!.qualifiedStaffIds.push(alternate.id);

    const result = await generateSchedule(state, "2026-08-03");
    const morning = result.assignments.find(
      (assignment) => assignment.flightNo === "CX100"
    );
    const evening = result.assignments.find(
      (assignment) => assignment.flightNo === "CX200"
    );

    expect(result.unfilledCount).toBe(0);
    expect(morning?.staffId).toBeTruthy();
    expect(evening?.staffId).toBeTruthy();
    expect(morning?.staffId).not.toBe(evening?.staffId);
  });

  it("keeps same-airline priority positions staffed when only one qualified worker is available", async () => {
    const state = modelState([
      flight("morning-cx", "CX100", "08:00", "10:00", ["G20"]),
      flight("evening-cx", "CX200", "20:00", "22:00", ["G20"]),
    ]);
    const alternate = {
      ...state.staff[0]!,
      id: "alternate-worker",
      name: "替代人员",
    };
    state.staff.push(alternate);
    const result = await generateSchedule(state, "2026-08-03");
    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.filter((assignment) =>
        ["CX100", "CX200"].includes(assignment.flightNo)
      )
    ).toHaveLength(2);
  });

  it("keeps same-airline control and number-one staffed when no safe alternate exists", async () => {
    const state = modelState(
      [
        flight("morning-cx", "CX100", "08:00", "10:00", ["G08"]),
        flight("evening-cx", "CX200", "20:00", "22:00", ["G17"]),
      ],
      (rule) => ({
        ...rule,
        remark: rule.flightNo === "CX100" ? "控制" : "一号",
      })
    );

    const result = await generateSchedule(state, "2026-08-03");
    const priorityAssignments = result.assignments.filter((assignment) =>
      ["CX100", "CX200"].includes(assignment.flightNo)
    );

    expect(result.unfilledCount).toBe(0);
    expect(priorityAssignments).toHaveLength(2);
    expect(new Set(priorityAssignments.map((item) => item.staffId))).toEqual(
      new Set(["worker"])
    );
    expect(
      result.warnings.some((warning) => warning.includes("同日同航司"))
    ).toBe(true);
  });

  it("avoids same-airline control and number-one across flights when a safe alternate exists", async () => {
    const state = modelState(
      [
        flight("morning-cx", "CX100", "08:00", "10:00", ["G08"]),
        flight("evening-cx", "CX200", "20:00", "22:00", ["G17"]),
      ],
      (rule) => ({
        ...rule,
        remark: rule.flightNo === "CX100" ? "控制" : "一号",
      })
    );
    const alternate = {
      ...state.staff[0]!,
      id: "alternate-worker",
      name: "替代人员",
    };
    state.staff.push(alternate);
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(alternate.id)
    );

    const result = await generateSchedule(state, "2026-08-03");
    const priorityAssignments = result.assignments.filter((assignment) =>
      ["CX100", "CX200"].includes(assignment.flightNo)
    );

    expect(result.unfilledCount).toBe(0);
    expect(new Set(priorityAssignments.map((item) => item.staffId)).size).toBe(
      2
    );
    expect(
      result.warnings.some((warning) => warning.includes("同日同航司"))
    ).toBe(false);
  });

  it("turns off same-airline control/number-one avoidance and its warning from the rule switch", async () => {
    const state = modelState(
      [
        flight("morning-cx", "CX100", "08:00", "10:00", ["G08"]),
        flight("evening-cx", "CX200", "20:00", "22:00", ["G17"]),
      ],
      (rule) => ({
        ...rule,
        remark: rule.flightNo === "CX100" ? "控制" : "一号",
      })
    );
    state.settings.sameDayCrossFlightPriorityEnabled = false;

    const result = await generateSchedule(state, "2026-08-03");

    expect(result.unfilledCount).toBe(0);
    expect(
      result.warnings.some((warning) => warning.includes("同日同航司"))
    ).toBe(false);
  });

  it("separates priority work across more than two same-airline flights", async () => {
    const state = modelState(
      [
        flight("fd-1", "FD101", "08:00", "10:00", ["G08"]),
        flight("fd-2", "FD202", "13:00", "15:00", ["G17"]),
        flight("fd-3", "FD303", "18:00", "20:00", ["G20"]),
      ],
      (rule) => ({ ...rule, remark: "控制" })
    );
    state.staff.push(
      { ...state.staff[0]!, id: "worker-2", name: "第二人员" },
      { ...state.staff[0]!, id: "worker-3", name: "第三人员" }
    );
    state.positionRules.forEach((rule) => {
      rule.qualifiedStaffIds = state.staff.map((person) => person.id);
    });

    const result = await generateSchedule(state, "2026-08-03");
    const assignedStaffIds = result.assignments
      .filter((assignment) => assignment.status === "assigned")
      .map((assignment) => assignment.staffId);
    expect(result.unfilledCount).toBe(0);
    expect(new Set(assignedStaffIds).size).toBe(3);
  });

  it("does not separate same-named priority positions across airlines", async () => {
    const state = modelState([
      flight("fd", "FD101", "08:00", "10:00", ["G20"]),
      flight("cx", "CX202", "15:00", "17:00", ["G20"]),
    ]);

    const result = await generateSchedule(state, "2026-08-03");
    expect(result.unfilledCount).toBe(0);
    expect(result.assignments.map((assignment) => assignment.staffId)).toEqual([
      "worker",
      "worker",
    ]);
  });

  it("places cross-workday qualification reservation after vacancies and before late-position fairness", async () => {
    const state = modelState([
      flight("late", "LATE100", "21:00", "23:30", ["A1"]),
    ]);
    const second = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二人员",
    };
    state.staff.push(second);
    state.positionRules[0]!.qualifiedStaffIds.push(second.id);
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "next-control",
      flightNo: "NEXT200",
      name: "控制",
      remark: "",
      qualifiedStaffIds: [state.staff[0]!.id],
    });
    state.settings.crossWorkdayQualificationReservations = [
      {
        id: "reserve-next-control",
        enabled: true,
        flightNo: "NEXT200",
        matchField: "position",
        keyword: "控制",
        minimumStaffCount: 1,
      },
    ];

    const problem = await captureProblem(state);
    const objectiveIds = problem.objectives.map((objective) => objective.id);
    const reservationIndex = objectiveIds.findIndex((id) =>
      id.startsWith("cross-workday-qualification-reservation:")
    );

    expect(reservationIndex).toBeGreaterThan(
      objectiveIds.indexOf("all-vacancies")
    );
    const lateFairnessIndex = objectiveIds.findIndex((id) =>
      id.startsWith("candidate:late-priority-frequency:")
    );
    if (lateFairnessIndex >= 0)
      expect(reservationIndex).toBeLessThan(lateFairnessIndex);
    expect(
      problem.variables.some((variable) =>
        variable.id.startsWith("cross-workday-reserve:")
      )
    ).toBe(true);
  });

  it("uses native lexicographic solving for the whole-day model", async () => {
    const problem = await captureProblem(
      modelState([flight("only", "AA100", "08:00", "10:00", ["A1"])])
    );

    expect(problem.strategy).toBe("native-lexicographic");
  });

  it("does not solve extra objectives for otherwise equivalent staff IDs", async () => {
    const problem = await captureProblem(
      modelState([flight("ke166", "KE166", "08:00", "10:00", ["H01"])])
    );

    expect(
      problem.objectives.filter((objective) =>
        objective.id.startsWith("candidate:staff-id")
      )
    ).toEqual([]);
  });

  it("locks late-position fairness in supervisor, number-one, declaration, delivery order", async () => {
    const state = modelState(
      [
        flight("late", "TR121", "21:55", "23:55", [
          "督导",
          "H02",
          "H04",
          "G14",
        ]),
      ],
      (rule) => ({
        ...rule,
        remark:
          rule.name === "H02"
            ? "一号"
            : rule.name === "H04"
              ? "申报"
              : rule.name === "G14"
                ? "送资料"
                : "",
      })
    );
    const second = {
      ...state.staff[0]!,
      id: "second-worker",
      name: "第二人员",
    };
    state.staff.push(second);
    state.positionRules.forEach((rule) =>
      rule.qualifiedStaffIds.push(second.id)
    );
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      ["supervisor", state.staff[0]!.id, "督导", ""],
      ["number-one", second.id, "H02", "一号"],
      ["declaration", state.staff[0]!.id, "H04", "申报"],
      ["delivery", second.id, "G14", "送资料"],
    ].map(([id, staffId, position, remark]) => ({
      id: id!,
      date: "2026-08-01",
      flightNo: "TR121",
      position: position!,
      staffId: staffId!,
      staffName: "测试人员",
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 5,
      remark: remark!,
    }));
    state.history.push({
      ...state.history[0]!,
      id: "latest-number-one",
      date: "2026-08-02",
      position: "H02",
      remark: "一号",
    });
    const problem = await captureProblem(state);

    const objectiveIds = problem.objectives.map((objective) => objective.id);
    const aggregateObjectives = objectiveIds.filter((id) =>
      id.startsWith("candidate:late-priority-aggregate-rotation:")
    );
    const categoryObjectives = objectiveIds.filter((id) =>
      id.startsWith("candidate:late-priority-frequency:")
    );

    expect(aggregateObjectives).toEqual([
      "candidate:late-priority-aggregate-rotation:category-boundary",
      "candidate:late-priority-aggregate-rotation:previous-workday",
      "candidate:late-priority-aggregate-rotation:current-month",
      "candidate:late-priority-aggregate-rotation:recent-eight-workdays",
    ]);
    expect(categoryObjectives).toEqual([
      "candidate:late-priority-frequency:supervisor",
      "candidate:late-priority-frequency:number-one",
      "candidate:late-priority-frequency:declaration",
      "candidate:late-priority-frequency:delivery",
    ]);
    expect(objectiveIds.indexOf(aggregateObjectives.at(-1)!)).toBeLessThan(
      objectiveIds.indexOf(categoryObjectives[0]!)
    );
  });

  it("omits inactive late-position objectives from a daytime model", async () => {
    const problem = await captureProblem(
      modelState([flight("day", "AA100", "08:00", "10:00", ["G01"])])
    );

    expect(
      problem.objectives.some((objective) =>
        objective.id.startsWith("candidate:late-priority-frequency:")
      )
    ).toBe(false);
  });

  it("linearizes soft combinations by mutually exclusive source flight", async () => {
    const state = modelState([
      flight("source", "SRC100", "06:00", "08:00", ["S1", "S2"]),
      flight("target", "DST200", "09:00", "11:00", ["T1"]),
    ]);
    state.settings.positionTransitionPolicies = [
      {
        id: "source-to-target",
        name: "来源航班到目标岗位",
        enabled: true,
        sourceFlightNo: "SRC100",
        sourcePositions: ["S1", "S2"],
        targetFlightNo: "DST200",
        targetPosition: "T1",
        minimumGapMinutes: 180,
        mode: "prefer",
      },
    ];
    state.settings.minimumRegularTransitionMinutes = 0;

    const problem = await captureProblem(state);
    const combinationVariables = problem.variables.filter((variable) =>
      variable.id.startsWith("combination:")
    );
    const combinationConstraints = problem.constraints.filter((constraint) =>
      constraint.id.startsWith("combination:")
    );

    expect(combinationVariables.length).toBeGreaterThan(0);
    expect(combinationVariables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "continuous",
          lowerBound: 0,
          upperBound: 1,
          lowerEnvelope: true,
        }),
      ])
    );
    expect(
      combinationConstraints.every((constraint) =>
        constraint.id.includes(":source-flight:")
      )
    ).toBe(true);
    expect(combinationConstraints[0]).toMatchObject({ lowerBound: -1 });
    expect(combinationConstraints[0]!.terms).toHaveLength(4);
    const transitionObjective = problem.objectives.find(
      (objective) => objective.id === "candidate:preferred-position-transition"
    );
    expect(transitionObjective?.objectiveValueStep).toBe(1);
  });

  it("adds a safe independent-capacity cut for high-load combinations", async () => {
    const state = modelState(
      [
        flight("first", "AA100", "06:00", "08:00", ["A1"]),
        flight("second", "BB200", "09:00", "11:00", ["B1"]),
        flight("third", "CC300", "12:00", "14:00", ["C1"]),
      ],
      (rule) => ({ ...rule, fatiguePoints: 4 })
    );
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.highLoadRecoveryMinutes = 360;

    const problem = await captureProblem(state);
    const capacityCut = problem.constraints.find(
      (constraint) => constraint.id === "high-load-independent-capacity:worker"
    );

    expect(capacityCut).toMatchObject({ lowerBound: -1 });
    expect(
      capacityCut?.terms.filter(
        (term) =>
          term.variableId.startsWith("combination:") && term.coefficient === 1
      )
    ).toHaveLength(3);
    expect(
      capacityCut?.terms.filter(
        (term) =>
          term.variableId.startsWith("staff:") && term.coefficient === -1
      )
    ).toHaveLength(3);
  });

  it("skips the high-load capacity cut beyond the exact small-graph limit", async () => {
    const state = modelState(
      Array.from({ length: 12 }, (_, index) =>
        flight(
          `flight-${index}`,
          `AA${100 + index}`,
          `${String(5 + index).padStart(2, "0")}:00`,
          `${String(6 + index).padStart(2, "0")}:00`,
          [`P${index}`]
        )
      ),
      (rule) => ({ ...rule, fatiguePoints: 4 })
    );
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.highLoadRecoveryMinutes = 720;

    const problem = await captureProblem(state);

    expect(
      problem.constraints.some((constraint) =>
        constraint.id.startsWith("high-load-independent-capacity:")
      )
    ).toBe(false);
  });

  it("omits a scarcity objective that duplicates the pre-noon vacancy objective", async () => {
    const problem = await captureProblem(
      modelState([
        flight("morning", "AA100", "08:00", "10:00", ["G01", "G02"]),
        flight("afternoon", "BB200", "13:00", "15:00", ["H01"]),
      ])
    );

    expect(problem.objectives.map((objective) => objective.id)).not.toContain(
      "pre-noon-scarcity"
    );
  });

  it("keeps a morning priority position ahead of an ordinary position when a vacancy is unavoidable", async () => {
    const state = modelState([
      flight("morning", "AA100", "08:00", "10:00", ["督导", "G01"]),
    ]);
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AA", position: "督导" },
    ];
    const problem = await captureProblem(state);
    const objective = problem.objectives.find(
      (item) => item.id === "pre-noon-priority-vacancies"
    );

    expect(objective?.terms).toEqual([
      { variableId: "vacancy:0", coefficient: 1 },
    ]);
  });
});
