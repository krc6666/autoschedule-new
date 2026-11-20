import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  flightIdentityKey,
  flightIdentityLabel,
  sameFlightIdentity,
  validateFlightIdentities,
  flightRuleMatches,
} from "../../src/domain/flights/flight-identities";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { scheduleRuleFingerprint } from "../../src/domain/rules/schedule-rule-fingerprint";

const catalog = [
  {
    id: "cx-service",
    displayName: "CX937",
    aliases: [
      { flightNo: "CX937早" },
      { flightNo: "CX937晚" },
      { flightNo: "CX937" },
      { flightNo: "CX999" },
    ],
  },
];

describe("长期航班身份与实际班次分离", () => {
  it("显式归并任意号码，原名称与实际班次不改", () => {
    const state = createDefaultState();
    state.shared.flightIdentities = catalog;
    const before = structuredClone(state.flights);
    expect(flightIdentityKey(state, "CX937早")).toBe("@CX-SERVICE");
    expect(sameFlightIdentity(state, "CX999", "CX937晚")).toBe(true);
    expect(flightRuleMatches(state, "CX937晚", "CX999")).toBe(true);
    expect(flightIdentityLabel(state, "@cx-service")).toBe("CX937");
    expect(sameFlightIdentity(state, "CX938", "CX937")).toBe(false);
    expect(state.flights).toEqual(before);
  });
  it("同号跨期复用按日期识别，缺日期不猜", () => {
    const state = createDefaultState();
    state.shared.flightIdentities = [
      {
        id: "old",
        displayName: "旧航班",
        aliases: [{ flightNo: "AB123", until: "2026-10-31" }],
      },
      {
        id: "new",
        displayName: "新航班",
        aliases: [{ flightNo: "AB123", from: "2026-11-01" }],
      },
    ];
    expect(validateFlightIdentities(state.shared.flightIdentities)).toEqual([]);
    expect(flightIdentityKey(state, "AB123", "2026-10-10")).toBe("@OLD");
    expect(flightIdentityKey(state, "AB123", "2026-11-10")).toBe("@NEW");
    expect(flightIdentityKey(state, "AB123")).toBe("AB123");
    expect(flightRuleMatches(state, "@old", "AB123", "2026-11-10")).toBe(false);
  });
  it("拒绝日期重叠和坏目录，Worker与规则指纹消费同一事实", () => {
    const state = createDefaultState();
    const oldFingerprint = scheduleRuleFingerprint(state);
    state.shared.flightIdentities = catalog;
    expect(createScheduleGenerationFacts(state).flightIdentities).toEqual(
      catalog
    );
    expect(scheduleRuleFingerprint(state)).not.toBe(oldFingerprint);
    expect(
      validateFlightIdentities([
        ...catalog,
        { ...catalog[0]!, id: "duplicate" },
      ]).length
    ).toBeGreaterThan(0);
    expect(
      validateFlightIdentities([
        {
          id: "bad",
          displayName: "",
          aliases: [{ flightNo: "X", from: "2026-02-30" }],
        },
      ]).length
    ).toBeGreaterThan(0);
  });
});
