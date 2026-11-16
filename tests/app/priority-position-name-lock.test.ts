import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import { diagnoseOrdinaryPriorityPosition } from "../../src/domain/rules/policy-configuration-diagnostics";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

function scenario() {
  const state = createDefaultState();
  const rule = state.positionRules[0]!;
  rule.flightNo = "KE160";
  rule.name = "督导";
  rule.category = "机动督导";
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "KE", position: "督导" },
  ];
  return { state, rule };
}

describe("普通重点固定岗位名", () => {
  it.each(["常规", "分流", "机动督导"] as const)(
    "%s 重点改名拒绝，配置和现有班表不变",
    (category) => {
      const { state, rule } = scenario();
      rule.category = category;
      const before = structuredClone(state);
      expect(
        updateConfigurationField(state, "position", rule.id, "name", "现场督导")
      ).toBe("priority-position-name-locked");
      expect(state).toEqual(before);
    }
  );

  it("非重点岗位仍可改名并联动引用", () => {
    const { state, rule } = scenario();
    state.settings.ordinaryPriorityPositions = [];
    expect(
      updateConfigurationField(state, "position", rule.id, "name", "现场督导")
    ).toBe("updated");
    expect(rule.name).toBe("现场督导");
  });

  it("公开页面命令提示拒绝原因并保留原岗位", async () => {
    const { state, rule } = scenario();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      {
        preferences: {
          loadScheduleDate: () => null,
          saveScheduleDate: () => undefined,
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => undefined,
        },
      }
    );
    await coordinator.handle({
      type: "update-configuration",
      entity: "position",
      id: rule.id,
      field: "name",
      value: "现场督导",
    });
    expect(
      coordinator.model().positionRules.find((r) => r.id === rule.id)?.name
    ).toBe("督导");
    expect(coordinator.view().toast?.message).toContain("重点岗位名称固定");
  });

  it("导入等来源造成名称不一致时给出诊断，同航司换号仍匹配", () => {
    const { state, rule } = scenario();
    rule.flightNo = "KE777";
    expect(diagnoseOrdinaryPriorityPosition(state, 0)).toEqual([]);
    rule.name = "现场督导";
    expect(diagnoseOrdinaryPriorityPosition(state, 0)[0]?.code).toBe(
      "ordinary-position-missing"
    );
  });
});
