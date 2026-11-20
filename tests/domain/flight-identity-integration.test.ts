import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { latePriorityFrequencyProfileForRule } from "../../src/domain/statistics/late-priority-frequency";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import { sameFlightStaffExclusionViolations } from "../../src/domain/rules/same-flight-staff-exclusion";
import { activeFlightRules } from "../../src/domain/flights/schedule-position-rules";
import { flightRuleSettings } from "../../src/domain/flights/flight-rule-settings";
import { buildHistoricalScheduleDraft } from "../../src/app/history-actions";

function fixture() {
  const state = createDefaultState();
  const staff = state.staff[0]!;
  staff.name = "测试人员";
  staff.dutyQualified = false;
  state.staff = [staff];
  state.flights = [];
  state.assignments = [];
  state.settings.latePriorityFlightNumbers = ["CX999"];
  state.settings.lateShiftEndTime = "22:00";
  state.shared.flightIdentities = [
    {
      id: "service",
      displayName: "CX937",
      aliases: [
        { flightNo: "CX937早" },
        { flightNo: "CX937晚" },
        { flightNo: "CX999", positionSourceFlightNo: "CX937晚" },
      ],
    },
  ];
  const rule = {
    ...state.positionRules[0]!,
    id: "role",
    flightNo: "CX937晚",
    name: "H02",
    remark: "一号",
    category: "常规" as const,
    manual: false,
    qualifiedStaffIds: [staff.id],
  };
  state.positionRules = [rule];
  state.history = ["CX937早", "CX937晚", "CX999"].map((flightNo, index) => ({
    id: `h${index}`,
    date: index < 2 ? "2026-11-01" : "2026-11-02",
    flightNo,
    position: "H02",
    staffId: staff.id,
    staffName: staff.name,
    startTime: "20:00",
    endTime: "23:00",
    workHours: 3,
    fatiguePoints: 3,
    remark: "一号",
  }));
  return { state, staff, rule };
}

describe("换号后的完整计次与规则链", () => {
  it("history editing resolves inherited jobs at the archived date", () => {
    const { state } = fixture();
    state.shared.flightIdentities![0]!.aliases[2]!.from = "2026-11-01";
    state.templates = [{ ...state.templates[0]!, flightNo: "CX999" }];
    state.history = [{ ...state.history[2]!, date: "2026-10-20" }];
    expect(
      buildHistoricalScheduleDraft(state, "2026-10-20").assignments
    ).toEqual([]);
    state.history[0]!.date = "2026-11-02";
    const restored = buildHistoricalScheduleDraft(state, "2026-11-02");
    expect(restored.assignments).toHaveLength(1);
    expect(restored.assignments[0]!.staffId).toBe(state.staff[0]!.id);
    expect(restored.assignments[0]!.flightNo).toBe("CX999");
  });
  it("historical role evidence uses the exact original job before another version of the same identity", () => {
    const { state, staff, rule } = fixture();
    state.positionRules = [
      { ...rule, id: "other", flightNo: "CX937早", remark: "申报" },
      rule,
    ];
    state.history = [
      {
        ...state.history[1]!,
        remark: "",
        assignmentRemarks: { remark: "", manualRemark: "" },
      },
    ];
    const row = buildMonthlyLatePriorityStatistics(state, "2026-11-20")
      .rows[0]!;
    expect(row.categories["一号"].effectiveCount).toBe(1);
    expect(row.categories["申报"].effectiveCount).toBe(0);
    const profile = latePriorityFrequencyProfileForRule(
      state,
      staff.id,
      { startTime: "20:00", endTime: "23:00" },
      rule,
      "2026-11-20"
    );
    expect(profile.counts["number-one"].currentMonthCount).toBe(1);
    expect(profile.counts.declaration.currentMonthCount).toBe(0);
    // The new number explicitly inherits the evening job, even without its own jobs.
    state.history[0]!.flightNo = "CX999";
    expect(
      buildMonthlyLatePriorityStatistics(state, "2026-11-20").rows[0]!
        .categories["申报"].effectiveCount
    ).toBe(0);
  });
  it("先认定原始事件再合并，同一天早晚不吞次数，轮换与表格相同", () => {
    const { state, staff, rule } = fixture();
    const statistics = buildMonthlyLatePriorityStatistics(state, "2026-11-20");
    expect(statistics.flightNumbers).toEqual(["@SERVICE"]);
    expect(
      statistics.rows[0]!.flights["@SERVICE"]!.categories["一号"].effectiveCount
    ).toBe(3);
    expect(
      statistics.rows[0]!.categories["一号"].details.map(
        (d) => d.flightNo
      ).sort()
    ).toEqual(["CX937早", "CX937晚", "CX999"].sort());
    expect(
      latePriorityFrequencyProfileForRule(
        state,
        staff.id,
        { startTime: "20:00", endTime: "23:00" },
        rule,
        "2026-11-20"
      ).counts["number-one"].currentMonthCount
    ).toBe(3);
  });
  it("原来源的负数截断和清零先计算，新档案的手工修正再应用", () => {
    const { state, staff } = fixture();
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: staff.id,
        flightNo: "CX937早",
        kind: "number-one",
        delta: -4,
      },
      {
        month: "2026-11",
        staffId: staff.id,
        flightNo: "CX937晚",
        kind: "number-one",
        delta: -1,
        resetBaseline: 1,
      },
      {
        month: "2026-11",
        staffId: staff.id,
        flightNo: "@SERVICE",
        kind: "number-one",
        delta: 2,
      },
    ];
    const cell = buildMonthlyLatePriorityStatistics(state, "2026-11-20")
      .rows[0]!.flights["@SERVICE"]!.categories["一号"];
    expect(cell.effectiveCount).toBe(3);
    expect(cell.visibleDetails.map((d) => d.flightNo)).toEqual([
      "CX937早",
      "CX999",
    ]);
    expect(state.history[0]!.flightNo).toBe("CX937早");
  });
  it("岗位按明确版本继承，规则自动共用，最终检查仍以实际班次分组", () => {
    const { state, rule } = fixture();
    const flight = {
      id: "new-flight",
      flightNo: "CX999",
      startTime: "20:00",
      endTime: "23:00",
      bookedPassengers: 100,
      positions: [],
      remark: "",
    };
    expect(activeFlightRules(state, flight).map((r) => r.id)).toEqual([
      rule.id,
    ]);
    state.settings.sameFlightStaffExclusions = [
      {
        id: "no-pair",
        enabled: true,
        flightNo: "CX937早",
        staffIds: ["one", "two"],
      },
    ];
    const row = {
      id: "a",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: "one",
      staffName: "一",
      startTime: "20:00",
      endTime: "23:00",
      workHours: 3,
      fatiguePoints: 3,
      remark: "",
      manualRemark: "",
      status: "assigned" as const,
    };
    const legal = [
      row,
      { ...row, id: "b", flightId: "another-actual-flight", staffId: "two" },
    ];
    expect(sameFlightStaffExclusionViolations(state, legal)).toHaveLength(0);
    const broken = [row, { ...legal[1]!, flightId: flight.id }];
    expect(sameFlightStaffExclusionViolations(state, broken)).toHaveLength(1);
    state.settings.mobileSupervisorFillRules = [
      {
        id: "fill",
        enabled: true,
        sourceFlightNo: "CX937早",
        sourcePositionKeyword: "督导",
        targetFlightNo: "CX937早",
        targetPositionKeyword: "H02",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    expect(
      flightRuleSettings(state).mobileSupervisorFillRules.every(
        (r) => r.sourceFlightNo === r.targetFlightNo
      )
    ).toBe(true);
  });
  it("早走每日仍只记一次，列归档案，历史时刻不重算", () => {
    const { state } = fixture();
    state.settings.earlyDepartureCutoffTime = "22:00";
    state.history = state.history.map((h, i) => ({
      ...h,
      startTime: i === 0 ? "08:00" : "17:00",
      endTime: i === 0 ? "12:00" : "20:00",
      flightCutoffTime: i === 0 ? "12:00" : "20:00",
    }));
    const rows = buildMonthlyRelaxedShiftStatistics(state, "2026-11-20").rows;
    expect(rows[0]!.earlyDepartures).toHaveLength(2);
    expect(rows[0]!.earlyDepartureDatesByFlight["@SERVICE"]).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});
