import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { validateFlightIdentities } from "../../src/domain/flights/flight-identities";
import { activeFlightRules } from "../../src/domain/flights/schedule-position-rules";
import { previewFlightIdentityChange } from "../../src/domain/flights/flight-identity-change";
import { flightRuleSettings } from "../../src/domain/flights/flight-rule-settings";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import { setTeamLeaderGapFillPositionsMovable } from "../../src/app/policy-actions";
import { teamLeaderGapFillPositionDisposition } from "../../src/domain/coverage/team-leader-gap-fill-protection";

const identities = [
  {
    id: "service",
    displayName: "长期航班",
    aliases: [
      { flightNo: "OLD100" },
      {
        flightNo: "NEW200",
        positionSourceFlightNo: "OLD100",
        from: "2026-11-01",
      },
    ],
  },
];

describe("航班档案维护与边界", () => {
  it("changing a protection switch through one alias updates the shared rule for all aliases", () => {
    const state = createDefaultState();
    state.shared.flightIdentities = identities;
    const old = {
      ...state.positionRules[0]!,
      id: "old",
      flightNo: "OLD100",
      name: "H99",
      category: "常规" as const,
      manual: false,
    };
    const next = { ...old, id: "next", flightNo: "NEW200" };
    state.positionRules = [old, next];
    state.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: "@SERVICE", position: "H99", movable: false },
    ];
    expect(setTeamLeaderGapFillPositionsMovable(state, [next.id], true)).toBe(
      true
    );
    expect(teamLeaderGapFillPositionDisposition(state, old).movable).toBe(true);
    expect(teamLeaderGapFillPositionDisposition(state, next).movable).toBe(
      true
    );
    expect(previewFlightIdentityChange(state, identities).errors).toEqual([]);
  });
  it.each([
    [{ id: 1, displayName: "坏档案", aliases: [{ flightNo: "A1" }] }],
    [
      {
        id: "x",
        displayName: "坏档案",
        aliases: [null, { flightNo: "A1", positionSourceFlightNo: "A2" }],
      },
    ],
    [{ id: "x", displayName: "坏档案", aliases: [{ flightNo: " @missing " }] }],
  ])("损坏输入返回明确错误，不抛异常或接受内部引用：%j", (...rows) => {
    expect(() => validateFlightIdentities(rows)).not.toThrow();
    expect(validateFlightIdentities(rows).length).toBeGreaterThan(0);
  });
  it("沿用岗位尊重实际排班日期，未生效的关系不借用旧岗", () => {
    const state = createDefaultState();
    state.shared.flightIdentities = identities;
    state.positionRules = [{ ...state.positionRules[0]!, flightNo: "OLD100" }];
    const flight = { ...state.flights[0]!, flightNo: "NEW200" };
    expect(
      activeFlightRules({ ...state, flightIdentityDate: "2026-10-20" }, flight)
    ).toEqual([]);
    expect(
      activeFlightRules({ ...state, flightIdentityDate: "2026-11-20" }, flight)
    ).toHaveLength(1);
  });
  it("预览后人工班表变化也要求重新预览", () => {
    const state = createDefaultState();
    const before = previewFlightIdentityChange(state, identities).fingerprint;
    state.assignments = [
      { id: "manual-change" } as (typeof state.assignments)[number],
    ];
    expect(previewFlightIdentityChange(state, identities).fingerprint).not.toBe(
      before
    );
  });
  it("岗位衔接同一目标的相反设置不依赖偶然顺序合并", () => {
    const state = createDefaultState();
    state.settings.positionTransitionPolicies = ["OLD100", "NEW200"].map(
      (flightNo, i) => ({
        id: `transition-${i}`,
        name: "衔接",
        enabled: true,
        sourceFlightNo: flightNo,
        sourcePositions: ["H01"],
        targetFlightNo: "ZZ300",
        targetPosition: "H02",
        minimumGapMinutes: 30,
        mode: i === 0 ? "prefer" : "forbid",
      })
    );
    expect(
      previewFlightIdentityChange(state, identities).errors.join()
    ).toContain("衔接");
  });
  it("完全相同的规则执行一次，不在归并扩展后重复执行", () => {
    const state = createDefaultState();
    state.shared.flightIdentities = identities;
    state.settings.crossFlightPriorityPolicies = ["OLD100", "NEW200"].map(
      (flightNo, i) => ({
        id: `priority-${i}`,
        enabled: true,
        flightNo,
        staffIds: [state.staff[0]!.id],
      })
    );
    const rules = flightRuleSettings(state).crossFlightPriorityPolicies;
    expect(rules.filter((r) => r.flightNo === "NEW200")).toHaveLength(1);
  });
  it("模板改号保留不同来源的人工账本，负数截断后汇总不能变多", () => {
    const state = createDefaultState(),
      staff = state.staff[0]!;
    state.staff = [staff];
    state.flights = [];
    state.assignments = [];
    state.templates = [
      { ...state.templates[0]!, id: "old", flightNo: "OLD100" },
    ];
    state.positionRules = [
      {
        ...state.positionRules[0]!,
        flightNo: "OLD100",
        name: "H01",
        remark: "一号",
        category: "常规",
        qualifiedStaffIds: [staff.id],
      },
    ];
    state.settings.latePriorityFlightNumbers = ["OLD100", "NEW200"];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: staff.id,
        flightNo: "OLD100",
        kind: "number-one",
        delta: -4,
      },
      {
        month: "2026-11",
        staffId: staff.id,
        flightNo: "NEW200",
        kind: "number-one",
        delta: 3,
      },
    ];
    const ledgers = structuredClone(state.latePriorityFrequencyAdjustments);
    updateConfigurationField(state, "template", "old", "flightNo", "NEW200");
    expect(state.latePriorityFrequencyAdjustments).toEqual(ledgers);
    const statistics = buildMonthlyLatePriorityStatistics(state, "2026-11-20");
    expect(statistics.rows[0]!.categories["一号"].effectiveCount).toBe(3);
  });
});
