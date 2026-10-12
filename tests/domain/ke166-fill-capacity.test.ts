import { expect, it } from "vitest";
import { assessKe166DistinctStaffCapacityFacts } from "../../src/domain/assignments/ke166-assignment";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { createDefaultState } from "../../src/defaults";
import { createAssignedPosition } from "../../src/domain/assignments/assignment-factory";
import { finalizeMobileSupervisors } from "../../src/domain/assignments/ke166-supervisor-finalizer";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { createKe166SnapshotScheduleGuard } from "../../src/domain/kernel/schedule-guard";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import * as XLSX from "xlsx-js-style";
import { generateSchedule } from "../helpers/generate-schedule";

function scenario() {
  const state = createDefaultState();
  const date = "2026-10-14";
  state.staff = state.staff.slice(0, 3).map((person, index) => ({
    ...person,
    id: `person-${index}`,
    name: `测试人员${index}`,
    status: "正常",
    staffType: "常规",
    teamLeader: false,
    nightShift: true,
    dutyQualified: false,
  }));
  const [supervisor, helper, spare] = state.staff;
  state.history = [];
  state.dutyRosterOverrides = [
    {
      date,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  state.settings.positionRotationEnabled = false;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.sameFlightStaffExclusions = [];
  state.settings.crossFlightPriorityPolicies = [
    {
      id: "ke-first",
      flightNo: "KE166",
      staffIds: [helper!.id],
      enabled: true,
    },
  ];
  state.settings.mobileSupervisorFillRules = [
    {
      id: "ke-h05",
      sourceFlightNo: "KE166",
      sourcePositionKeyword: "督导",
      targetFlightNo: "KE166",
      targetPositionKeyword: "H05",
      enabled: true,
      allowAutomatic: true,
      allowManual: true,
    },
  ];
  const flight = {
    id: "ke",
    flightNo: "KE166",
    startTime: "09:15",
    endTime: "11:15",
    bookedPassengers: 0,
    positions: [],
    remark: "",
  };
  const afternoon = {
    ...flight,
    id: "afternoon",
    flightNo: "OTHER100",
    startTime: "14:00",
    endTime: "16:00",
  };
  state.flights = [flight, afternoon];
  const base = {
    ...state.positionRules[0]!,
    manual: false,
    remark: "",
    minPassengers: 0,
    fatiguePoints: 2,
    coverageRole: undefined,
  };
  state.positionRules = [
    {
      ...base,
      id: "source",
      flightNo: "KE166",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: [supervisor!.id],
    },
    {
      ...base,
      id: "h03",
      flightNo: "KE166",
      name: "H03",
      category: "常规",
      qualifiedStaffIds: [supervisor!.id, spare!.id],
    },
    {
      ...base,
      id: "h05",
      flightNo: "KE166",
      name: "H05",
      category: "常规",
      coverageRole: "supervisor-fill",
      qualifiedStaffIds: [helper!.id, supervisor!.id],
    },
    {
      ...base,
      id: "afternoon",
      flightNo: "OTHER100",
      name: "G01",
      category: "常规",
      qualifiedStaffIds: [helper!.id],
    },
  ];
  const preparation = prepareSchedule(
    state,
    date,
    evaluateAutomaticHardConstraints
  );
  const assignments = preparation.tasks
    .filter((task) => task.rule.category !== "机动督导")
    .map((task) =>
      createAssignedPosition(
        task,
        task.rule.id === "h03" ? supervisor! : helper!,
        2,
        [],
        []
      )
    );
  return {
    state,
    date,
    flight,
    supervisor: supervisor!,
    helper: helper!,
    assignments,
    preparation,
  };
}

it("rejects a configured H05 proposal that frees its safe regular worker, preserving the original counters", async () => {
  const { state, date, flight, helper, supervisor, assignments, preparation } =
    scenario();
  const originalAssignments = structuredClone(assignments);
  expect(
    evaluateAutomaticHardConstraints({
      state,
      assignments: assignments.filter((item) => item.position !== "H05"),
      flight,
      rule: state.positionRules.find((item) => item.id === "h05")!,
      person: helper,
      workHours: 2,
      transitionMode: "forbid",
    }).eligible
  ).toBe(true);
  await finalizeMobileSupervisors({
    solver: defaultHighsSolver,
    state,
    date,
    assignments,
    preparation,
    lockedAssignmentIds: new Set(),
  });
  expect(assessKe166DistinctStaffCapacityFacts(state, assignments)).toEqual([]);
  expect(
    assignments.filter(
      (item) => item.position === "H05" || item.flightNo === "OTHER100"
    )
  ).toEqual(
    originalAssignments.filter(
      (item) => item.position === "H05" || item.flightNo === "OTHER100"
    )
  );
  expect(assignments.find((item) => item.position === "H03")?.staffId).toBe(
    state.staff[2]!.id
  );
  expect(assignments.find((item) => item.position === "H05")).toMatchObject({
    staffId: helper.id,
    workHours: 2,
  });
  expect(assignments.find((item) => item.position === "督导")).toMatchObject({
    staffId: supervisor.id,
    status: "assigned",
  });
  expect(
    assignments.every(
      (item) => !item.supervisorSourceAssignmentId && !item.supervisorFillRuleId
    )
  ).toBe(true);
  expect(
    assignments
      .find((item) => item.position === "督导")
      ?.decisionTrace?.some((item) => item.message.includes("腾挪后"))
  ).toBe(true);
  expect(
    createKe166SnapshotScheduleGuard().validate(assignments, {
      phase: "final",
      ke166SnapshotFacts: { state, date },
    })
  ).toEqual([]);
});

it("leaves only the KE166 supervisor vacant when fallback sharing still violates capacity", async () => {
  const { state, date, helper, assignments } = scenario();
  state.settings.mobileSupervisorFillRules = [];
  state.positionRules = state.positionRules.filter((item) => item.id !== "h05");
  state.positionRules
    .find((item) => item.id === "h03")!
    .qualifiedStaffIds.push(helper.id);
  assignments.splice(
    assignments.findIndex((item) => item.position === "H05"),
    1
  );
  const originalAssignments = structuredClone(assignments);
  const preparation = prepareSchedule(
    state,
    date,
    evaluateAutomaticHardConstraints
  );
  await finalizeMobileSupervisors({
    solver: defaultHighsSolver,
    state,
    date,
    assignments,
    preparation,
    lockedAssignmentIds: new Set(),
  });
  expect(assignments.filter((item) => item.position !== "督导")).toEqual(
    originalAssignments
  );
  expect(assignments.find((item) => item.position === "督导")).toMatchObject({
    staffId: null,
    status: "unfilled",
  });
  expect(
    assignments
      .find((item) => item.position === "督导")
      ?.decisionTrace?.some((item) => item.message.includes("已恢复原柜台安排"))
  ).toBe(true);
  expect(
    assignments.every(
      (item) => !item.supervisorSourceAssignmentId && !item.supervisorFillRuleId
    )
  ).toBe(true);
  const violations = createKe166SnapshotScheduleGuard().validate(assignments, {
    phase: "final",
    ke166SnapshotFacts: { state, date },
  });
  expect(violations).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: "KE166机动督导未安排，岗位已留空，请人工复核",
    }),
  ]);
  state.assignments = assignments;
  const workbook = buildScheduleWorkbook(state, date);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets["排班结果"]!
  );
  expect(rows.find((row) => row["岗位"] === "H03")?.["姓名"]).toBe(
    originalAssignments[0]!.staffName
  );
  expect(rows.find((row) => row["岗位"] === "督导")?.["姓名"] ?? "").toBe("");
});

it("keeps the final guard rejecting a later stage that recreates invalid H05 sharing", async () => {
  const { state, date, assignments, preparation, helper } = scenario();
  await finalizeMobileSupervisors({
    solver: defaultHighsSolver,
    state,
    date,
    assignments,
    preparation,
    lockedAssignmentIds: new Set(),
  });
  const source = assignments.find((item) => item.position === "督导")!;
  const illegal = structuredClone(assignments);
  const counter = illegal.find((item) => item.position === "H03")!;
  delete counter.supervisorSourceAssignmentId;
  counter.workHours = 2;
  counter.staffId = state.staff[2]!.id;
  counter.staffName = state.staff[2]!.name;
  Object.assign(
    illegal.find((item) => item.position === "H05")!,
    {
      staffId: source.staffId,
      staffName: source.staffName,
      supervisorSourceAssignmentId: source.id,
      supervisorFillRuleId: "ke-h05",
      workHours: 0,
      fatiguePoints: 0,
    }
  );
  const violations = createKe166SnapshotScheduleGuard().validate(illegal, {
    phase: "final",
    ke166SnapshotFacts: { state, date },
  });
  expect(violations[0]).toMatchObject({
    details: {
      code: "ke166-distinct-staff-capacity",
      reason: expect.stringContaining(helper.name),
    },
  });
});

it("restores an available independent supervisor instead of leaving a vacancy after an invalid rotation proposal", async () => {
  const { state, date, helper, assignments } = scenario();
  const independent = state.staff[2]!;
  independent.teamLeader = true;
  state.settings.mobileSupervisorFillRules = [];
  state.positionRules = state.positionRules.filter((item) => item.id !== "h05");
  state.positionRules
    .find((item) => item.id === "h03")!
    .qualifiedStaffIds.push(helper.id);
  state.positionRules
    .find((item) => item.id === "source")!
    .qualifiedStaffIds.push(independent.id);
  assignments.splice(
    assignments.findIndex((item) => item.position === "H05"),
    1
  );
  state.history = [
    {
      id: "previous-supervisor",
      date: "2026-10-12",
      flightNo: "KE166",
      position: "督导",
      staffId: independent.id,
      staffName: independent.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 2,
      remark: "",
    },
  ];
  const originalAssignments = structuredClone(assignments);
  const preparation = prepareSchedule(
    state,
    date,
    evaluateAutomaticHardConstraints
  );
  await finalizeMobileSupervisors({
    solver: defaultHighsSolver,
    state,
    date,
    assignments,
    preparation,
    lockedAssignmentIds: new Set(),
  });
  expect(assignments.filter((item) => item.position !== "督导")).toEqual(
    originalAssignments
  );
  expect(assignments.find((item) => item.position === "督导")).toMatchObject({
    staffId: independent.id,
    status: "assigned",
  });
  expect(
    createKe166SnapshotScheduleGuard().validate(assignments, {
      phase: "final",
      ke166SnapshotFacts: { state, date },
    })
  ).toEqual([]);
});

it("produces a safe kernel result and exports the regular H05 assignment", async () => {
  const { state, date } = scenario();
  const result = await generateSchedule(state, date);
  expect(result.safetyCredential).toBeDefined();
  const h05 = result.assignments.find((item) => item.position === "H05")!;
  expect(h05).toMatchObject({ status: "assigned", workHours: 2 });
  expect(h05.staffId).toBeTruthy();
  expect(h05.supervisorSourceAssignmentId).toBeUndefined();
  expect(
    assessKe166DistinctStaffCapacityFacts(state, result.assignments)
  ).toEqual([]);
  expect(
    result.assignments.filter((item) => item.status === "unfilled")
  ).toEqual([]);
  state.assignments = result.assignments;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    buildScheduleWorkbook(state, date).Sheets["排班结果"]!
  );
  expect(rows.find((row) => row["岗位"] === "H05")).toMatchObject({
    姓名: h05.staffName,
    "工作时长(小时)": 2,
  });
});
