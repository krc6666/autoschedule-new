import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import {
  buildMonthlyLatePriorityStatistics,
  latePriorityStatisticsFlightNumbers,
} from "../../src/domain/statistics/monthly-late-priority-statistics";
import type { AppState, HistoryRecord, PositionRule } from "../../src/model";

const DATE = "2026-08-18";

function addLateFlight(
  state: AppState,
  flightNo: string,
  staffId: string
): void {
  state.flights.push({
    id: `flight-${flightNo.toLowerCase()}`,
    flightNo,
    startTime: "22:00",
    endTime: "23:55",
    bookedPassengers: 0,
    positions: ["T01", "T02", "T03", "T04"],
    remark: "",
  });
  const definitions = [
    ["T01", "一号"],
    ["T02", "申报"],
    ["T03", "送资料"],
    ["督导", ""],
  ] as const;
  state.positionRules.push(
    ...definitions.map(([name, remark], index): PositionRule => ({
      id: `position-${flightNo.toLowerCase()}-${index}`,
      flightNo,
      name,
      category: "常规",
      remark,
      qualifiedStaffIds: [staffId],
      manual: false,
      fatiguePoints: 5,
      minPassengers: 0,
      earlyReleaseMinutes: 0,
    }))
  );
}

function history(
  id: string,
  flightNo: string,
  position: string,
  remark: string,
  staffId: string,
  date = "2026-08-10",
  endTime = "23:55",
  historyCoverage?: HistoryRecord["historyCoverage"]
): HistoryRecord {
  return {
    id,
    date,
    flightNo,
    position,
    staffId,
    staffName: "测试人员",
    startTime: "22:00",
    endTime,
    workHours: 2,
    fatiguePoints: 5,
    remark,
    ...(historyCoverage ? { historyCoverage } : {}),
  };
}

describe("monthly late priority statistics", () => {
  it("counts a mobile supervisor role in the supervisor category", () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "督导"
    )!;
    const staffId = rule.qualifiedStaffIds[0]!;
    rule.category = "机动督导";
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      history("mobile-supervisor", "TR121", "督导", "", staffId),
    ];

    const row = buildMonthlyLatePriorityStatistics(state, DATE).rows.find(
      (item) => item.staff.id === staffId
    )!;

    expect(row.categories.督导.qualified).toBe(true);
    expect(row.categories.督导.details).toHaveLength(1);
    expect(row.categories.督导.effectiveCount).toBe(1);
  });

  it("projects final counts by flight and category", () => {
    const state = createDefaultState();
    state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
    const staff = state.staff[0]!;
    state.positionRules = state.positionRules.map((rule) =>
      rule.flightNo === "TR121" && rule.name === "一号"
        ? { ...rule, qualifiedStaffIds: [staff.id] }
        : rule
    );
    addLateFlight(state, "TW616", staff.id);
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: staff.id,
        flightNo: "TR121",
        kind: "number-one",
        delta: 2,
      },
      {
        month: "2026-08",
        staffId: staff.id,
        flightNo: "TW616",
        kind: "declaration",
        delta: 1,
      },
    ];

    const row = buildMonthlyLatePriorityStatistics(
      state,
      "2026-08-20"
    ).rows.find((item) => item.staff.id === staff.id)!;

    expect(row.flights["TR121"]?.categories["一号"].effectiveCount).toBe(2);
    expect(row.flights["TW616"]?.categories["申报"].effectiveCount).toBe(1);
    expect(row.flights["TR121"]?.categories["申报"].effectiveCount).toBe(0);
  });

  it("applies manual correction by staff, flight and category", () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "申报"
    )!;
    const staffId = rule.qualifiedStaffIds[0]!;
    addLateFlight(state, "TW616", staffId);
    state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId,
        flightNo: "TW616",
        kind: "declaration",
        delta: 2,
      },
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "delivery",
        delta: 1,
      },
    ];
    const row = buildMonthlyLatePriorityStatistics(state, DATE).rows.find(
      (item) => item.staff.id === staffId
    )!;
    expect(row.categories.申报.effectiveCount).toBe(2);
    expect(row.categories.申报.manualCorrection).toBe(2);
    expect(row.categories.送资料.effectiveCount).toBe(1);
    expect(row.categories.督导.effectiveCount).toBe(0);
  });

  it("keeps the personnel order stable when only manual corrections change", () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "一号"
    )!;
    const staffId = rule.qualifiedStaffIds[0]!;
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const before = buildMonthlyLatePriorityStatistics(state, DATE).rows.map(
      (row) => row.staff.id
    );

    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "number-one",
        delta: 1,
      },
    ];
    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);

    expect(statistics.rows.map((row) => row.staff.id)).toEqual(before);
    expect(
      statistics.rows.find((row) => row.staff.id === staffId)?.categories.一号
        .effectiveCount
    ).toBe(1);
  });

  it("combines selected flights into one staff table and keeps flight details", () => {
    const state = createDefaultState();
    const trRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "送资料"
    )!;
    const staffId = trRule.qualifiedStaffIds[0]!;
    addLateFlight(state, "TW616", staffId);
    state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
    state.history = [
      history("tr-delivery", "TR121", trRule.name, trRule.remark, staffId),
      history("tw-delivery", "TW616", "T03", "送资料", staffId),
      history("outside", "AK100", "A01", "送资料", staffId),
    ];

    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);
    const row = statistics.rows.find((item) => item.staff.id === staffId)!;

    expect(statistics.flightNumbers).toEqual(["TR121", "TW616"]);
    expect(row.totalCount).toBe(2);
    expect(row.categories.送资料.details).toEqual([
      expect.objectContaining({ flightNo: "TR121", date: "2026-08-10" }),
      expect.objectContaining({ flightNo: "TW616", date: "2026-08-10" }),
    ]);
  });

  it("keeps zero-count qualified workers while excluding sick, administrative and unqualified workers", () => {
    const state = createDefaultState();
    const trRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.name === "H02"
    )!;
    const trStaffId = trRule.qualifiedStaffIds[0]!;
    const trZeroStaffId = trRule.qualifiedStaffIds[1]!;
    const sickStaffId = trRule.qualifiedStaffIds[2]!;
    const adminStaffId = trRule.qualifiedStaffIds[3]!;
    state.staff.find((person) => person.id === sickStaffId)!.status = "病假";
    state.staff.find((person) => person.id === adminStaffId)!.staffType =
      "行政支援";
    trRule.qualifiedStaffIds = [
      trStaffId,
      trZeroStaffId,
      sickStaffId,
      adminStaffId,
    ];
    const twStaffId = state.staff.find(
      (person) => !trRule.qualifiedStaffIds.includes(person.id)
    )!.id;
    addLateFlight(state, "TW616", twStaffId);
    state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
    state.history = [
      history("tr-one", "TR121", "H02", "一号", trStaffId),
      history("tw-one", "TW616", "T01", "一号", twStaffId),
    ];

    expect(latePriorityStatisticsFlightNumbers(state)).toEqual([
      "TR121",
      "TW616",
    ]);

    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);

    expect(
      statistics.rows
        .filter((row) => row.categories.一号.qualified)
        .map((row) => [row.staff.id, row.categories.一号.details.length])
    ).toEqual(
      expect.arrayContaining([
        [trZeroStaffId, 0],
        [trStaffId, 1],
        [twStaffId, 1],
      ])
    );
    expect(statistics.rows.some((row) => row.staff.id === sickStaffId)).toBe(
      false
    );
    expect(statistics.rows.some((row) => row.staff.id === adminStaffId)).toBe(
      false
    );
  });

  it("keeps four labels and counts archived facts even without today's qualification", () => {
    const state = createDefaultState();
    const rules = {
      一号: state.positionRules.find(
        (rule) => rule.flightNo === "TR121" && rule.remark === "一号"
      )!,
      申报: state.positionRules.find(
        (rule) => rule.flightNo === "TR121" && rule.remark === "申报"
      )!,
      送资料: state.positionRules.find(
        (rule) => rule.flightNo === "TR121" && rule.remark === "送资料"
      )!,
      督导: state.positionRules.find(
        (rule) => rule.flightNo === "TR121" && rule.name === "督导"
      )!,
    };
    const qualifiedId = rules.一号.qualifiedStaffIds[0]!;
    const unqualifiedId = state.staff.find(
      (person) => person.id !== qualifiedId
    )!.id;
    Object.values(rules).forEach((rule) => {
      rule.qualifiedStaffIds = [qualifiedId];
    });
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      history("one", "TR121", rules.一号.name, rules.一号.remark, qualifiedId),
      history(
        "declaration",
        "TR121",
        rules.申报.name,
        rules.申报.remark,
        qualifiedId
      ),
      history(
        "delivery",
        "TR121",
        rules.送资料.name,
        rules.送资料.remark,
        qualifiedId
      ),
      history(
        "supervisor",
        "TR121",
        rules.督导.name,
        rules.督导.remark,
        qualifiedId
      ),
      history(
        "unqualified",
        "TR121",
        rules.一号.name,
        rules.一号.remark,
        unqualifiedId
      ),
      history(
        "boundary",
        "TR121",
        rules.一号.name,
        rules.一号.remark,
        qualifiedId,
        "2026-08-12",
        "23:00"
      ),
    ];

    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);
    expect(statistics.rows).toHaveLength(2);
    const qualified = statistics.rows.find((r) => r.staff.id === qualifiedId)!;
    const unqualified = statistics.rows.find(
      (r) => r.staff.id === unqualifiedId
    )!;
    expect(unqualified.categories.一号.effectiveCount).toBe(1);
    expect(unqualified.qualificationOverrideCount).toBe(0);
    expect(unqualified.qualificationUnrecordedCount).toBe(1);
    for (const category of ["督导", "一号", "申报", "送资料"] as const)
      expect(qualified.categories[category].details).toEqual([
        expect.objectContaining({ date: "2026-08-10" }),
      ]);
  });

  it("counts a combined declaration and delivery role once as delivery", () => {
    const state = createDefaultState();
    const combinedRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.name === "H04"
    )!;
    combinedRule.remark = "申报/送资料";
    const staffId = combinedRule.qualifiedStaffIds[0]!;
    combinedRule.qualifiedStaffIds = [staffId];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.activeScheduleDate = DATE;
    state.assignments = [
      {
        id: "current-combined",
        flightId: state.flights.find((flight) => flight.flightNo === "TR121")!
          .id,
        flightNo: "TR121",
        positionRuleId: combinedRule.id,
        position: combinedRule.name,
        staffId,
        staffName: "测试人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: combinedRule.remark,
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "declaration",
        delta: 5,
      },
    ];

    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);
    const row = statistics.rows.find((item) => item.staff.id === staffId)!;
    expect(row.categories.申报.details).toEqual([]);
    expect(row.categories.送资料.details).toEqual([
      expect.objectContaining({ date: DATE }),
    ]);
    expect(row.flights.TR121!.categories.申报.manualCorrection).toBe(0);
    expect(row.flights.TR121!.totalCount).toBe(1);
    expect(row.totalCount).toBe(1);
  });

  it("keeps separate declaration and delivery roles as two counts", () => {
    const state = createDefaultState();
    const staffId = state.staff[0]!.id;
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "separate-declaration",
        flightNo: "TARGET",
        name: "D01",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: [staffId],
      },
      {
        ...base,
        id: "separate-delivery",
        flightNo: "TARGET",
        name: "D02",
        remark: "送资料",
        category: "常规",
        qualifiedStaffIds: [staffId],
      },
    ];
    state.settings.latePriorityFlightNumbers = ["TARGET"];
    state.activeScheduleDate = DATE;
    state.assignments = state.positionRules.map((rule) => ({
      id: `assignment-${rule.id}`,
      flightId: "target-flight",
      flightNo: "TARGET",
      positionRuleId: rule.id,
      position: rule.name,
      staffId,
      staffName: "测试人员",
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 5,
      remark: rule.remark,
      manualRemark: "",
      status: "assigned" as const,
    }));

    const row = buildMonthlyLatePriorityStatistics(state, DATE).rows[0]!;

    expect(row.categories.申报.details).toHaveLength(1);
    expect(row.categories.送资料.details).toHaveLength(1);
    expect(row.totalCount).toBe(2);
  });

  it("uses the current final schedule instead of same-day history", () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "一号"
    )!;
    const archivedStaffId = rule.qualifiedStaffIds[0]!;
    const currentStaffId = rule.qualifiedStaffIds[1]!;
    rule.qualifiedStaffIds = [archivedStaffId, currentStaffId];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      history(
        "old-day",
        "TR121",
        rule.name,
        rule.remark,
        archivedStaffId,
        "2026-08-16"
      ),
      history(
        "stale-same-day",
        "TR121",
        rule.name,
        rule.remark,
        archivedStaffId,
        DATE
      ),
    ];
    state.activeScheduleDate = DATE;
    state.assignments = [
      {
        id: "current-one",
        flightId: state.flights.find((flight) => flight.flightNo === "TR121")!
          .id,
        flightNo: "TR121",
        positionRuleId: rule.id,
        position: rule.name,
        staffId: currentStaffId,
        staffName: "当前人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: rule.remark,
        manualRemark: "",
        status: "assigned",
      },
    ];

    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);
    expect(
      statistics.rows
        .find((row) => row.staff.id === archivedStaffId)
        ?.categories.一号.details.map((item) => item.date)
    ).toEqual(["2026-08-16"]);
    expect(
      statistics.rows
        .find((row) => row.staff.id === currentStaffId)
        ?.categories.一号.details.map((item) => item.date)
    ).toEqual([DATE]);
  });

  it("keeps supervisor-qualified rows visible but excludes their allowed relief from the declaration spread", () => {
    const state = createDefaultState();
    const supervisorRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.name === "督导"
    )!;
    const declarationRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "申报"
    )!;
    const supervisorId = supervisorRule.qualifiedStaffIds[0]!;
    const ordinaryIds = state.staff
      .filter(
        (person) =>
          person.status === "正常" &&
          person.staffType === "常规" &&
          person.id !== supervisorId
      )
      .slice(0, 2)
      .map((person) => person.id);
    supervisorRule.qualifiedStaffIds = [supervisorId];
    declarationRule.qualifiedStaffIds = [supervisorId, ...ordinaryIds];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      history(
        "ordinary-once",
        "TR121",
        declarationRule.name,
        declarationRule.remark,
        ordinaryIds[0]!,
        "2026-08-10"
      ),
      history(
        "ordinary-twice-1",
        "TR121",
        declarationRule.name,
        declarationRule.remark,
        ordinaryIds[1]!,
        "2026-08-10"
      ),
      history(
        "ordinary-twice-2",
        "TR121",
        declarationRule.name,
        declarationRule.remark,
        ordinaryIds[1]!,
        "2026-08-12"
      ),
    ];

    const statistics = buildMonthlyLatePriorityStatistics(state, DATE);

    expect(statistics.ranges.申报).toEqual({
      min: 0,
      max: 2,
      difference: 2,
      allowedDifference: 2,
    });
    expect(
      statistics.rows.find((row) => row.staff.id === supervisorId)?.categories
        .申报.qualified
    ).toBe(true);
  });

  it("keeps late-priority-only imports in late-priority statistics", () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "H02"
    )!;
    const staffId = rule.qualifiedStaffIds[0]!;
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      history(
        "partial-late",
        "TR121",
        "H02",
        rule.remark,
        staffId,
        "2026-08-10",
        "23:55",
        "late-priority-only"
      ),
    ];

    const row = buildMonthlyLatePriorityStatistics(state, DATE).rows.find(
      (item) => item.staff.id === staffId
    )!;

    expect(row.totalCount).toBe(1);
  });
});
