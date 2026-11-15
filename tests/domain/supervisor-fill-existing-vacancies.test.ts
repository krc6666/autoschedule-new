import { describe, expect, it } from "vitest";
import type { Assignment, PositionRule, Staff } from "../../src/model";
import { createOrdinarySchedulingState } from "../helpers/scheduling-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import {
  prepareConfiguredSupervisorFillUnderShortage,
  prepareConfiguredSupervisorFillUnderShortageByReassignment,
} from "../../src/domain/assignments/supervisor-fill";
import { finalizeMobileSupervisors } from "../../src/domain/assignments/ke166-supervisor-finalizer";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";

const DATE = "2026-11-18";
const cases = [
  {
    flightNo: "AB123",
    first: "G19",
    middle: "G15",
    target: "G14",
    vacancy: "G12",
  },
  {
    flightNo: "TR121",
    first: "H03",
    middle: "H06",
    target: "H07",
    vacancy: "H09",
  },
  {
    flightNo: "KE166",
    first: "H03",
    middle: "H06",
    target: "H05",
    vacancy: "H09",
  },
];

function scenario(example = cases[0]!, chain = false) {
  const state = createOrdinarySchedulingState();
  const basePerson = state.staff.find((person) => person.status === "正常")!;
  const person = (id: string): Staff => ({
    ...basePerson,
    id,
    name: id,
    teamLeader: false,
    dutyQualified: false,
    nightShift: true,
  });
  const supervisor = person("supervisor");
  const worker = person("worker");
  const bridge = person("bridge");
  state.staff = chain ? [supervisor, bridge, worker] : [supervisor, worker];
  state.history = [];
  state.assignments = [];
  state.dutyRosterOverrides = [
    {
      date: DATE,
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.workloadBalanceEnabled = false;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.positionTransitionPolicies = [];
  state.settings.ordinaryPriorityPositions = [];
  const flight = {
    id: "flight",
    flightNo: example.flightNo,
    startTime: "08:45",
    endTime: "10:45",
    bookedPassengers: 100,
    positions: [],
    remark: "",
  };
  state.flights = [flight];
  const base = state.positionRules[0]!;
  const rule = (id: string, name: string, ids: string[]): PositionRule => ({
    ...base,
    id,
    flightNo: flight.flightNo,
    name,
    category: "常规",
    remark: "",
    manual: false,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
    qualifiedStaffIds: ids,
    fatiguePoints: 2,
  });
  const source: PositionRule = {
    ...rule("source", "督导", [supervisor.id]),
    category: "机动督导",
    fatiguePoints: 4,
  };
  const first = rule("first", example.first, [
    supervisor.id,
    chain ? bridge.id : worker.id,
  ]);
  const middle = rule("middle", example.middle, [bridge.id, worker.id]);
  const target = rule("target", example.target, [worker.id]);
  const vacancy = rule("vacancy", example.vacancy, []);
  state.positionRules = [
    source,
    first,
    ...(chain ? [middle] : []),
    target,
    vacancy,
  ];
  state.settings.mobileSupervisorFillRules = [
    {
      id: "configured-fill",
      enabled: true,
      sourceFlightNo: flight.flightNo,
      sourcePositionKeyword: source.name,
      targetFlightNo: flight.flightNo,
      targetPositionKeyword: target.name,
      allowAutomatic: true,
      allowManual: true,
    },
  ];
  const assignment = (
    position: PositionRule,
    staff: Staff | null
  ): Assignment => ({
    id: `a-${position.id}`,
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: position.id,
    position: position.name,
    staffId: staff?.id ?? null,
    staffName: staff?.name ?? "",
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints: position.fatiguePoints,
    remark: position.remark,
    manualRemark: "",
    status: staff ? "assigned" : "unfilled",
  });
  const assignments = [
    assignment(first, supervisor),
    ...(chain ? [assignment(middle, bridge)] : []),
    assignment(target, worker),
    assignment(vacancy, null),
  ];
  const preparation = prepareSchedule(
    state,
    DATE,
    evaluateAutomaticHardConstraints
  );
  return {
    state,
    supervisor,
    worker,
    bridge,
    flight,
    source,
    first,
    middle,
    target,
    vacancy,
    assignments,
    assignment,
    preparation,
  };
}

describe("configured supervisor fill preserves pre-existing vacancies for every flight", () => {
  it.each(cases)(
    "backup refill preserves the old vacancy on $flightNo/$target",
    (example) => {
      const { state, supervisor, worker, flight, source, assignments } =
        scenario(example);
      const oldVacancy = structuredClone(assignments.at(-1)!);
      const chosen = prepareConfiguredSupervisorFillUnderShortage(
        state,
        assignments,
        flight,
        source
      );
      expect(chosen?.id).toBe(supervisor.id);
      expect(
        assignments.find((a) => a.positionRuleId === "first")?.staffId
      ).toBe(worker.id);
      expect(
        assignments.find((a) => a.positionRuleId === "target")?.staffId
      ).toBeNull();
      expect(assignments.at(-1)).toEqual(oldVacancy);
    }
  );

  it.each(cases)(
    "solver finds a legal chain despite an old vacancy on $flightNo/$target",
    async (example) => {
      const {
        state,
        supervisor,
        worker,
        bridge,
        flight,
        source,
        assignments,
        preparation,
      } = scenario(example, true);
      const oldVacancy = structuredClone(assignments.at(-1)!);
      const chosen =
        await prepareConfiguredSupervisorFillUnderShortageByReassignment(
          defaultHighsSolver,
          state,
          assignments,
          flight,
          source,
          DATE,
          preparation.runFacts
        );
      expect(chosen?.id).toBe(supervisor.id);
      expect(
        assignments.find((a) => a.positionRuleId === "first")?.staffId
      ).toBe(bridge.id);
      expect(
        assignments.find((a) => a.positionRuleId === "middle")?.staffId
      ).toBe(worker.id);
      expect(assignments.at(-1)).toEqual(oldVacancy);
    }
  );

  it.each(cases)(
    "final supervisor assignments keep the configured target on $flightNo",
    async (example) => {
      const { state, supervisor, assignments, preparation } = scenario(
        example,
        true
      );
      const oldVacancy = structuredClone(assignments.at(-1)!);
      const result = await finalizeMobileSupervisors({
        solver: defaultHighsSolver,
        state,
        date: DATE,
        assignments,
        preparation,
        lockedAssignmentIds: new Set(),
      });
      const source = result.find((a) => a.positionRuleId === "source")!;
      expect(result.find((a) => a.positionRuleId === "target")).toMatchObject({
        staffId: supervisor.id,
        supervisorSourceAssignmentId: source.id,
        supervisorFillRuleId: "configured-fill",
        workHours: 0,
        fatiguePoints: 0,
      });
      expect(result.find((a) => a.positionRuleId === "vacancy")).toEqual(
        oldVacancy
      );
      expect(
        result
          .filter((a) => a.status === "unfilled")
          .map((a) => a.positionRuleId)
      ).toEqual(["vacancy"]);
      expect(
        source.decisionTrace?.some((d) => d.outcome === "fallback")
      ).not.toBe(true);
    }
  );

  it("allows an originally empty configured target and multiple unrelated old vacancies", () => {
    const {
      state,
      supervisor,
      flight,
      source,
      target,
      vacancy,
      assignments,
      assignment,
    } = scenario();
    Object.assign(
      assignments.find((a) => a.positionRuleId === target.id)!,
      assignment(target, null)
    );
    const extraRule = { ...vacancy, id: "extra-vacancy", name: "G11" };
    state.positionRules.push(extraRule);
    assignments.push(assignment(extraRule, null));
    const oldVacancies = structuredClone(
      assignments.filter(
        (a) => a.positionRuleId !== "first" && a.positionRuleId !== "target"
      )
    );
    expect(
      prepareConfiguredSupervisorFillUnderShortage(
        state,
        assignments,
        flight,
        source
      )?.id
    ).toBe(supervisor.id);
    expect(
      assignments.filter((a) => oldVacancies.some((old) => old.id === a.id))
    ).toEqual(oldVacancies);
  });

  it.each(["backup", "solver"])(
    "%s refuses to move the old hole onto an occupied counter lacking a qualified replacement",
    async (path) => {
      const {
        state,
        supervisor,
        flight,
        source,
        first,
        assignments,
        preparation,
      } = scenario();
      first.qualifiedStaffIds = [supervisor.id];
      const before = structuredClone(assignments);
      const selected =
        path === "backup"
          ? prepareConfiguredSupervisorFillUnderShortage(
              state,
              assignments,
              flight,
              source
            )
          : await prepareConfiguredSupervisorFillUnderShortageByReassignment(
              defaultHighsSolver,
              state,
              assignments,
              flight,
              source,
              DATE,
              preparation.runFacts
            );
      expect(selected).toBeNull();
      expect(assignments).toEqual(before);
    }
  );

  it.each(["backup", "solver"])(
    "%s preserves locked target and existing vacancy",
    async (path) => {
      const { state, flight, source, target, assignments, preparation } =
        scenario();
      const before = structuredClone(assignments);
      const locked = new Set([
        assignments.find((a) => a.positionRuleId === target.id)!.id,
      ]);
      const selected =
        path === "backup"
          ? prepareConfiguredSupervisorFillUnderShortage(
              state,
              assignments,
              flight,
              source,
              locked
            )
          : await prepareConfiguredSupervisorFillUnderShortageByReassignment(
              defaultHighsSolver,
              state,
              assignments,
              flight,
              source,
              DATE,
              preparation.runFacts,
              locked
            );
      expect(selected).toBeNull();
      expect(assignments).toEqual(before);
    }
  );

  it("full generation keeps configured fill and final guard rejects a subsequently broken source link", async () => {
    const { state } = scenario(cases[0]!, true);
    const result = await generateSchedule(state, DATE);
    const source = result.assignments.find(
      (a) => a.positionRuleId === "source"
    )!;
    const target = result.assignments.find(
      (a) => a.positionRuleId === "target"
    )!;
    expect(target.supervisorSourceAssignmentId).toBe(source.id);
    const preparation = prepareSchedule(
      state,
      DATE,
      evaluateAutomaticHardConstraints
    );
    const safety = createScheduleSafetySession({
      phase: "final",
      state,
      date: DATE,
      runFacts: preparation.runFacts,
    });
    expect(() =>
      safety.assertAssignmentsSafe(result.assignments)
    ).not.toThrow();
    const broken = structuredClone(result.assignments);
    broken.find((a) => a.id === source.id)!.staffId = null;
    broken.find((a) => a.id === source.id)!.staffName = "";
    broken.find((a) => a.id === source.id)!.status = "unfilled";
    expect(() => safety.assertAssignmentsSafe(broken)).toThrow();
  });
});
