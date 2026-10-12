import { describe, expect, it } from "vitest";
import { createSchedulingScenario } from "../helpers/scheduling-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { recoverLocalScheduleIssues } from "../../src/domain/kernel/schedule-local-recovery";
import { assertDailyScheduleSafety } from "../../src/domain/kernel/daily-schedule-safety";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { createAssignedPosition } from "../../src/domain/assignments/assignment-factory";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import { utils } from "xlsx-js-style";
import type { AssignmentTask } from "../../src/domain/flights/schedule-tasks";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { createDefaultState } from "../../src/defaults";

function fixture() {
  const state = createSchedulingScenario();
  state.staff = [0, 1].map((index) => ({
    ...state.staff[index]!,
    id: `worker-${index}`,
    name: `人员${index}`,
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: false,
    dutyQualified: true,
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
  state.settings.crossFlightPriorityPolicies = [];
  const tasks: AssignmentTask[] = state.positionRules.map((rule, index) => ({
    key: `${state.flights[index]!.id}:${rule.id}`,
    flight: state.flights[index]!,
    rule,
  }));
  const assignments = tasks.map((task, index) =>
    createAssignedPosition(task, state.staff[index]!, 2, [], [])
  );
  const check = (rows: readonly (typeof assignments)[number][]) =>
    assertDailyScheduleSafety({
      state,
      date: "2026-10-14",
      assignments: rows,
      tasks,
      evaluateEligibility: evaluateAutomaticHardConstraints,
      allowFinalizedConcurrency: true,
    });
  return { state, tasks, assignments, check };
}

describe("automatic schedule local vacancy recovery", () => {
  it("leaves a strict recovery target empty with the actual reason and keeps another flight", async () => {
    const { state } = fixture();
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.nextWorkdayRecoveryMode = "forbid";
    state.settings.nextWorkdayRecoveryTargets = [
      {
        id: "target",
        enabled: true,
        flightNo: "TEST0",
        positionKeyword: "柜台",
      },
    ];
    state.settings.lateShiftRecoveryPositionRules = [
      {
        id: "previous",
        enabled: true,
        flightNo: "LATE1",
        matchField: "remark",
        keyword: "一号",
        nextWorkdayCutoffTime: "",
      },
    ];
    state.history = [
      {
        id: "previous",
        date: "2026-10-12",
        flightNo: "LATE1",
        position: "H01",
        staffId: "worker-0",
        staffName: "人员0",
        startTime: "21:00",
        endTime: "23:55",
        workHours: 2.9,
        fatiguePoints: 3,
        remark: "一号",
      },
    ];
    const result = await generateSchedule(state, "2026-10-14");
    expect(
      result.assignments.find((row) => row.flightId === "flight-0")
    ).toMatchObject({ status: "unfilled", staffId: null });
    expect(
      result.assignments.find((row) => row.flightId === "flight-1")!.staffId
    ).toBe("worker-1");
    expect(
      result.assignments
        .find((row) => row.flightId === "flight-0")!
        .systemNotes?.join("；")
    ).toContain("上一班做了需要休息保护");
    expect(result.safetyCredential).toBeDefined();
  });
  it.each(["休假", "病假"] as const)(
    "only clears the %s worker's row, preserves other assignments and exports the reason",
    (status) => {
      const { state, assignments, check } = fixture();
      const unaffected = structuredClone(assignments[1]!);
      state.staff[0]!.status = status;
      assignments[0]!.decisionEvidence = undefined;
      const warnings = recoverLocalScheduleIssues(state, assignments, check);
      expect(assignments[0]).toMatchObject({
        staffId: null,
        status: "unfilled",
      });
      expect(assignments[0]).not.toHaveProperty("decisionEvidence");
      expect(assignments[1]).toEqual(unaffected);
      expect(warnings.join("；")).toContain("今天不在岗");
      expect(() => check(assignments)).not.toThrow();
      const workbook = buildScheduleWorkbook(
        { ...createDefaultState(), ...state, assignments },
        "2026-10-14"
      );
      const text = workbook.SheetNames.flatMap((name) =>
        utils.sheet_to_json(workbook.Sheets[name]!, { header: 1 })
      )
        .flat()
        .join(" ");
      expect(text).toContain("今天不在岗");
    }
  );

  it("only clears an unqualified row without changing other legal workers", () => {
    const { state, assignments, check } = fixture();
    state.positionRules[0]!.qualifiedStaffIds = [];
    recoverLocalScheduleIssues(state, assignments, check);
    expect(assignments[0]!.systemNotes?.join("；")).toContain("合格人员名单");
    expect(assignments[1]!.staffId).toBe("worker-1");
  });

  it("rechecks after each conflict so it preserves one safe assignment rather than clearing both", () => {
    const { state, tasks, assignments, check } = fixture();
    tasks[1]!.rule.qualifiedStaffIds = ["worker-0"];
    tasks[1]!.flight.startTime = "09:00";
    tasks[1]!.flight.endTime = "11:00";
    assignments[1] = createAssignedPosition(
      tasks[1]!,
      state.staff[0]!,
      2,
      [],
      []
    );
    recoverLocalScheduleIssues(state, assignments, check);
    expect(assignments.filter((row) => row.status === "assigned")).toHaveLength(
      1
    );
    expect(assignments[0]!.staffId).toBe("worker-0");
    expect(assignments[1]!.status).toBe("unfilled");
    expect(() => check(assignments)).not.toThrow();
  });

  it("clears a removed supervisor's linked zero-hour counter and a guide borrowing that person", () => {
    const { state, tasks, assignments, check } = fixture();
    tasks[0]!.rule.category = "机动督导";
    const counterRule = {
      ...tasks[0]!.rule,
      id: "counter",
      name: "H05",
      category: "常规" as const,
    };
    const guideRule = {
      ...counterRule,
      id: "guide",
      name: "引导",
      category: "引导" as const,
    };
    state.positionRules.push(counterRule, guideRule);
    const counter = {
      ...createAssignedPosition(
        { ...tasks[0]!, rule: counterRule },
        state.staff[0]!,
        0,
        [],
        []
      ),
      supervisorSourceAssignmentId: assignments[0]!.id,
      supervisorFillRuleId: "fill",
      fatiguePoints: 0,
    };
    const guide = createAssignedPosition(
      { ...tasks[0]!, rule: guideRule },
      state.staff[0]!,
      0,
      [],
      []
    );
    assignments.push(counter, guide);
    state.staff[0]!.status = "休假";
    recoverLocalScheduleIssues(state, assignments, check);
    expect(
      assignments
        .filter((row) => row.status === "assigned")
        .map((row) => row.staffId)
    ).toEqual(["worker-1"]);
    expect(assignments.find((row) => row.id === counter.id)).not.toHaveProperty(
      "supervisorSourceAssignmentId"
    );
    expect(assignments.find((row) => row.id === counter.id)).not.toHaveProperty(
      "supervisorFillRuleId"
    );
    expect(assignments.find((row) => row.id === guide.id)).toMatchObject({
      workHours: 0,
      fatiguePoints: 0,
    });
  });

  it("keeps strict direct checks and never masks a program failure or an unlocatable error", () => {
    const { state, assignments, check } = fixture();
    state.staff[0]!.status = "休假";
    expect(() => check(assignments)).toThrow(ScheduleGuardError);
    const before = structuredClone(assignments);
    expect(() =>
      recoverLocalScheduleIssues(state, assignments, () => {
        throw new Error("program error");
      })
    ).toThrow("program error");
    expect(() =>
      recoverLocalScheduleIssues(state, assignments, () => {
        throw new ScheduleGuardError([
          { ruleId: "unknown", message: "unknown" },
        ]);
      })
    ).toThrow(ScheduleGuardError);
    expect(assignments).toEqual(before);
  });

  it.each(["early-finish", "late-start"] as const)(
    "generates the other flight when half-rest %s work cannot be assigned",
    async (mode) => {
      const { state } = fixture();
      const halfRestIndex = mode === "early-finish" ? 1 : 0;
      const result = await generateSchedule(state, "2026-10-14", {
        preferences: {
          halfRestStaffIds: [state.staff[halfRestIndex]!.id],
          halfRestModes: { [state.staff[halfRestIndex]!.id]: mode },
        },
      });
      expect(
        result.assignments.find(
          (row) => row.flightId === `flight-${halfRestIndex}`
        )
      ).toMatchObject({ status: "unfilled", staffId: null });
      expect(
        result.assignments.find(
          (row) => row.flightId === `flight-${1 - halfRestIndex}`
        )
      ).toMatchObject({
        status: "assigned",
        staffId: `worker-${1 - halfRestIndex}`,
      });
      expect(result.unfilledCount).toBe(1);
      expect(result.warnings.join("；")).toContain(
        state.staff[halfRestIndex]!.name
      );
      const safety = createScheduleSafetySession({
        phase: "final",
        state,
        date: "2026-10-14",
        runFacts: createScheduleRunFacts(state, "2026-10-14", {
          halfRestStaffIds: [state.staff[halfRestIndex]!.id],
          halfRestModes: { [state.staff[halfRestIndex]!.id]: mode },
        }),
      });
      expect(() =>
        safety.assertAssignmentsSafe(result.assignments)
      ).not.toThrow();
      expect(result.safetyCredential).toBeDefined();
    }
  );

  it("retains a sick duty plan, warns and generates the other legal flight", async () => {
    const { state } = fixture();
    state.staff[0]!.status = "病假";
    state.dutyRosterOverrides = [
      {
        date: "2026-10-14",
        dutyStaffId: "worker-0",
        cxPreflightStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    const result = await generateSchedule(state, "2026-10-14");
    expect(result.assignments.some((row) => row.staffId === "worker-0")).toBe(
      false
    );
    expect(
      result.assignments.find((row) => row.flightId === "flight-1")!.staffId
    ).toBe("worker-1");
    expect(result.warnings.join("；")).toContain("主值班人员人员0当前为病假");
    expect(state.dutyRosterOverrides[0]!.dutyStaffId).toBe("worker-0");
  });
});
