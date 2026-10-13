import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { reviewLatePriorityFrequency } from "../../src/domain/reviews/late-priority-frequency-review";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import type {
  AppState,
  Assignment,
  HistoryRecord,
  PositionRule,
  Staff,
} from "../../src/model";

const DATE = "2026-08-18";

function setup(): {
  state: AppState;
  underused: Staff;
  frequent: Staff;
  assignments: Assignment[];
} {
  const state = createDefaultState();
  // Isolate frequency: this fixture repeats the only (therefore first) job
  // across flights. Daily-primary enforcement has its own cross-intent test.
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  const [underused, frequent] = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 2);
  state.staff = [underused!, frequent!];
  state.staff.forEach((person) => {
    person.dutyQualified = false;
    person.nightShift = true;
  });
  state.settings.positionRotationEnabled = true;
  state.settings.lateShiftEndTime = "23:00";
  state.flights = [
    {
      id: "early",
      flightNo: "EARLY",
      startTime: "08:00",
      endTime: "10:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "late",
      flightNo: "FD573",
      startTime: "21:55",
      endTime: "23:55",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  const earlyRule = {
    ...state.positionRules[0]!,
    id: "early-rule",
    flightNo: "EARLY",
    name: "E01",
    remark: "",
    category: "常规",
    qualifiedStaffIds: [underused!.id, frequent!.id],
  } satisfies PositionRule;
  const lateRule = {
    ...state.positionRules[0]!,
    id: "late-rule",
    flightNo: "FD573",
    name: "H04",
    remark: "申报",
    category: "常规",
    qualifiedStaffIds: [underused!.id, frequent!.id],
  } satisfies PositionRule;
  state.positionRules = [earlyRule, lateRule];
  state.history = [
    history(frequent!, "2026-08-12", "FD573", "H04", "申报", 0),
    history(frequent!, "2026-08-14", "FD573", "H04", "申报", 1),
  ];
  const assignments = [
    assignment("early-underused", "early", "EARLY", earlyRule, underused!),
    assignment("early-frequent", "early", "EARLY", earlyRule, frequent!),
    assignment("late-primary", "late", "FD573", lateRule, frequent!),
  ];
  assignments[1]!.startTime = "10:15";
  assignments[1]!.endTime = "12:15";
  state.assignments = structuredClone(assignments);
  return { state, underused: underused!, frequent: frequent!, assignments };
}

function assignment(
  id: string,
  flightId: string,
  flightNo: string,
  rule: PositionRule,
  person: Staff
): Assignment {
  const late = flightId === "late";
  return {
    id,
    flightId,
    flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: person.id,
    staffName: person.name,
    startTime: late ? "21:55" : "08:00",
    endTime: late ? "23:55" : "10:00",
    workHours: 2,
    fatiguePoints: rule.fatiguePoints,
    remark: rule.remark,
    manualRemark: "",
    status: "assigned",
  };
}

function history(
  person: Staff,
  date: string,
  flightNo: string,
  position: string,
  remark: string,
  index: number
): HistoryRecord {
  return {
    id: `${person.id}-${index}`,
    date,
    flightNo,
    position,
    staffId: person.id,
    staffName: person.name,
    startTime: "21:55",
    endTime: "23:55",
    workHours: 2,
    fatiguePoints: 5,
    remark,
  };
}

describe("late priority frequency review", () => {
  it("moves a same-flight supervisor role to the lower-frequency supervisor before comparing combined late roles", async () => {
    const { state, underused, frequent, assignments } = setup();
    const supervisorRule = {
      ...state.positionRules[1]!,
      id: "late-supervisor-rule",
      name: "督导",
      remark: "",
      qualifiedStaffIds: [underused.id, frequent.id],
    } satisfies PositionRule;
    state.positionRules = [state.positionRules[0]!, supervisorRule];
    state.history = [
      ...Array.from({ length: 4 }, (_, index) =>
        history(frequent, "2026-08-12", "FD573", "督导", "", index)
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        history(underused, "2026-08-12", "OTHER", "H04", "申报", index + 10)
      ),
      history(frequent, "2026-08-16", "EARLY", "E01", "", 99),
    ];
    const primary = assignments.find((item) => item.id === "late-primary")!;
    primary.positionRuleId = supervisorRule.id;
    primary.position = supervisorRule.name;
    primary.remark = supervisorRule.remark;

    const warnings = await reviewLatePriorityFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(primary.staffId).toBe(underused.id);
  });

  it("safely moves a late declaration role to the lowest-frequency qualified worker", async () => {
    const { state, underused, assignments } = setup();

    const warnings = await reviewLatePriorityFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      assignments.find((item) => item.id === "late-primary")?.staffId
    ).toBe(underused.id);
    expect(
      assignments
        .find((item) => item.id === "late-primary")
        ?.decisionTrace?.some(
          (decision) =>
            decision.ruleId === "late-priority-frequency" &&
            decision.outcome === "selected"
        )
    ).toBe(true);
  });

  it("reviews a combined role as delivery rather than declaration", async () => {
    const { state, underused, assignments } = setup();
    const combinedRule = state.positionRules.find(
      (rule) => rule.id === "late-rule"
    )!;
    combinedRule.remark = "申报/送资料";
    state.history.forEach((record) => {
      record.remark = "申报/送资料";
    });
    const primary = assignments.find((item) => item.id === "late-primary")!;
    primary.remark = "申报/送资料";

    const warnings = await reviewLatePriorityFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(primary.staffId).toBe(underused.id);
    const message = primary.decisionTrace?.find(
      (decision) => decision.ruleId === "late-priority-frequency"
    )?.message;
    expect(message).toContain("本月跨航班送资料");
    expect(message).not.toContain("本月跨航班申报");
  });

  it("does not warn when the current late role is already assigned to a lowest-frequency worker", async () => {
    const { state, underused, assignments } = setup();
    const primary = assignments.find((item) => item.id === "late-primary")!;
    primary.staffId = underused.id;
    primary.staffName = underused.name;

    const warnings = await reviewLatePriorityFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(warnings).toEqual([]);
    expect(
      primary.decisionTrace?.some(
        (decision) =>
          decision.ruleId === "late-priority-frequency" &&
          decision.outcome === "fallback"
      )
    ).toBeFalsy();
  });

  it("uses a concise warning when the lowest-frequency worker is unavailable for a safe move", async () => {
    const { state, underused, frequent, assignments } = setup();
    const blockingRule = {
      ...state.positionRules[0]!,
      id: "blocking-rule",
      flightNo: "FD573",
      name: "H06",
      remark: "",
      qualifiedStaffIds: [underused.id],
    } satisfies PositionRule;
    state.positionRules.push(blockingRule);
    assignments.push(
      assignment("locked-blocker", "late", "FD573", blockingRule, underused)
    );

    const warnings = await reviewLatePriorityFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set(["locked-blocker"])
    );

    expect(
      assignments.find((item) => item.id === "late-primary")?.staffId
    ).toBe(frequent.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(frequent.name);
    expect(warnings[0]).not.toMatch(/infeasible|求解目标|完整重排方案/i);
    expect(warnings[0]!.split("。").filter(Boolean)).toHaveLength(2);
  });

  it("does not create a diversion transfer only to improve late-priority frequency", async () => {
    const state = createDefaultState();
    const [protectedWorker, replacementWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [protectedWorker!, replacementWorker!];
    protectedWorker!.name = "人员A";
    replacementWorker!.name = "人员B";
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.settings.positionRotationEnabled = true;
    state.settings.latePriorityFlightNumbers = ["TARGET"];
    state.settings.lateShiftEndTime = "23:00";
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    const sourceFlight = {
      ...state.flights[0]!,
      id: "source-flight",
      flightNo: "SOURCE",
      startTime: "21:05",
      endTime: "23:05",
    };
    const targetFlight = {
      ...state.flights[0]!,
      id: "target-flight",
      flightNo: "TARGET",
      startTime: "21:55",
      endTime: "23:55",
    };
    const sourceRule: PositionRule = {
      ...state.positionRules[0]!,
      id: "source-rule",
      flightNo: "SOURCE",
      name: "G09",
      category: "分流",
      earlyReleaseMinutes: 75,
      qualifiedStaffIds: [protectedWorker!.id],
    };
    const targetRule: PositionRule = {
      ...sourceRule,
      id: "target-rule",
      flightNo: "TARGET",
      name: "H02",
      category: "常规",
      remark: "申报",
      earlyReleaseMinutes: 0,
      qualifiedStaffIds: [protectedWorker!.id, replacementWorker!.id],
    };
    const source: Assignment = {
      id: "source-assignment",
      flightId: sourceFlight.id,
      flightNo: sourceFlight.flightNo,
      positionRuleId: sourceRule.id,
      position: sourceRule.name,
      staffId: protectedWorker!.id,
      staffName: protectedWorker!.name,
      startTime: sourceFlight.startTime,
      endTime: "22:10",
      workHours: 1.08,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
    const target: Assignment = {
      id: "target-assignment",
      flightId: targetFlight.id,
      flightNo: targetFlight.flightNo,
      positionRuleId: targetRule.id,
      position: targetRule.name,
      staffId: replacementWorker!.id,
      staffName: replacementWorker!.name,
      startTime: targetFlight.startTime,
      endTime: targetFlight.endTime,
      workHours: 2,
      fatiguePoints: 5,
      remark: targetRule.remark,
      manualRemark: "",
      status: "assigned",
    };
    state.flights = [sourceFlight, targetFlight];
    state.positionRules = [sourceRule, targetRule];
    state.history = Array.from({ length: 4 }, (_, index) => ({
      id: `history-${index}`,
      date: `2026-08-${10 + index}`,
      flightNo: "TARGET",
      position: "H02",
      staffId: replacementWorker!.id,
      staffName: replacementWorker!.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 5,
      remark: "申报",
    }));
    const assignments = [source, target];

    await reviewLatePriorityFrequency(
      defaultHighsSolver,
      state,
      assignments,
      DATE,
      new Set()
    );

    expect(target.staffId).toBe(replacementWorker!.id);
    expect(source.endTime).toBe("22:10");
    expect(source.workHours).toBe(1.08);
  });
});
