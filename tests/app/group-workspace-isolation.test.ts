import { describe, expect, it } from "vitest";

import { createTestAutoscheduleStore } from "../helpers/application";
import { createDefaultState } from "../../src/defaults";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { buildDailyStaffFlightStatistics } from "../../src/domain/statistics/daily-staff-flight-statistics";
import { getDutyRosterForDate } from "../../src/domain/duty-roster/roster";

describe("group workspace isolation", () => {
  it("uses only the active group's history for statistics and archive reads", () => {
    const initial = createDefaultState();
    initial.groups.A.settings.dutyFatiguePoints = 0;
    initial.groups.B.settings.dutyFatiguePoints = 0;
    initial.settings = initial.groups.A.settings;
    const a = initial.staff[0]!;
    const b = { ...initial.staff[1]!, id: "b-only", name: "B组人员" };
    initial.groups.A.staff = [a];
    initial.groups.A.history = [
      {
        id: "a-history",
        date: "2026-08-01",
        flightNo: "A-FLIGHT",
        position: "G01",
        staffId: a.id,
        staffName: a.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
    ];
    initial.staff = initial.groups.A.staff;
    initial.history = initial.groups.A.history;
    initial.groups.B.staff = [b];
    initial.groups.B.history = [
      {
        id: "b-history",
        date: "2026-08-01",
        flightNo: "B-FLIGHT",
        position: "G01",
        staffId: b.id,
        staffName: b.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
    ];
    const store = createTestAutoscheduleStore(initial);

    store.getState().switchGroup("B");
    expect(
      buildDailyStaffFlightStatistics(
        store.getState().model,
        "2026-08-01"
      ).rows.map((row) => row.staffId)
    ).toEqual([b.id]);
    expect(
      currentScheduleHistory(store.getState().model, "2026-08-01")
    ).toEqual([]);

    store.getState().switchGroup("A");
    expect(
      buildDailyStaffFlightStatistics(
        store.getState().model,
        "2026-08-01"
      ).rows.map((row) => row.staffId)
    ).toEqual([a.id]);
  });

  it("keeps duty and standby overrides in the active group", () => {
    const initial = createDefaultState();
    const a = initial.staff[0]!;
    const b = { ...initial.staff[1]!, id: "b-only", name: "B组人员" };
    initial.groups.A.staff = [a];
    initial.groups.A.dutyRosterOverrides = [
      {
        date: "2026-08-01",
        cxPreflightStaffId: null,
        dutyStaffId: a.id,
        standbyStaffIds: [a.id, null],
      },
    ];
    initial.staff = initial.groups.A.staff;
    initial.dutyRosterOverrides = initial.groups.A.dutyRosterOverrides;
    initial.groups.B.staff = [b];
    initial.groups.B.dutyRosterOverrides = [
      {
        date: "2026-08-01",
        cxPreflightStaffId: null,
        dutyStaffId: b.id,
        standbyStaffIds: [b.id, null],
      },
    ];
    const store = createTestAutoscheduleStore(initial);

    store.getState().switchGroup("B");
    expect(
      getDutyRosterForDate(store.getState().model, "2026-08-01").dutyStaffId
    ).toBe(b.id);
    store.getState().switchGroup("A");
    expect(
      getDutyRosterForDate(store.getState().model, "2026-08-01").dutyStaffId
    ).toBe(a.id);
  });

  it("projects and edits only the active group's position and scheduling rules", () => {
    const initial = createDefaultState();
    initial.groups.A.positionRules[0]!.category = "分流";
    initial.groups.A.settings.maxDailyHours = 9.5;
    initial.groups.B.positionRules[0]!.category = "常规";
    initial.groups.B.settings.maxDailyHours = 8.5;
    initial.positionRules = initial.groups.A.positionRules;
    initial.settings = initial.groups.A.settings;
    const store = createTestAutoscheduleStore(initial);

    expect(store.getState().model.positionRules[0]!.category).toBe("分流");
    expect(store.getState().model.settings.maxDailyHours).toBe(9.5);

    store.getState().switchGroup("B");
    expect(store.getState().model.positionRules[0]!.category).toBe("常规");
    expect(store.getState().model.settings.maxDailyHours).toBe(8.5);
    store
      .getState()
      .configuration.updateField("settings", "", "maxDailyHours", 7.5);

    store.getState().switchGroup("A");
    expect(store.getState().model.positionRules[0]!.category).toBe("分流");
    expect(store.getState().model.settings.maxDailyHours).toBe(9.5);
    store.getState().switchGroup("B");
    expect(store.getState().model.positionRules[0]!.category).toBe("常规");
    expect(store.getState().model.settings.maxDailyHours).toBe(7.5);
  });

  it("persists and restores different group rules without copying either over", () => {
    const state = createDefaultState();
    state.groups.A.positionRules[0]!.category = "分流";
    state.groups.A.settings.maxDailyHours = 9.5;
    state.groups.B.positionRules[0]!.category = "常规";
    state.groups.B.settings.maxDailyHours = 8.5;
    state.positionRules = state.groups.A.positionRules;
    state.settings = state.groups.A.settings;
    const store = createTestAutoscheduleStore(state);
    let serialized = "";

    store.getState().switchGroup("B");
    store.getState().persist();
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        serialized = value;
      },
    });

    const restored = createTestAutoscheduleStore(
      loadState({ getItem: () => serialized })
    );
    expect(restored.getState().model.groups.A.positionRules[0]!.category).toBe(
      "分流"
    );
    expect(restored.getState().model.groups.A.settings.maxDailyHours).toBe(9.5);
    expect(restored.getState().model.positionRules[0]!.category).toBe("常规");
    expect(restored.getState().model.settings.maxDailyHours).toBe(8.5);
    restored.getState().switchGroup("A");
    expect(restored.getState().model.positionRules[0]!.category).toBe("分流");
    expect(restored.getState().model.settings.maxDailyHours).toBe(9.5);
  });

  it("keeps group position edits on store creation and model replacement", () => {
    const initial = createDefaultState();
    const template = { ...initial.templates[0]!, positions: ["H1", "H2"] };
    const ruleA = {
      ...initial.positionRules[0]!,
      id: "a-h1",
      flightNo: template.flightNo,
      name: "H1",
      category: "分流" as const,
    };
    const ruleB = {
      ...initial.groups.B.positionRules[0]!,
      id: "b-h1",
      flightNo: template.flightNo,
      name: "H1",
      category: "常规" as const,
    };
    initial.templates = [template];
    initial.shared.templates = [template];
    initial.groups.A.positionRules = [ruleA];
    initial.groups.B.positionRules = [ruleB];
    initial.positionRules = initial.groups.A.positionRules;

    const store = createTestAutoscheduleStore(initial);

    expect(
      store.getState().model.groups.A.positionRules.map((rule) => rule.name)
    ).toEqual(["H1"]);
    expect(
      store.getState().model.groups.B.positionRules.map((rule) => rule.name)
    ).toEqual(["H1"]);
    expect(store.getState().model.groups.A.positionRules[0]!.category).toBe(
      "分流"
    );
    expect(store.getState().model.groups.B.positionRules[0]!.category).toBe(
      "常规"
    );

    const replacement = structuredClone(initial);
    store.getState().replaceModel(replacement);
    expect(store.getState().model.groups.A.positionRules).toHaveLength(1);
    expect(store.getState().model.groups.B.positionRules).toHaveLength(1);
  });
});
