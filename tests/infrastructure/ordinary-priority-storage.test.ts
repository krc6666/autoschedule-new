import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { restorePersistedState } from "../../src/infrastructure/state-restoration";

describe("普通重点集合状态", () => {
  it("旧版本迁移时预填现有五类普通岗位，且保留末班账本", () => {
    const fallback = createDefaultState();
    const legacy = structuredClone(fallback) as unknown as Record<
      string,
      unknown
    >;
    legacy.version = 7;
    delete legacy.ordinaryPriorityFrequencyAdjustments;
    const restored = restorePersistedState(legacy, fallback)!;
    expect(restored.version).toBe(11);
    expect(restored.settings.ordinaryPriorityPositions.length).toBeGreaterThan(
      0
    );
    expect(restored.latePriorityFrequencyAdjustments).toEqual(
      fallback.latePriorityFrequencyAdjustments
    );
  });
});
