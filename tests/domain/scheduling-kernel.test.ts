import { describe, expect, it } from "vitest";

import { createOrdinarySchedulingState } from "../helpers/scheduling-scenario";
import {
  sortFlightCountersDescending,
  visiblePositionRemark,
} from "../../src/utils";
import { intervalsOverlap } from "../../src/domain/shared/time";
import { canAssignStaff } from "../../src/domain/candidates/assignment-eligibility";
import { generateSchedule } from "../helpers/generate-schedule";
import { activeFlightPositions } from "../../src/domain/flights/schedule-position-rules";
import { getDutyRosterForDate } from "../../src/domain/duty-roster/roster";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";

describe("scheduler domain", { timeout: 15_000 }, () => {
  it("uses delivery rather than declaration corrections for a combined role", async () => {
    const state = createOrdinarySchedulingState();
    const qualified = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = qualified;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "late-combined",
        flightNo: "LATE100",
        startTime: "21:00",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "late-combined-rule",
        flightNo: "LATE100",
        name: "H04",
        remark: "申报/送资料",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
        fatiguePoints: 1,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["LATE100"];
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.workloadBalanceEnabled = false;
    state.dutyRosterOverrides = [
      {
        date: "2026-08-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: qualified[0]!.id,
        flightNo: "LATE100",
        kind: "declaration",
        delta: 100,
      },
      {
        month: "2026-08",
        staffId: qualified[1]!.id,
        flightNo: "LATE100",
        kind: "delivery",
        delta: 1,
      },
    ];

    const result = await generateSchedule(state, "2026-08-18");

    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find(
        (assignment) => assignment.positionRuleId === "late-combined-rule"
      )?.staffId
    ).toBe(qualified[0]!.id);
  });

  it("uses a manual late-priority correction to select the lower-count qualified worker", async () => {
    const state = createOrdinarySchedulingState();
    const qualified = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = qualified;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "late-declaration",
        flightNo: "LATE100",
        startTime: "21:00",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "late-declaration-rule",
        flightNo: "LATE100",
        name: "H04",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
        fatiguePoints: 1,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["LATE100"];
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.workloadBalanceEnabled = false;
    state.dutyRosterOverrides = [
      {
        date: "2026-08-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];

    const baseline = await generateSchedule(state, "2026-08-18");
    const baselineStaffId = baseline.assignments.find(
      (assignment) => assignment.positionRuleId === "late-declaration-rule"
    )?.staffId;
    expect(baselineStaffId).toBeTruthy();
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: baselineStaffId!,
        flightNo: "LATE100",
        kind: "declaration",
        delta: 1,
      },
    ];

    const adjusted = await generateSchedule(state, "2026-08-18");
    const adjustedStaffId = adjusted.assignments.find(
      (assignment) => assignment.positionRuleId === "late-declaration-rule"
    )?.staffId;

    expect(adjusted.unfilledCount).toBe(0);
    expect(adjustedStaffId).toBe(
      qualified.find((person) => person.id !== baselineStaffId)?.id
    );
  });

  it("shares compatible late-priority work instead of concentrating it on one person", async () => {
    const state = createOrdinarySchedulingState();
    const qualified = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = qualified;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late-declaration",
        flightNo: "LATE100",
        startTime: "20:00",
        endTime: "23:05",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late-delivery",
        flightNo: "LATE200",
        startTime: "23:05",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      ...["E01", "E02"].map((name) => ({
        ...base,
        id: `early-${name}`,
        flightNo: "EARLY100",
        name,
        remark: "",
        category: "常规" as const,
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
        fatiguePoints: 0,
      })),
      {
        ...base,
        id: "late-declaration-rule",
        flightNo: "LATE100",
        name: "H04",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "late-delivery-rule",
        flightNo: "LATE200",
        name: "H05",
        remark: "送资料",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
        fatiguePoints: 1,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["LATE100", "LATE200"];
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.workloadBalanceEnabled = false;
    state.dutyRosterOverrides = [
      {
        date: "2026-08-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];

    const result = await generateSchedule(state, "2026-08-18");
    expect(result.safetyCredential?.phase).toBe("final");
    expect(result.safetyCredential?.date).toBe("2026-08-18");
    const lateStaffIds = result.assignments
      .filter((assignment) => assignment.flightNo.startsWith("LATE"))
      .map((assignment) => assignment.staffId);

    expect(result.unfilledCount).toBe(0);
    expect(new Set(lateStaffIds).size).toBe(2);
  });

  it("keeps compatible late-priority positions filled when only one person qualifies", async () => {
    const state = createOrdinarySchedulingState();
    const only = state.staff.find((person) => person.status === "正常")!;
    only.dutyQualified = false;
    only.nightShift = true;
    state.staff = [only];
    state.flights = [
      {
        id: "late-declaration",
        flightNo: "LATE100",
        startTime: "21:00",
        endTime: "23:05",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late-delivery",
        flightNo: "LATE200",
        startTime: "23:05",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "late-declaration-rule",
        flightNo: "LATE100",
        name: "H04",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: [only.id],
        minPassengers: 0,
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "late-delivery-rule",
        flightNo: "LATE200",
        name: "H05",
        remark: "送资料",
        category: "常规",
        qualifiedStaffIds: [only.id],
        minPassengers: 0,
        fatiguePoints: 1,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["LATE100", "LATE200"];
    state.settings.minimumRegularTransitionMinutes = 0;
    state.dutyRosterOverrides = [
      {
        date: "2026-08-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];

    const result = await generateSchedule(state, "2026-08-18");

    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments
        .filter((assignment) => assignment.flightNo.startsWith("LATE"))
        .map((assignment) => assignment.staffId)
    ).toEqual([only.id, only.id]);
  });

  it("keeps same-flight supervisor counts within one even when the lower-frequency supervisor has recovery protection", async () => {
    const state = createOrdinarySchedulingState();
    const [underused, frequent] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [underused!, frequent!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "tr121-supervisor",
        flightNo: "TR121",
        name: "督导",
        remark: "",
        category: "常规",
        qualifiedStaffIds: [underused!.id, frequent!.id],
        minPassengers: 0,
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-09-21",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `frequent-supervisor-${index}`,
        date: `2026-09-${String(1 + index * 2).padStart(2, "0")}`,
        flightNo: "TR121",
        position: "督导",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      })),
      {
        id: "underused-previous-late",
        date: "2026-09-19",
        flightNo: "OTHER",
        position: "H04",
        staffId: underused!.id,
        staffName: underused!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "申报",
      },
    ];

    const result = await generateSchedule(state, "2026-09-21");

    expect(result.assignments[0]?.staffId).toBe(underused!.id);
  });

  it("leaves TR121 number-one unfilled after every qualified worker reaches two automatic monthly turns", async () => {
    const state = createOrdinarySchedulingState();
    const qualified = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = qualified;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "tr121-number-one",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
      },
      {
        ...state.positionRules[0]!,
        id: "tr121-ordinary",
        flightNo: "TR121",
        name: "H03",
        remark: "",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-09-21",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = qualified.flatMap((person, personIndex) =>
      ["2026-09-01", "2026-09-03"].map((date, dateIndex) => ({
        id: `number-one-${personIndex}-${dateIndex}`,
        date,
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      }))
    );

    const result = await generateSchedule(state, "2026-09-21");
    const numberOne = result.assignments.find(
      (assignment) => assignment.positionRuleId === "tr121-number-one"
    );

    expect(numberOne?.status).toBe("unfilled");
    expect(numberOne?.staffId).toBeNull();
    expect(
      result.assignments.find(
        (assignment) => assignment.positionRuleId === "tr121-ordinary"
      )
    ).toMatchObject({ status: "assigned", staffId: expect.any(String) });
  });

  it("prioritizes a zero-frequency worker within the same flight and late-position category", async () => {
    const state = createOrdinarySchedulingState();
    const [underused, frequent] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [underused!, frequent!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "late-flight",
        flightNo: "LATE100",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        id: "late-declaration",
        flightNo: "LATE100",
        name: "G20",
        category: "常规",
        remark: "申报",
        qualifiedStaffIds: [underused!.id, frequent!.id],
        manual: false,
        fatiguePoints: 5,
        minPassengers: 0,
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-11",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.settings.latePriorityFlightNumbers = ["LATE100"];
    state.history = [
      {
        id: "frequent-tr-declaration",
        date: "2026-08-01",
        flightNo: "LATE100",
        position: "G20",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 1,
        remark: "申报",
      },
      {
        id: "frequent-tw-delivery",
        date: "2026-08-03",
        flightNo: "LATE100",
        position: "G20",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "22:10",
        endTime: "00:10",
        workHours: 2,
        fatiguePoints: 1,
        remark: "申报",
      },
      {
        id: "underused-heavy-previous-workday",
        date: "2026-08-09",
        flightNo: "DAY100",
        position: "G10",
        staffId: underused!.id,
        staffName: underused!.name,
        startTime: "16:00",
        endTime: "18:00",
        workHours: 2,
        fatiguePoints: 10,
        remark: "",
      },
      {
        id: "frequent-light-previous-workday",
        date: "2026-08-09",
        flightNo: "DAY100",
        position: "G11",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
    ];

    const assignment = (await generateSchedule(state, "2026-08-11"))
      .assignments[0]!;

    expect(assignment.staffId).toBe(underused!.id);
    expect(assignment.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "late-priority-frequency",
          outcome: "selected",
        }),
      ])
    );
  });

  it("allows the next workday duty worker to take a priority position", async () => {
    const state = createOrdinarySchedulingState();
    const protectedWorker = state.staff.find(
      (person) => person.status === "正常"
    )!;
    state.staff = [protectedWorker];
    protectedWorker.dutyQualified = true;
    state.flights = [
      {
        id: "flight",
        flightNo: "F100",
        startTime: "18:00",
        endTime: "20:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "priority",
        flightNo: "F100",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [protectedWorker.id],
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-14",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
      {
        date: "2026-08-16",
        cxPreflightStaffId: null,
        dutyStaffId: protectedWorker.id,
        standbyStaffIds: [null, null],
      },
    ];

    const result = await generateSchedule(state, "2026-08-14");
    const assignment = result.assignments.find(
      (item) => item.positionRuleId === "priority"
    )!;

    expect(assignment.staffId).toBe(protectedWorker.id);
    expect(result.unfilledCount).toBe(0);
  });

  it("assigns only available and qualified staff without time conflicts", async () => {
    const state = createOrdinarySchedulingState();
    const result = await generateSchedule(state, "2026-07-18");
    const assigned = result.assignments.filter((item) => item.staffId);

    for (const assignment of assigned) {
      const person = state.staff.find(
        (item) => item.id === assignment.staffId
      )!;
      const rule = state.positionRules.find(
        (item) => item.id === assignment.positionRuleId
      )!;
      expect(person.status).toBe("正常");
      if (rule.category !== "引导")
        expect(rule.qualifiedStaffIds).toContain(person.id);
      const conflicts = assigned
        .filter(
          (other) =>
            other.id !== assignment.id &&
            other.staffId === assignment.staffId &&
            intervalsOverlap(
              other.startTime,
              other.endTime,
              assignment.startTime,
              assignment.endTime
            )
        )
        .filter(
          (other) =>
            other.flightId !== assignment.flightId ||
            (state.positionRules.find(
              (item) => item.id === other.positionRuleId
            )?.category !== "引导" &&
              rule.category !== "引导")
        );
      expect(conflicts).toHaveLength(0);
    }
  }, 30_000);

  it("marks a position unfilled when every qualified person is unavailable", async () => {
    const state = createOrdinarySchedulingState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "收费/引导"
    )!;
    state.staff
      .filter((item) => rule.qualifiedStaffIds.includes(item.id))
      .forEach((item) => {
        item.status = "休假";
      });
    const result = await generateSchedule(state, "2026-07-18");
    const assignment = result.assignments.find(
      (item) => item.positionRuleId === rule.id
    )!;
    expect(assignment.staffId).toBeNull();
    expect(result.unfilledCount).toBeGreaterThan(0);
  }, 30_000);

  it("prefers the candidate with lower historical fatigue", async () => {
    const state = createOrdinarySchedulingState();
    state.flights = [state.flights[0]!];
    state.flights[0]!.positions = ["G12"];
    state.history = [
      {
        id: "h1",
        date: "2026-07-17",
        flightNo: "F",
        position: "P",
        staffId: "2",
        staffName: "华嘉慧",
        startTime: "08:00",
        endTime: "12:00",
        workHours: 4,
        fatiguePoints: 30,
        remark: "",
      },
    ];
    const result = await generateSchedule(state, "2026-07-18");
    expect(result.assignments[0]!.staffId).not.toBe("2");
  });

  it("does not automatically use concurrent team-leader supervision to remove a vacancy", async () => {
    const state = createOrdinarySchedulingState();
    const [leader, releasedWorker, dutyWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [leader!, releasedWorker!, dutyWorker!];
    leader!.teamLeader = true;
    releasedWorker!.teamLeader = false;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    dutyWorker!.dutyQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-07-29",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.settings.teamLeaderConcurrentSupervisionMaxOverlapMinutes = 15;
    state.flights = [
      {
        id: "mf",
        flightNo: "MF8683",
        startTime: "13:40",
        endTime: "15:40",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "fd",
        flightNo: "FD573",
        startTime: "15:25",
        endTime: "17:25",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "mf-supervisor",
        flightNo: "MF8683",
        name: "督导",
        category: "常规",
        fatiguePoints: 5,
        qualifiedStaffIds: [leader!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "fd-supervisor",
        flightNo: "FD573",
        name: "督导",
        category: "常规",
        fatiguePoints: 5,
        qualifiedStaffIds: [leader!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "fd-g10",
        flightNo: "FD573",
        name: "G10",
        category: "常规",
        fatiguePoints: 2,
        qualifiedStaffIds: [releasedWorker!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-29");
    const mfSupervisor = result.assignments.find(
      (item) => item.positionRuleId === "mf-supervisor"
    )!;
    const fdSupervisor = result.assignments.find(
      (item) => item.positionRuleId === "fd-supervisor"
    )!;
    const g10 = result.assignments.find(
      (item) => item.positionRuleId === "fd-g10"
    )!;

    expect(result.unfilledCount).toBeGreaterThan(0);
    expect([mfSupervisor, fdSupervisor, g10]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ staffId: leader!.id })])
    );
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("分队长并行督导补缺")])
    );
  });

  it("keeps the team leader out when the legacy overlap limit is configured", async () => {
    const state = createOrdinarySchedulingState();
    const [leader, releasedWorker, dutyWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [leader!, releasedWorker!, dutyWorker!];
    leader!.teamLeader = true;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    dutyWorker!.dutyQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-07-29",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.settings.teamLeaderConcurrentSupervisionMaxOverlapMinutes = 14;
    state.flights = [
      {
        id: "mf",
        flightNo: "MF8683",
        startTime: "13:40",
        endTime: "15:40",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "fd",
        flightNo: "FD573",
        startTime: "15:25",
        endTime: "17:25",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "mf-supervisor",
        flightNo: "MF8683",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [leader!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "fd-supervisor",
        flightNo: "FD573",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [leader!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "fd-g10",
        flightNo: "FD573",
        name: "G10",
        category: "常规",
        qualifiedStaffIds: [releasedWorker!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-29");

    expect(
      result.assignments.find((item) => item.positionRuleId === "fd-g10")
        ?.status
    ).toBe("unfilled");
    expect(
      result.assignments.filter(
        (item) => item.position.includes("督导") && item.staffId === leader!.id
      )
    ).toHaveLength(0);
  });

  it("does not use concurrent supervision when all regular positions are already filled", async () => {
    const state = createOrdinarySchedulingState();
    const [leader, otherSupervisor] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [leader!, otherSupervisor!];
    leader!.teamLeader = true;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.teamLeaderConcurrentSupervisionMaxOverlapMinutes = 30;
    state.flights = [
      {
        id: "first",
        flightNo: "F100",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second",
        flightNo: "F200",
        startTime: "14:45",
        endTime: "16:45",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "first-supervisor",
        flightNo: "F100",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [leader!.id, otherSupervisor!.id],
      },
      {
        ...base,
        id: "second-supervisor",
        flightNo: "F200",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [leader!.id, otherSupervisor!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-29");

    expect(result.unfilledCount).toBe(1);
    expect(
      result.assignments.filter((item) => item.staffId === leader!.id)
    ).toHaveLength(0);
    expect(
      result.warnings.some((warning) => warning.includes("分队长并行督导补缺"))
    ).toBe(false);
  });

  it("does not grant concurrent-supervision permission to an ordinary worker", async () => {
    const state = createOrdinarySchedulingState();
    const [ordinary, releasedWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [ordinary!, releasedWorker!];
    state.staff.forEach((person) => {
      person.teamLeader = false;
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "first",
        flightNo: "F100",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second",
        flightNo: "F200",
        startTime: "14:45",
        endTime: "16:45",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "first-supervisor",
        flightNo: "F100",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [ordinary!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "second-supervisor",
        flightNo: "F200",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [ordinary!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "second-counter",
        flightNo: "F200",
        name: "G10",
        category: "常规",
        qualifiedStaffIds: [releasedWorker!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-29");

    expect(result.unfilledCount).toBe(1);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "second-counter"
      )?.status
    ).toBe("unfilled");
  });

  it("does not re-enable a team leader through a KE166 overlap", async () => {
    const state = createOrdinarySchedulingState();
    const [leader, releasedWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [leader!, releasedWorker!];
    leader!.teamLeader = true;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second",
        flightNo: "F200",
        startTime: "14:45",
        endTime: "16:45",
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
        category: "常规",
        qualifiedStaffIds: [leader!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "second-supervisor",
        flightNo: "F200",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [leader!.id, releasedWorker!.id],
      },
      {
        ...base,
        id: "second-counter",
        flightNo: "F200",
        name: "G10",
        category: "常规",
        qualifiedStaffIds: [releasedWorker!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-29");

    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "second-counter"
      )?.status
    ).toBe("unfilled");
    expect(
      result.assignments.filter(
        (item) => item.staffId === leader!.id && item.position.includes("督导")
      )
    ).toHaveLength(0);
  });

  it("does not restore concurrent supervision through diversion timing", async () => {
    const state = createOrdinarySchedulingState();
    const [firstSupervisor, leader, secondSupervisor, dutyWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 4);
    state.staff = [firstSupervisor!, leader!, secondSupervisor!, dutyWorker!];
    firstSupervisor!.teamLeader = false;
    leader!.teamLeader = true;
    secondSupervisor!.teamLeader = false;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    dutyWorker!.dutyQualified = true;
    state.dutyRosterOverrides = [
      {
        date: "2026-07-29",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "mf",
        flightNo: "MF8683",
        startTime: "13:40",
        endTime: "15:40",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ae",
        flightNo: "AE218",
        startTime: "14:25",
        endTime: "16:25",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "fd",
        flightNo: "FD573",
        startTime: "15:25",
        endTime: "17:25",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "mf-supervisor",
        flightNo: "MF8683",
        name: "督导",
        category: "分流",
        fatiguePoints: 5,
        earlyReleaseMinutes: 15,
        qualifiedStaffIds: [firstSupervisor!.id, leader!.id],
      },
      {
        ...base,
        id: "ae-supervisor",
        flightNo: "AE218",
        name: "督导",
        category: "常规",
        fatiguePoints: 5,
        qualifiedStaffIds: [firstSupervisor!.id, leader!.id],
      },
      {
        ...base,
        id: "fd-supervisor",
        flightNo: "FD573",
        name: "督导",
        category: "常规",
        fatiguePoints: 5,
        qualifiedStaffIds: [leader!.id, secondSupervisor!.id],
      },
      {
        ...base,
        id: "fd-g10",
        flightNo: "FD573",
        name: "G10",
        category: "常规",
        fatiguePoints: 2,
        qualifiedStaffIds: [secondSupervisor!.id],
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AE", position: "督导" },
      { airlineCode: "FD", position: "督导" },
    ];

    const result = await generateSchedule(state, "2026-07-29");
    const mfSupervisor = result.assignments.find(
      (item) => item.positionRuleId === "mf-supervisor"
    )!;
    const aeSupervisor = result.assignments.find(
      (item) => item.positionRuleId === "ae-supervisor"
    )!;
    const fdSupervisor = result.assignments.find(
      (item) => item.positionRuleId === "fd-supervisor"
    )!;
    const g10 = result.assignments.find(
      (item) => item.positionRuleId === "fd-g10"
    )!;

    expect(result.unfilledCount).toBeGreaterThan(0);
    expect(
      [mfSupervisor, aeSupervisor, fdSupervisor, g10].some(
        (assignment) => assignment.staffId === leader!.id
      )
    ).toBe(false);
    expect(result.warnings.join("\n")).not.toContain("分队长并行督导补缺");
  });

  it("prefers the qualified worker with fewer same-position assignments in the last six archived workdays", async () => {
    const state = createOrdinarySchedulingState();
    const [frequent, lessFrequent] = state.staff;
    state.staff = [frequent!, lessFrequent!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        fatiguePoints: 1,
        remark: "一号",
        qualifiedStaffIds: [frequent!.id, lessFrequent!.id],
      },
    ];
    state.settings.historyWindowDays = 1;
    state.history = ["2026-10-02", "2026-10-04", "2026-10-06", "2026-10-08"]
      .map((date, index) => ({
        id: `frequent-${index}`,
        date,
        flightNo: "CX937",
        position: "G20",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "一号",
      }))
      .concat(
        ["2026-09-20", "2026-09-22", "2026-09-24", "2026-09-26"].map(
          (date, index) => ({
            id: `older-less-frequent-${index}`,
            date,
            flightNo: "CX937",
            position: "G20",
            staffId: lessFrequent!.id,
            staffName: lessFrequent!.name,
            startTime: "08:00",
            endTime: "10:00",
            workHours: 2,
            fatiguePoints: 1,
            remark: "一号",
          })
        ),
        [
          {
            id: "less-frequent",
            date: "2026-10-10",
            flightNo: "CX937",
            position: "G20",
            staffId: lessFrequent!.id,
            staffName: lessFrequent!.name,
            startTime: "08:00",
            endTime: "10:00",
            workHours: 2,
            fatiguePoints: 1,
            remark: "",
          },
          {
            id: "unrelated-frequent",
            date: "2026-10-12",
            flightNo: "CX937",
            position: "G18",
            staffId: frequent!.id,
            staffName: frequent!.name,
            startTime: "08:00",
            endTime: "10:00",
            workHours: 2,
            fatiguePoints: 1,
            remark: "",
          },
          {
            id: "unrelated-less-frequent",
            date: "2026-10-12",
            flightNo: "CX937",
            position: "G17",
            staffId: lessFrequent!.id,
            staffName: lessFrequent!.name,
            startTime: "08:00",
            endTime: "10:00",
            workHours: 2,
            fatiguePoints: 1,
            remark: "",
          },
        ]
      );

    const assignment = (await generateSchedule(state, "2026-10-14"))
      .assignments[0]!;
    expect(assignment.staffId).toBe(lessFrequent!.id);
    expect(assignment.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency",
          outcome: "selected",
        }),
      ])
    );
  });

  it("does not reserve a low-frequency priority-position worker for an ordinary position that another worker can cover", async () => {
    const state = createOrdinarySchedulingState();
    const [frequent, lessFrequent, ordinaryWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [frequent!, lessFrequent!, ordinaryWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx931",
        flightNo: "CX931",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX931",
        name: "G20",
        category: "常规",
        fatiguePoints: 4,
        remark: "一号",
        qualifiedStaffIds: [frequent!.id, lessFrequent!.id],
      },
      {
        ...base,
        id: "cx-g15",
        flightNo: "CX931",
        name: "G15",
        category: "常规",
        fatiguePoints: 1,
        remark: "",
        qualifiedStaffIds: [lessFrequent!.id, ordinaryWorker!.id],
      },
    ];
    state.history = [
      "2026-08-15",
      "2026-08-17",
      "2026-08-19",
      "2026-08-21",
    ].map((date, index) => ({
      id: `frequent-priority-${index}`,
      date,
      flightNo: "CX931",
      position: "G20",
      staffId: frequent!.id,
      staffName: frequent!.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 1,
      fatiguePoints: 4,
      remark: "一号",
    }));

    const assignments = (await generateSchedule(state, "2026-08-23"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")?.staffId
    ).toBe(lessFrequent!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g15")?.staffId
    ).toBe(ordinaryWorker!.id);
  });

  it("does not use monthly frequency to choose an ordinary position worker", async () => {
    const state = createOrdinarySchedulingState();
    const [first, second] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [first!, second!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.teamLeader = false;
    });
    state.flights = [
      {
        id: "ordinary",
        flightNo: "CX931",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g15",
        flightNo: "CX931",
        name: "G15",
        category: "常规",
        fatiguePoints: 1,
        remark: "",
        qualifiedStaffIds: [first!.id, second!.id],
      },
    ];
    state.history = [
      {
        id: "ordinary-1",
        date: "2026-08-15",
        flightNo: "CX931",
        position: "G15",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
      {
        id: "ordinary-2",
        date: "2026-08-17",
        flightNo: "CX931",
        position: "G15",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
      {
        id: "recent-1",
        date: "2026-08-19",
        flightNo: "OTHER",
        position: "P1",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "11:00",
        endTime: "12:00",
        workHours: 1,
        fatiguePoints: 0,
        remark: "",
      },
      {
        id: "recent-2",
        date: "2026-08-21",
        flightNo: "OTHER",
        position: "P2",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "11:00",
        endTime: "12:00",
        workHours: 1,
        fatiguePoints: 0,
        remark: "",
      },
    ];

    expect(
      (await generateSchedule(state, "2026-08-23")).assignments[0]?.staffId
    ).toBe(first!.id);
  });

  it("keeps priority-position frequency ahead of ordinary consecutive protection", async () => {
    const state = createOrdinarySchedulingState();
    const [priorityWorker, repeatedWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [priorityWorker!, repeatedWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx931",
        flightNo: "CX931",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX931",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [priorityWorker!.id, repeatedWorker!.id],
      },
      {
        ...base,
        id: "cx-g15",
        flightNo: "CX931",
        name: "G15",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [priorityWorker!.id, repeatedWorker!.id],
      },
    ];
    state.history = [
      ...["2026-08-19", "2026-08-21"].map((date, index) => ({
        id: `ordinary-repeat-${index}`,
        date,
        flightNo: "CX931",
        position: "G15",
        staffId: repeatedWorker!.id,
        staffName: repeatedWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      })),
      {
        id: "priority-history",
        date: "2026-08-17",
        flightNo: "CX931",
        position: "G20",
        staffId: repeatedWorker!.id,
        staffName: repeatedWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 4,
        remark: "一号",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-08-23"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")?.staffId
    ).toBe(priorityWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g15")?.staffId
    ).toBe(repeatedWorker!.id);
  });

  it("uses the current-month total before the recent-six-workday count for long-term same-position fairness", async () => {
    const state = createOrdinarySchedulingState();
    const [frequent, medium, leastFrequent] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [frequent!, medium!, leastFrequent!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "target-flight",
        flightNo: "TARGET100",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "target-g20",
        flightNo: "TARGET100",
        name: "G20",
        category: "常规",
        fatiguePoints: 1,
        remark: "一号",
        qualifiedStaffIds: state.staff.map((person) => person.id),
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TARGET100", position: "G20" },
    ];
    const dates = [
      "2026-10-02",
      "2026-10-04",
      "2026-10-06",
      "2026-10-08",
      "2026-10-10",
      "2026-10-12",
      "2026-10-14",
      "2026-10-16",
      "2026-10-18",
      "2026-10-20",
      "2026-10-22",
      "2026-10-24",
      "2026-10-26",
    ];
    state.history = dates
      .map((date, index) => {
        const person =
          index < 8 ? frequent! : index < 11 ? medium! : leastFrequent!;
        return {
          id: `monthly-g20-${index}`,
          date,
          flightNo: "TARGET100",
          position: "G20",
          staffId: person.id,
          staffName: person.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        };
      })
      .concat([
        {
          id: "latest-frequent-load",
          date: "2026-10-26",
          flightNo: "OTHER100",
          position: "G17",
          staffId: frequent!.id,
          staffName: frequent!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "latest-medium-load",
          date: "2026-10-26",
          flightNo: "OTHER200",
          position: "G18",
          staffId: medium!.id,
          staffName: medium!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "comparison-frequent-load",
          date: "2026-10-27",
          flightNo: "OTHER300",
          position: "G17",
          staffId: frequent!.id,
          staffName: frequent!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "comparison-medium-load",
          date: "2026-10-27",
          flightNo: "OTHER400",
          position: "G18",
          staffId: medium!.id,
          staffName: medium!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "comparison-least-load",
          date: "2026-10-27",
          flightNo: "OTHER500",
          position: "G19",
          staffId: leastFrequent!.id,
          staffName: leastFrequent!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
      ]);

    const assignment = (await generateSchedule(state, "2026-10-28"))
      .assignments[0]!;
    expect(assignment.staffId).toBe(leastFrequent!.id);
    expect(assignment.staffId).not.toBe(frequent!.id);
  });

  it("keeps a generation-stage frequency result when later rotation has no safe alternative", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    const [frequent, lessFrequent, releaseWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [lessFrequent!, frequent!, releaseWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "base",
        flightNo: "BASE100",
        startTime: "06:00",
        endTime: "07:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "source",
        flightNo: "SOURCE100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "TARGET100",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "base-position",
        flightNo: "BASE100",
        name: "B01",
        category: "常规",
        fatiguePoints: 1,
        qualifiedStaffIds: [frequent!.id],
      },
      {
        ...base,
        id: "release-base-position",
        flightNo: "BASE100",
        name: "B02",
        category: "常规",
        fatiguePoints: 1,
        qualifiedStaffIds: [releaseWorker!.id],
      },
      {
        ...base,
        id: "source-position",
        flightNo: "SOURCE100",
        name: "S01",
        category: "常规",
        fatiguePoints: 1,
        qualifiedStaffIds: [lessFrequent!.id, releaseWorker!.id],
      },
      {
        ...base,
        id: "target-position",
        flightNo: "TARGET100",
        name: "G20",
        category: "常规",
        fatiguePoints: 1,
        remark: "一号",
        qualifiedStaffIds: [frequent!.id, lessFrequent!.id, releaseWorker!.id],
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TARGET100", position: "G20" },
    ];
    state.history = ["2026-10-02", "2026-10-04", "2026-10-06", "2026-10-08"]
      .flatMap((date, index) => [
        {
          id: `frequent-target-${index}`,
          date,
          flightNo: "TARGET100",
          position: "G20",
          staffId: frequent!.id,
          staffName: frequent!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "一号",
        },
        {
          id: `release-target-${index}`,
          date,
          flightNo: "TARGET100",
          position: "G20",
          staffId: releaseWorker!.id,
          staffName: releaseWorker!.name,
          startTime: "08:30",
          endTime: "10:30",
          workHours: 2,
          fatiguePoints: 1,
          remark: "一号",
        },
      ])
      .concat(
        ["2026-10-06", "2026-10-08"].map((date, index) => ({
          id: `release-source-${index}`,
          date,
          flightNo: "SOURCE100",
          position: "S01",
          staffId: releaseWorker!.id,
          staffName: releaseWorker!.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        }))
      );

    const assignments = (await generateSchedule(state, "2026-10-10"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "base-position")
        ?.staffId
    ).toBe(frequent!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "target-position")
        ?.staffId
    ).toBe(lessFrequent!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "source-position")
        ?.staffId
    ).toBe(releaseWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "target-position")
        ?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency",
          outcome: "selected",
        }),
      ])
    );
    expect(
      assignments.find((item) => item.positionRuleId === "source-position")
        ?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-rotation",
          outcome: "fallback",
        }),
      ])
    );
  });

  it("records why a high-frequency position cannot be balanced when no other worker is qualified", async () => {
    const state = createOrdinarySchedulingState();
    const [onlyQualified, unqualified] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [onlyQualified!, unqualified!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "target",
        flightNo: "TARGET100",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "target-position",
        flightNo: "TARGET100",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [onlyQualified!.id],
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "TARGET100", position: "G20" },
    ];
    state.history = ["2026-10-02", "2026-10-04", "2026-10-06"].map(
      (date, index) => ({
        id: `only-qualified-${index}`,
        date,
        flightNo: "TARGET100",
        position: "G20",
        staffId: onlyQualified!.id,
        staffName: onlyQualified!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      })
    );

    state.assignments = (
      await generateSchedule(state, "2026-10-08")
    ).assignments;
    const target = state.assignments[0]!;
    expect(target.staffId).toBe(onlyQualified!.id);
    expect(target.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency-review",
          outcome: "fallback",
        }),
      ])
    );
    const feedback = buildScheduleFeedback(state, "2026-10-08").find(
      (item) => item.key === "position-frequency-review"
    )!;
    expect(feedback).toMatchObject({ status: "需复核" });
    expect(feedback.text).toContain("本月承担4次");
    expect(feedback.text).toContain("当前只有这一名合格人员");
    expect(feedback.text).toContain("请关注岗位人员储备");
  });

  it("prefers a rested worker for a high-load position during the recovery window", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "first-flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second-base-flight",
        flightNo: "F0",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "next-flight",
        flightNo: "F2",
        startTime: "11:00",
        endTime: "13:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = { ...state.positionRules[0]!, category: "常规" as const };
    state.positionRules = [
      {
        ...base,
        id: "first-high",
        flightNo: "F1",
        name: "一号柜台",
        remark: "一号",
        fatiguePoints: 5,
        qualifiedStaffIds: [first!.id],
      },
      {
        ...base,
        id: "second-base",
        flightNo: "F0",
        name: "普通柜台",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds: [second!.id],
      },
      {
        ...base,
        id: "next-high",
        flightNo: "F2",
        name: "控制柜台",
        remark: "",
        fatiguePoints: 5,
        qualifiedStaffIds: [first!.id, second!.id],
      },
    ];
    state.history = [
      {
        id: "history",
        date: "2026-07-17",
        flightNo: "OLD",
        position: "P",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.highLoadProtectionEnabled = true;
    state.settings.highLoadFatigueThreshold = 4;
    state.settings.highLoadRecoveryMinutes = 180;
    state.settings.remarkedPositionHighLoad = true;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.positionRuleId === "next-high"
      )?.staffId
    ).toBe(second!.id);
    state.settings.highLoadProtectionEnabled = false;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.positionRuleId === "next-high"
      )?.staffId
    ).toBe(first!.id);
  });

  it("fills a high-load position when every candidate is still in the protection window", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.flights = [
      {
        id: "first-flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second-flight",
        flightNo: "F2",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "next-flight",
        flightNo: "F3",
        startTime: "11:00",
        endTime: "13:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "first-high",
        flightNo: "F1",
        name: "一号",
        remark: "一号",
        fatiguePoints: 5,
        qualifiedStaffIds: [first!.id],
      },
      {
        ...base,
        id: "second-high",
        flightNo: "F2",
        name: "申报",
        remark: "申报",
        fatiguePoints: 5,
        qualifiedStaffIds: [second!.id],
      },
      {
        ...base,
        id: "next-high",
        flightNo: "F3",
        name: "控制",
        remark: "控制",
        fatiguePoints: 5,
        qualifiedStaffIds: [first!.id, second!.id],
      },
    ];
    state.settings.highLoadProtectionEnabled = true;
    state.settings.highLoadFatigueThreshold = 4;
    state.settings.highLoadRecoveryMinutes = 180;
    state.settings.remarkedPositionHighLoad = true;
    const result = await generateSchedule(state, "2026-07-18");
    const target = result.assignments.find(
      (item) => item.positionRuleId === "next-high"
    )!;
    expect(target).toMatchObject({
      staffId: expect.any(String),
      status: "assigned",
    });
    state.assignments = result.assignments;
    expect(canAssignStaff(state, target.id, first!.id)).toBeNull();
  });

  it("applies an editable position-to-position preparation interval", async () => {
    const state = createOrdinarySchedulingState();
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "source-flight",
        flightNo: "CX931",
        startTime: "17:50",
        endTime: "19:50",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second-base-flight",
        flightNo: "BASE",
        startTime: "17:50",
        endTime: "19:50",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target-flight",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-g19",
        flightNo: "CX931",
        name: "G19",
        category: "常规",
        fatiguePoints: 2,
        remark: "",
        qualifiedStaffIds: [first!.id],
      },
      {
        ...base,
        id: "second-base",
        flightNo: "BASE",
        name: "普通柜台",
        category: "常规",
        fatiguePoints: 1,
        remark: "",
        qualifiedStaffIds: [second!.id],
      },
      {
        ...base,
        id: "target-h02",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        fatiguePoints: 2,
        remark: "",
        qualifiedStaffIds: [first!.id, second!.id],
      },
    ];
    state.history = [
      {
        id: "history",
        date: "2026-07-17",
        flightNo: "OLD",
        position: "P",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.positionTransitionPolicies = [
      {
        id: "cx931-h02",
        name: "H02准备保护",
        enabled: true,
        sourceFlightNo: "CX931",
        sourcePositions: ["G19"],
        targetFlightNo: "TR121",
        targetPosition: "H02",
        minimumGapMinutes: 180,
        mode: "prefer",
      },
    ];
    const protectedSchedule = await generateSchedule(state, "2026-07-18");
    expect(
      protectedSchedule.assignments.find(
        (item) => item.positionRuleId === "target-h02"
      )?.staffId
    ).toBe(second!.id);
    state.assignments = protectedSchedule.assignments;
    state.settings.positionTransitionPolicies[0]!.mode = "forbid";
    const protectedTarget = state.assignments.find(
      (item) => item.positionRuleId === "target-h02"
    )!;
    expect(canAssignStaff(state, protectedTarget.id, first!.id)).toContain(
      "最小衔接间隔"
    );
    state.settings.positionTransitionPolicies[0]!.enabled = false;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.positionRuleId === "target-h02"
      )?.staffId
    ).toBe(first!.id);
  });

  it("protects a worker when projected fatigue exceeds the rolling-window limit", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "first-flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second-base-flight",
        flightNo: "F0",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "next-flight",
        flightNo: "F2",
        startTime: "11:00",
        endTime: "13:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "first-load",
        flightNo: "F1",
        name: "P1",
        category: "常规",
        fatiguePoints: 5,
        remark: "",
        qualifiedStaffIds: [first!.id],
      },
      {
        ...base,
        id: "second-base",
        flightNo: "F0",
        name: "P0",
        category: "常规",
        fatiguePoints: 1,
        remark: "",
        qualifiedStaffIds: [second!.id],
      },
      {
        ...base,
        id: "next-load",
        flightNo: "F2",
        name: "P2",
        category: "常规",
        fatiguePoints: 5,
        remark: "",
        qualifiedStaffIds: [first!.id, second!.id],
      },
    ];
    state.history = [
      {
        id: "history",
        date: "2026-07-17",
        flightNo: "OLD",
        position: "P",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.settings.rollingLoadProtectionEnabled = true;
    state.settings.rollingLoadWindowMinutes = 360;
    state.settings.rollingLoadMaxFatigue = 8;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.positionRuleId === "next-load"
      )?.staffId
    ).toBe(second!.id);
    state.settings.rollingLoadProtectionEnabled = false;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.positionRuleId === "next-load"
      )?.staffId
    ).toBe(first!.id);
  });

  it("uses the same-position frequency rule only while same-position fairness is enabled", async () => {
    const state = createOrdinarySchedulingState();
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.teamLeader = false;
    });
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "g20",
        flightNo: "F1",
        name: "G20",
        category: "常规",
        fatiguePoints: 4,
        remark: "一号",
        qualifiedStaffIds: [first!.id, second!.id],
      },
    ];
    state.history = [
      {
        id: "repeat",
        date: "2026-07-17",
        flightNo: "F1",
        position: "G20",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "一号",
      },
      {
        id: "other-load",
        date: "2026-07-17",
        flightNo: "OLD",
        position: "OTHER",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "11:00",
        endTime: "13:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.positionRotationEnabled = true;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]!.staffId
    ).toBe(second!.id);
    state.settings.positionRotationEnabled = false;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]!.staffId
    ).toBe(first!.id);
  });

  it("fills the position when every qualified candidate recently worked the same position", async () => {
    const state = createOrdinarySchedulingState();
    const workers = state.staff.slice(0, 2);
    state.staff = workers;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "position",
        flightNo: "F1",
        name: "G12",
        qualifiedStaffIds: workers.map((person) => person.id),
      },
    ];
    state.history = workers.map((person, index) => ({
      id: `history-${index}`,
      date: "2026-07-17",
      flightNo: "F1",
      position: "G12",
      staffId: person.id,
      staffName: person.name,
      startTime: "08:00",
      endTime: "10:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
    }));
    state.settings.positionRotationEnabled = true;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]
    ).toMatchObject({
      status: "assigned",
      staffId: expect.any(String),
    });
  });

  it("fills a rolling-load protected position when no unprotected candidate exists", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    const person = state.staff[0]!;
    state.staff = [person];
    person.dutyQualified = false;
    state.flights = [
      {
        id: "first",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "next",
        flightNo: "F2",
        startTime: "11:00",
        endTime: "13:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "first",
        flightNo: "F1",
        name: "G12",
        fatiguePoints: 5,
        remark: "",
        qualifiedStaffIds: [person.id],
      },
      {
        ...base,
        id: "next",
        flightNo: "F2",
        name: "G13",
        fatiguePoints: 5,
        remark: "",
        qualifiedStaffIds: [person.id],
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = true;
    state.settings.rollingLoadMaxFatigue = 8;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments
    ).toMatchObject([
      { status: "assigned", staffId: person.id },
      { status: "assigned", staffId: person.id },
    ]);
  });

  it("reduces the next late-shift load after a high-load final flight on the previous day", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, restedWorker] = state.staff;
    state.staff = [protectedWorker!, restedWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.teamLeader = false;
    });
    state.flights = [
      {
        id: "late-flight",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "late-high",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        fatiguePoints: 4,
        remark: "一号",
        qualifiedStaffIds: [protectedWorker!.id, restedWorker!.id],
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-07-18",
        flightNo: "TR121",
        position: "H02",
        staffId: protectedWorker!.id,
        staffName: protectedWorker!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
      {
        id: "rested-worker-load",
        date: "2026-07-18",
        flightNo: "EARLY",
        position: "P",
        staffId: restedWorker!.id,
        staffName: restedWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.tr121H02CooldownWorkdays = 0;
    state.settings.lateShiftRecoveryEnabled = true;
    state.settings.lateShiftEndTime = "23:00";
    expect(
      (await generateSchedule(state, "2026-07-20")).assignments[0]!.staffId
    ).toBe(restedWorker!.id);
    state.settings.lateShiftRecoveryEnabled = false;
    expect(
      (await generateSchedule(state, "2026-07-20")).assignments[0]!.staffId
    ).toBe(protectedWorker!.id);
  });

  it("keeps a protected late-shift worker for the lighter lower position when staffing is limited", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, restedWorker] = state.staff;
    state.staff = [protectedWorker!, restedWorker!];
    state.flights = [
      {
        id: "late-flight",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "upper-high",
        flightNo: "TR121",
        name: "H02",
        fatiguePoints: 4,
        remark: "一号",
        qualifiedStaffIds: [protectedWorker!.id, restedWorker!.id],
      },
      {
        ...base,
        id: "lower-light",
        flightNo: "TR121",
        name: "H01",
        fatiguePoints: 1,
        remark: "",
        qualifiedStaffIds: [protectedWorker!.id, restedWorker!.id],
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-07-17",
        flightNo: "TR121",
        position: "H02",
        staffId: protectedWorker!.id,
        staffName: protectedWorker!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.find((item) => item.positionRuleId === "upper-high")
        ?.staffId
    ).toBe(restedWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "lower-light")
        ?.staffId
    ).toBe(protectedWorker!.id);
  });

  it("keeps priority-position frequency ahead of next-workday recovery", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [protectedWorker!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx937",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        remark: "一号",
        fatiguePoints: 4,
        qualifiedStaffIds: [protectedWorker!.id, alternate!.id],
      },
    ];
    state.history = [
      {
        id: "late-highest",
        date: "2026-08-21",
        flightNo: "TR121",
        position: "H02",
        staffId: protectedWorker!.id,
        staffName: protectedWorker!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
      {
        id: "late-lower",
        date: "2026-08-21",
        flightNo: "TW616",
        position: "G12",
        staffId: alternate!.id,
        staffName: alternate!.name,
        startTime: "21:30",
        endTime: "23:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
      {
        id: "alternate-frequency-1",
        date: "2026-08-17",
        flightNo: "CX937",
        position: "G20",
        staffId: alternate!.id,
        staffName: alternate!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 0,
        remark: "一号",
      },
      {
        id: "alternate-frequency-2",
        date: "2026-08-19",
        flightNo: "CX937",
        position: "G20",
        staffId: alternate!.id,
        staffName: alternate!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 0,
        remark: "一号",
      },
    ];

    const target = (await generateSchedule(state, "2026-08-23"))
      .assignments[0]!;
    expect(target.staffId).toBe(protectedWorker!.id);
    expect(target.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency",
          outcome: "selected",
        }),
      ])
    );
  });

  it("moves a previous final-late supervisor away from the next final-late supervisor position when a safe replacement exists", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, replacement] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [protectedWorker!, replacement!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "tr121",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "tr-supervisor",
        flightNo: "TR121",
        name: "督导",
        category: "常规",
        remark: "",
        fatiguePoints: 6,
        qualifiedStaffIds: [protectedWorker!.id, replacement!.id],
      },
    ];
    state.history = [
      {
        id: "previous-supervisor",
        date: "2026-08-21",
        flightNo: "TWB616",
        position: "督导/引导",
        staffId: protectedWorker!.id,
        staffName: protectedWorker!.name,
        startTime: "22:00",
        endTime: "23:30",
        workHours: 1.5,
        fatiguePoints: 6,
        remark: "",
      },
      {
        id: "replacement-load",
        date: "2026-08-21",
        flightNo: "OTHER",
        position: "普通岗位",
        staffId: replacement!.id,
        staffName: replacement!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;

    const assignment = (await generateSchedule(state, "2026-08-23"))
      .assignments[0]!;

    expect(assignment.staffId).toBe(replacement!.id);
    expect(assignment.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "late-shift-recovery",
          outcome: "selected",
        }),
      ])
    );
  });

  it("keeps a previous final-late priority worker off flights starting at or after the configured next-workday cutoff", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [protectedWorker!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "afternoon",
        flightNo: "DAY200",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "evening",
        flightNo: "NIGHT300",
        startTime: "20:00",
        endTime: "22:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = [protectedWorker!.id, alternate!.id];
    state.positionRules = state.flights.map((flight, index) => ({
      ...base,
      id: `ordinary-${index}`,
      flightNo: flight.flightNo,
      name: `P${index}`,
      category: "常规" as const,
      remark: "",
      fatiguePoints: 1,
      qualifiedStaffIds,
    }));
    state.history = [
      {
        id: "protected-late",
        date: "2026-08-21",
        flightNo: "TR121",
        position: "H02",
        staffId: protectedWorker!.id,
        staffName: protectedWorker!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 0,
        remark: "一号",
      },
      {
        id: "alternate-history",
        date: "2026-08-21",
        flightNo: "EARLY999",
        position: "普通岗位",
        staffId: alternate!.id,
        staffName: alternate!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    Object.assign(
      state.settings.lateShiftRecoveryPositionRules.find(
        (rule) => rule.matchField === "remark" && rule.keyword === "一号"
      )!,
      { nextWorkdayCutoffTime: "12:00" }
    );

    const result = await generateSchedule(state, "2026-08-23");
    const protectedAssignments = result.assignments.filter(
      (assignment) => assignment.staffId === protectedWorker!.id
    );

    expect(
      protectedAssignments.map((assignment) => assignment.flightNo)
    ).toEqual(["EARLY100"]);
    expect(result.unfilledCount).toBe(0);
  });

  it("keeps the duty morning lock ahead of next-workday priority-position recovery", async () => {
    const state = createOrdinarySchedulingState();
    const [dutyWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [dutyWorker!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.flights = [
      {
        id: "cx937",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [dutyWorker!.id, alternate!.id],
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-23",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = [
      {
        id: "late-highest",
        date: "2026-08-21",
        flightNo: "TR121",
        position: "H02",
        staffId: dutyWorker!.id,
        staffName: dutyWorker!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    state.assignments = (
      await generateSchedule(state, "2026-08-23")
    ).assignments;
    expect(state.assignments[0]?.staffId).toBe(dutyWorker!.id);
    const feedback = buildScheduleFeedback(state, "2026-08-23").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.status).toBe("需复核");
    expect(feedback.text).toContain("值班上午上岗要求优先");
  });

  it("keeps the only qualified worker on a protected next-workday position and explains the coverage override", async () => {
    const state = createOrdinarySchedulingState();
    const [onlyQualified, unqualified] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [onlyQualified!, unqualified!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke-one",
        flightNo: "KE166",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [onlyQualified!.id],
      },
    ];
    state.history = [
      {
        id: "late-highest",
        date: "2026-08-21",
        flightNo: "TR121",
        position: "H02",
        staffId: onlyQualified!.id,
        staffName: onlyQualified!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    state.assignments = (
      await generateSchedule(state, "2026-08-23")
    ).assignments;
    expect(state.assignments[0]?.staffId).toBe(onlyQualified!.id);
    const feedback = buildScheduleFeedback(state, "2026-08-23").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.status).toBe("需复核");
    expect(feedback.text).toContain("唯一合格人员");
  });

  it("keeps the KE166 mobile supervisor independent and lets another worker satisfy next-workday recovery", async () => {
    const state = createOrdinarySchedulingState();
    const [mobileSupervisor, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [mobileSupervisor!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:00",
        endTime: "10:00",
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
        remark: "",
        qualifiedStaffIds: [mobileSupervisor!.id],
      },
      {
        ...base,
        id: "ke-one",
        flightNo: "KE166",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [mobileSupervisor!.id, alternate!.id],
      },
    ];
    state.settings.mobileSupervisorCoverageRules = [];
    state.history = [
      {
        id: "late-highest",
        date: "2026-08-21",
        flightNo: "TR121",
        position: "H02",
        staffId: mobileSupervisor!.id,
        staffName: mobileSupervisor!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    state.assignments = (
      await generateSchedule(state, "2026-08-23")
    ).assignments;

    expect(
      state.assignments.find(
        (assignment) => assignment.positionRuleId === "ke-supervisor"
      )?.staffId
    ).toBe(mobileSupervisor!.id);
    expect(
      state.assignments.find(
        (assignment) => assignment.positionRuleId === "ke-one"
      )?.staffId
    ).toBe(alternate!.id);
    const feedback = buildScheduleFeedback(state, "2026-08-23").find(
      (item) => item.key === "previous-late"
    )!;
    expect(feedback.status).toBe("已执行");
  });

  it("fills a next-day late position when the protected worker is the only candidate", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    state.staff = [person];
    state.flights = [
      {
        id: "late-flight",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "late-high",
        flightNo: "TR121",
        name: "H02",
        fatiguePoints: 4,
        remark: "一号",
        qualifiedStaffIds: [person.id],
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-07-17",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionRotationEnabled = false;
    const result = await generateSchedule(state, "2026-07-18");
    const target = result.assignments[0]!;
    expect(target).toMatchObject({ staffId: person.id, status: "assigned" });
    state.assignments = result.assignments;
    state.activeScheduleDate = "2026-07-18";
    expect(canAssignStaff(state, target.id, person.id)).toBeNull();
  });

  it("never leaves an early position empty because the worker handled the previous late shift", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    state.staff = [person];
    person.dutyQualified = false;
    state.flights = [
      {
        id: "early",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "early-position",
        flightNo: "KE166",
        name: "H03",
        qualifiedStaffIds: [person.id],
      },
    ];
    state.history = [
      {
        id: "previous-late",
        date: "2026-07-17",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: "一号",
      },
    ];
    state.settings.lateShiftRecoveryEnabled = true;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]
    ).toMatchObject({
      status: "assigned",
      staffId: person.id,
    });
  });

  it("rejects manual changes that violate time constraints", async () => {
    const state = createOrdinarySchedulingState();
    state.assignments = (
      await generateSchedule(state, "2026-07-18")
    ).assignments;
    const pair = state.assignments.flatMap((first) =>
      state.assignments
        .filter(
          (other) =>
            other.flightId === first.flightId &&
            other.id !== first.id &&
            first.staffId
        )
        .filter((other) => {
          const rule = state.positionRules.find(
            (item) => item.id === other.positionRuleId
          );
          return rule?.qualifiedStaffIds.includes(first.staffId!) ?? false;
        })
        .map((other) => ({ first, other }))
    )[0]!;
    expect(canAssignStaff(state, pair.other.id, pair.first.staffId!)).toMatch(
      /时段/
    );
  }, 30_000);

  it("allows assigning a regular position when the only same-flight overlap is a guide assignment", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    const base = state.positionRules[0]!;
    state.staff = [person];
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.positionRules = [
      {
        ...base,
        id: "source",
        flightNo: "F1",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
      {
        ...base,
        id: "target",
        flightNo: "F1",
        name: "G02",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
      {
        ...base,
        id: "guide",
        flightNo: "F1",
        name: "柜台引导",
        category: "引导",
        qualifiedStaffIds: [],
      },
    ];
    state.assignments = (
      await generateSchedule(state, "2026-07-18")
    ).assignments;
    const source = state.assignments.find(
      (item) => item.positionRuleId === "source"
    )!;
    const target = state.assignments.find(
      (item) => item.positionRuleId === "target"
    )!;
    const guide = state.assignments.find(
      (item) => item.positionRuleId === "guide"
    )!;
    expect(guide.staffId).toBe(person.id);
    expect(canAssignStaff(state, target.id, person.id, source.id)).toBeNull();
  });

  it("keeps pre-noon regular positions visible but unassigned below passenger thresholds", async () => {
    const state = createOrdinarySchedulingState();
    state.flights = [state.flights[0]!];
    state.flights[0]!.positions = ["G12", "G13"];
    state.positionRules = state.positionRules.filter(
      (rule) => rule.flightNo === "CX937" && ["G12", "G13"].includes(rule.name)
    );
    state.flights[0]!.bookedPassengers = 20;
    state.positionRules.find(
      (rule) => rule.flightNo === "CX937" && rule.name === "G13"
    )!.minPassengers = 30;
    const belowThreshold = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    expect(belowThreshold.map((item) => item.position)).toEqual(["G12", "G13"]);
    expect(
      belowThreshold.find((item) => item.position === "G13")
    ).toMatchObject({ status: "manual", staffId: null });
    state.flights[0]!.bookedPassengers = 30;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.position === "G13"
      )?.staffId
    ).not.toBeNull();
  });

  it("puts supervisors first and otherwise follows position configuration order", () => {
    const state = createOrdinarySchedulingState();
    const flight = state.flights[0]!;
    state.flights = [flight];
    const rules = state.positionRules.filter(
      (rule) => rule.flightNo === flight.flightNo
    );
    state.positionRules = [
      rules.find((rule) => rule.name === "G12")!,
      rules.find((rule) => rule.name === "督导")!,
      rules.find((rule) => rule.name === "G13")!,
      rules.find((rule) => rule.name === "超规柜台")!,
    ];
    expect(activeFlightPositions(state, flight)).toEqual([
      "督导",
      "G12",
      "G13",
      "超规柜台",
    ]);
  });

  it("sorts all G and H counters from high to low in one operation", () => {
    const state = createOrdinarySchedulingState();
    const flight = state.flights[0]!;
    const rules = state.positionRules.filter(
      (rule) => rule.flightNo === flight.flightNo
    );
    state.positionRules = [
      rules.find((rule) => rule.name === "G12")!,
      rules.find((rule) => rule.name === "柜台引导1")!,
      rules.find((rule) => rule.name === "G20")!,
      rules.find((rule) => rule.name === "督导")!,
      rules.find((rule) => rule.name === "G13")!,
    ];
    state.positionRules = sortFlightCountersDescending(
      state.positionRules,
      flight.flightNo
    );
    expect(activeFlightPositions(state, flight)).toEqual([
      "督导",
      "G20",
      "G13",
      "G12",
      "柜台引导1",
    ]);
  });

  it("keeps administrative support in its position role instead of moving the category to the bottom", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    state.staff = state.staff.slice(0, 3);
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "G14",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "p2",
        flightNo: "F1",
        name: "G13",
        category: "行政支援",
        qualifiedStaffIds: [state.staff[1]!.id],
      },
      {
        ...base,
        id: "p3",
        flightNo: "F1",
        name: "督导",
        category: "行政支援",
        qualifiedStaffIds: [state.staff[2]!.id],
      },
    ];
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.map(
        (item) => item.position
      )
    ).toEqual(["督导", "G14", "G13"]);
  });

  it("leaves administrative support empty when a basic position is short-staffed", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    state.staff = [state.staff[0]!];
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "p2",
        flightNo: "F1",
        name: "G12",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "p3",
        flightNo: "F1",
        name: "超规行李引导",
        category: "行政支援",
        qualifiedStaffIds: [],
      },
    ];
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.find((item) => item.position === "G12")?.status
    ).toBe("unfilled");
    expect(
      result.assignments.find((item) => item.position === "超规行李引导")
    ).toMatchObject({ status: "manual", staffId: null });
  });

  it("fills an administrative support position with an available regular worker", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    state.staff = state.staff.slice(0, 2);
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "p2",
        flightNo: "F1",
        name: "超规行李引导",
        category: "行政支援",
        qualifiedStaffIds: [state.staff[1]!.id],
      },
    ];
    const adminSupport = (
      await generateSchedule(state, "2026-07-18")
    ).assignments.find((item) => item.position === "超规行李引导");
    expect(adminSupport).toMatchObject({
      status: "assigned",
      staffId: state.staff[1]!.id,
      workHours: 2,
      fatiguePoints: base.fatiguePoints,
    });
  });

  it("keeps regular positions ahead of administrative support positions", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    state.staff = [state.staff[0]!];
    state.staff[0]!.dutyQualified = false;
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "administrative-first",
        flightNo: "F1",
        name: "行政补位",
        category: "行政支援",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "regular-second",
        flightNo: "F1",
        name: "G14",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "regular-second")
    ).toMatchObject({ status: "assigned", staffId: state.staff[0]!.id });
    expect(
      assignments.find((item) => item.positionRuleId === "administrative-first")
    ).toMatchObject({ status: "manual", staffId: null });
  });

  it("continues using a regular worker on a non-conflicting administrative support position", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    state.staff = [state.staff[0]!];
    state.staff[0]!.dutyQualified = false;
    state.settings.minimumRegularTransitionMinutes = 0;
    state.flights = [
      {
        id: "regular-flight",
        flightNo: "REGULAR",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "support-flight",
        flightNo: "SUPPORT",
        startTime: "17:00",
        endTime: "19:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "regular-position",
        flightNo: "REGULAR",
        name: "G14",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "support-position",
        flightNo: "SUPPORT",
        name: "行政补位",
        category: "行政支援",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;

    expect(
      assignments.filter((item) => item.staffId === state.staff[0]!.id)
    ).toHaveLength(2);
    expect(
      assignments.find((item) => item.positionRuleId === "support-position")
    ).toMatchObject({ status: "assigned", workHours: 2 });
  });

  it("uses the regular counterpart qualifications for same-name administrative support", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    const regular = state.staff[0]!;
    const administrative = state.staff[1]!;
    administrative.staffType = "行政支援";
    regular.dutyQualified = false;
    state.staff = [regular, administrative];
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "regular-counterpart",
        flightNo: "F1",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [regular.id],
      },
      {
        ...base,
        id: "administrative-counterpart",
        flightNo: "F1",
        name: "督导",
        category: "行政支援",
        qualifiedStaffIds: [administrative.id],
      },
    ];

    const assignment = (await generateSchedule(state, "2026-07-18"))
      .assignments[0];

    expect(assignment).toMatchObject({
      positionRuleId: "administrative-counterpart",
      status: "assigned",
      staffId: regular.id,
    });
  });

  it("omits administrative support positions while the mode is disabled", async () => {
    const state = createOrdinarySchedulingState();
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "G14",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "p2",
        flightNo: "F1",
        name: "行政补位",
        category: "行政支援",
        qualifiedStaffIds: [],
      },
    ];
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.map(
        (item) => item.position
      )
    ).toEqual(["G14"]);
  });

  it("requires administrative personnel to have position qualifications in support mode", () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    const person = state.staff[0]!;
    person.staffType = "行政支援";
    state.flights = [state.flights[0]!];
    const rule = state.positionRules.find(
      (item) =>
        item.flightNo === state.flights[0]!.flightNo && item.name === "G12"
    )!;
    rule.qualifiedStaffIds = [];
    state.assignments = [
      {
        id: "target",
        flightId: state.flights[0]!.id,
        flightNo: state.flights[0]!.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: state.flights[0]!.startTime,
        endTime: state.flights[0]!.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: "",
        manualRemark: "",
        status: "unfilled",
      },
    ];
    expect(canAssignStaff(state, "target", person.id)).toContain("岗位资质");
    rule.qualifiedStaffIds = [person.id];
    expect(canAssignStaff(state, "target", person.id)).toBeNull();
    state.settings.adminSupportEnabled = false;
    expect(canAssignStaff(state, "target", person.id)).toContain("尚未启用");
  });

  it("allows administrative support only after no qualified regular worker remains available", () => {
    const state = createOrdinarySchedulingState();
    state.settings.adminSupportEnabled = true;
    const regular = state.staff[0]!;
    const administrative = state.staff[1]!;
    administrative.staffType = "行政支援";
    state.staff = [regular, administrative];
    state.flights = [state.flights[0]!];
    const rule = state.positionRules.find(
      (item) =>
        item.flightNo === state.flights[0]!.flightNo && item.name === "G12"
    )!;
    rule.qualifiedStaffIds = [regular.id, administrative.id];
    state.assignments = [
      {
        id: "target",
        flightId: state.flights[0]!.id,
        flightNo: state.flights[0]!.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: state.flights[0]!.startTime,
        endTime: state.flights[0]!.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: "",
        manualRemark: "",
        status: "unfilled",
      },
    ];
    expect(canAssignStaff(state, "target", administrative.id)).toContain(
      "优先安排常规人员"
    );
    regular.status = "休假";
    expect(canAssignStaff(state, "target", administrative.id)).toBeNull();
  });

  it("generates one assignment for every configured rule id without inventing positions", async () => {
    const state = createOrdinarySchedulingState();
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: ["未配置岗位"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "督导",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "p2",
        flightNo: "F1",
        name: "督导",
        qualifiedStaffIds: [state.staff[1]!.id],
      },
    ];
    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    expect(assignments.map((item) => item.positionRuleId)).toEqual([
      "p1",
      "p2",
    ]);
    expect(assignments.map((item) => item.position)).toEqual(["督导", "督导"]);
  });

  it("replaces a same-name regular position in administrative support mode", async () => {
    const state = createOrdinarySchedulingState();
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "regular-supervisor",
        flightNo: "F1",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [state.staff[0]!.id],
      },
      {
        ...base,
        id: "regular-counter",
        flightNo: "F1",
        name: "G14",
        category: "常规",
        qualifiedStaffIds: [state.staff[1]!.id],
      },
      {
        ...base,
        id: "admin-supervisor",
        flightNo: "F1",
        name: "督导",
        category: "行政支援",
        qualifiedStaffIds: [],
      },
    ];
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments.map(
        (item) => item.positionRuleId
      )
    ).toEqual(["regular-supervisor", "regular-counter"]);
    state.settings.adminSupportEnabled = true;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments
    ).toMatchObject([
      {
        positionRuleId: "admin-supervisor",
        status: "assigned",
        staffId: state.staff[0]!.id,
      },
      { positionRuleId: "regular-counter", status: "assigned" },
    ]);
  });

  it("reserves versatile staff for a later overlapping position with fewer qualified workers", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = state.staff.filter((person) =>
      ["2", "3"].includes(person.id)
    );
    state.flights = [
      {
        id: "flex-flight",
        flightNo: "FLEX",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "rare-flight",
        flightNo: "RARE",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "flex",
        flightNo: "FLEX",
        name: "普通柜台",
        qualifiedStaffIds: ["2", "3"],
      },
      {
        ...base,
        id: "rare",
        flightNo: "RARE",
        name: "限制柜台",
        qualifiedStaffIds: ["2"],
      },
    ];
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.find((item) => item.positionRuleId === "flex")?.staffId
    ).toBe("3");
    expect(
      result.assignments.find((item) => item.positionRuleId === "rare")?.staffId
    ).toBe("2");
    expect(result.unfilledCount).toBe(0);
  });

  it("considers every overlapping afternoon position before choosing any staff", async () => {
    const state = createOrdinarySchedulingState();
    const [workerA, workerB, workerC, workerD, workerE] = state.staff;
    state.staff = [workerA!, workerB!, workerC!, workerD!, workerE!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.cxPreflightQualified = false;
      person.status = "正常";
      person.staffType = "常规";
      person.nightShift = true;
    });
    state.history = [];
    state.dutyRosterOverrides = [];
    state.settings.positionTransitionPolicies = [];
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;

    const candidateGroups = [
      [workerA!.id, workerB!.id],
      [workerA!.id, workerC!.id],
      [workerA!.id, workerC!.id],
      [workerB!.id, workerD!.id],
      [workerB!.id, workerE!.id],
    ];
    state.flights = candidateGroups.map((_, index) => ({
      id: `global-flight-${index + 1}`,
      flightNo: `GLOBAL${index + 1}`,
      startTime: "13:00",
      endTime: "15:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    }));
    const base = state.positionRules[0]!;
    state.positionRules = state.flights.map((flight, index) => ({
      ...base,
      id: `global-position-${index + 1}`,
      flightNo: flight.flightNo,
      name: `P${index + 1}`,
      category: "常规" as const,
      remark: "",
      qualifiedStaffIds: candidateGroups[index]!,
      fatiguePoints: 1,
      manual: false,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));

    const result = await generateSchedule(state, "2026-07-18");
    const assignedByRuleId = new Map(
      result.assignments.map((assignment) => [
        assignment.positionRuleId,
        assignment.staffId,
      ])
    );

    expect(result.unfilledCount).toBe(0);
    expect(assignedByRuleId.get("global-position-1")).toBe(workerB!.id);
    expect(
      new Set(result.assignments.map((assignment) => assignment.staffId)).size
    ).toBe(5);
  });

  it("globally schedules each pre-noon position by scarcity before softer transition preferences", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    const [rareWorker, flexibleWorker] = state.staff;
    state.staff = [rareWorker!, flexibleWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "base-flight",
        flightNo: "BASE",
        startTime: "06:00",
        endTime: "07:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "flex-flight",
        flightNo: "FLEX",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "rare-flight",
        flightNo: "RARE",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = { ...state.positionRules[0]!, category: "常规" as const };
    state.positionRules = [
      {
        ...base,
        id: "base",
        flightNo: "BASE",
        name: "P0",
        qualifiedStaffIds: [flexibleWorker!.id],
      },
      {
        ...base,
        id: "flex",
        flightNo: "FLEX",
        name: "普通柜台",
        qualifiedStaffIds: [rareWorker!.id, flexibleWorker!.id],
      },
      {
        ...base,
        id: "rare",
        flightNo: "RARE",
        name: "限制柜台",
        qualifiedStaffIds: [rareWorker!.id],
      },
    ];
    state.settings.positionTransitionPolicies = [
      {
        id: "prefer-flexible-worker-away",
        name: "普通柜台优先避开",
        enabled: true,
        sourceFlightNo: "BASE",
        sourcePositions: ["P0"],
        targetFlightNo: "FLEX",
        targetPosition: "普通柜台",
        minimumGapMinutes: 180,
        mode: "prefer",
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.find((item) => item.positionRuleId === "rare")?.staffId
    ).toBe(rareWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "flex")?.staffId
    ).toBe(flexibleWorker!.id);
    expect(result.unfilledCount).toBe(0);
  });

  it("fills guide rules from the bottom-most distinct positions when no support source exists", async () => {
    const state = createOrdinarySchedulingState();
    const [topWorker, bottomWorker, diversionWorker] = state.staff;
    state.staff = [topWorker!, bottomWorker!, diversionWorker!];
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "regular-top",
        flightNo: "F1",
        name: "G03",
        category: "常规",
        qualifiedStaffIds: [topWorker!.id],
      },
      {
        ...base,
        id: "regular-bottom",
        flightNo: "F1",
        name: "G02",
        category: "常规",
        qualifiedStaffIds: [bottomWorker!.id],
      },
      {
        ...base,
        id: "diversion-lowest",
        flightNo: "F1",
        name: "G01",
        category: "分流",
        qualifiedStaffIds: [diversionWorker!.id],
      },
      {
        ...base,
        id: "guide-one",
        flightNo: "F1",
        name: "柜台引导1",
        category: "引导",
        qualifiedStaffIds: [],
      },
      {
        ...base,
        id: "guide-two",
        flightNo: "F1",
        name: "柜台引导2",
        category: "引导",
        qualifiedStaffIds: [],
      },
    ];
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.find((item) => item.positionRuleId === "guide-one")
        ?.staffId
    ).toBe(diversionWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "guide-two")
        ?.staffId
    ).toBe(bottomWorker!.id);
    expect(
      result.assignments
        .filter((item) => item.positionRuleId?.startsWith("guide-"))
        .every((item) => item.workHours === 0 && item.fatiguePoints === 0)
    ).toBe(true);
  });

  it("prioritizes a regular worker on an administrative support position for guide reuse", async () => {
    const state = createOrdinarySchedulingState();
    const [supportWorker, bottomWorker, administrativeWorker] = state.staff;
    administrativeWorker!.staffType = "行政支援";
    state.staff = [supportWorker!, bottomWorker!, administrativeWorker!];
    state.settings.adminSupportEnabled = true;
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "administrative-source",
        flightNo: "F1",
        name: "行政补位",
        category: "行政支援",
        qualifiedStaffIds: [supportWorker!.id, administrativeWorker!.id],
      },
      {
        ...base,
        id: "regular-bottom",
        flightNo: "F1",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [bottomWorker!.id],
      },
      {
        ...base,
        id: "guide",
        flightNo: "F1",
        name: "柜台引导",
        category: "引导",
        qualifiedStaffIds: [],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;

    expect(
      assignments.find(
        (item) => item.positionRuleId === "administrative-source"
      )
    ).toMatchObject({ status: "assigned", staffId: supportWorker!.id });
    expect(
      assignments.find((item) => item.positionRuleId === "guide")?.staffId
    ).toBe(supportWorker!.id);
  });

  it("keeps the configured supervisor at the top without generating a fill position", async () => {
    const state = createOrdinarySchedulingState();
    const [supervisor, counterWorker] = state.staff;
    state.staff = [supervisor!, counterWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "F1",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor!.id],
      },
      {
        ...base,
        id: "counter",
        flightNo: "F1",
        name: "G12",
        category: "常规",
        qualifiedStaffIds: [counterWorker!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const supervisorAssignment = result.assignments.find(
      (item) => item.positionRuleId === "supervisor"
    )!;
    const counterAssignment = result.assignments.find(
      (item) => item.positionRuleId === "counter"
    )!;
    expect(activeFlightPositions(state, state.flights[0]!)).toEqual([
      "督导",
      "G12",
    ]);
    expect(supervisorAssignment).toMatchObject({
      staffId: supervisor!.id,
      status: "assigned",
    });
    state.assignments = result.assignments;
    expect(counterAssignment).toMatchObject({
      staffId: counterWorker!.id,
      status: "assigned",
    });
  });

  it("leaves a vacancy when the only qualified candidate is a team leader", async () => {
    const state = createOrdinarySchedulingState();
    const teamLeader = state.staff[0]!;
    state.staff = [teamLeader];
    teamLeader.teamLeader = true;
    teamLeader.dutyQualified = false;
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "F1",
        name: "督导",
        category: "常规",
        qualifiedStaffIds: [teamLeader.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");

    expect(result.assignments[0]).toMatchObject({
      staffId: null,
      status: "unfilled",
    });
  });

  it("uses an equally qualified regular worker before pulling a free team leader into an ordinary counter", async () => {
    const state = createOrdinarySchedulingState();
    const [teamLeader, regular] = state.staff;
    state.staff = [teamLeader!, regular!];
    teamLeader!.teamLeader = true;
    regular!.teamLeader = false;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "counter",
        flightNo: "F1",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [teamLeader!.id, regular!.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");

    expect(result.assignments[0]).toMatchObject({
      staffId: regular!.id,
      status: "assigned",
    });
  });

  it("automatically shows a KE166 regular worker in the supervisor cell without duplicating work hours", async () => {
    const state = createOrdinarySchedulingState();
    const supervisor = state.staff[0]!;
    state.staff = [supervisor];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke166-counter",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 7,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const supervisorAssignment = result.assignments.find(
      (item) => item.positionRuleId === "ke166-supervisor"
    )!;
    const counterAssignment = result.assignments.find(
      (item) => item.positionRuleId === "ke166-counter"
    )!;

    expect(supervisorAssignment).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(counterAssignment).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      workHours: 0,
      fatiguePoints: 7,
      supervisorSourceAssignmentId: supervisorAssignment.id,
    });
    expect(
      result.assignments.reduce((sum, item) => sum + item.workHours, 0)
    ).toBe(2);
    expect(
      result.assignments.reduce((sum, item) => sum + item.fatiguePoints, 0)
    ).toBe(12);
  });

  it("keeps the schedule when no KE166 mobile supervisor is available", async () => {
    const state = createOrdinarySchedulingState();
    const counterWorker = state.staff[0]!;
    state.staff = [counterWorker];
    counterWorker.dutyQualified = false;
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke166-counter",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [counterWorker.id],
        fatiguePoints: 7,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");

    expect(
      result.assignments.find(
        (assignment) => assignment.positionRuleId === "ke166-counter"
      )
    ).toMatchObject({ staffId: counterWorker.id, status: "assigned" });
    expect(
      result.assignments.find(
        (assignment) => assignment.positionRuleId === "ke166-supervisor"
      )
    ).toMatchObject({ staffId: null, status: "unfilled" });
    expect(result.warnings).toContain(
      "KE166机动督导未安排，岗位已留空，请人工复核"
    );
  });

  it("keeps an early-start half-rest worker eligible for a late KE166 supervisor shift", async () => {
    const state = createOrdinarySchedulingState();
    const worker = state.staff[0]!;
    state.staff = [worker];
    worker.dutyQualified = false;
    state.flights = [
      {
        id: "ke166-late",
        flightNo: "KE166",
        startTime: "21:00",
        endTime: "23:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-late-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [worker.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke166-late-counter",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [worker.id],
        fatiguePoints: 7,
      },
    ];

    const result = await generateSchedule(state, "2026-09-14", {
      preferences: {
        halfRestStaffIds: [worker.id],
        halfRestModes: { [worker.id]: "late-start" },
      },
    });
    const preparation = prepareSchedule(
      state,
      "2026-09-14",
      evaluateAutomaticHardConstraints,
      {
        halfRestStaffIds: [worker.id],
        halfRestModes: { [worker.id]: "late-start" },
      }
    );
    expect(preparation.runFacts.halfRest.activeStaffIds).toContain(worker.id);
    expect(
      result.assignments.find(
        (assignment) => assignment.positionRuleId === "ke166-late-supervisor"
      )
    ).toMatchObject({ staffId: worker.id, status: "assigned" });
  });

  it("prefers another KE166 mobile supervisor when the first qualified worker is on duty next workday", async () => {
    const state = createOrdinarySchedulingState();
    const [protectedWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [protectedWorker!, alternate!];
    state.staff.forEach((person) => {
      person.teamLeader = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = [protectedWorker!.id, alternate!.id];
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds,
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "counter",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        remark: "",
        qualifiedStaffIds,
        fatiguePoints: 2,
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-14",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
      {
        date: "2026-08-16",
        cxPreflightStaffId: null,
        dutyStaffId: protectedWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-08-14"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "supervisor")?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "counter")?.staffId
    ).toBe(protectedWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "counter")
        ?.supervisorSourceAssignmentId
    ).toBeUndefined();
  });

  it("rotates the independent KE166 mobile supervisor after the previous workday", async () => {
    const state = createOrdinarySchedulingState();
    const [repeatedSupervisor, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [repeatedSupervisor!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.teamLeader = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = [repeatedSupervisor!.id, alternate!.id];
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds,
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "counter",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        remark: "",
        qualifiedStaffIds,
        fatiguePoints: 2,
      },
    ];
    state.history = [
      {
        id: "previous-supervisor",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "督导",
        staffId: repeatedSupervisor!.id,
        staffName: repeatedSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
      {
        id: "previous-alternate-priority",
        date: "2026-10-22",
        flightNo: "CX931",
        position: "G18",
        staffId: alternate!.id,
        staffName: alternate!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "控制",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "supervisor")?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "counter")?.staffId
    ).toBe(repeatedSupervisor!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "counter")
        ?.supervisorSourceAssignmentId
    ).toBeUndefined();
  });

  it("keeps the only KE166 mobile supervisor pair complete and reports the consecutive exception", async () => {
    const state = createOrdinarySchedulingState();
    const supervisor = state.staff.find((person) => person.status === "正常")!;
    state.staff = [supervisor];
    supervisor.dutyQualified = false;
    state.settings.lateShiftRecoveryEnabled = false;
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "counter",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 2,
      },
    ];
    state.history = [
      {
        id: "previous-supervisor",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "督导",
        staffId: supervisor.id,
        staffName: supervisor.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");
    const top = result.assignments.find(
      (item) => item.positionRuleId === "supervisor"
    )!;
    const counter = result.assignments.find(
      (item) => item.positionRuleId === "counter"
    )!;

    expect(top.staffId).toBe(supervisor.id);
    expect(counter.staffId).toBe(supervisor.id);
    expect(top.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-rotation",
          outcome: "fallback",
        }),
      ])
    );
    expect(result.warnings.join("\n")).toContain(
      `${supervisor.name} 已连续1次承担KE166/督导`
    );
    state.assignments = result.assignments;
    const feedback = buildScheduleFeedback(state, "2026-10-24").find(
      (item) => item.key === "position-rotation"
    )!;
    expect(feedback).toMatchObject({ status: "需复核" });
    expect(feedback.text).toContain("当前连续第2次");
  });

  it("moves a cooling duty worker to the next configured late target", async () => {
    const state = createOrdinarySchedulingState();
    const [dutyWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [dutyWorker!, alternate!];
    dutyWorker!.dutyQualified = true;
    alternate!.dutyQualified = true;
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY1",
        startTime: "08:00",
        endTime: "09:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second-late",
        flightNo: "TW616",
        startTime: "20:00",
        endTime: "22:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "latest",
        flightNo: "TR121",
        startTime: "22:00",
        endTime: "23:59",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = [dutyWorker!.id, alternate!.id];
    state.positionRules = [
      {
        ...base,
        id: "early-position",
        flightNo: "EARLY1",
        name: "E01",
        category: "常规",
        remark: "",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "second-priority",
        flightNo: "TW616",
        name: "G12",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "first-priority",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds,
      },
    ];
    state.settings.dutyPositionPriorities = [
      { id: "first", enabled: true, flightNo: "TR121", positionKeyword: "H02" },
      {
        id: "second",
        enabled: true,
        flightNo: "TW616",
        positionKeyword: "G12",
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-10-24",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = [
      {
        id: "previous-duty-target",
        date: "2026-10-22",
        flightNo: "TR121",
        position: "H02",
        staffId: dutyWorker!.id,
        staffName: dutyWorker!.name,
        startTime: "22:00",
        endTime: "23:59",
        workHours: 2,
        fatiguePoints: 6,
        remark: "一号",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "second-priority")
        ?.staffId
    ).toBe(dutyWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "first-priority")
        ?.staffId
    ).toBe(alternate!.id);
  });

  it("does not change KE166 mobile supervisor reuse when a worker is marked as team leader", async () => {
    const scheduleSupervisor = async (teamLeaderId?: string) => {
      const state = createOrdinarySchedulingState();
      state.staff = state.staff.slice(0, 2);
      state.staff.forEach((person) => {
        person.teamLeader = person.id === teamLeaderId;
        person.dutyQualified = false;
      });
      state.flights = [
        {
          id: "ke166",
          flightNo: "KE166",
          startTime: "08:30",
          endTime: "10:30",
          bookedPassengers: 100,
          positions: [],
          remark: "",
        },
      ];
      const base = state.positionRules[0]!;
      const qualifiedStaffIds = state.staff.map((person) => person.id);
      state.positionRules = [
        {
          ...base,
          id: "supervisor",
          flightNo: "KE166",
          name: "督导",
          category: "机动督导",
          qualifiedStaffIds,
          fatiguePoints: 5,
        },
        {
          ...base,
          id: "counter",
          flightNo: "KE166",
          name: "H06",
          category: "常规",
          remark: "",
          qualifiedStaffIds,
          fatiguePoints: 2,
        },
        {
          ...base,
          id: "first-worker-counter",
          flightNo: "KE166",
          name: "H07",
          category: "常规",
          remark: "",
          qualifiedStaffIds: [state.staff[0]!.id],
          fatiguePoints: 2,
        },
      ];
      return (await generateSchedule(state, "2026-07-18")).assignments.find(
        (item) => item.positionRuleId === "supervisor"
      )!.staffId;
    };

    const baselineStaffId = await scheduleSupervisor();
    expect(await scheduleSupervisor(baselineStaffId!)).toBe(baselineStaffId);
  });

  it("keeps the KE166 mobile supervisor away from forbidden remarked positions", async () => {
    const state = createOrdinarySchedulingState();
    const [supervisor, worker] = state.staff;
    state.staff = [supervisor!, worker!];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "h02",
        flightNo: "KE166",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [supervisor!.id, worker!.id],
        fatiguePoints: 7,
      },
      {
        ...base,
        id: "h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [supervisor!.id, worker!.id],
        fatiguePoints: 2,
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    const top = assignments.find(
      (item) => item.positionRuleId === "supervisor"
    )!;
    expect(
      assignments.find((item) => item.positionRuleId === "h02")?.staffId
    ).not.toBe(supervisor!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "h06")
    ).toMatchObject({
      staffId: supervisor!.id,
      workHours: 0,
      supervisorSourceAssignmentId: top.id,
    });
  });

  it("keeps the KE166 supervisor in the top position when every regular target is forbidden", async () => {
    const state = createOrdinarySchedulingState();
    const [supervisor, worker] = state.staff;
    state.staff = [supervisor!, worker!];
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "h02",
        flightNo: "KE166",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [supervisor!.id, worker!.id],
        fatiguePoints: 7,
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "supervisor")
    ).toMatchObject({ staffId: supervisor!.id, workHours: 2 });
    expect(
      assignments.find((item) => item.positionRuleId === "h02")
    ).toMatchObject({ staffId: worker!.id, workHours: 2 });
  });

  it("moves unavoidable regular-position gaps toward the bottom of every flight", async () => {
    const state = createOrdinarySchedulingState();
    const [first, second, third] = state.staff;
    state.staff = [first!, second!, third!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = { ...state.positionRules[0]!, category: "常规" as const };
    state.positionRules = [
      {
        ...base,
        id: "h05",
        flightNo: "F1",
        name: "H05",
        qualifiedStaffIds: [first!.id, second!.id, third!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "h06",
        flightNo: "F1",
        name: "H06",
        qualifiedStaffIds: [first!.id, second!.id, third!.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "h07",
        flightNo: "F1",
        name: "H07",
        qualifiedStaffIds: [first!.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "h08",
        flightNo: "F1",
        name: "H08",
        qualifiedStaffIds: [second!.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "h09",
        flightNo: "F1",
        name: "H09",
        qualifiedStaffIds: [third!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "guide",
        flightNo: "F1",
        name: "柜台引导",
        category: "引导",
        qualifiedStaffIds: [],
        fatiguePoints: 1,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const regular = result.assignments.filter((item) =>
      item.positionRuleId?.startsWith("h")
    );
    const assignedPositions = regular
      .filter((item) => item.staffId)
      .map((item) => item.position);
    const guide = result.assignments.find(
      (item) => item.positionRuleId === "guide"
    )!;

    expect(assignedPositions).toEqual(["H05", "H06", "H07"]);
    expect(regular.filter((item) => item.staffId)).toHaveLength(3);
    expect(regular.find((item) => item.position === "H07")).toMatchObject({
      staffId: first!.id,
      fatiguePoints: 3,
    });
    expect(regular.find((item) => item.position === "H08")?.staffId).toBeNull();
    expect(regular.find((item) => item.position === "H09")?.staffId).toBeNull();
    expect(guide.staffId).toBe(first!.id);
    for (const assignment of regular.filter((item) => item.staffId)) {
      const rule = state.positionRules.find(
        (item) => item.id === assignment.positionRuleId
      )!;
      expect(rule.qualifiedStaffIds).toContain(assignment.staffId);
    }
  });

  it("does not move an unqualified worker upward merely to hide a gap", async () => {
    const state = createOrdinarySchedulingState();
    const [first, second] = state.staff;
    state.staff = [first!, second!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "flight",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = { ...state.positionRules[0]!, category: "常规" as const };
    state.positionRules = [
      {
        ...base,
        id: "h05",
        flightNo: "F1",
        name: "H05",
        qualifiedStaffIds: [],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "h06",
        flightNo: "F1",
        name: "H06",
        qualifiedStaffIds: [first!.id, second!.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "h07",
        flightNo: "F1",
        name: "H07",
        qualifiedStaffIds: [first!.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "h08",
        flightNo: "F1",
        name: "H08",
        qualifiedStaffIds: [second!.id],
        fatiguePoints: 2,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const regular = result.assignments.filter((item) =>
      item.positionRuleId?.startsWith("h")
    );

    expect(
      regular.filter((item) => item.staffId).map((item) => item.position)
    ).toEqual(["H06", "H07"]);
    expect(regular.find((item) => item.position === "H05")?.staffId).toBeNull();
    expect(regular.find((item) => item.position === "H08")?.staffId).toBeNull();
    for (const assignment of regular.filter((item) => item.staffId)) {
      const rule = state.positionRules.find(
        (item) => item.id === assignment.positionRuleId
      )!;
      expect(rule.qualifiedStaffIds).toContain(assignment.staffId);
    }
  });

  it("keeps the KE166 supervisor link when a qualified worker is moved upward", async () => {
    const state = createOrdinarySchedulingState();
    const [supervisor, worker] = state.staff;
    state.staff = [supervisor!, worker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        qualifiedStaffIds: [supervisor!.id, worker!.id],
        fatiguePoints: 7,
      },
      {
        ...base,
        id: "h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        qualifiedStaffIds: [supervisor!.id],
        fatiguePoints: 6,
      },
      {
        ...base,
        id: "h07",
        flightNo: "KE166",
        name: "H07",
        category: "常规",
        qualifiedStaffIds: [worker!.id],
        fatiguePoints: 2,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const supervisorAssignment = result.assignments.find(
      (item) => item.positionRuleId === "supervisor"
    )!;
    const h05 = result.assignments.find(
      (item) => item.positionRuleId === "h05"
    )!;
    const h06 = result.assignments.find(
      (item) => item.positionRuleId === "h06"
    )!;
    const h07 = result.assignments.find(
      (item) => item.positionRuleId === "h07"
    )!;

    expect(supervisorAssignment).toMatchObject({
      staffId: supervisor!.id,
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(h05).toMatchObject({
      staffId: worker!.id,
      workHours: 2,
      fatiguePoints: 7,
    });
    expect(h06).toMatchObject({
      staffId: supervisor!.id,
      workHours: 0,
      fatiguePoints: 6,
      supervisorSourceAssignmentId: supervisorAssignment.id,
    });
    expect(h07.staffId).toBeNull();
    expect(
      result.assignments
        .filter((item) => item.status === "assigned")
        .reduce((sum, item) => sum + item.workHours, 0)
    ).toBe(4);
  });

  it("does not let the duty-morning priority take KE166's only mobile supervisor away", async () => {
    const state = createOrdinarySchedulingState();
    const [mobileSupervisor, dutyWorker, cxWorker] = state.staff;
    state.staff = [mobileSupervisor!, dutyWorker!, cxWorker!];
    const date = "2026-07-18";
    state.dutyRosterOverrides = [
      {
        date,
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-counter",
        flightNo: "CX937",
        name: "G12",
        category: "常规",
        qualifiedStaffIds: [mobileSupervisor!.id, cxWorker!.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [mobileSupervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke-counter",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [mobileSupervisor!.id, dutyWorker!.id],
        fatiguePoints: 7,
      },
    ];

    const result = await generateSchedule(state, date);
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const keCounter = result.assignments.find(
      (item) => item.positionRuleId === "ke-counter"
    )!;
    const cxCounter = result.assignments.find(
      (item) => item.positionRuleId === "cx-counter"
    )!;

    expect(supervisor).toMatchObject({
      staffId: mobileSupervisor!.id,
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(keCounter).toMatchObject({
      staffId: dutyWorker!.id,
      workHours: 2,
      fatiguePoints: 7,
    });
    expect(keCounter.supervisorSourceAssignmentId).toBeUndefined();
    expect(cxCounter).toMatchObject({
      staffId: cxWorker!.id,
      status: "assigned",
    });
  });

  it("keeps the only KE166 supervisor ahead of an overlapping duty target", async () => {
    const state = createOrdinarySchedulingState();
    const [dutySupervisor, alternate] = state.staff;
    state.staff = [dutySupervisor!, alternate!].map((person) => ({
      ...person,
      status: "正常",
      nightShift: true,
    }));
    const date = "2026-07-18";
    state.dutyRosterOverrides = [
      {
        date,
        cxPreflightStaffId: null,
        dutyStaffId: dutySupervisor!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "21:00",
        endTime: "23:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "duty",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
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
        qualifiedStaffIds: [dutySupervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "duty-target",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [dutySupervisor!.id, alternate!.id],
        fatiguePoints: 10,
      },
    ];

    const assignments = (await generateSchedule(state, date)).assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "ke-supervisor")
        ?.staffId
    ).toBe(dutySupervisor!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "duty-target")?.staffId
    ).toBe(alternate!.id);
  });

  it("keeps KE166 supervisor synced when administrative support mode only replaces other counters", async () => {
    const state = createOrdinarySchedulingState();
    const supervisor = state.staff[0]!;
    const backup = state.staff[1]!;
    state.staff = [supervisor, backup];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.adminSupportEnabled = true;
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 200,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h04",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-h08-regular",
        flightNo: "KE166",
        name: "H08",
        category: "常规",
        qualifiedStaffIds: [backup.id],
        fatiguePoints: 2,
        minPassengers: 170,
      },
      {
        ...base,
        id: "ke166-h08-admin",
        flightNo: "KE166",
        name: "H08",
        category: "行政支援",
        qualifiedStaffIds: [],
        fatiguePoints: 2,
        minPassengers: 170,
      },
      {
        ...base,
        id: "ke166-h09-regular",
        flightNo: "KE166",
        name: "H09",
        category: "常规",
        qualifiedStaffIds: [backup.id],
        fatiguePoints: 2,
        minPassengers: 200,
      },
      {
        ...base,
        id: "ke166-h09-admin",
        flightNo: "KE166",
        name: "H09",
        category: "行政支援",
        qualifiedStaffIds: [],
        fatiguePoints: 2,
        minPassengers: 200,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const supervisorAssignment = result.assignments.find(
      (item) => item.positionRuleId === "ke166-supervisor"
    )!;
    const counterAssignment = result.assignments.find(
      (item) => item.positionRuleId === "ke166-h04"
    )!;

    expect(activeFlightPositions(state, state.flights[0]!)).toEqual([
      "督导",
      "H04",
      "H08",
      "H09",
    ]);
    expect(supervisorAssignment).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      workHours: 2,
      fatiguePoints: 4,
    });
    expect(counterAssignment).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      workHours: 0,
      fatiguePoints: 2,
      supervisorSourceAssignmentId: supervisorAssignment.id,
    });
  });

  it("reserves a KE166 regular position for a supervisor-qualified worker in administrative support mode", async () => {
    const state = createOrdinarySchedulingState();
    const supervisor = state.staff[0]!;
    const regular = state.staff[1]!;
    state.staff = [supervisor, regular];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.adminSupportEnabled = true;
    state.flights = [
      {
        id: "other",
        flightNo: "OTHER",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 200,
        positions: [],
        remark: "",
      },
    ];
    state.history = [
      {
        id: "regular-heavy-history",
        date: "2026-07-17",
        flightNo: "HISTORY",
        position: "P1",
        staffId: regular.id,
        staffName: regular.name,
        startTime: "08:00",
        endTime: "20:00",
        workHours: 12,
        fatiguePoints: 8,
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const bothStaffIds = [supervisor.id, regular.id];
    state.positionRules = [
      {
        ...base,
        id: "other-counter",
        flightNo: "OTHER",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: bothStaffIds,
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "ke166-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [supervisor.id],
        fatiguePoints: 4,
      },
      {
        ...base,
        id: "ke166-h04",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: bothStaffIds,
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke166-h08-regular",
        flightNo: "KE166",
        name: "H08",
        category: "常规",
        qualifiedStaffIds: bothStaffIds,
        fatiguePoints: 2,
        minPassengers: 170,
      },
      {
        ...base,
        id: "ke166-h08-admin",
        flightNo: "KE166",
        name: "H08",
        category: "行政支援",
        qualifiedStaffIds: [],
        fatiguePoints: 2,
        minPassengers: 170,
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const supervisorAssignment = result.assignments.find(
      (item) => item.positionRuleId === "ke166-supervisor"
    )!;
    const ke166Regular = result.assignments.find(
      (item) => item.positionRuleId === "ke166-h04"
    )!;
    const otherRegular = result.assignments.find(
      (item) => item.positionRuleId === "other-counter"
    )!;

    expect(supervisorAssignment).toMatchObject({
      staffId: supervisor.id,
      status: "assigned",
      fatiguePoints: 4,
    });
    expect(ke166Regular).toMatchObject({
      staffId: supervisor.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisorAssignment.id,
    });
    expect(otherRegular).toMatchObject({
      staffId: regular.id,
      status: "assigned",
      workHours: 2,
    });
  });

  it("does not copy one flight's configured guide positions into every other flight", async () => {
    const state = createOrdinarySchedulingState();
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.find(
        (item) => item.flightNo === "CX937" && item.position === "柜台引导1"
      )?.staffId
    ).toEqual(expect.any(String));
    expect(
      result.assignments.find(
        (item) => item.flightNo === "FD573" && item.position === "柜台引导1"
      )
    ).toBeUndefined();
    expect(
      result.assignments.find(
        (item) => item.flightNo === "TR121" && item.position === "收费/引导"
      )
    ).toBeDefined();
  });

  it("generates only configured positions and never adds generic support to afternoon flights", async () => {
    const state = createOrdinarySchedulingState();
    const flight = state.flights.find((item) => item.flightNo === "FD573")!;
    flight.positions.push("未配置岗位");
    state.flights = [flight];
    state.staff.forEach((person) => {
      person.status = "休假";
    });
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.some((item) => item.position === "未配置岗位")
    ).toBe(false);
    expect(
      result.assignments.some((item) => item.position === "临时支援")
    ).toBe(false);
    expect(
      result.assignments
        .filter((item) => !item.positionRuleId)
        .every((item) =>
          ["柜台引导1", "柜台引导2", "超规柜台", "超规行李引导"].includes(
            item.position
          )
        )
    ).toBe(true);
  });

  it("does not invent a generic support position for a short-staffed morning flight", async () => {
    const state = createOrdinarySchedulingState();
    const flight = state.flights.find((item) => item.flightNo === "FD573")!;
    flight.startTime = "08:00";
    flight.endTime = "10:00";
    state.flights = [flight];
    state.staff.forEach((person) => {
      person.status = "休假";
    });
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments.filter((item) => item.position === "临时支援")
    ).toHaveLength(0);
  });

  it("allows a guide to reuse its selected same-flight regular worker", async () => {
    const state = createOrdinarySchedulingState();
    state.flights = [state.flights[0]!];
    const result = await generateSchedule(state, "2026-07-18");
    const guide = result.assignments.find(
      (item) => item.position === "柜台引导1"
    )!;
    const source = result.assignments.find(
      (item) =>
        item.flightId === guide.flightId &&
        item.staffId === guide.staffId &&
        item.id !== guide.id
    )!;
    expect(guide.workHours).toBe(0);
    expect(
      state.positionRules.find((item) => item.id === source.positionRuleId)
        ?.category
    ).toBe("常规");
    state.assignments = result.assignments;
    guide.staffId = null;
    guide.staffName = "";
    guide.status = "unfilled";
    expect(
      canAssignStaff(state, guide.id, source.staffId!, source.id)
    ).toBeNull();
  });

  it("hides 一号 while preserving the rest of a configured position remark", () => {
    expect(visiblePositionRemark("一号申报")).toBe("申报");
    expect(visiblePositionRemark("一号")).toBe("");
  });

  it("prioritizes regular workers who do not yet have working hours", async () => {
    const state = createOrdinarySchedulingState();
    const workers = state.staff.slice(0, 3);
    state.staff = workers;
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "09:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "f2",
        flightNo: "F2",
        startTime: "09:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "f3",
        flightNo: "F3",
        startTime: "10:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = state.flights.map((flight, index) => ({
      ...base,
      id: `p${index + 1}`,
      flightNo: flight.flightNo,
      name: `P${index + 1}`,
      category: "常规",
      fatiguePoints: 0,
      remark: "",
      qualifiedStaffIds: workers.map((person) => person.id),
    }));
    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    expect(new Set(assignments.map((item) => item.staffId))).toEqual(
      new Set(workers.map((person) => person.id))
    );
  });

  it("keeps the schedule feasible when enough positions exist but one worker has no eligible choice", async () => {
    const state = createOrdinarySchedulingState();
    const [qualifiedWorker, unqualifiedWorker] = state.staff.slice(0, 2);
    state.staff = [qualifiedWorker!, unqualifiedWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "coverage-flight",
        flightNo: "COVERAGE100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = ["C01", "C02"].map((name, index) => ({
      ...base,
      id: `coverage-${index + 1}`,
      flightNo: "COVERAGE100",
      name,
      category: "常规" as const,
      remark: "",
      qualifiedStaffIds: [qualifiedWorker!.id],
      minPassengers: 0,
      fatiguePoints: 1,
    }));

    const result = await generateSchedule(state, "2026-07-18");

    expect(result.assignments).toHaveLength(2);
    expect(
      result.assignments.filter(
        (assignment) => assignment.status === "assigned"
      )
    ).toHaveLength(1);
    expect(
      result.assignments.some(
        (assignment) => assignment.staffId === unqualifiedWorker!.id
      )
    ).toBe(false);
  });

  it("gives every available regular worker actual hours in the configured default schedule", async () => {
    const state = createOrdinarySchedulingState();
    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    const workedIds = new Set(
      assignments
        .filter((item) => item.workHours > 0)
        .map((item) => item.staffId)
    );
    const requiredIds = state.staff
      .filter(
        (person) => person.staffType === "常规" && person.status === "正常"
      )
      .map((person) => person.id);
    expect(requiredIds.filter((staffId) => !workedIds.has(staffId))).toEqual(
      []
    );
  }, 30_000);

  it("reserves the duty-qualified person for the first counter on the latest flight", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
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
        flightNo: "LATE",
        startTime: "21:00",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      {
        ...base,
        id: "early-position",
        flightNo: "EARLY",
        name: "普通柜台",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "late-supervisor",
        flightNo: "LATE",
        name: "督导",
        remark: "",
        fatiguePoints: 4,
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "late-first",
        flightNo: "LATE",
        name: "H02",
        remark: "一号",
        fatiguePoints: 5,
        qualifiedStaffIds,
      },
    ];
    const dutyStaffId = getDutyRosterForDate(state, "2026-07-20").dutyStaffId;
    const assignments = (await generateSchedule(state, "2026-07-20"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "late-first")?.staffId
    ).toBe(dutyStaffId);
  });

  it("keeps the duty person off earlier high-load work so they cover the latest noted position", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
    const dutyStaffId = getDutyRosterForDate(state, "2026-07-20").dutyStaffId!;
    const other = state.staff.find((person) => person.id !== dutyStaffId)!;
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY",
        startTime: "17:00",
        endTime: "19:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "LATE",
        startTime: "21:00",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "early-control",
        flightNo: "EARLY",
        name: "G18",
        remark: "控制",
        fatiguePoints: 5,
        qualifiedStaffIds: [dutyStaffId, other.id],
      },
      {
        ...base,
        id: "late-first",
        flightNo: "LATE",
        name: "H02",
        remark: "一号",
        fatiguePoints: 5,
        qualifiedStaffIds: [dutyStaffId, other.id],
      },
    ];
    state.history = [
      {
        id: "other-history",
        date: "2026-07-18",
        flightNo: "EARLY",
        position: "G18",
        staffId: other.id,
        staffName: other.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 50,
        remark: "",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-20"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "early-control")
        ?.staffId
    ).toBe(other.id);
    expect(
      assignments.find((item) => item.positionRuleId === "late-first")?.staffId
    ).toBe(dutyStaffId);
  });

  it("falls back to a noted position on the second-latest flight when the latest has no eligible target", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
    const dutyStaffId = getDutyRosterForDate(state, "2026-07-20").dutyStaffId!;
    const other = state.staff.find((person) => person.id !== dutyStaffId)!;
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY",
        startTime: "17:00",
        endTime: "19:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "second-latest",
        flightNo: "SECOND",
        startTime: "20:00",
        endTime: "22:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "latest",
        flightNo: "LATEST",
        startTime: "22:30",
        endTime: "00:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "early-position",
        flightNo: "EARLY",
        name: "P1",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds: [dutyStaffId, other.id],
      },
      {
        ...base,
        id: "second-declare",
        flightNo: "SECOND",
        name: "G17",
        remark: "申报",
        fatiguePoints: 4,
        qualifiedStaffIds: [dutyStaffId, other.id],
      },
      {
        ...base,
        id: "latest-first",
        flightNo: "LATEST",
        name: "H02",
        remark: "一号",
        fatiguePoints: 5,
        qualifiedStaffIds: [other.id],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-20"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "second-declare")
        ?.staffId
    ).toBe(dutyStaffId);
    expect(
      assignments.find((item) => item.positionRuleId === "latest-first")
        ?.staffId
    ).toBe(other.id);
  });

  it("assigns the duty person to both a morning flight and the protected late position", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = state.staff.slice(0, 6);
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.staff[5]!.cxPreflightQualified = true;
    const dutyStaffId = getDutyRosterForDate(state, "2026-07-20").dutyStaffId!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.flights = [
      {
        id: "morning",
        flightNo: "MORNING",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "middle",
        flightNo: "MIDDLE",
        startTime: "15:00",
        endTime: "17:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "LATE",
        startTime: "21:00",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "morning-position",
        flightNo: "MORNING",
        name: "G12",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "middle-position",
        flightNo: "MIDDLE",
        name: "G13",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "late-first",
        flightNo: "LATE",
        name: "H02",
        remark: "一号",
        fatiguePoints: 5,
        qualifiedStaffIds,
      },
    ];

    const dutyAssignments = (
      await generateSchedule(state, "2026-07-20")
    ).assignments.filter((item) => item.staffId === dutyStaffId);
    expect(dutyAssignments.some((item) => item.flightNo === "MORNING")).toBe(
      true
    );
    expect(
      dutyAssignments.some((item) => item.positionRuleId === "late-first")
    ).toBe(true);
    expect(dutyAssignments.some((item) => item.flightNo === "MIDDLE")).toBe(
      false
    );
  });

  it("rests the duty person between the required morning and late targets when another worker can cover", async () => {
    const state = createOrdinarySchedulingState();
    const [duty, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [duty!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.flights = [
      {
        id: "morning",
        flightNo: "MORNING",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "middle",
        flightNo: "MIDDLE",
        startTime: "14:00",
        endTime: "16:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = [duty!.id, alternate!.id];
    state.positionRules = [
      {
        ...base,
        id: "morning-position",
        flightNo: "MORNING",
        name: "G12",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "middle-position",
        flightNo: "MIDDLE",
        name: "G01",
        category: "常规",
        qualifiedStaffIds,
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "late-position",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
        fatiguePoints: 8,
      },
    ];
    state.settings.dutyPositionPriorities = [
      {
        id: "late-target",
        enabled: true,
        flightNo: "TR121",
        positionKeyword: "H02",
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-07-20",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [null, null],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-20"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "morning-position")
        ?.staffId
    ).toBe(duty!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "late-position")
        ?.staffId
    ).toBe(duty!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "middle-position")
        ?.staffId
    ).toBe(alternate!.id);
  });

  it("keeps the duty person off a CX priority position before comparing middle-flight fatigue", async () => {
    const state = createOrdinarySchedulingState();
    const [duty, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [duty!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    state.flights = [
      {
        id: "morning",
        flightNo: "MORNING",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "middle-cx",
        flightNo: "CX931",
        startTime: "14:00",
        endTime: "16:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = [duty!.id, alternate!.id];
    state.positionRules = [
      {
        ...base,
        id: "morning-position",
        flightNo: "MORNING",
        name: "G12",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "cx-priority-position",
        flightNo: "CX931",
        name: "G20",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "cx-ordinary-position",
        flightNo: "CX931",
        name: "G14",
        remark: "",
        category: "常规",
        qualifiedStaffIds,
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "late-position",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
        fatiguePoints: 8,
      },
    ];
    state.settings.dutyPositionPriorities = [
      {
        id: "late-target",
        enabled: true,
        flightNo: "TR121",
        positionKeyword: "H02",
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-26",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = ["2026-08-22", "2026-08-24"].map((date, index) => ({
      id: `cx931-g20-${index}`,
      date,
      flightNo: "CX931",
      position: "G20",
      staffId: alternate!.id,
      staffName: alternate!.name,
      startTime: "17:50",
      endTime: "19:50",
      workHours: 2,
      fatiguePoints: 1,
      remark: "一号",
    }));

    const result = await generateSchedule(state, "2026-08-26");

    expect(result.unfilledCount).toBe(0);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "cx-priority-position"
      )?.staffId
    ).toBe(alternate!.id);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "cx-ordinary-position"
      )?.staffId
    ).toBe(duty!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "late-position")
        ?.staffId
    ).toBe(duty!.id);
  });

  it("allows the duty morning assignment to use a flight starting after 08:30 and before noon", async () => {
    const state = createOrdinarySchedulingState();
    const [dutyWorker, otherWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [dutyWorker!, otherWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = true;
      person.cxPreflightQualified = false;
    });
    state.history = [];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-11",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
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
        id: "late",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      {
        ...base,
        id: "cx-counter",
        flightNo: "CX937",
        name: "G17",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "ke-counter",
        flightNo: "KE166",
        name: "H04",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "late-counter",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
      },
    ];

    const assignments = (await generateSchedule(state, "2026-08-11"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "ke-counter")?.staffId
    ).toBe(dutyWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "cx-counter")?.staffId
    ).toBe(otherWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "late-counter")
        ?.staffId
    ).toBe(dutyWorker!.id);
  });

  it("moves the duty worker between morning flights to prevent a repeated priority position", async () => {
    const state = createOrdinarySchedulingState();
    const [dutyWorker, otherWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [dutyWorker!, otherWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = true;
      person.cxPreflightQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.dutyRosterOverrides = [
      {
        date: "2026-08-11",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
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
        id: "late",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      {
        ...base,
        id: "cx-counter",
        flightNo: "CX937",
        name: "G17",
        remark: "",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "ke-counter",
        flightNo: "KE166",
        name: "H04",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "late-counter",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
      },
    ];
    state.history = [
      {
        id: "previous-ke-counter",
        date: "2026-08-09",
        flightNo: "KE166",
        position: "H04",
        staffId: dutyWorker!.id,
        staffName: dutyWorker!.name,
        startTime: "09:15",
        endTime: "11:15",
        workHours: 2,
        fatiguePoints: 6,
        remark: "申报",
      },
    ];

    const result = await generateSchedule(state, "2026-08-11");

    expect(
      result.assignments.find((item) => item.positionRuleId === "ke-counter")
        ?.staffId
    ).toBe(otherWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "cx-counter")
        ?.staffId
    ).toBe(dutyWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "late-counter")
        ?.staffId
    ).toBe(dutyWorker!.id);
    expect(result.warnings.join("\n")).not.toContain("重点岗位连续轮岗未落实");
  });

  it("allows the duty person to fill a qualified middle position after both duty targets are locked", async () => {
    const state = createOrdinarySchedulingState();
    const dutyWorker = state.staff.find((person) => person.status === "正常")!;
    state.staff = [dutyWorker];
    dutyWorker.dutyQualified = true;
    state.settings.maxDailyHours = 12;
    state.dutyRosterOverrides = [
      {
        date: "2026-07-29",
        cxPreflightStaffId: null,
        dutyStaffId: dutyWorker.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "morning",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "middle",
        flightNo: "FD573",
        startTime: "15:25",
        endTime: "17:25",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "TR121",
        startTime: "21:55",
        endTime: "23:55",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "morning-position",
        flightNo: "CX937",
        name: "G17",
        remark: "",
        category: "常规",
        qualifiedStaffIds: [dutyWorker.id],
      },
      {
        ...base,
        id: "middle-position",
        flightNo: "FD573",
        name: "G10",
        remark: "",
        category: "常规",
        qualifiedStaffIds: [dutyWorker.id],
      },
      {
        ...base,
        id: "late-position",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [dutyWorker.id],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-29"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "morning-position")
        ?.staffId
    ).toBe(dutyWorker.id);
    expect(
      assignments.find((item) => item.positionRuleId === "late-position")
        ?.staffId
    ).toBe(dutyWorker.id);
    expect(
      assignments.find((item) => item.positionRuleId === "middle-position")
    ).toMatchObject({
      staffId: dutyWorker.id,
      status: "assigned",
    });
  });

  it("keeps every feasible position filled even when fatigue balance cannot meet both targets", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.minimumRegularTransitionMinutes = 0;
    state.staff = state.staff.slice(0, 2);
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.workloadBalanceEnabled = true;
    state.settings.maxWorkHoursDifference = 2;
    state.settings.maxTodayFatigueDifference = 4;
    state.flights = [
      {
        id: "long",
        flightNo: "LONG",
        startTime: "08:00",
        endTime: "14:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `short-${index}`,
        flightNo: `SHORT${index}`,
        startTime: `${14 + index}:00`,
        endTime: `${15 + index}:00`,
        bookedPassengers: 100,
        positions: [],
        remark: "",
      })),
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = state.flights.map((flight, index) => ({
      ...base,
      id: `balance-${index}`,
      flightNo: flight.flightNo,
      name: `P${index}`,
      category: "常规",
      remark: "",
      fatiguePoints: index === 0 ? 0 : 1,
      qualifiedStaffIds,
    }));

    const assignments = (await generateSchedule(state, "2026-07-20"))
      .assignments;
    const loads = state.staff.map((person) => ({
      hours: assignments
        .filter((item) => item.staffId === person.id)
        .reduce((sum, item) => sum + item.workHours, 0),
      fatigue: assignments
        .filter((item) => item.staffId === person.id)
        .reduce((sum, item) => sum + item.fatiguePoints, 0),
    }));
    expect(assignments.every((item) => item.status === "assigned")).toBe(true);
    const flightsByStaff = state.staff.map(
      (person) =>
        new Set(
          assignments
            .filter((item) => item.staffId === person.id)
            .map((item) => item.flightNo)
        ).size
    );
    expect(
      Math.max(...flightsByStaff) - Math.min(...flightsByStaff)
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...loads.map((item) => item.fatigue)) -
        Math.min(...loads.map((item) => item.fatigue))
    ).toBeLessThanOrEqual(5);
  });

  it("uses an archived day to rotate the lower-load worker into the next duty day", async () => {
    const state = createOrdinarySchedulingState();
    state.settings.dutyFatiguePoints = 0;
    state.staff = state.staff.filter((person) =>
      ["2", "3"].includes(person.id)
    );
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [state.flights[0]!];
    state.flights[0]!.positions = ["G12"];
    state.positionRules = state.positionRules.filter(
      (rule) => rule.flightNo === "CX937" && rule.name === "G12"
    );
    const firstDay = (await generateSchedule(state, "2026-07-18"))
      .assignments[0]!;
    expect(firstDay.staffId).toBe("2");
    state.history = [
      {
        id: "archived",
        date: "2026-07-18",
        flightNo: firstDay.flightNo,
        position: firstDay.position,
        staffId: firstDay.staffId!,
        staffName: firstDay.staffName,
        startTime: firstDay.startTime,
        endTime: firstDay.endTime,
        workHours: firstDay.workHours,
        fatiguePoints: firstDay.fatiguePoints,
        remark: "",
      },
    ];
    expect(
      (await generateSchedule(state, "2026-07-20")).assignments[0]!.staffId
    ).toBe("3");
  });

  it("allows an afternoon diversion when early release leaves the required transition gap", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = [state.staff.find((person) => person.id === "2")!];
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "15:00",
        endTime: "17:00",
        bookedPassengers: 0,
        positions: ["P1"],
        remark: "",
      },
      {
        id: "f2",
        flightNo: "F2",
        startTime: "17:30",
        endTime: "19:30",
        bookedPassengers: 0,
        positions: ["P2"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "P1",
        category: "分流",
        qualifiedStaffIds: ["2"],
        earlyReleaseMinutes: 60,
      },
      {
        ...base,
        id: "p2",
        flightNo: "F2",
        name: "P2",
        category: "常规",
        qualifiedStaffIds: ["2"],
        earlyReleaseMinutes: 0,
      },
    ];
    const result = await generateSchedule(state, "2026-07-18");
    expect(result.assignments.map((item) => item.staffId)).toEqual(["2", "2"]);
    expect(result.assignments[0]).toMatchObject({
      endTime: "17:00",
      workHours: 1,
    });
  });

  it("allows a valid afternoon diversion transfer without the regular 90-minute gap", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff.find((item) => item.id === "2")!;
    person.nightShift = true;
    state.staff = [person];
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["P1"],
        remark: "",
      },
      {
        id: "f2",
        flightNo: "F2",
        startTime: "22:10",
        endTime: "00:10",
        bookedPassengers: 0,
        positions: ["P2"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "P1",
        category: "分流",
        qualifiedStaffIds: [person.id],
        earlyReleaseMinutes: 60,
      },
      {
        ...base,
        id: "p2",
        flightNo: "F2",
        name: "P2",
        category: "常规",
        qualifiedStaffIds: [person.id],
        earlyReleaseMinutes: 0,
      },
    ];
    state.settings.minimumRegularTransitionMinutes = 90;

    const result = await generateSchedule(state, "2026-10-03");
    const assignments = result.assignments.filter(
      (assignment) => assignment.positionRuleId
    );

    expect(assignments.map((assignment) => assignment.staffId)).toEqual([
      person.id,
      person.id,
    ]);
    expect(assignments[0]!.endTime).toBe("22:10");
    expect(assignments[0]!.workHours).toBeCloseTo(65 / 60);
  });

  it("does not use diversion when another qualified worker can cover the next flight", async () => {
    const state = createOrdinarySchedulingState();
    const workers = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    workers.forEach((person) => {
      person.nightShift = true;
      person.dutyQualified = false;
    });
    state.staff = workers;
    state.flights = [
      {
        id: "ak-flight",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
      {
        id: "tw-flight",
        flightNo: "TW616",
        startTime: "22:10",
        endTime: "00:10",
        bookedPassengers: 0,
        positions: ["G14"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ak-g09",
        flightNo: "AK151",
        name: "G09",
        category: "分流",
        earlyReleaseMinutes: 60,
        qualifiedStaffIds: workers.map((person) => person.id),
      },
      {
        ...base,
        id: "tw-g14",
        flightNo: "TW616",
        name: "G14",
        category: "常规",
        earlyReleaseMinutes: 0,
        qualifiedStaffIds: workers.map((person) => person.id),
      },
    ];

    const result = await generateSchedule(state, "2026-10-03");
    const assignments = result.assignments.filter(
      (assignment) => assignment.positionRuleId
    );

    expect(assignments).toHaveLength(2);
    expect(assignments[0]!.staffId).not.toBe(assignments[1]!.staffId);
    expect(assignments[0]!.endTime).toBe("23:05");
    expect(assignments[0]!.workHours).toBe(2);
  });

  it("does not create a diversion transfer while finalizing a staffed KE166 supervisor", async () => {
    const state = createOrdinarySchedulingState();
    const workers = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    workers.forEach((person) => {
      person.nightShift = true;
      person.dutyQualified = false;
    });
    state.staff = workers;
    state.flights = [
      {
        id: "ak-flight",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
      {
        id: "ke-flight",
        flightNo: "KE166",
        startTime: "22:10",
        endTime: "00:10",
        bookedPassengers: 0,
        positions: ["督导"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ak-g09-ke-case",
        flightNo: "AK151",
        name: "G09",
        category: "分流",
        earlyReleaseMinutes: 60,
        qualifiedStaffIds: [workers[0]!.id],
      },
      {
        ...base,
        id: "ke-supervisor-diversion-case",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        earlyReleaseMinutes: 0,
        qualifiedStaffIds: workers.map((person) => person.id),
      },
    ];

    const result = await generateSchedule(state, "2026-10-03");
    const source = result.assignments.find(
      (assignment) => assignment.positionRuleId === "ak-g09-ke-case"
    )!;
    const supervisor = result.assignments.find(
      (assignment) =>
        assignment.positionRuleId === "ke-supervisor-diversion-case"
    )!;

    expect(supervisor.staffId).not.toBe(source.staffId);
    expect(source.endTime).toBe("23:05");
    expect(source.workHours).toBe(2);
  });

  it("does not apply diversion release to morning flights", async () => {
    const state = createOrdinarySchedulingState();
    state.staff = [state.staff.find((person) => person.id === "2")!];
    state.flights = [
      {
        id: "f1",
        flightNo: "F1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 0,
        positions: ["P1"],
        remark: "",
      },
      {
        id: "f2",
        flightNo: "F2",
        startTime: "09:30",
        endTime: "11:30",
        bookedPassengers: 0,
        positions: ["P2"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "p1",
        flightNo: "F1",
        name: "P1",
        category: "分流",
        qualifiedStaffIds: ["2"],
        earlyReleaseMinutes: 60,
      },
      {
        ...base,
        id: "p2",
        flightNo: "F2",
        name: "P2",
        category: "常规",
        qualifiedStaffIds: ["2"],
        earlyReleaseMinutes: 0,
      },
    ];
    const result = await generateSchedule(state, "2026-07-18");
    expect(
      result.assignments
        .filter((item) => item.positionRuleId)
        .map((item) => item.staffId)
    ).toEqual([null, "2"]);
    expect(
      result.assignments.find((item) => item.position === "临时支援")
    ).toBeUndefined();
    expect(result.assignments[0]!.endTime).toBe("10:00");
  });

  it("applies passenger thresholds before noon while preserving the morning manual override", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.flights = [
      {
        id: "morning",
        flightNo: "MORNING",
        startTime: "11:59",
        endTime: "13:00",
        bookedPassengers: 0,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "morning-manual-threshold",
        flightNo: "MORNING",
        name: "G01",
        category: "常规",
        manual: true,
        minPassengers: 300,
        qualifiedStaffIds: [person.id],
      },
    ];

    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]
    ).toMatchObject({
      positionRuleId: "morning-manual-threshold",
      status: "manual",
      staffId: null,
    });
    state.flights[0]!.bookedPassengers = 300;
    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]
    ).toMatchObject({
      positionRuleId: "morning-manual-threshold",
      status: "assigned",
      staffId: person.id,
    });
  });

  it("keeps the passenger threshold and manual behavior for flights starting at noon", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.flights = [
      {
        id: "noon",
        flightNo: "NOON",
        startTime: "12:00",
        endTime: "14:00",
        bookedPassengers: 0,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "noon-manual-threshold",
        flightNo: "NOON",
        name: "G01",
        category: "常规",
        manual: true,
        minPassengers: 300,
        qualifiedStaffIds: [person.id],
      },
    ];

    expect(
      (await generateSchedule(state, "2026-07-18")).assignments[0]
    ).toMatchObject({
      positionRuleId: "noon-manual-threshold",
      status: "manual",
      staffId: null,
    });
  });

  it("breaks a strict transition rule before noon and records the override", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.flights = [
      {
        id: "source",
        flightNo: "SOURCE",
        startTime: "06:00",
        endTime: "07:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "TARGET",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-position",
        flightNo: "SOURCE",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
      {
        ...base,
        id: "target-position",
        flightNo: "TARGET",
        name: "H01",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
    ];
    state.settings.positionTransitionPolicies = [
      {
        id: "strict-morning-transition",
        name: "早间严格衔接",
        enabled: true,
        sourceFlightNo: "SOURCE",
        sourcePositions: ["G01"],
        targetFlightNo: "TARGET",
        targetPosition: "H01",
        minimumGapMinutes: 180,
        mode: "forbid",
      },
    ];

    const target = (
      await generateSchedule(state, "2026-07-18")
    ).assignments.find((item) => item.positionRuleId === "target-position")!;
    expect(target).toMatchObject({ status: "assigned", staffId: person.id });
    expect(target.systemNotes).toContain("已突破严格限制仍安排：早间严格衔接");
  });

  it("reallocates an overlapping worker between pre-noon flights and marks the source vacancy", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.flights = [
      {
        id: "source",
        flightNo: "SOURCE",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "TARGET",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-position",
        flightNo: "SOURCE",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
      {
        ...base,
        id: "target-position",
        flightNo: "TARGET",
        name: "H01",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
    ];

    const result = await generateSchedule(state, "2026-07-18");
    const source = result.assignments.find(
      (item) => item.positionRuleId === "source-position"
    )!;
    const target = result.assignments.find(
      (item) => item.positionRuleId === "target-position"
    )!;
    expect(target).toMatchObject({ status: "assigned", staffId: person.id });
    expect(source).toMatchObject({ status: "unfilled", staffId: null });
    expect(source.systemNotes).toContain("因抽调至 TARGET/H01 而空缺");
  });

  it("records a concrete staffing-shortage reason for an unfilled regular position before noon", async () => {
    const state = createOrdinarySchedulingState();
    const person = state.staff[0]!;
    person.dutyQualified = false;
    state.staff = [person];
    state.flights = [
      {
        id: "morning",
        flightNo: "MORNING",
        startTime: "09:00",
        endTime: "11:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "first",
        flightNo: "MORNING",
        name: "G01",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
      {
        ...base,
        id: "second",
        flightNo: "MORNING",
        name: "G02",
        category: "常规",
        qualifiedStaffIds: [person.id],
      },
    ];

    const unfilled = (
      await generateSchedule(state, "2026-07-18")
    ).assignments.find((item) => item.status === "unfilled")!;
    expect(unfilled.systemNotes?.join("；")).toContain(
      "因合格人数不足而无法填满"
    );
    expect(unfilled.systemNotes?.join("；")).toContain("时段冲突");
  });

  it("assigns the duty worker by the editable flight and position priority order", async () => {
    const state = createOrdinarySchedulingState();
    const [duty, other] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [duty!, other!];
    state.flights = [
      {
        id: "tw",
        flightNo: "TW616",
        startTime: "19:00",
        endTime: "21:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "tr",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "tw-one",
        flightNo: "TW616",
        name: "G01",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [duty!.id, other!.id],
      },
      {
        ...base,
        id: "tr-one",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [duty!.id, other!.id],
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-07-18",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [null, null],
      },
    ];

    let assignments = (await generateSchedule(state, "2026-07-18")).assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "tr-one")?.staffId
    ).toBe(duty!.id);

    state.settings.dutyPositionPriorities.reverse();
    assignments = (await generateSchedule(state, "2026-07-18")).assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "tw-one")?.staffId
    ).toBe(duty!.id);
  });

  it("keeps the configured duty lock ahead of a strict transition preference", async () => {
    const state = createOrdinarySchedulingState();
    const [duty, other, third] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [duty!, other!, third!];
    state.flights = [
      {
        id: "morning",
        flightNo: "MORNING",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "tw",
        flightNo: "TW616",
        startTime: "19:00",
        endTime: "21:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "tr",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const qualifiedStaffIds = state.staff.map((person) => person.id);
    state.positionRules = [
      {
        ...base,
        id: "morning-source",
        flightNo: "MORNING",
        name: "G01",
        remark: "",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "tw-one",
        flightNo: "TW616",
        name: "G01",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
      },
      {
        ...base,
        id: "tr-one",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds,
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-07-18",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [other!.id, third!.id],
      },
    ];
    state.settings.positionTransitionPolicies = [
      {
        id: "block-tr",
        name: "值班人员不能接TR",
        enabled: true,
        sourceFlightNo: "MORNING",
        sourcePositions: ["G01"],
        targetFlightNo: "TR121",
        targetPosition: "H02",
        minimumGapMinutes: 1440,
        mode: "forbid",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-07-18"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "morning-source")
        ?.staffId
    ).toBe(duty!.id);
    const target = assignments.find(
      (item) => item.positionRuleId === "tr-one"
    )!;
    expect(target.staffId).toBe(duty!.id);
    expect(target.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "duty-position",
          outcome: "selected",
        }),
        expect.objectContaining({
          ruleId: "position-transition",
          outcome: "fallback",
        }),
      ])
    );
    expect(
      assignments.find((item) => item.positionRuleId === "tw-one")?.staffId
    ).not.toBe(duty!.id);
  });

  it("uses the next configured duty target while the first H02 target is cooling down", async () => {
    const state = createOrdinarySchedulingState();
    const [duty, other] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [duty!, other!];
    state.flights = [
      {
        id: "tr",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "tw",
        flightNo: "TW616",
        startTime: "21:45",
        endTime: "23:45",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "tr-h02",
        flightNo: "TR121",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [duty!.id, other!.id],
      },
      {
        ...base,
        id: "tw-one",
        flightNo: "TW616",
        name: "G20",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [duty!.id, other!.id],
      },
    ];
    state.settings.dutyPositionPriorities = [
      {
        id: "tr-first",
        enabled: true,
        flightNo: "TR121",
        positionKeyword: "H02",
      },
      {
        id: "tw-second",
        enabled: true,
        flightNo: "TW616",
        positionKeyword: "一号",
      },
    ];
    state.dutyRosterOverrides = [
      {
        date: "2026-07-20",
        cxPreflightStaffId: null,
        dutyStaffId: duty!.id,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = [
      {
        id: "repeat",
        date: "2026-07-18",
        flightNo: "TR121",
        position: "H02",
        staffId: duty!.id,
        staffName: duty!.name,
        startTime: "21:30",
        endTime: "23:30",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];
    const assignments = (await generateSchedule(state, "2026-07-20"))
      .assignments;

    expect(
      assignments.find((assignment) => assignment.positionRuleId === "tr-h02")
    ).toMatchObject({ staffId: other!.id, position: "H02" });
    expect(
      assignments.find((assignment) => assignment.positionRuleId === "tw-one")
    ).toMatchObject({ staffId: duty!.id, position: "G20" });
  });

  it("keeps KE166 ordinary positions available while selecting the lower-frequency priority-position worker", async () => {
    const state = createOrdinarySchedulingState();
    const [alternate, frequent] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [alternate!, frequent!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "cx937",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke-g18",
        flightNo: "KE166",
        name: "G18",
        category: "常规",
        fatiguePoints: 1,
        qualifiedStaffIds: [alternate!.id, frequent!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        fatiguePoints: 1,
        remark: "一号",
        qualifiedStaffIds: [alternate!.id, frequent!.id],
      },
    ];
    state.settings.historyWindowDays = 1;
    state.history = ["2026-10-02", "2026-10-04", "2026-10-06", "2026-10-08"]
      .map((date, index) => ({
        id: `frequent-g20-${index}`,
        date,
        flightNo: "CX937",
        position: "G20",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 1,
        remark: "一号",
      }))
      .concat([
        {
          id: "other-1",
          date: "2026-10-10",
          flightNo: "MU100",
          position: "G18",
          staffId: alternate!.id,
          staffName: alternate!.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "other-2",
          date: "2026-10-12",
          flightNo: "MU200",
          position: "G18",
          staffId: alternate!.id,
          staffName: alternate!.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "other-frequent",
          date: "2026-10-12",
          flightNo: "MU300",
          position: "G17",
          staffId: frequent!.id,
          staffName: frequent!.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
      ]);

    const assignments = (await generateSchedule(state, "2026-10-14"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "ke-g18")?.staffId
    ).toBe(frequent!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")
        ?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency",
          outcome: "selected",
        }),
      ])
    );
    state.assignments = assignments;
    expect(
      buildScheduleFeedback(state, "2026-10-14").find(
        (item) => item.key === "position-frequency-review"
      )
    ).toMatchObject({
      status: "已执行",
    });
  });

  it("continues to every overlapping flight when KE166 cannot form a safe high-frequency exchange", async () => {
    const state = createOrdinarySchedulingState();
    const [keWorker, alternate, frequent] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [keWorker!, alternate!, frequent!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "mu100",
        flightNo: "MU100",
        startTime: "08:10",
        endTime: "10:10",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "cx937",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "ke-g18",
        flightNo: "KE166",
        name: "G18",
        category: "常规",
        fatiguePoints: 1,
        qualifiedStaffIds: [keWorker!.id],
      },
      {
        ...base,
        id: "mu-h02",
        flightNo: "MU100",
        name: "H02",
        category: "常规",
        fatiguePoints: 1,
        qualifiedStaffIds: [alternate!.id, frequent!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        fatiguePoints: 1,
        remark: "一号",
        qualifiedStaffIds: [keWorker!.id, alternate!.id, frequent!.id],
      },
    ];
    state.settings.historyWindowDays = 1;
    state.history = ["2026-10-02", "2026-10-04", "2026-10-06", "2026-10-08"]
      .map((date, index) => ({
        id: `frequent-g20-${index}`,
        date,
        flightNo: "CX937",
        position: "G20",
        staffId: frequent!.id,
        staffName: frequent!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      }))
      .concat([
        {
          id: "other-1",
          date: "2026-10-10",
          flightNo: "MU100",
          position: "H02",
          staffId: alternate!.id,
          staffName: alternate!.name,
          startTime: "08:10",
          endTime: "10:10",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
        {
          id: "other-2",
          date: "2026-10-12",
          flightNo: "MU200",
          position: "H02",
          staffId: alternate!.id,
          staffName: alternate!.name,
          startTime: "08:10",
          endTime: "10:10",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        },
      ]);

    const assignments = (await generateSchedule(state, "2026-10-14"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "ke-g18")?.staffId
    ).toBe(keWorker!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "mu-h02")?.staffId
    ).toBe(frequent!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")?.staffId
    ).toBe(alternate!.id);
  });

  it("uses generation-stage frequency before consecutive priority-position protection", async () => {
    const state = createOrdinarySchedulingState();
    const [alternate, repeated] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [alternate!, repeated!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "g18",
        flightNo: "MU100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "g16",
        flightNo: "MU200",
        startTime: "08:15",
        endTime: "10:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "g20",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g18",
        flightNo: "CX937",
        name: "G18",
        category: "常规",
        qualifiedStaffIds: [alternate!.id, repeated!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [alternate!.id, repeated!.id],
      },
    ];
    state.history = [
      {
        id: "previous-g20",
        date: "2026-10-22",
        flightNo: "CX937",
        position: "G20",
        staffId: repeated!.id,
        staffName: repeated!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 1,
        remark: "一号",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;
    expect(assignments.find((item) => item.position === "G20")?.staffId).toBe(
      alternate!.id
    );
    expect(assignments.find((item) => item.position === "G18")?.staffId).toBe(
      repeated!.id
    );
    expect(
      assignments.find((item) => item.position === "G20")?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency",
          outcome: "selected",
        }),
      ])
    );
  });

  it("globally resolves a repeated high-fatigue position before post-schedule rotation", async () => {
    const state = createOrdinarySchedulingState();
    const [first, second, third] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    const repeated = third!;
    const nextForRepeated = second!;
    const nextForSecond = first!;
    state.staff = [nextForRepeated, repeated, nextForSecond];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "g18",
        flightNo: "MU100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "g16",
        flightNo: "MU200",
        startTime: "08:15",
        endTime: "10:15",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "g20",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g18",
        flightNo: "MU100",
        name: "G18",
        category: "常规",
        qualifiedStaffIds: [nextForRepeated.id, nextForSecond.id],
      },
      {
        ...base,
        id: "cx-g16",
        flightNo: "MU200",
        name: "G16",
        category: "常规",
        qualifiedStaffIds: [repeated.id, nextForSecond.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        qualifiedStaffIds: [repeated.id, nextForRepeated.id],
      },
    ];
    state.settings.ordinaryPriorityPositions =
      state.settings.ordinaryPriorityPositions.filter(
        (item) => !(item.airlineCode === "CX" && item.position === "G20")
      );
    state.history = ["2026-10-20", "2026-10-22"]
      .map((date, index) => ({
        id: `repeated-g20-${index}`,
        date,
        flightNo: "CX937",
        position: "G20",
        staffId: repeated.id,
        staffName: repeated.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      }))
      .concat(
        ["2026-10-02", "2026-10-04"].map((date, index) => ({
          id: `older-g18-${index}`,
          date,
          flightNo: "MU100",
          position: "G18",
          staffId: nextForSecond.id,
          staffName: nextForSecond.name,
          startTime: "08:00",
          endTime: "10:00",
          workHours: 2,
          fatiguePoints: 1,
          remark: "",
        }))
      );

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;
    expect(assignments.find((item) => item.position === "G20")?.staffId).toBe(
      nextForRepeated.id
    );
    expect(assignments.find((item) => item.position === "G18")?.staffId).toBe(
      nextForSecond.id
    );
    expect(assignments.find((item) => item.position === "G16")?.staffId).toBe(
      repeated.id
    );
    expect(
      assignments.find((item) => item.position === "G20")?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "high-fatigue-position-consecutive",
          outcome: "selected",
        }),
      ])
    );
  });

  it("globally resolves a repeated priority position across overlapping flights", async () => {
    const state = createOrdinarySchedulingState();
    const [targetCandidate, repeatedWorker, relayWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    state.staff = [targetCandidate!, repeatedWorker!, relayWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "source",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-priority",
        flightNo: "CX937",
        name: "G17",
        remark: "申报",
        fatiguePoints: 2,
        category: "常规",
        qualifiedStaffIds: [targetCandidate!.id, relayWorker!.id],
      },
      {
        ...base,
        id: "target-h02",
        flightNo: "KE166",
        name: "H02",
        remark: "一号",
        fatiguePoints: 6,
        category: "常规",
        qualifiedStaffIds: [repeatedWorker!.id, targetCandidate!.id],
      },
      {
        ...base,
        id: "relay-regular",
        flightNo: "KE166",
        name: "H04",
        remark: "",
        fatiguePoints: 1,
        category: "常规",
        qualifiedStaffIds: [repeatedWorker!.id, relayWorker!.id],
      },
    ];
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "CX", position: "G17" },
      { airlineCode: "KE", position: "H02" },
    ];
    state.history = [
      {
        id: "previous-h02",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "H02",
        staffId: repeatedWorker!.id,
        staffName: repeatedWorker!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 6,
        remark: "一号",
      },
      {
        id: "older-source",
        date: "2026-10-10",
        flightNo: "CX937",
        position: "G17",
        staffId: relayWorker!.id,
        staffName: relayWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "申报",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");

    expect(
      result.assignments.find((item) => item.positionRuleId === "target-h02")
        ?.staffId
    ).toBe(targetCandidate!.id);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "source-priority"
      )?.staffId
    ).toBe(relayWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "relay-regular")
        ?.staffId
    ).toBe(repeatedWorker!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "target-h02")
        ?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency",
          outcome: "selected",
        }),
      ])
    );
  });

  it("rotates KE166 counters before binding the mobile supervisor", async () => {
    const state = createOrdinarySchedulingState();
    const [targetCandidate, repeatedWorker, relayWorker, supervisorCandidate] =
      state.staff.filter((person) => person.status === "正常").slice(0, 4);
    state.staff = [
      targetCandidate!,
      repeatedWorker!,
      relayWorker!,
      supervisorCandidate!,
    ];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g17",
        flightNo: "CX937",
        name: "G17",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: [targetCandidate!.id, relayWorker!.id],
      },
      {
        ...base,
        id: "ke-supervisor",
        flightNo: "KE166",
        name: "督导",
        remark: "",
        fatiguePoints: 5,
        category: "机动督导",
        qualifiedStaffIds: [relayWorker!.id, supervisorCandidate!.id],
      },
      {
        ...base,
        id: "ke-h02",
        flightNo: "KE166",
        name: "H02",
        remark: "一号",
        fatiguePoints: 6,
        category: "常规",
        qualifiedStaffIds: [repeatedWorker!.id, targetCandidate!.id],
      },
      {
        ...base,
        id: "ke-h04",
        flightNo: "KE166",
        name: "H04",
        remark: "",
        fatiguePoints: 2,
        category: "常规",
        qualifiedStaffIds: [repeatedWorker!.id, relayWorker!.id],
      },
      {
        ...base,
        id: "ke-h06",
        flightNo: "KE166",
        name: "H06",
        remark: "",
        fatiguePoints: 1,
        category: "常规",
        qualifiedStaffIds: [
          repeatedWorker!.id,
          relayWorker!.id,
          supervisorCandidate!.id,
        ],
      },
    ];
    state.history = [
      {
        id: "previous-ke-h02",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "H02",
        staffId: repeatedWorker!.id,
        staffName: repeatedWorker!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 6,
        remark: "一号",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const h02 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h02"
    )!;
    const h04 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h04"
    )!;
    const h06 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h06"
    )!;
    const g17 = result.assignments.find(
      (item) => item.positionRuleId === "cx-g17"
    )!;

    expect(h02.staffId).toBe(targetCandidate!.id);
    expect(g17.staffId).toBe(relayWorker!.id);
    expect(h04.staffId).toBe(repeatedWorker!.id);
    expect(h06).toMatchObject({
      staffId: supervisorCandidate!.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisor.id,
    });
    expect(supervisor).toMatchObject({
      staffId: supervisorCandidate!.id,
      status: "assigned",
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(result.warnings.join("\n")).not.toContain("重点岗位连续轮岗未落实");
    expect(
      result.assignments
        .filter((item) => item.staffId === supervisorCandidate!.id)
        .reduce((sum, item) => sum + item.workHours, 0)
    ).toBe(2);
  });

  it("uses an idle qualified KE166 supervisor independently before any counter coverage", async () => {
    const state = createOrdinarySchedulingState();
    const [
      repeatedH02,
      h02Replacement,
      counterSupervisor,
      independentSupervisor,
    ] = state.staff.filter((person) => person.status === "正常").slice(0, 4);
    state.staff = [
      repeatedH02!,
      h02Replacement!,
      counterSupervisor!,
      independentSupervisor!,
    ];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    independentSupervisor!.teamLeader = true;
    state.flights = [
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
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
        qualifiedStaffIds: [counterSupervisor!.id, independentSupervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke-h02",
        flightNo: "KE166",
        name: "H02",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [repeatedH02!.id, h02Replacement!.id],
        fatiguePoints: 6,
      },
      {
        ...base,
        id: "ke-h03",
        flightNo: "KE166",
        name: "H03",
        category: "常规",
        qualifiedStaffIds: [repeatedH02!.id],
        fatiguePoints: 3,
      },
      {
        ...base,
        id: "ke-h04",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [counterSupervisor!.id],
        fatiguePoints: 2,
      },
    ];
    state.history = [
      {
        id: "previous-h02",
        date: "2026-10-03",
        flightNo: "KE166",
        position: "H02",
        staffId: repeatedH02!.id,
        staffName: repeatedH02!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 6,
        remark: "一号",
      },
      {
        id: "previous-supervisor",
        date: "2026-10-03",
        flightNo: "KE166",
        position: "督导",
        staffId: counterSupervisor!.id,
        staffName: counterSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, "2026-10-05");
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const h02 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h02"
    )!;
    const h03 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h03"
    )!;
    const h04 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h04"
    )!;

    expect(supervisor).toMatchObject({
      staffId: independentSupervisor!.id,
      status: "assigned",
      workHours: 2,
      fatiguePoints: 5,
    });
    expect(h02).toMatchObject({ staffId: h02Replacement!.id, workHours: 2 });
    expect(h03).toMatchObject({ staffId: repeatedH02!.id, workHours: 2 });
    expect(h04).toMatchObject({ staffId: counterSupervisor!.id, workHours: 2 });
    expect(
      result.assignments.some(
        (item) => item.supervisorSourceAssignmentId === supervisor.id
      )
    ).toBe(false);
    expect(result.warnings.join("\n")).not.toContain("连续轮岗未落实");
  });

  it("chooses a non-repeated KE166 mobile supervisor after keeping final counter staff in place", async () => {
    const state = createOrdinarySchedulingState();
    const [previousSupervisor, alternateSupervisor] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [previousSupervisor!, alternateSupervisor!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    const both = [previousSupervisor!.id, alternateSupervisor!.id];
    state.positionRules = [
      {
        ...base,
        id: "ke-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: both,
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke-h05",
        flightNo: "KE166",
        name: "H05",
        category: "常规",
        qualifiedStaffIds: both,
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "ke-h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        qualifiedStaffIds: both,
        fatiguePoints: 2,
      },
    ];
    state.history = [
      {
        id: "previous-ke-supervisor",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "督导",
        staffId: previousSupervisor!.id,
        staffName: previousSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
      {
        id: "balanced-other-supervisor",
        date: "2026-10-22",
        flightNo: "OTHER",
        position: "督导",
        staffId: alternateSupervisor!.id,
        staffName: alternateSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const h05 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h05"
    )!;
    const h06 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h06"
    )!;

    expect(supervisor.staffId).toBe(alternateSupervisor!.id);
    const counters = [h05, h06];
    expect(new Set(counters.map((assignment) => assignment.staffId))).toEqual(
      new Set([previousSupervisor!.id, alternateSupervisor!.id])
    );
    expect(
      counters.find(
        (assignment) => assignment.staffId === previousSupervisor!.id
      )
    ).toMatchObject({ workHours: 2 });
    expect(
      counters.find(
        (assignment) => assignment.staffId === alternateSupervisor!.id
      )
    ).toMatchObject({
      workHours: 0,
      supervisorSourceAssignmentId: supervisor.id,
    });
  });

  it("lets a repeated free team leader rest when a KE166 counter can safely cover supervision", async () => {
    const state = createOrdinarySchedulingState();
    const [repeatedSupervisor, counterSupervisor] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [repeatedSupervisor!, counterSupervisor!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    repeatedSupervisor!.teamLeader = true;
    counterSupervisor!.teamLeader = false;
    state.flights = [
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
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
        qualifiedStaffIds: [repeatedSupervisor!.id, counterSupervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke-h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        qualifiedStaffIds: [counterSupervisor!.id],
        fatiguePoints: 2,
      },
    ];
    state.history = [
      {
        id: "previous-ke-supervisor",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "督导",
        staffId: repeatedSupervisor!.id,
        staffName: repeatedSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const h06 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h06"
    )!;
    expect(supervisor.staffId).toBe(counterSupervisor!.id);
    expect(h06).toMatchObject({
      staffId: counterSupervisor!.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisor.id,
    });
    expect(
      result.assignments.some(
        (assignment) => assignment.staffId === repeatedSupervisor!.id
      )
    ).toBe(false);
    expect(result.warnings.join("\n")).not.toContain(
      "KE166机动督导连续轮岗未落实"
    );
  });

  it("releases a non-repeated KE166 supervisor from an overlapping flight before retaining a repeated independent supervisor", async () => {
    const state = createOrdinarySchedulingState();
    const [repeatedSupervisor, overlappingSupervisor, counterWorker] =
      state.staff.filter((person) => person.status === "正常").slice(0, 3);
    state.staff = [repeatedSupervisor!, overlappingSupervisor!, counterWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "overlap",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "later",
        flightNo: "LATER1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "overlap-position",
        flightNo: "CX937",
        name: "G16",
        category: "常规",
        qualifiedStaffIds: [overlappingSupervisor!.id, counterWorker!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "ke-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [repeatedSupervisor!.id, overlappingSupervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke-h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        qualifiedStaffIds: [overlappingSupervisor!.id, counterWorker!.id],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "later-position",
        flightNo: "LATER1",
        name: "P01",
        category: "常规",
        qualifiedStaffIds: [repeatedSupervisor!.id],
        fatiguePoints: 1,
      },
    ];
    state.history = [
      {
        id: "previous-ke-supervisor",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "督导",
        staffId: repeatedSupervisor!.id,
        staffName: repeatedSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const h06 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h06"
    )!;
    const overlap = result.assignments.find(
      (item) => item.positionRuleId === "overlap-position"
    )!;

    expect(supervisor.staffId).toBe(overlappingSupervisor!.id);
    expect(h06).toMatchObject({
      staffId: overlappingSupervisor!.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisor.id,
    });
    expect(overlap.staffId).toBe(counterWorker!.id);
    expect(result.warnings.join("\n")).not.toContain(
      "KE166机动督导连续轮岗未落实"
    );
  });

  it("uses a multi-flight personnel chain to place a non-repeated KE166 counter supervisor", async () => {
    const state = createOrdinarySchedulingState();
    const [
      repeatedSupervisor,
      overlappingSupervisor,
      relayWorker,
      counterWorker,
    ] = state.staff.filter((person) => person.status === "正常").slice(0, 4);
    state.staff = [
      repeatedSupervisor!,
      overlappingSupervisor!,
      relayWorker!,
      counterWorker!,
    ];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "source-one",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "source-two",
        flightNo: "CX938",
        startTime: "08:05",
        endTime: "10:05",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "ke",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "later",
        flightNo: "LATER1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-one-position",
        flightNo: "CX937",
        name: "G16",
        category: "常规",
        qualifiedStaffIds: [overlappingSupervisor!.id, relayWorker!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "source-two-position",
        flightNo: "CX938",
        name: "G17",
        category: "常规",
        qualifiedStaffIds: [relayWorker!.id, counterWorker!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "ke-supervisor",
        flightNo: "KE166",
        name: "督导",
        category: "机动督导",
        qualifiedStaffIds: [repeatedSupervisor!.id, overlappingSupervisor!.id],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "ke-h06",
        flightNo: "KE166",
        name: "H06",
        category: "常规",
        qualifiedStaffIds: [
          overlappingSupervisor!.id,
          relayWorker!.id,
          counterWorker!.id,
        ],
        fatiguePoints: 2,
      },
      {
        ...base,
        id: "later-position",
        flightNo: "LATER1",
        name: "P01",
        category: "常规",
        qualifiedStaffIds: [repeatedSupervisor!.id],
        fatiguePoints: 1,
      },
    ];
    state.history = [
      {
        id: "previous-ke-supervisor",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "督导",
        staffId: repeatedSupervisor!.id,
        staffName: repeatedSupervisor!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
      {
        id: "previous-relay-load",
        date: "2026-10-22",
        flightNo: "OTHER1",
        position: "P01",
        staffId: relayWorker!.id,
        staffName: relayWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 10,
        remark: "",
      },
      {
        id: "previous-counter-load",
        date: "2026-10-22",
        flightNo: "OTHER2",
        position: "P02",
        staffId: counterWorker!.id,
        staffName: counterWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 20,
        remark: "",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");
    const supervisor = result.assignments.find(
      (item) => item.positionRuleId === "ke-supervisor"
    )!;
    const h06 = result.assignments.find(
      (item) => item.positionRuleId === "ke-h06"
    )!;

    expect(supervisor.staffId).toBe(overlappingSupervisor!.id);
    expect(h06).toMatchObject({
      staffId: overlappingSupervisor!.id,
      workHours: 0,
      supervisorSourceAssignmentId: supervisor.id,
    });
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "source-one-position"
      )?.staffId
    ).toBe(relayWorker!.id);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "source-two-position"
      )?.staffId
    ).toBe(counterWorker!.id);
    expect(result.warnings.join("\n")).not.toContain(
      "KE166机动督导连续轮岗未落实"
    );
  });

  it("uses a four-person open reassignment chain when swaps and closed cycles cannot rotate a repeated priority position", async () => {
    const state = createOrdinarySchedulingState();
    const [
      repeatedWorker,
      firstMover,
      secondMover,
      endpointWorker,
      occupiedBlocker,
    ] = state.staff.filter((person) => person.status === "正常").slice(0, 5);
    state.staff = [
      repeatedWorker!,
      firstMover!,
      secondMover!,
      endpointWorker!,
      occupiedBlocker!,
    ];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "source-zero",
        flightNo: "S0",
        startTime: "07:30",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "source-one",
        flightNo: "S1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "source-two",
        flightNo: "S2",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "T1",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "later",
        flightNo: "L1",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-zero-position",
        flightNo: "S0",
        name: "P00",
        category: "常规",
        qualifiedStaffIds: [occupiedBlocker!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "source-one-position",
        flightNo: "S1",
        name: "P01",
        category: "常规",
        qualifiedStaffIds: [firstMover!.id, secondMover!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "source-two-position",
        flightNo: "S2",
        name: "P02",
        category: "常规",
        qualifiedStaffIds: [secondMover!.id, endpointWorker!.id],
        fatiguePoints: 1,
      },
      {
        ...base,
        id: "target-position",
        flightNo: "T1",
        name: "G20",
        remark: "控制",
        category: "常规",
        qualifiedStaffIds: [
          repeatedWorker!.id,
          firstMover!.id,
          occupiedBlocker!.id,
        ],
        fatiguePoints: 5,
      },
      {
        ...base,
        id: "later-position",
        flightNo: "L1",
        name: "P03",
        category: "常规",
        qualifiedStaffIds: [repeatedWorker!.id],
        fatiguePoints: 1,
      },
    ];
    state.history = [
      {
        id: "previous-target",
        date: "2026-10-22",
        flightNo: "T1",
        position: "G20",
        staffId: repeatedWorker!.id,
        staffName: repeatedWorker!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 5,
        remark: "控制",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");

    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "target-position"
      )?.staffId
    ).toBe(firstMover!.id);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "source-one-position"
      )?.staffId
    ).toBe(secondMover!.id);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "source-two-position"
      )?.staffId
    ).toBe(endpointWorker!.id);
    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "later-position"
      )?.staffId
    ).toBe(repeatedWorker!.id);
    expect(result.warnings.join("\n")).not.toContain("重点岗位连续轮岗未落实");
  });

  it("reports an unresolved second consecutive priority-position assignment", async () => {
    const state = createOrdinarySchedulingState();
    const [blockedWorker, occupiedCandidate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [occupiedCandidate!, blockedWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.flights = [
      {
        id: "source",
        flightNo: "CX937",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "KE166",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "source-only",
        flightNo: "CX937",
        name: "G17",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: [occupiedCandidate!.id],
      },
      {
        ...base,
        id: "target-h02",
        flightNo: "KE166",
        name: "H02",
        remark: "一号",
        fatiguePoints: 6,
        category: "常规",
        qualifiedStaffIds: [blockedWorker!.id, occupiedCandidate!.id],
      },
    ];
    state.history = [
      {
        id: "previous-h02",
        date: "2026-10-22",
        flightNo: "KE166",
        position: "H02",
        staffId: blockedWorker!.id,
        staffName: blockedWorker!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 6,
        remark: "一号",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");

    expect(
      result.assignments.find((item) => item.positionRuleId === "target-h02")
        ?.staffId
    ).toBe(blockedWorker!.id);
    expect(result.warnings.join("\n")).toContain(
      `${blockedWorker!.name} 已连续1次承担KE166/H02`
    );
  });

  it("prevents a second consecutive priority position before ordinary assignments consume a safe non-overlapping replacement", async () => {
    const state = createOrdinarySchedulingState();
    const [repeatedWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [repeatedWorker!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "early",
        flightNo: "EARLY1",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "target",
        flightNo: "CX931",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "LATE1",
        startTime: "18:00",
        endTime: "20:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "early-ordinary",
        flightNo: "EARLY1",
        name: "E01",
        category: "常规",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds: [alternate!.id],
      },
      {
        ...base,
        id: "target-control",
        flightNo: "CX931",
        name: "G18",
        category: "常规",
        remark: "控制",
        fatiguePoints: 6,
        qualifiedStaffIds: [repeatedWorker!.id, alternate!.id],
      },
      {
        ...base,
        id: "late-ordinary",
        flightNo: "LATE1",
        name: "L01",
        category: "常规",
        remark: "",
        fatiguePoints: 1,
        qualifiedStaffIds: [repeatedWorker!.id],
      },
    ];
    state.history = [
      {
        id: "previous-control",
        date: "2026-10-22",
        flightNo: "CX931",
        position: "G18",
        staffId: repeatedWorker!.id,
        staffName: repeatedWorker!.name,
        startTime: "13:00",
        endTime: "15:00",
        workHours: 2,
        fatiguePoints: 6,
        remark: "控制",
      },
    ];

    const result = await generateSchedule(state, "2026-10-24");

    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "target-control"
      )?.staffId
    ).toBe(alternate!.id);
    expect(
      result.assignments.find((item) => item.positionRuleId === "late-ordinary")
        ?.staffId
    ).toBe(repeatedWorker!.id);
    expect(result.warnings.join("\n")).not.toContain("重点岗位连续轮岗未落实");
  });

  it("uses monthly priority-position frequency before previous-workday load", async () => {
    const state = createOrdinarySchedulingState();
    const [heavierPreviousWorker, lighterPreviousWorker] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [heavierPreviousWorker!, lighterPreviousWorker!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "target",
        flightNo: "CX931",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "target-control",
        flightNo: "CX931",
        name: "G18",
        category: "常规",
        remark: "控制",
        fatiguePoints: 6,
        qualifiedStaffIds: [
          heavierPreviousWorker!.id,
          lighterPreviousWorker!.id,
        ],
      },
    ];
    state.history = [
      {
        id: "previous-heavy",
        date: "2026-10-22",
        flightNo: "OTHER1",
        position: "P01",
        staffId: heavierPreviousWorker!.id,
        staffName: heavierPreviousWorker!.name,
        startTime: "08:00",
        endTime: "18:00",
        workHours: 10,
        fatiguePoints: 10,
        remark: "",
      },
      {
        id: "previous-light",
        date: "2026-10-22",
        flightNo: "OTHER2",
        position: "P02",
        staffId: lighterPreviousWorker!.id,
        staffName: lighterPreviousWorker!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
      ...["2026-10-02", "2026-10-04"].map((date, index) => ({
        id: `older-control-${index}`,
        date,
        flightNo: "CX931",
        position: "G18",
        staffId: lighterPreviousWorker!.id,
        staffName: lighterPreviousWorker!.name,
        startTime: "13:00",
        endTime: "15:00",
        workHours: 2,
        fatiguePoints: 6,
        remark: "控制",
      })),
    ];

    const result = await generateSchedule(state, "2026-10-24");

    expect(
      result.assignments.find(
        (item) => item.positionRuleId === "target-control"
      )?.staffId
    ).toBe(heavierPreviousWorker!.id);
  });

  it("keeps an unavoidable late-flight worker off an earlier priority position when a safe alternate exists", async () => {
    const state = createOrdinarySchedulingState();
    const [lateWorker, alternate] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [lateWorker!, alternate!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.settings.lateShiftRecoveryEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.positionTransitionPolicies = [];
    state.flights = [
      {
        id: "early",
        flightNo: "CX931",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "late",
        flightNo: "TR121",
        startTime: "21:30",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "early-control",
        flightNo: "CX931",
        name: "G18",
        category: "常规",
        remark: "控制",
        fatiguePoints: 5,
        qualifiedStaffIds: [lateWorker!.id, alternate!.id],
      },
      {
        ...base,
        id: "late-position",
        flightNo: "TR121",
        name: "H08",
        category: "常规",
        remark: "",
        fatiguePoints: 2,
        qualifiedStaffIds: [lateWorker!.id],
      },
    ];

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;

    expect(
      assignments.find((item) => item.positionRuleId === "early-control")
        ?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "late-position")
        ?.staffId
    ).toBe(lateWorker!.id);
  });

  it("uses an overlapping-flight direct swap after same-flight candidates are unavailable", async () => {
    const state = createOrdinarySchedulingState();
    const [alternate, repeated] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [alternate!, repeated!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "other",
        flightNo: "MU100",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "other-g18",
        flightNo: "MU100",
        name: "G18",
        category: "常规",
        qualifiedStaffIds: [alternate!.id, repeated!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [alternate!.id, repeated!.id],
      },
    ];
    state.settings.ordinaryPriorityPositions =
      state.settings.ordinaryPriorityPositions.filter(
        (item) => !(item.airlineCode === "CX" && item.position === "G20")
      );
    state.history = [
      {
        id: "previous-g20",
        date: "2026-10-22",
        flightNo: "CX937",
        position: "G20",
        staffId: repeated!.id,
        staffName: repeated!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 1,
        remark: "一号",
      },
    ];

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")?.staffId
    ).toBe(alternate!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "other-g18")?.staffId
    ).toBe(repeated!.id);
  });

  it("keeps an unavoidable third consecutive assignment and records the rotation review reason", async () => {
    const state = createOrdinarySchedulingState();
    const [alternate, repeated] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [alternate!, repeated!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "cx-g18",
        flightNo: "CX937",
        name: "G18",
        category: "常规",
        qualifiedStaffIds: [alternate!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        qualifiedStaffIds: [repeated!.id, alternate!.id],
      },
    ];
    state.history = ["2026-10-20", "2026-10-22"].map((date, index) => ({
      id: `repeated-g20-${index}`,
      date,
      flightNo: "CX937",
      position: "G20",
      staffId: repeated!.id,
      staffName: repeated!.name,
      startTime: "08:30",
      endTime: "10:30",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
    }));

    const result = await generateSchedule(state, "2026-10-24");
    state.assignments = result.assignments;
    const repeatedAssignment = state.assignments.find(
      (item) => item.position === "G20"
    )!;
    expect(repeatedAssignment.staffId).toBe(repeated!.id);
    expect(repeatedAssignment.decisionTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-rotation",
          outcome: "fallback",
        }),
      ])
    );
    const feedback = buildScheduleFeedback(state, "2026-10-24").find(
      (item) => item.key === "position-rotation"
    )!;
    expect(feedback).toMatchObject({ status: "需复核" });
    expect(feedback.text).toContain(`${repeated!.name} 已连续2次承担CX937/G20`);
    expect(feedback.text).not.toMatch(
      /infeasible|changed-assignment-count|双向岗位资质|完整重排方案/
    );
    expect((feedback.text.match(/[。！？]/g) ?? []).length).toBeLessThanOrEqual(
      2
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${repeated!.name} 已连续2次承担CX937/G20`),
      ])
    );
  });

  it("blocks a strict transition after noon while prefer mode remains a fallback preference", async () => {
    const buildState = (mode: "prefer" | "forbid") => {
      const state = createOrdinarySchedulingState();
      state.settings.minimumRegularTransitionMinutes = 0;
      const person = state.staff.find((item) => item.status === "正常")!;
      person.dutyQualified = false;
      state.staff = [person];
      state.flights = [
        {
          id: "source",
          flightNo: "SOURCE",
          startTime: "13:00",
          endTime: "14:00",
          bookedPassengers: 100,
          positions: [],
          remark: "",
        },
        {
          id: "target",
          flightNo: "TARGET",
          startTime: "15:00",
          endTime: "16:00",
          bookedPassengers: 100,
          positions: [],
          remark: "",
        },
      ];
      const base = state.positionRules[0]!;
      state.positionRules = [
        {
          ...base,
          id: "source-position",
          flightNo: "SOURCE",
          name: "G01",
          category: "常规",
          qualifiedStaffIds: [person.id],
        },
        {
          ...base,
          id: "target-position",
          flightNo: "TARGET",
          name: "H01",
          category: "常规",
          qualifiedStaffIds: [person.id],
        },
      ];
      state.settings.positionTransitionPolicies = [
        {
          id: "afternoon-transition",
          name: "下午严格衔接",
          enabled: true,
          sourceFlightNo: "SOURCE",
          sourcePositions: ["G01"],
          targetFlightNo: "TARGET",
          targetPosition: "H01",
          minimumGapMinutes: 180,
          mode,
        },
      ];
      return state;
    };

    const strictResult = await generateSchedule(
      buildState("forbid"),
      "2026-07-18"
    );
    expect(
      strictResult.assignments.find(
        (item) => item.positionRuleId === "target-position"
      )
    ).toMatchObject({
      status: "unfilled",
      staffId: null,
      systemNotes: [expect.stringContaining("下午严格衔接")],
    });

    const preferredResult = await generateSchedule(
      buildState("prefer"),
      "2026-07-18"
    );
    expect(
      preferredResult.assignments.find(
        (item) => item.positionRuleId === "target-position"
      )
    ).toMatchObject({
      status: "assigned",
      staffId: expect.any(String),
    });
  });

  it("keeps a pre-noon manual position in the initial global solution", async () => {
    const state = createOrdinarySchedulingState();
    const [alternate, repeated] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [alternate!, repeated!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "manual-g18",
        flightNo: "CX937",
        name: "G18",
        category: "常规",
        manual: true,
        qualifiedStaffIds: [alternate!.id, repeated!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        qualifiedStaffIds: [alternate!.id, repeated!.id],
      },
    ];
    state.settings.ordinaryPriorityPositions =
      state.settings.ordinaryPriorityPositions.filter(
        (item) => !(item.airlineCode === "CX" && item.position === "G20")
      );
    state.history = ["2026-10-20", "2026-10-22"].map((date, index) => ({
      id: `repeated-g20-${index}`,
      date,
      flightNo: "CX937",
      position: "G20",
      staffId: repeated!.id,
      staffName: repeated!.name,
      startTime: "08:30",
      endTime: "10:30",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
    }));

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;
    expect(assignments.find((item) => item.position === "G20")?.staffId).toBe(
      alternate!.id
    );
    expect(assignments.find((item) => item.position === "G18")?.staffId).toBe(
      repeated!.id
    );
    expect(
      assignments.find((item) => item.position === "G20")?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "high-fatigue-position-consecutive",
          outcome: "selected",
        }),
      ])
    );
  });

  it("does not move duty and KE166 mobile-supervisor locks during rotation review", async () => {
    const state = createOrdinarySchedulingState();
    const [supervisor, repeated] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = [supervisor!, repeated!];
    state.staff.forEach((person) => {
      person.dutyQualified = false;
    });
    state.flights = [
      {
        id: "ke166",
        flightNo: "KE166",
        startTime: "08:00",
        endTime: "10:00",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
      {
        id: "cx",
        flightNo: "CX937",
        startTime: "08:30",
        endTime: "10:30",
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
        qualifiedStaffIds: [supervisor!.id],
      },
      {
        ...base,
        id: "ke-counter",
        flightNo: "KE166",
        name: "H04",
        category: "常规",
        qualifiedStaffIds: [supervisor!.id, repeated!.id],
      },
      {
        ...base,
        id: "cx-g20",
        flightNo: "CX937",
        name: "G20",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [supervisor!.id, repeated!.id],
      },
    ];
    state.history = ["2026-10-20", "2026-10-22"].map((date, index) => ({
      id: `repeated-g20-${index}`,
      date,
      flightNo: "CX937",
      position: "G20",
      staffId: repeated!.id,
      staffName: repeated!.name,
      startTime: "08:30",
      endTime: "10:30",
      workHours: 2,
      fatiguePoints: 1,
      remark: "一号",
    }));

    const assignments = (await generateSchedule(state, "2026-10-24"))
      .assignments;
    expect(
      assignments.find((item) => item.positionRuleId === "ke-supervisor")
        ?.staffId
    ).toBe(supervisor!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "ke-counter")
        ?.supervisorSourceAssignmentId
    ).toBeTruthy();
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")?.staffId
    ).toBe(repeated!.id);
    expect(
      assignments.find((item) => item.positionRuleId === "cx-g20")
        ?.decisionTrace
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "position-frequency-review",
          outcome: "fallback",
          message: expect.stringContaining("值班或KE166固定岗位"),
        }),
        expect.objectContaining({
          ruleId: "position-rotation",
          outcome: "fallback",
        }),
      ])
    );
  });
});
