import { expect, it, vi } from "vitest";
import { createSchedulingScenario } from "../helpers/scheduling-scenario";
import { createAssignedPosition } from "../../src/domain/assignments/assignment-factory";
import { finalizeSchedule } from "../../src/domain/kernel/schedule-finalizer";
import { createScheduleLedger } from "../../src/domain/kernel/schedule-ledger";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import type { AssignmentTask } from "../../src/domain/flights/schedule-tasks";
import { makeUnfilled } from "../../src/domain/flights/schedule-position-rules";

// Isolate the final review: actual post-stage transactional rollback has its
// own regression in schedule-pipeline.test.ts; kernel tests cover all stages.
vi.mock("../../src/domain/kernel/schedule-pipeline", () => ({
  runCoveragePipeline: async () => [],
  runPostSchedulePipeline: async () => [],
}));

async function runFinalizer(
  change: (data: ReturnType<typeof fixture>) => void
) {
  const data = fixture();
  change(data);
  const { state, assignments, tasks, locks, preserved } = data;
  const date = "2026-10-14";
  const runFacts = createScheduleRunFacts(state, date);
  const safetySession = createScheduleSafetySession({
    phase: "final",
    state,
    date,
    runFacts,
  });
  const result = await finalizeSchedule({
    state,
    date,
    ledger: createScheduleLedger(assignments),
    solver: {
      solve: async () => {
        throw new Error("final review does not solve");
      },
    },
    safetySession,
    warnings: [],
    flights: state.flights,
    displayRulesByFlight: new Map(
      tasks.map((task) => [task.flight.id, [task.rule]])
    ),
    lockedAssignmentIds: locks,
    dailyFlightCountBalanceFallback: false,
    candidateStaffIds: new Set(state.staff.map((person) => person.id)),
    runFacts,
    automaticTasks: tasks,
    preservedAssignments: preserved,
    optimizationQuality: "all-objectives-optimal",
    finalizeMobileSupervisors: async () => undefined,
    reportProgress: () => undefined,
    scheduleRunId: "final-review-regression",
  });
  expect(() =>
    safetySession.assertAssignmentsSafe(result.assignments)
  ).not.toThrow();
  expect(() =>
    assertDailyScheduleSafety({
      state,
      date,
      tasks,
      assignments: result.assignments,
      evaluateEligibility: evaluateAutomaticHardConstraints,
      allowFinalizedConcurrency: true,
      preservedAssignments: preserved,
    })
  ).not.toThrow();
  expect(result.unfilledCount).toBe(
    result.assignments.filter((row) => row.status === "unfilled").length
  );
  expect(result.safetyCredential).toBeDefined();
  return { ...data, result };
}

function fixture() {
  const state = createSchedulingScenario();
  state.staff = [0, 1].map((index) => ({
    ...state.staff[index]!,
    id: `worker-${index}`,
    name: `人员${index}`,
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: false,
    dutyQualified: false,
    nightShift: true,
  }));
  state.flights = [0, 1].map((index) => ({
    id: `flight-${index}`,
    flightNo: `TEST${index}`,
    positions: ["柜台"],
    startTime: index ? "14:00" : "08:00",
    endTime: index ? "16:00" : "10:00",
    bookedPassengers: 200,
    remark: "",
  }));
  state.positionRules = state.flights.map((flight, index) => ({
    ...state.positionRules[0]!,
    id: `rule-${index}`,
    flightNo: flight.flightNo,
    name: "柜台",
    category: "常规" as const,
    qualifiedStaffIds: [state.staff[index]!.id],
    minPassengers: 0,
    earlyReleaseMinutes: 0,
    manual: false,
    fatiguePoints: 1,
    remark: "",
  }));
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.positionTransitionPolicies = [];
  state.settings.minimumRegularTransitionMinutes = 0;
  const tasks: AssignmentTask[] = state.positionRules.map((rule, index) => ({
    key: `${state.flights[index]!.id}:${rule.id}`,
    flight: state.flights[index]!,
    rule,
  }));
  const assignments = tasks.map((task, index) =>
    createAssignedPosition(task, state.staff[index]!, 2, [], [])
  );
  return {
    state,
    tasks,
    assignments,
    locks: new Set<string>(),
    preserved: [] as typeof assignments,
  };
}

it("adopts a new final schedule with only the now-unqualified row vacant", async () => {
  const { result } = await runFinalizer(({ state }) => {
    state.positionRules[0]!.qualifiedStaffIds = [];
  });
  expect(result.assignments[0]!.status).toBe("unfilled");
  expect(result.assignments[1]!.staffId).toBe("worker-1");
  expect(result.warnings.join("；")).toContain("合格人员名单");
});

it("refills configured H05 after the final guard removes invalid supervisor sharing", async () => {
  const { result, state } = await runFinalizer(
    ({ state, tasks, assignments }) => {
      const flight = state.flights[0]!;
      flight.flightNo = "KE166";
      const source = state.positionRules[0]!;
      source.flightNo = "KE166";
      source.name = "督导";
      source.category = "机动督导";
      const target = {
        ...source,
        id: "h05",
        name: "H05",
        category: "常规" as const,
        coverageRole: "supervisor-fill" as const,
        qualifiedStaffIds: ["worker-1"],
        fatiguePoints: 2,
      };
      state.positionRules.push(target);
      state.settings.dailyPrimaryPositionUniqueEnabled = false;
      state.settings.crossFlightPriorityPolicies = [
        {
          id: "ke-first",
          flightNo: "KE166",
          staffIds: ["worker-1"],
          enabled: true,
        },
      ];
      state.settings.mobileSupervisorFillRules = [
        {
          id: "ke-fill",
          sourceFlightNo: "KE166",
          sourcePositionKeyword: "督导",
          targetFlightNo: "KE166",
          targetPositionKeyword: "H05",
          enabled: true,
          allowAutomatic: true,
          allowManual: true,
        },
      ];
      assignments[0] = createAssignedPosition(
        tasks[0]!,
        state.staff[0]!,
        2,
        [],
        []
      );
      const h05 = makeUnfilled(flight, "H05", target);
      Object.assign(h05, {
        status: "assigned",
        staffId: "worker-0",
        staffName: state.staff[0]!.name,
        workHours: 0,
        fatiguePoints: 0,
        supervisorSourceAssignmentId: assignments[0].id,
        supervisorFillRuleId: "ke-fill",
      });
      assignments.push(h05);
      tasks.push({ key: `${flight.id}:${target.id}`, flight, rule: target });
    }
  );
  expect(
    result.assignments.find((row) => row.position === "H05")
  ).toMatchObject({
    status: "assigned",
    staffId: "worker-1",
    workHours: 2,
    fatiguePoints: 2,
  });
  expect(
    result.assignments.find((row) => row.position === "H05")
      ?.supervisorSourceAssignmentId
  ).toBeUndefined();
  expect(result.unfilledCount).toBe(0);
  expect(result.warnings.join("；")).not.toContain("这个岗位已留空");
  expect(
    result.assignments.find((row) => row.position === "H05")?.systemNotes
  ).toBeUndefined();
  expect(
    result.assignments.find((row) => row.position === "督导")?.staffId
  ).toBe("worker-0");
  expect(
    result.assignments.find((row) => row.flightNo === "TEST1")?.staffId
  ).toBe("worker-1");
  // A later write cannot bypass the same final guard after a successful refill.
  const invalid = structuredClone(result.assignments);
  const h05 = invalid.find((row) => row.position === "H05")!;
  h05.staffId = "worker-0";
  h05.staffName = state.staff[0]!.name;
  expect(() =>
    createScheduleSafetySession({
      phase: "final",
      state,
      date: "2026-10-14",
      runFacts: createScheduleRunFacts(state, "2026-10-14"),
    }).assertAssignmentsSafe(invalid)
  ).toThrow();
});

it("keeps the first one-number position when a late change duplicates it", async () => {
  const { result } = await runFinalizer(({ state, assignments, tasks }) => {
    state.settings.dailyPrimaryPositionUniqueEnabled = true;
    tasks[1]!.rule.qualifiedStaffIds = ["worker-0"];
    assignments[1] = createAssignedPosition(
      tasks[1]!,
      state.staff[0]!,
      2,
      [],
      []
    );
  });
  expect(result.assignments[0]!.staffId).toBe("worker-0");
  expect(result.assignments[1]!.status).toBe("unfilled");
  expect(result.warnings.join("；")).toContain("一个人只能做一次一号");
});

it("creates a vacancy for a missing final automatic position without dropping another flight", async () => {
  const { result } = await runFinalizer(({ assignments }) => {
    assignments.splice(0, 1);
  });
  expect(result.assignments).toHaveLength(2);
  expect(result.assignments[0]!.status).toBe("unfilled");
  expect(result.assignments[1]!.staffId).toBe("worker-1");
});

it("may leave a locked automatic position vacant to satisfy an otherwise impossible balance", async () => {
  const { result } = await runFinalizer(
    ({ state, tasks, assignments, locks, preserved }) => {
      const flight = {
        ...state.flights[1]!,
        id: "flight-2",
        flightNo: "TEST2",
        startTime: "18:00",
        endTime: "20:00",
      };
      const rule = {
        ...state.positionRules[1]!,
        id: "rule-2",
        flightNo: "TEST2",
        qualifiedStaffIds: ["worker-0"],
      };
      state.flights.push(flight);
      state.positionRules.push(rule);
      tasks.push({ key: `${flight.id}:${rule.id}`, flight, rule });
      tasks[1]!.rule.qualifiedStaffIds = ["worker-0"];
      assignments.splice(
        0,
        assignments.length,
        ...tasks.map((task) =>
          createAssignedPosition(task, state.staff[0]!, 2, [], [])
        )
      );
      assignments.forEach((row) => {
        locks.add(row.id);
        preserved.push(structuredClone(row));
      });
    }
  );
  expect(
    result.assignments.filter((row) => row.status === "assigned")
  ).toHaveLength(1);
  expect(result.unfilledCount).toBe(2);
  expect(result.warnings.join("；")).toContain("航班数均衡");
});
