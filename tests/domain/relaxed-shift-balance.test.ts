import { describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import type { Assignment, HistoryRecord } from "../../src/model";
import {
  balanceRelaxedShifts,
  preservesRelaxedShiftBalance,
} from "../../src/domain/reviews/relaxed-shift-balance";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { generateSchedule } from "../helpers/generate-schedule";
import * as XLSX from "xlsx-js-style";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "../../src/domain/rules/built-in-rule-registry";
import { USER_SCHEDULING_RULES } from "../../src/ui/projections/policy-rule-presentation";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";

function fixture() {
  const state = createDefaultState();
  const sample = state.staff.find(
    (p) => p.status === "正常" && p.staffType === "常规"
  )!;
  state.staff = ["甲", "乙"].map((name, i) => ({
    ...structuredClone(sample),
    id: `p${i}`,
    name,
    dutyQualified: false,
    teamLeader: false,
  }));
  state.positionRules = [];
  state.dutyRosterOverrides = [];
  state.activeScheduleDate = "2026-11-06";
  state.flights = [
    {
      id: "am",
      flightNo: "AM100",
      startTime: "09:00",
      endTime: "10:00",
      bookedPassengers: 0,
      positions: ["P1"],
      remark: "",
    },
    {
      id: "pm",
      flightNo: "PM100",
      startTime: "14:00",
      endTime: "15:00",
      bookedPassengers: 0,
      positions: ["P1"],
      remark: "",
    },
  ];
  const make = (id: string, flightId: string, staff: number): Assignment => {
    const flight = state.flights.find((f) => f.id === flightId)!;
    return {
      id,
      flightId,
      flightNo: flight.flightNo,
      positionRuleId: id,
      position: "P1",
      staffId: `p${staff}`,
      staffName: state.staff[staff]!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned",
    };
  };
  state.assignments = [
    make("a0", "am", 0),
    make("a1", "am", 1),
    make("p1", "pm", 1),
  ];
  state.history = ["2026-11-02", "2026-11-04"].flatMap((date) =>
    state.assignments.map((a): HistoryRecord => ({
      ...a,
      date,
      staffId: a.staffId!,
      flightCutoffTime: a.endTime,
    }))
  );
  return state;
}

function qualityFixture() {
  const state = fixture();
  state.settings.afternoonRestBalanceEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  const earlier = state.flights[0]!;
  state.flights[1] = {
    ...state.flights[1]!,
    startTime: "11:00",
    endTime: "11:50",
  };
  const later = state.flights[1];
  state.assignments = [
    state.assignments[0]!,
    {
      ...state.assignments[2]!,
      startTime: later.startTime,
      endTime: later.endTime,
    },
  ];
  state.history = state.assignments.map((assignment, index) => ({
    ...assignment,
    staffId: assignment.staffId!,
    date: "2026-11-02",
    startTime: "08:30",
    flightStartTime: index === 0 ? earlier.startTime : later.startTime,
  }));
  return state;
}

function balanceFixture(
  state: ReturnType<typeof fixture>,
  assertSafe = () => undefined
) {
  return balanceRelaxedShifts({
    state,
    date: state.activeScheduleDate!,
    assignments: state.assignments,
    lockedAssignmentIds: new Set(),
    assertSafe,
  });
}

function latePriorityFixture() {
  const state = fixture();
  const earlier = state.assignments[0]!;
  const lateFlight = state.flights[1]!;
  Object.assign(lateFlight, {
    flightNo: "KE160",
    startTime: "21:55",
    endTime: "23:55",
  });
  const supervisor: Assignment = {
    ...state.assignments[2]!,
    flightNo: lateFlight.flightNo,
    startTime: lateFlight.startTime,
    endTime: lateFlight.endTime,
    workHours: 2,
    position: "督导",
  };
  state.staff.forEach((person) => {
    person.nightShift = true;
  });
  state.assignments = [earlier, supervisor];
  state.positionRules = state.assignments.map((assignment) => ({
    id: assignment.positionRuleId!,
    flightNo: assignment.flightNo,
    name: assignment.position,
    category: "常规",
    remark: "",
    qualifiedStaffIds: state.staff.map((person) => person.id),
    manual: false,
    fatiguePoints: assignment.fatiguePoints,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  }));
  Object.assign(state.settings, {
    earlyDepartureBalanceEnabled: true,
    earlyDepartureCutoffTime: "16:00",
    earlyDepartureMaxDifference: 0,
    afternoonRestBalanceEnabled: false,
    lateShiftEndTime: "23:00",
    latePriorityFlightNumbers: [lateFlight.flightNo],
    ordinaryPriorityPositions: [],
    dailyPrimaryPositionUniqueEnabled: false,
    lateShiftRecoveryEnabled: false,
    highLoadProtectionEnabled: false,
    rollingLoadProtectionEnabled: false,
    workloadBalanceEnabled: false,
  });
  const history = (assignment: Assignment, date: string): HistoryRecord => ({
    ...assignment,
    id: `${date}-${assignment.id}`,
    date,
    staffId: earlier.staffId!,
    staffName: earlier.staffName,
    flightCutoffTime: assignment.endTime,
  });
  state.history = [
    history(earlier, "2026-11-02"),
    history(earlier, "2026-11-03"),
    history(supervisor, "2026-11-04"),
    history(supervisor, "2026-11-05"),
  ];
  return { state, date: state.activeScheduleDate!, supervisor };
}

describe("monthly relaxed shift balance", () => {
  it("keeps the late supervisor rotation even when swapping would balance early departure counts", () => {
    const { state, date, supervisor } = latePriorityFixture();
    const result = balanceRelaxedShifts({
      state,
      date,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => {},
    });
    expect(result.find((row) => row.id === supervisor.id)?.staffName).toBe(
      "乙"
    );
    expect(result).toEqual(state.assignments);
  });

  it.each(["outside the late scope", "equal late rotation"])(
    "still improves early departure fairness with %s",
    (scenario) => {
      const { state, date, supervisor } = latePriorityFixture();
      if (scenario === "outside the late scope")
        state.settings.latePriorityFlightNumbers = [];
      else
        state.history = state.history.filter(
          (row) => row.flightNo !== supervisor.flightNo
        );
      const result = balanceRelaxedShifts({
        state,
        date,
        assignments: state.assignments,
        lockedAssignmentIds: new Set(),
        assertSafe: () => {},
      });
      expect(result.find((row) => row.id === supervisor.id)?.staffName).toBe(
        "甲"
      );
    }
  );

  it("retains the fair late supervisor in the final generated schedule", async () => {
    const { state, date, supervisor } = latePriorityFixture();
    const result = await generateSchedule({ ...state, assignments: [] }, date);
    expect(
      result.assignments.find(
        (row) => row.positionRuleId === supervisor.positionRuleId
      )?.staffName
    ).toBe("乙");
    expect(result.unfilledCount).toBe(0);
    expect(result.safetyCredential).toBeDefined();
  });

  it("rotates the flight that begins earlier when monthly counts are tied", () => {
    const state = qualityFixture();
    state.settings.relaxedShiftFlightNumbers = [];
    const result = balanceFixture(state);
    expect(result[0]!.staffId).toBe("p1");
    expect(result[1]!.staffId).toBe("p0");
    expect(
      preservesRelaxedShiftBalance(
        state,
        state.activeScheduleDate!,
        result,
        state.assignments
      )
    ).toBe(false);
    expect(
      balanceFixture(state, () => {
        throw new ScheduleGuardError([
          { ruleId: "staff-unavailable", message: "unsafe swap" },
        ]);
      })
    ).toEqual(state.assignments);
  });

  it("prefers fewer early departures even when that person had the earliest flight", () => {
    const state = qualityFixture();
    const afternoon = {
      ...state.flights[1]!,
      startTime: "14:00",
      endTime: "15:00",
    };
    state.flights[1] = afternoon;
    state.assignments[1] = {
      ...state.assignments[1]!,
      startTime: afternoon.startTime,
      endTime: afternoon.endTime,
    };
    state.history.push({ ...state.history[1]!, date: "2026-11-04" });
    expect(balanceFixture(state)[0]!.staffId).toBe("p0");
  });

  it("does not balance tied counts by making today's only early departure later", () => {
    const state = qualityFixture();
    const lateFlight = {
      ...state.flights[1]!,
      id: "late",
      flightNo: "PM200",
      startTime: "14:00",
      endTime: "15:00",
    };
    state.flights.push(lateFlight);
    const extra = {
      ...state.assignments[1]!,
      id: "late-post",
      flightId: lateFlight.id,
      flightNo: lateFlight.flightNo,
      startTime: lateFlight.startTime,
      endTime: lateFlight.endTime,
    };
    const before = [...state.assignments, extra];
    const after = [
      ...state.assignments,
      { ...extra, staffId: "p0", staffName: "甲" },
    ];
    const date = state.activeScheduleDate!;
    for (const [assignments, expected] of [
      [before, [540]],
      [after, [660]],
    ] as const) {
      expect(
        buildMonthlyRelaxedShiftStatistics(
          { ...state, assignments: [...assignments] },
          date
        ).currentEarlyDepartureStartMinutes
      ).toEqual(expected);
    }
    expect(preservesRelaxedShiftBalance(state, date, before, after)).toBe(
      false
    );
  });

  it("does not compare unequal samples when an unknown start changes hands", () => {
    const state = qualityFixture();
    const third = { ...state.staff[0]!, id: "p2", name: "丙" };
    state.staff.push(third);
    state.history.push({
      ...state.history[0]!,
      id: "third-history",
      staffId: third.id,
      staffName: third.name,
    });
    state.flights[1]!.startTime = "";
    const [first, second] = state.assignments;
    const thirdAssignment = {
      ...first!,
      id: "third-post",
      staffId: third.id,
      staffName: third.name,
    };
    const before = [first!, second!, thirdAssignment];
    const after = [
      { ...first!, staffId: second!.staffId, staffName: second!.staffName },
      { ...second!, staffId: first!.staffId, staffName: first!.staffName },
      thirdAssignment,
    ];
    const date = state.activeScheduleDate!;
    expect(preservesRelaxedShiftBalance(state, date, before, after)).toBe(true);
    expect(preservesRelaxedShiftBalance(state, date, after, before)).toBe(true);
  });

  it("keeps legacy dates counted without guessing their original flight start", () => {
    const state = qualityFixture();
    state.history = state.history.map((row) => ({
      ...row,
      flightStartTime: undefined,
    }));
    expect(
      buildMonthlyRelaxedShiftStatistics(
        state,
        state.activeScheduleDate!
      ).rows.map((row) => row.earlyDepartures.length)
    ).toEqual([2, 2]);
    expect(balanceFixture(state)).toEqual(state.assignments);
  });

  it.each(["09:00", "11:00"])(
    "keeps conflicting archived starts neutral when %s comes first",
    (firstStart) => {
      const state = qualityFixture();
      const [earlier, other] = state.history;
      state.history = [
        { ...earlier!, flightStartTime: firstStart },
        {
          ...earlier!,
          id: "duplicate",
          flightStartTime: firstStart === "09:00" ? "11:00" : "09:00",
        },
        { ...other!, flightStartTime: "10:00" },
      ];
      const date = state.activeScheduleDate!;
      const report = buildMonthlyRelaxedShiftStatistics(state, date);
      expect(report.rows.map((row) => row.earlyDepartures.length)).toEqual([
        2, 2,
      ]);
      expect(balanceFixture(state)).toEqual(state.assignments);
      expect(report.rows.map((row) => row.earlyDepartureStartMinutes)).toEqual([
        [540],
        [600, 660],
      ]);

      const historicalDate = earlier!.date;
      const history = currentScheduleHistory(state, historicalDate, {
        preserveArchivedFlightStarts: true,
      });
      expect(history.map((row) => row.flightStartTime)).toEqual([
        undefined,
        "10:00",
      ]);
      const workbook = buildScheduleWorkbook(state, historicalDate, {
        historicalEdit: true,
      });
      const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
      expect(
        parseWorkbook(
          XLSX.read(bytes, { type: "array" }),
          state.staff
        ).history!.map((row) => row.flightStartTime)
      ).toEqual([undefined, "10:00"]);
    }
  );

  it("archives the flight start and carries it through Excel bytes and local storage", () => {
    const state = qualityFixture();
    state.assignments[0]!.startTime = "08:30";
    state.history = currentScheduleHistory(state, "2026-11-02");
    const expectStarts = (history: HistoryRecord[]) =>
      expect(
        history.map(({ startTime, flightStartTime }) => [
          startTime,
          flightStartTime,
        ])
      ).toEqual([
        ["08:30", "09:00"],
        ["11:00", "11:00"],
      ]);
    expectStarts(state.history);
    const bytes = XLSX.write(buildConfigWorkbook(state), {
      type: "array",
      bookType: "xlsx",
    });
    expectStarts(
      parseWorkbook(XLSX.read(bytes, { type: "array" }), state.staff).history!
    );
    const memory = new Map<string, string>();
    saveState(state, { setItem: memory.set.bind(memory) });
    expectStarts(
      loadState({ getItem: (key) => memory.get(key) ?? null }).history
    );
    const [first, second] = state.history;
    state.history = [first!, { ...second!, flightStartTime: undefined }];
    const date = "2026-11-02";
    state.flights[0]!.startTime = "07:00";
    for (const history of [
      currentScheduleHistory(state, date, {
        preserveArchivedFlightStarts: true,
      }),
      parseWorkbook(
        buildScheduleWorkbook(state, date, { historicalEdit: true }),
        state.staff
      ).history!,
    ])
      expect(history.map((row) => row.flightStartTime)).toEqual([
        "09:00",
        undefined,
      ]);
  });

  it("keeps the earlier rotation through Worker/WASM and exported XLSX", async () => {
    const state = qualityFixture();
    state.settings.minimumRegularTransitionMinutes = 0;
    state.positionRules = state.assignments.map((assignment) => ({
      id: assignment.positionRuleId!,
      flightNo: assignment.flightNo,
      name: assignment.position,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const date = state.activeScheduleDate!;
    const baseline = await generateSchedule(
      {
        ...state,
        settings: { ...state.settings, earlyDepartureBalanceEnabled: false },
      },
      date
    );
    expect(new Set(baseline.assignments.map((row) => row.staffId)).size).toBe(
      2
    );
    const first = baseline.assignments.find(
      (row) => row.flightId === "am"
    )!.staffId!;
    const second = baseline.assignments.find(
      (row) => row.flightId === "pm"
    )!.staffId!;
    state.history[0]!.staffId = first;
    state.history[0]!.staffName = state.staff.find(
      (person) => person.id === first
    )!.name;
    state.history[1]!.staffId = second;
    state.history[1]!.staffName = state.staff.find(
      (person) => person.id === second
    )!.name;
    const replies: ScheduleWorkerResponse[] = [];
    const host = {
      onmessage: undefined as
        | ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>)
        | undefined,
      postMessage: (reply: ScheduleWorkerResponse) => replies.push(reply),
    };
    vi.stubGlobal("self", host);
    try {
      await import("../../src/schedule.worker");
      await host.onmessage!(
        new MessageEvent<ScheduleWorkerRequest>("message", {
          data: {
            state: createScheduleGenerationFacts(state),
            date,
            preferences: { halfRestStaffIds: [] },
          },
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(replies.filter(({ type }) => type === "error")).toEqual([]);
    const reply = replies.find((message) => message.type === "result");
    if (reply?.type !== "result") throw new Error("no worker result");
    const { result } = reply;
    expect(result.unfilledCount).toBe(0);
    expect(result.safetyCredential).toBeDefined();
    const workbook = buildScheduleWorkbook(
      { ...state, assignments: result.assignments },
      date
    );
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const sheet = XLSX.read(bytes, { type: "array" }).Sheets["排班结果"]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
    expect(
      rows.map((row) => [row["航班开始时间"], row["人员编号"]]).sort()
    ).toEqual([
      ["09:00", second],
      ["11:00", first],
    ]);
  });

  it("balances the afternoon-free column even when old afternoon-rest counts are tied", () => {
    const state = fixture();
    state.settings.earlyDepartureBalanceEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    const flight = {
      ...state.flights[1]!,
      id: "evening",
      flightNo: "EV100",
      startTime: "19:00",
      endTime: "20:00",
    };
    state.flights.push(flight);
    const evening = {
      ...state.assignments[2]!,
      id: "late",
      flightId: flight.id,
      flightNo: flight.flightNo,
      startTime: flight.startTime,
      endTime: flight.endTime,
      staffId: "p0",
      staffName: "甲",
    };
    state.assignments.push(evening);
    state.history = [{ ...evening, date: "2026-11-02", staffId: "p0" }];
    const result = balanceFixture(state);
    const report = buildMonthlyRelaxedShiftStatistics(
      { ...state, assignments: result },
      state.activeScheduleDate!
    );
    expect(report.rows.map((row) => row.afternoonFreeDates)).toEqual([
      ["2026-11-02"],
      ["2026-11-06"],
    ]);
  });
  it("shares recent fatigue protection instead of undoing it to balance monthly rest", () => {
    const state = fixture();
    state.history.forEach((r) => {
      r.fatiguePoints = r.staffId === "p0" ? 6 : 1;
    });
    const run = () =>
      balanceRelaxedShifts({
        state,
        date: state.activeScheduleDate!,
        assignments: state.assignments,
        lockedAssignmentIds: new Set(),
        assertSafe: () => undefined,
      });
    expect(run()).toEqual(state.assignments);
    state.settings.workloadBalanceEnabled = false;
    const result = run();
    expect(
      buildMonthlyRelaxedShiftStatistics(
        { ...state, assignments: result },
        state.activeScheduleDate!
      ).currentAfternoonRest.map((p) => p.staffName)
    ).toEqual(["乙"]);
  });
  it("does not give duty an afternoon flight to balance monthly rest counts", () => {
    const state = fixture();
    state.settings.earlyDepartureBalanceEnabled = false;
    state.staff[0]!.dutyQualified = true;
    state.dutyRosterOverrides = [
      {
        date: state.activeScheduleDate!,
        dutyStaffId: "p0",
        cxPreflightStaffId: null,
        standbyStaffIds: ["p1", null],
      },
    ];
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    expect(result.find((a) => a.flightId === "pm")?.staffId).toBe("p1");
    expect(result).toEqual(state.assignments);
  });
  it("does not hide the recipient from the comparison by swapping in an originally idle person", () => {
    const state = fixture();
    state.staff.push({
      ...structuredClone(state.staff[0]!),
      id: "p2",
      name: "丙",
    });
    state.staff = [state.staff[0]!, state.staff[2]!, state.staff[1]!];
    state.history.push(
      ...state.history
        .filter((row) => row.staffId === "p0")
        .map((row) => ({ ...row, staffId: "p2", staffName: "丙" }))
    );
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    expect(
      buildMonthlyRelaxedShiftStatistics(
        { ...state, assignments: result },
        state.activeScheduleDate!
      ).currentAfternoonRest.map((p) => p.staffName)
    ).toEqual(["乙"]);
  });
  it("catches up across archived workdays without losing daily rest opportunities", async () => {
    const state = fixture();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.minimumRegularTransitionMinutes = 0;
    state.positionRules = state.assignments.map((a) => ({
      id: a.positionRuleId!,
      flightNo: a.flightNo,
      name: a.id,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const recipients: string[] = [];
    for (const date of [
      "2026-11-06",
      "2026-11-08",
      "2026-11-10",
      "2026-11-12",
    ]) {
      state.assignments = [];
      state.activeScheduleDate = date;
      const result = await generateSchedule(state, date);
      expect(result.unfilledCount).toBe(0);
      // Independently classify actual intervals rather than using the balance score.
      const resting = state.staff.filter(
        (person) =>
          result.assignments.some((a) => a.staffId === person.id) &&
          !result.assignments.some(
            (a) =>
              a.staffId === person.id &&
              a.startTime < "18:00" &&
              a.endTime > "12:00"
          )
      );
      expect(resting).toHaveLength(1);
      recipients.push(resting[0]!.name);
      state.history.push(
        ...result.assignments.map((a) => ({
          ...a,
          date,
          staffId: a.staffId!,
          flightCutoffTime: a.endTime,
        }))
      );
    }
    expect(recipients.slice(0, 2)).toEqual(["乙", "乙"]);
    expect(recipients.slice(2).sort()).toEqual(["乙", "甲"]);
    const report = buildMonthlyRelaxedShiftStatistics(state, "2026-11-12");
    expect(report.rows.map((row) => row.afternoonRestDates.length)).toEqual([
      3, 3,
    ]);
  });
  it("registers the final review and exposes independent switches in the actual rule ledger", () => {
    const state = fixture();
    const definition = BUILT_IN_RULE_REGISTRY.definition(
      "relaxed-shift-balance"
    );
    expect(definition?.execute.map((item) => item.kind)).toEqual([
      "final-review",
    ]);
    expect(
      USER_SCHEDULING_RULES.find((rule) => rule.id === "relaxed-shift-balance")
        ?.description
    ).toContain("本月");
    state.settings.earlyDepartureBalanceEnabled = false;
    expect(
      builtInRulePreferences(state.settings).find(
        (rule) => rule.id === "relaxed-shift-balance"
      )?.enabled
    ).toBe(true);
    state.settings.afternoonRestBalanceEnabled = false;
    expect(
      builtInRulePreferences(state.settings).find(
        (rule) => rule.id === "relaxed-shift-balance"
      )?.enabled
    ).toBe(false);
  });
  it("keeps explicit switches and zero targets through Excel, empty import, restart and actual scheduling", async () => {
    const source = fixture();
    source.settings.earlyDepartureBalanceEnabled = false;
    source.settings.earlyDepartureMaxDifference = 3;
    source.settings.afternoonRestMaxDifference = 0;
    source.settings.dailyPrimaryPositionUniqueEnabled = false;
    source.settings.positionRotationEnabled = false;
    source.settings.workloadBalanceEnabled = false;
    source.settings.minimumRegularTransitionMinutes = 0;
    source.positionRules = source.assignments.map((a) => ({
      id: a.positionRuleId!,
      flightNo: a.flightNo,
      name: a.id,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const bytes = XLSX.write(buildConfigWorkbook(source), {
      type: "array",
      bookType: "xlsx",
    });
    const imported = parseWorkbook(XLSX.read(bytes, { type: "array" }), []);
    const target = createDefaultState();
    const applied = applyWorkbookImport(target, imported, "all");
    expect(applied.errors).toBeUndefined();
    let persisted = "";
    saveState(target, {
      setItem: (_k, value) => {
        persisted = value;
      },
    });
    const restarted = loadState({ getItem: () => persisted });
    for (const key of [
      "earlyDepartureBalanceEnabled",
      "earlyDepartureMaxDifference",
      "afternoonRestBalanceEnabled",
      "afternoonRestMaxDifference",
    ] as const)
      expect(restarted.settings[key]).toBe(source.settings[key]);
    const result = await generateSchedule(restarted, "2026-11-06");
    expect(result.unfilledCount).toBe(0);
    expect(
      buildMonthlyRelaxedShiftStatistics(
        {
          ...restarted,
          assignments: result.assignments,
          activeScheduleDate: "2026-11-06",
        },
        "2026-11-06"
      ).currentAfternoonRest.map((p) => p.staffName)
    ).toEqual(["乙"]);
  });
  it("runs the same balance after the complete automatic pipeline and final safety", async () => {
    const state = fixture();
    state.settings.dailyPrimaryPositionUniqueEnabled = false;
    state.settings.positionRotationEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.settings.minimumRegularTransitionMinutes = 0;
    state.positionRules = state.assignments.map((a) => ({
      id: a.positionRuleId!,
      flightNo: a.flightNo,
      name: a.id,
      category: "常规",
      remark: "",
      qualifiedStaffIds: ["p0", "p1"],
      manual: false,
      fatiguePoints: 1,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }));
    const result = await generateSchedule(state, state.activeScheduleDate!);
    expect(result.unfilledCount).toBe(0);
    const report = buildMonthlyRelaxedShiftStatistics(
      { ...state, assignments: result.assignments },
      state.activeScheduleDate!
    );
    expect(report.currentEarlyDepartures.map((p) => p.staffName)).toEqual([
      "乙",
    ]);
    expect(report.currentAfternoonRest.map((p) => p.staffName)).toEqual(["乙"]);
    expect(result.safetyCredential).toBeDefined();
  });
  it("preserves the original when disabled, locked or rejected by final safety", () => {
    for (const mode of ["disabled", "locked", "unsafe"] as const) {
      const state = fixture();
      if (mode === "disabled") {
        state.settings.earlyDepartureBalanceEnabled = false;
        state.settings.afternoonRestBalanceEnabled = false;
      }
      let checked = 0;
      const result = balanceRelaxedShifts({
        state,
        date: state.activeScheduleDate!,
        assignments: state.assignments,
        lockedAssignmentIds: new Set(
          mode === "locked" ? state.assignments.map((a) => a.id) : []
        ),
        assertSafe: () => {
          checked++;
          throw new ScheduleGuardError([
            { ruleId: "staff-unavailable", message: "final safety rejects" },
          ]);
        },
      });
      expect(result).toEqual(state.assignments);
      if (mode === "unsafe") expect(checked).toBeGreaterThan(0);
    }
  });

  it("ignores target/future/other-month and partial history; keeps each setting independent", () => {
    const state = fixture();
    state.settings.earlyDepartureBalanceEnabled = false;
    state.history.push(
      ...state.history.map((row) => ({ ...row, date: "2026-12-02" })),
      ...state.history.map((row) => ({ ...row, date: "2026-11-08" })),
      ...state.history.map((row) => ({ ...row, date: "2026-11-06" })),
      ...state.history.map((row) => ({
        ...row,
        date: "2026-11-01",
        historyCoverage: "late-priority-only" as const,
      }))
    );
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    const report = buildMonthlyRelaxedShiftStatistics(
      {
        ...state,
        history: state.history.filter(
          (r) =>
            r.date < state.activeScheduleDate! && r.date.startsWith("2026-11")
        ),
        assignments: result,
      },
      state.activeScheduleDate!
    );
    expect(report.currentAfternoonRest.map((p) => p.staffName)).toEqual(["乙"]);
    expect(
      report.rows.find((r) => r.staff.name === "甲")!.afternoonRestDates
    ).toHaveLength(2);
  });

  it("gives the next rest opportunity to the person at zero rather than two", () => {
    const state = fixture();
    const before = structuredClone(state);
    const result = balanceRelaxedShifts({
      state,
      date: state.activeScheduleDate!,
      assignments: state.assignments,
      lockedAssignmentIds: new Set(),
      assertSafe: () => undefined,
    });
    const report = buildMonthlyRelaxedShiftStatistics(
      { ...state, assignments: result },
      state.activeScheduleDate!
    );
    expect(report.currentEarlyDepartures.map((p) => p.staffName)).toEqual([
      "乙",
    ]);
    expect(report.currentAfternoonRest.map((p) => p.staffName)).toEqual(["乙"]);
    expect(state).toEqual(before);
    expect(result.filter((a) => a.status === "assigned")).toHaveLength(3);
  });
});
