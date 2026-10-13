import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { Assignment } from "../../src/model";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { createDailyPrimaryPositionScheduleGuard } from "../../src/domain/kernel/schedule-guard";
import { optimizeReassignment } from "../../src/domain/solver/reassignment-optimizer";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { finalizeMobileSupervisors } from "../../src/domain/assignments/ke166-supervisor-finalizer";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import type { ReassignmentIntent } from "../../src/domain/solver/reassignment-intent";
function scenario() {
  const state = createDefaultState();
  state.staff = state.staff.slice(0, 3).map((p, i) => ({
    ...p,
    id: `S${i}`,
    name: `P${i}`,
    staffType: "常规",
    status: "正常",
    nightShift: true,
    teamLeader: false,
  }));
  state.history = [];
  state.assignments = [];
  state.dutyRosterOverrides = [];
  Object.assign(state.settings, {
    positionRotationEnabled: false,
    lateShiftRecoveryEnabled: false,
    highLoadProtectionEnabled: false,
    rollingLoadProtectionEnabled: false,
    workloadBalanceEnabled: false,
    maxDailyHours: 12,
    positionTransitionPolicies: [],
    crossWorkdayQualificationReservations: [],
    crossFlightPriorityPolicies: [],
    latePriorityFlightNumbers: [],
  });
  state.flights = [
    {
      id: "f1",
      flightNo: "KE166",
      startTime: "09:15",
      endTime: "11:15",
      positions: ["H02", "H05", "H06"],
      bookedPassengers: 200,
      remark: "",
    },
    {
      id: "f2",
      flightNo: "OTHER100",
      startTime: "17:50",
      endTime: "19:50",
      positions: ["G20"],
      bookedPassengers: 200,
      remark: "",
    },
  ];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "r1",
      flightNo: "KE166",
      name: "H02",
      category: "常规",
      coverageRole: "none",
      manual: false,
      minPassengers: 0,
      remark: "一号",
      qualifiedStaffIds: ["S0", "S2"],
    },
    {
      ...base,
      id: "r2",
      flightNo: "KE166",
      name: "H05",
      category: "常规",
      coverageRole: "none",
      manual: false,
      minPassengers: 0,
      remark: "",
      qualifiedStaffIds: ["S0", "S1"],
    },
    {
      ...base,
      id: "r3",
      flightNo: "KE166",
      name: "H06",
      category: "常规",
      coverageRole: "none",
      manual: false,
      minPassengers: 0,
      remark: "",
      qualifiedStaffIds: ["S1", "S2"],
    },
    {
      ...base,
      id: "r4",
      flightNo: "OTHER100",
      name: "G20",
      category: "常规",
      coverageRole: "none",
      manual: false,
      minPassengers: 0,
      remark: "一号",
      qualifiedStaffIds: ["S2"],
    },
  ];
  const assignments = state.positionRules.map<Assignment>((r, i) => {
    const f = state.flights.find((f) => f.flightNo === r.flightNo)!;
    const id = ["S0", "S1", "S2", "S2"][i]!;
    return {
      id: `A${i}`,
      flightId: f.id,
      flightNo: f.flightNo,
      positionRuleId: r.id,
      position: r.name,
      staffId: id,
      staffName: id,
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: r.remark,
      manualRemark: "",
      status: "assigned",
    };
  });
  return { state, assignments };
}
describe("daily primary position in supervisor reassignment", () => {
  it("rejects two movable first positions too", async () => {
    const { state, assignments } = scenario();
    const result = await optimizeReassignment({
      solver: defaultHighsSolver,
      state,
      assignments,
      primary: assignments[1]!,
      movableAssignments: assignments,
      date: "2026-10-15",
      intent: { kind: "configured-supervisor-fill-under-shortage" },
      primaryCandidateAllowed: (p) => p.id === "S0",
      maxParticipants: 5,
    });
    expect(result.changes).toBeNull();
  });
  it("rejects a normalized plan that reintroduces a duplicate after solving", () => {
    const { state, assignments } = scenario();
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments,
      date: "2026-10-15",
      primaryAssignmentId: "A1",
      intent: { kind: "configured-supervisor-fill-under-shortage" },
      changes: [
        { assignmentId: "A1", staffId: "S0" },
        { assignmentId: "A0", staffId: "S2" },
        { assignmentId: "A2", staffId: "S1" },
      ],
    });
    expect(reasons.some((reason) => reason.includes("一号"))).toBe(true);
  });
  it("preserves legal counters and records the actual rejection at supervisor finalization", async () => {
    const { state, assignments } = scenario();
    state.settings.minimumRegularTransitionMinutes = 0;
    state.positionRules[1]!.coverageRole = "supervisor-fill";
    state.positionRules.unshift({
      ...state.positionRules[0]!,
      id: "supervisor",
      name: "督导",
      remark: "",
      category: "机动督导",
      qualifiedStaffIds: ["S0"],
    });
    state.settings.mobileSupervisorFillRules = [
      {
        id: "specified",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    const before = structuredClone(assignments);
    const preparation = prepareSchedule(
      state,
      "2026-10-15",
      evaluateAutomaticHardConstraints
    );
    await finalizeMobileSupervisors({
      state,
      assignments,
      date: "2026-10-15",
      solver: defaultHighsSolver,
      preparation,
      lockedAssignmentIds: new Set(),
    });
    expect(assignments.slice(0, 4).map((row) => row.staffId)).toEqual(
      before.map((row) => row.staffId)
    );
    const supervisor = assignments.find(
      (row) => row.positionRuleId === "supervisor"
    )!;
    expect(supervisor.status).toBe("unfilled");
    expect(supervisor.systemNotes?.join("；")).toContain("一号");
    expect(
      createDailyPrimaryPositionScheduleGuard().validate(assignments, {
        phase: "partial",
        dailyPrimaryPositionFacts: { state },
      })
    ).toEqual([]);
  });
  it.each<ReassignmentIntent>([
    { kind: "configured-supervisor-fill-under-shortage" },
    { kind: "mobile-supervisor-counter-coverage" },
    { kind: "next-workday-cutoff-recovery" },
    { kind: "late-priority-frequency-review" },
    { kind: "team-leader-concurrent-gap-fill" },
    { kind: "team-leader-gap-fill", crossWorkdayReservation: "preserve" },
  ])("rejects a fixed first-position duplicate in %j", async (intent) => {
    const { state, assignments } = scenario();
    const guard = createDailyPrimaryPositionScheduleGuard();
    expect(
      guard.validate(assignments, {
        phase: "partial",
        dailyPrimaryPositionFacts: { state },
      })
    ).toEqual([]);
    const result = await optimizeReassignment({
      solver: defaultHighsSolver,
      state,
      assignments,
      primary: assignments[1]!,
      movableAssignments: assignments.slice(0, 3),
      date: "2026-10-15",
      intent,
      primaryCandidateAllowed: (p) => p.id === "S0",
      maxParticipants: 5,
    });

    expect(
      result.changes,
      "a globally illegal chain must not be accepted as a valid fill"
    ).toBeNull();
  });
  it("finds another legal chain instead of abandoning all supervisors", async () => {
    const { state, assignments } = scenario();
    state.staff.push({ ...state.staff[0]!, id: "S3", name: "P3" });
    state.positionRules[0]!.qualifiedStaffIds.push("S3");
    const result = await optimizeReassignment({
      solver: defaultHighsSolver,
      state,
      assignments,
      primary: assignments[1]!,
      movableAssignments: assignments.slice(0, 3),
      date: "2026-10-15",
      intent: { kind: "configured-supervisor-fill-under-shortage" },
      primaryCandidateAllowed: (p) => p.id === "S0",
      maxParticipants: 5,
    });
    expect(result.changes).not.toBeNull();
    const projected = assignments.map((row) => {
      const change = result.changes?.find((c) => c.assignmentId === row.id);
      return change ? { ...row, staffId: change.staffId } : row;
    });
    expect(projected[1]!.staffId).toBe("S0");
    expect(projected[3]!.staffId).toBe("S2");
    expect(
      createDailyPrimaryPositionScheduleGuard().validate(projected, {
        phase: "partial",
        dailyPrimaryPositionFacts: { state },
      })
    ).toEqual([]);
  });
  it("honors the disabled setting", async () => {
    const { state, assignments } = scenario();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    const result = await optimizeReassignment({
      solver: defaultHighsSolver,
      state,
      assignments,
      primary: assignments[1]!,
      movableAssignments: assignments.slice(0, 3),
      date: "2026-10-15",
      intent: { kind: "configured-supervisor-fill-under-shortage" },
      primaryCandidateAllowed: (p) => p.id === "S0",
      maxParticipants: 5,
    });
    expect(result.changes).not.toBeNull();
  });
});
