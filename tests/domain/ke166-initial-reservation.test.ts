import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { optimizeDailySchedule } from "../../src/domain/kernel/daily-schedule-optimizer";
import { createScheduleLedger } from "../../src/domain/kernel/schedule-ledger";
import { createKe166SnapshotScheduleGuard } from "../../src/domain/kernel/schedule-guard";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { generateSchedule } from "../helpers/generate-schedule";

function scenario(withCounter = true, extraSupervisor = false) {
  const state = createDefaultState();
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  const [blocked, needed, replacement, spare] = state.staff;
  state.staff = [
    blocked!,
    needed!,
    replacement!,
    ...(extraSupervisor ? [spare!] : []),
  ].map((person) => ({
    ...person,
    status: "正常" as const,
    teamLeader: false,
    nightShift: true,
    dutyQualified: false,
  }));
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.positionRotationEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.dutyRosterOverrides = [
    {
      date: "2026-09-18",
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.flights = [
    {
      id: "fixed",
      flightNo: "FIX100",
      startTime: "20:00",
      endTime: "22:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "cx",
      flightNo: "CX937",
      startTime: "20:00",
      endTime: "22:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "ke",
      flightNo: "KE166",
      startTime: "20:00",
      endTime: "22:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "fixed",
      flightNo: "FIX100",
      name: "G01",
      category: "常规",
      qualifiedStaffIds: [blocked!.id],
      fatiguePoints: 2,
    },
    {
      ...base,
      id: "cx",
      flightNo: "CX937",
      name: "G01",
      category: "常规",
      qualifiedStaffIds: withCounter
        ? [needed!.id, replacement!.id]
        : [needed!.id],
      fatiguePoints: 2,
    },
    {
      ...base,
      id: "ke-supervisor",
      flightNo: "KE166",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: [
        blocked!.id,
        needed!.id,
        ...(extraSupervisor ? [spare!.id] : []),
      ],
      fatiguePoints: 5,
    },
    {
      ...base,
      id: "ke-counter",
      flightNo: "KE166",
      name: "H04",
      remark: withCounter ? "" : "排查",
      category: "常规",
      qualifiedStaffIds: withCounter
        ? [needed!.id, replacement!.id]
        : [replacement!.id],
      fatiguePoints: 2,
    },
  ];
  if (withCounter)
    state.history = [
      {
        id: "prior-ke",
        date: "2026-09-16",
        flightNo: "KE166",
        position: "H04",
        staffId: needed!.id,
        staffName: needed!.name,
        startTime: "20:00",
        endTime: "22:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
      },
      {
        id: "prior-cx",
        date: "2026-09-16",
        flightNo: "CX937",
        position: "G01",
        staffId: replacement!.id,
        staffName: replacement!.name,
        startTime: "20:00",
        endTime: "22:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
      },
    ];
  return {
    state,
    needed: needed!.id,
    replacement: replacement!.id,
    spare: spare!.id,
  };
}

function morningPriorityScenario(
  helperType: "常规" | "行政支援" | null = "常规"
) {
  const state = createDefaultState();
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  const supervisor = state.staff[0]!;
  const helper = state.staff[1]!;
  state.staff = [
    {
      ...supervisor,
      status: "正常" as const,
      staffType: "常规" as const,
      teamLeader: false,
      nightShift: true,
      dutyQualified: false,
    },
    ...(helperType
      ? [
          {
            ...helper,
            status: "正常" as const,
            staffType: helperType,
            teamLeader: false,
            nightShift: true,
            dutyQualified: false,
          },
        ]
      : []),
  ];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.positionRotationEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.sameFlightStaffExclusions = [];
  state.settings.crossFlightPriorityPolicies = [
    {
      id: "ke166-first",
      enabled: true,
      flightNo: "KE166",
      staffIds: [helper.id],
    },
    {
      id: "cx937-second",
      enabled: true,
      flightNo: "CX937",
      staffIds: [helper.id],
    },
  ];
  state.dutyRosterOverrides = [
    {
      date: "2026-09-24",
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.flights = [
    {
      id: "ke",
      flightNo: "KE166",
      startTime: "09:15",
      endTime: "11:15",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
    {
      id: "cx",
      flightNo: "CX937",
      startTime: "09:25",
      endTime: "11:25",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    },
  ];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "ke-supervisor",
      flightNo: "KE166",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: [supervisor.id],
      fatiguePoints: 5,
    },
    {
      ...base,
      id: "ke-counter",
      flightNo: "KE166",
      name: "H03",
      remark: "",
      category: "常规",
      qualifiedStaffIds: [supervisor.id, ...(helperType ? [helper.id] : [])],
      fatiguePoints: 2,
    },
    {
      ...base,
      id: "cx-counter",
      flightNo: "CX937",
      name: "G20",
      remark: "",
      category: "常规",
      qualifiedStaffIds: helperType ? [helper.id] : [],
      fatiguePoints: 2,
    },
  ];
  return { state, supervisor, helper };
}

describe(
  "KE166 supervisor capacity in the initial schedule",
  { timeout: 30_000 },
  () => {
    it("keeps a separate regular worker on KE166 even when CX937 must stay vacant", async () => {
      const {
        state,
        supervisor,
        helper: flexibleWorker,
      } = morningPriorityScenario();

      const result = await generateSchedule(state, "2026-09-24");

      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: supervisor.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )
      ).toMatchObject({ staffId: flexibleWorker.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )?.supervisorSourceAssignmentId
      ).toBeUndefined();
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "cx-counter"
        )
      ).toMatchObject({ staffId: null, status: "unfilled" });
    });

    it("keeps a KE166 priority person on KE166 when only the KE166 policy is configured", async () => {
      const { state, supervisor, helper } = morningPriorityScenario();
      const alternate = {
        ...helper,
        id: "alternate",
        name: "备用人员",
      };
      state.staff.push(alternate);
      state.positionRules.find(
        (rule) => rule.id === "cx-counter"
      )!.qualifiedStaffIds = [helper.id, alternate.id];
      state.settings.crossFlightPriorityPolicies = [
        {
          id: "ke166-first",
          enabled: true,
          flightNo: "KE166",
          staffIds: [helper.id],
        },
      ];

      const result = await generateSchedule(state, "2026-09-24");
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )
      ).toMatchObject({ staffId: helper.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "cx-counter"
        )
      ).toMatchObject({ staffId: alternate.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: supervisor.id, status: "assigned" });
    });

    it("does not count administrative support as the second KE166 worker", async () => {
      const {
        state,
        supervisor,
        helper: administrativeSupport,
      } = morningPriorityScenario("行政支援");

      const result = await generateSchedule(state, "2026-09-24");

      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: supervisor.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )
      ).toMatchObject({ staffId: supervisor.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )?.supervisorSourceAssignmentId
      ).toBeTruthy();
      expect(
        result.assignments.some(
          (assignment) => assignment.staffId === administrativeSupport.id
        )
      ).toBe(false);
    });

    it("rejects a post-stage move that sends the reserved KE166 worker to CX937", async () => {
      const {
        state,
        supervisor,
        helper: flexibleWorker,
      } = morningPriorityScenario();
      const result = await generateSchedule(state, "2026-09-24");
      const supervisorAssignment = result.assignments.find(
        (assignment) => assignment.positionRuleId === "ke-supervisor"
      )!;
      const illegal = result.assignments.map((assignment) => {
        if (assignment.positionRuleId === "ke-counter")
          return {
            ...assignment,
            staffId: supervisor.id,
            staffName: supervisor.name,
            supervisorSourceAssignmentId: supervisorAssignment.id,
          };
        if (assignment.positionRuleId === "cx-counter")
          return {
            ...assignment,
            staffId: flexibleWorker.id,
            staffName: flexibleWorker.name,
            status: "assigned" as const,
          };
        return assignment;
      });
      const ledger = createScheduleLedger(result.assignments, {
        safetySession: createScheduleSafetySession({
          phase: "final",
          state,
          date: "2026-09-24",
          runFacts: createScheduleRunFacts(state, "2026-09-24"),
          guards: [createKe166SnapshotScheduleGuard()],
        }),
      });

      expect(() =>
        ledger.commit({ type: "replace", assignments: illegal })
      ).toThrow(/KE166.*真人/);
      expect(ledger.snapshot()).toEqual(result.assignments);
    });

    it("leaves the lower-priority CX937 position vacant without emptying an unrelated unique position", async () => {
      const { state, needed, replacement } = scenario();
      const fixedWorker = state.staff[0]!;
      state.settings.crossFlightPriorityPolicies = [
        {
          id: "ke166-first",
          enabled: true,
          flightNo: "KE166",
          staffIds: [replacement],
        },
        {
          id: "cx937-second",
          enabled: true,
          flightNo: "CX937",
          staffIds: [replacement],
        },
      ];

      const result = await generateSchedule(state, "2026-09-18");

      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "fixed"
        )
      ).toMatchObject({ staffId: fixedWorker.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: needed, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )
      ).toMatchObject({ staffId: replacement, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "cx"
        )
      ).toMatchObject({ staffId: null, status: "unfilled" });
    });

    it("keeps the legal dual-role fallback when no second regular worker exists", async () => {
      const { state, supervisor } = morningPriorityScenario(null);

      const result = await generateSchedule(state, "2026-09-24");

      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: supervisor.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )
      ).toMatchObject({ staffId: supervisor.id, status: "assigned" });
      expect(
        result.assignments.find(
          (assignment) => assignment.positionRuleId === "ke-counter"
        )?.supervisorSourceAssignmentId
      ).toBeTruthy();
    });

    it("reserves a compatible KE counter while keeping CX937 staffed", async () => {
      const { state, needed, replacement } = scenario();
      state.settings.latePriorityFlightNumbers = ["TR121"];
      state.history.push({
        id: "prior-late",
        date: "2026-09-16",
        flightNo: "TR121",
        position: "H02",
        staffId: needed,
        staffName: state.staff.find((person) => person.id === needed)!.name,
        startTime: "22:00",
        endTime: "23:30",
        workHours: 1.5,
        fatiguePoints: 10,
        remark: "一号",
      });
      state.staff.find((person) => person.id === needed)!.dutyQualified = true;
      state.dutyRosterOverrides[0]!.dutyStaffId = needed;
      state.settings.dutyPositionPriorities = [
        { id: "cx", enabled: true, flightNo: "CX937", positionKeyword: "G01" },
      ];
      const preparation = prepareSchedule(
        state,
        "2026-09-18",
        evaluateAutomaticHardConstraints
      );
      const initial = await optimizeDailySchedule({
        solver: defaultHighsSolver,
        state,
        date: "2026-09-18",
        preparation,
      });
      expect(
        initial.assignments.find((item) => item.positionRuleId === "ke-counter")
          ?.staffId
      ).toBe(needed);
      expect(
        initial.assignments.find((item) => item.positionRuleId === "cx")
          ?.staffId
      ).toBe(replacement);

      const result = await generateSchedule(state, "2026-09-18");
      expect(
        result.assignments.find(
          (item) => item.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: needed, status: "assigned" });
      expect(
        result.assignments.find((item) => item.positionRuleId === "cx")
      ).toMatchObject({ staffId: replacement, status: "assigned" });
      expect(
        result.assignments.find((item) => item.positionRuleId === "ke-counter")
          ?.supervisorSourceAssignmentId
      ).toBeTruthy();
    });

    it("keeps an independent supervisor when a spare qualified worker is available", async () => {
      const { state, spare } = scenario(true, true);
      const result = await generateSchedule(state, "2026-09-18");
      expect(
        result.assignments.find(
          (item) => item.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: spare, status: "assigned" });
      expect(
        result.assignments.find((item) => item.positionRuleId === "ke-counter")
          ?.supervisorSourceAssignmentId
      ).toBeUndefined();
      expect(
        result.assignments.find((item) => item.positionRuleId === "cx")?.status
      ).toBe("assigned");
    });

    it("does not treat a fully booked supervisor as independently available", async () => {
      const { state, needed, replacement } = scenario();
      const alreadyBusy = state.staff[0]!;
      const base = state.positionRules[0]!;
      state.settings.maxDailyHours = 8;
      state.staff.find((person) => person.id === needed)!.dutyQualified = true;
      state.dutyRosterOverrides[0]!.dutyStaffId = needed;
      state.settings.dutyPositionPriorities = [
        { id: "cx", enabled: true, flightNo: "CX937", positionKeyword: "G01" },
      ];
      state.flights[0] = {
        ...state.flights[0]!,
        startTime: "08:00",
        endTime: "12:00",
      };
      state.flights.push({
        id: "second",
        flightNo: "FIX200",
        startTime: "13:30",
        endTime: "17:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      });
      state.positionRules.push({
        ...base,
        id: "second",
        flightNo: "FIX200",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [alreadyBusy.id],
        fatiguePoints: 2,
      });
      state.positionRules.find(
        (rule) => rule.id === "ke-supervisor"
      )!.qualifiedStaffIds = [alreadyBusy.id, needed];

      const result = await generateSchedule(state, "2026-09-18");
      expect(
        result.assignments.find(
          (item) => item.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: needed, status: "assigned" });
      expect(
        result.assignments.find((item) => item.positionRuleId === "cx")
      ).toMatchObject({ staffId: replacement, status: "assigned" });
    });

    it("leaves the supervisor vacant without a compatible counter rather than taking CX937 staff", async () => {
      const { state } = scenario(false);
      const result = await generateSchedule(state, "2026-09-18");
      expect(
        result.assignments.find(
          (item) => item.positionRuleId === "ke-supervisor"
        )
      ).toMatchObject({ staffId: null, status: "unfilled" });
      expect(
        result.assignments.find((item) => item.positionRuleId === "cx")?.status
      ).toBe("assigned");
      expect(result.warnings).toContain(
        "KE166机动督导未安排，岗位已留空，请人工复核"
      );
    });
  }
);
