import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  flightPlanReview,
  type FlightPlanTemplateReviewChoice,
} from "../../src/domain/flights/flight-plan-review";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { seasonalState } from "../helpers/seasonal-flight-scenario";
import { applyWorkbookImport } from "../../src/app/workbook-actions";

const preferences = {
  loadScheduleDate: () => "2026-11-11",
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};
function choice(
  state: ReturnType<typeof seasonalState>,
  action: FlightPlanTemplateReviewChoice["action"]
): FlightPlanTemplateReviewChoice {
  const template = state.templates[0]!;
  return {
    action,
    expectedSourceFlightNos: flightPlanReview(state).sourceFlightNos,
    templateId: template.id,
    expectedFlightNo: template.flightNo,
    expectedStartTime: template.startTime,
    expectedEndTime: template.endTime,
    previousFlightNo: "OLD100",
  };
}
function currentB() {
  const store = createTestAutoscheduleStore(seasonalState());
  store.getState().switchGroup("B");
  return store;
}
function bytes(state: ReturnType<typeof seasonalState>) {
  return parseWorkbook(
    XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "buffer",
        bookType: "xlsx",
      })
    ),
    []
  );
}

describe("seasonal flight confirmation and group isolation", () => {
  it("uses actual group job flights as the season and keeps spare templates without a missing-job warning", () => {
    const state = seasonalState();
    state.groups.B.positionRules = structuredClone(state.positionRules);
    state.groups.B.flights = [];
    state.templates.push({
      ...state.templates[0]!,
      id: "spare",
      flightNo: "SPARE100",
    });
    expect(flightPlanReview(state).count).toBe(0);
    expect(flightPlanReview(state, "B").count).toBe(0);
    expect(state.templates.map((r) => r.flightNo)).toContain("SPARE100");
  });

  it("compares A and B seasons in either direction and refuses a stale source list", () => {
    const store = currentB();
    expect(flightPlanReview(store.getState().model).sourceFlightNos).toEqual([
      "NEW100",
    ]);
    const aReview = flightPlanReview(store.getState().model, "A");
    expect(aReview.sourceFlightNos).toEqual(["OLD100"]);
    expect(aReview.unmatchedFlightNos).toContain("NEW100");
    const command = choice(store.getState().model, "rename");
    const state = structuredClone(store.getState().model);
    state.groups.A.positionRules.push({
      ...state.groups.A.positionRules[0]!,
      id: "another",
      flightNo: "NEW200",
    });
    store.getState().replaceModel(state);
    const before = structuredClone(store.getState().model);
    expect(store.getState().configuration.reviewFlightPlan(command).ok).toBe(
      false
    );
    expect(store.getState().model).toEqual(before);
  });

  it.each(["rename", "retire-flight"] as const)(
    "handles %s across every current reference in only B while preserving history and the other group",
    (action) => {
      const store = currentB();
      const state = structuredClone(store.getState().model);
      const settings = state.settings;
      settings.latePriorityFlightNumbers = ["OLD100"];
      settings.positionTransitionPolicies = [
        {
          id: "transition",
          name: "link",
          enabled: true,
          sourceFlightNo: "OLD100",
          sourcePositions: ["H03"],
          targetFlightNo: "OLD100",
          targetPosition: "H03",
          minimumGapMinutes: 90,
          mode: "forbid",
        },
      ];
      settings.dutyPositionPriorities = [
        {
          id: "duty",
          flightNo: "OLD100",
          positionKeyword: "H03",
          enabled: true,
        },
      ];
      settings.nextWorkdayRecoveryTargets = [
        {
          id: "target",
          flightNo: "OLD100",
          positionKeyword: "H03",
          enabled: true,
        },
      ];
      settings.lateShiftRecoveryPositionRules = [
        {
          id: "late",
          enabled: true,
          flightNo: "OLD100",
          matchField: "position",
          keyword: "H03",
          nextWorkdayCutoffTime: "18:00",
        },
      ];
      settings.mobileSupervisorCoverageRules = [
        {
          id: "coverage",
          enabled: false,
          flightNo: "OLD100",
          matchField: "position",
          keyword: "H03",
          mode: "forbid",
        },
      ];
      settings.mobileSupervisorFillRules = [
        {
          id: "fill",
          enabled: true,
          sourceFlightNo: "OLD100",
          sourcePositionKeyword: "H03",
          targetFlightNo: "OLD100",
          targetPositionKeyword: "H04",
          allowAutomatic: false,
          allowManual: true,
        },
      ];
      settings.crossWorkdayQualificationReservations = [
        {
          id: "reserve",
          enabled: true,
          flightNo: "OLD100",
          matchField: "position",
          keyword: "H03",
          minimumStaffCount: 2,
        },
      ];
      settings.crossFlightPriorityPolicies = [
        { id: "cross", enabled: true, flightNo: "OLD100", staffIds: [] },
      ];
      settings.sameFlightStaffExclusions = [
        {
          id: "exclude",
          enabled: false,
          flightNo: "OLD100",
          firstStaffId: "b1",
          secondStaffId: "b2",
        },
      ];
      settings.teamLeaderGapFillPositionPolicies = [
        { flightNo: "OLD100", position: "H03", movable: false },
      ];
      state.latePriorityFrequencyAdjustments = [
        {
          month: "2026-11",
          staffId: "b1",
          flightNo: "OLD100",
          kind: "supervisor",
          delta: 2,
        },
      ];
      state.history = [
        {
          id: "past",
          date: "2026-11-09",
          flightNo: "OLD100",
          position: "H03",
          staffId: "b1",
          staffName: "匿名",
          startTime: "10:00",
          endTime: "12:00",
          workHours: 2,
          fatiguePoints: 2,
          remark: "过去原文",
        },
      ];
      state.activeScheduleDate = "2026-11-11";
      store.getState().replaceModel(state);
      const original = structuredClone(store.getState().model);
      const result = store.getState().configuration.reviewFlightPlan(
        action === "rename"
          ? choice(original, "rename")
          : {
              action,
              previousFlightNo: "OLD100",
              expectedSourceFlightNos:
                flightPlanReview(original).sourceFlightNos,
            }
      );
      expect(result.ok).toBe(true);
      const after = store.getState().model;
      if (action === "retire-flight") {
        expect(after.positionRules).toEqual([]);
        expect(after.flights).toEqual([]);
        for (const key of [
          "latePriorityFlightNumbers",
          "positionTransitionPolicies",
          "dutyPositionPriorities",
          "nextWorkdayRecoveryTargets",
          "lateShiftRecoveryPositionRules",
          "mobileSupervisorCoverageRules",
          "mobileSupervisorFillRules",
          "crossWorkdayQualificationReservations",
          "crossFlightPriorityPolicies",
          "sameFlightStaffExclusions",
          "teamLeaderGapFillPositionPolicies",
        ] as const)
          expect(after.settings[key]).toEqual([]);
        expect(after.history).toEqual(original.history);
        expect(after.groups.A).toEqual(original.groups.A);
        expect(after.templates).toEqual(original.templates);
        expect(after.weeklyFlightPlans).toEqual(original.weeklyFlightPlans);
        expect(after.latePriorityFrequencyAdjustments).toEqual(
          original.latePriorityFrequencyAdjustments
        );
        expect(after.ordinaryPriorityFrequencyAdjustments).toEqual(
          original.ordinaryPriorityFrequencyAdjustments
        );
        expect(after.activeScheduleDate).toBeNull();
        return;
      }
      expect(after.settings).toEqual(
        JSON.parse(
          JSON.stringify(original.settings).replaceAll("OLD100", "NEW100")
        )
      );
      expect(after.positionRules).toEqual(
        original.positionRules.map((r) => ({ ...r, flightNo: "NEW100" }))
      );
      expect(after.flights[0]).toMatchObject({
        flightNo: "NEW100",
        startTime: "13:00",
        endTime: "15:00",
        bookedPassengers: 123,
        remark: original.flights[0]!.remark,
      });
      expect(after.history).toEqual(original.history);
      expect(after.groups.A).toEqual(original.groups.A);
      expect(after.templates).toEqual(original.templates);
      expect(after.weeklyFlightPlans).toEqual(original.weeklyFlightPlans);
      expect(after.latePriorityFrequencyAdjustments[0]!.flightNo).toBe(
        "NEW100"
      );
      expect(after.activeScheduleDate).toBeNull();
      expect(flightPlanReview(after).unmatchedFlightNos).not.toContain(
        "OLD100"
      );
    }
  );

  it("records truly new flights without inheriting jobs or clearing schedules, and carries confirmation through XLSX and reload", () => {
    const store = currentB();
    const before = structuredClone(store.getState().model);
    expect(
      store
        .getState()
        .configuration.reviewFlightPlan(choice(before, "new-flight")).ok
    ).toBe(true);
    const after = store.getState().model;
    expect(after.positionRules).toEqual(before.positionRules);
    expect(after.flights).toEqual(before.flights);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.groups.A).toEqual(before.groups.A);
    expect(flightPlanReview(after).missingPositions[0]!.confirmedNew).toBe(
      true
    );
    let saved = "";
    saveState(after, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const restored = loadState({ getItem: () => saved });
    expect(flightPlanReview(restored).missingPositions[0]!.confirmedNew).toBe(
      true
    );
    expect(bytes(restored).flightPlanConfirmations).toEqual(
      after.flightPlanConfirmations
    );
    const target = structuredClone(currentB().getState().model);
    const imported = bytes(restored);
    expect(
      applyWorkbookImport(target, imported, "config", {
        restoreFlightConfiguration: true,
      }).errors
    ).toBeUndefined();
    expect(target.flightPlanConfirmations).toEqual(
      after.flightPlanConfirmations
    );
    expect(
      flightPlanReview(target).missingPositions.find(
        (r) => r.template.flightNo === "NEW100"
      )?.confirmedNew
    ).toBe(true);
  });

  it.each(["keep-current-time", "use-template-time"] as const)(
    "makes %s explicit, keeps history and re-warns on any later compared time change",
    (action) => {
      const store = currentB();
      const model = structuredClone(store.getState().model);
      model.flights[0]!.flightNo = "NEW100";
      store.getState().replaceModel(model);
      const before = structuredClone(store.getState().model);
      const row = before.flights[0]!;
      expect(flightPlanReview(before).timeDifferences).toHaveLength(1);
      expect(
        store.getState().configuration.reviewFlightPlan({
          ...choice(before, action),
          flightId: row.id,
          expectedCurrentStartTime: row.startTime,
          expectedCurrentEndTime: row.endTime,
        }).ok
      ).toBe(true);
      expect(
        flightPlanReview(store.getState().model).timeDifferences
      ).toHaveLength(0);
      expect(store.getState().model.history).toEqual(before.history);
      expect(store.getState().model.groups.A).toEqual(before.groups.A);
      const changed = structuredClone(store.getState().model);
      changed.templates[0]!.startTime = "14:00";
      expect(flightPlanReview(changed).timeDifferences).toHaveLength(1);
      if (action === "keep-current-time")
        expect(store.getState().model.flights[0]!.startTime).toBe("10:00");
      else expect(store.getState().model.flights[0]!.startTime).toBe("13:00");
    }
  );

  it("refuses stale previews, unknown mappings and collisions with exact state preservation", () => {
    for (const failure of ["stale", "unknown", "rules", "flights"] as const) {
      const store = currentB();
      const command = choice(store.getState().model, "rename");
      const state = structuredClone(store.getState().model);
      if (failure === "stale") state.templates[0]!.startTime = "14:00";
      if (failure === "unknown") command.previousFlightNo = "GUESS";
      if (failure === "rules")
        state.positionRules.push({
          ...state.positionRules[0]!,
          id: "duplicate",
          flightNo: "NEW100",
        });
      if (failure === "flights")
        state.flights.push({
          ...state.flights[0]!,
          id: "duplicate",
          flightNo: "NEW100",
        });
      store.getState().replaceModel(state);
      const before = structuredClone(store.getState().model);
      expect(store.getState().configuration.reviewFlightPlan(command).ok).toBe(
        false
      );
      expect(store.getState().model).toEqual(before);
    }
  });

  it("keeps confirmations owned by B through repeated switches and storage restoration", () => {
    const store = currentB();
    store
      .getState()
      .configuration.reviewFlightPlan(
        choice(store.getState().model, "new-flight")
      );
    const confirmed = structuredClone(
      store.getState().model.flightPlanConfirmations
    );
    store.getState().switchGroup("A");
    expect(store.getState().model.flightPlanConfirmations).toEqual([]);
    expect(store.getState().model.groups.B.flightPlanConfirmations).toEqual(
      confirmed
    );
    let saved = "";
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const restored = createTestAutoscheduleStore(
      loadState({ getItem: () => saved })
    );
    restored.getState().switchGroup("B");
    expect(restored.getState().model.flightPlanConfirmations).toEqual(
      confirmed
    );
    expect(
      flightPlanReview(restored.getState().model).missingPositions[0]!
        .confirmedNew
    ).toBe(true);
  });

  it("rejects an outdated current-time choice or an incomplete template before any writes", () => {
    for (const invalid of ["current-time", "template-time"] as const) {
      const store = currentB();
      const state = structuredClone(store.getState().model);
      state.flights[0]!.flightNo = "NEW100";
      if (invalid === "template-time") state.templates[0]!.startTime = "";
      store.getState().replaceModel(state);
      const before = structuredClone(store.getState().model);
      const result = store.getState().configuration.reviewFlightPlan({
        ...choice(before, "keep-current-time"),
        flightId: before.flights[0]!.id,
        expectedCurrentStartTime: "09:00",
        expectedCurrentEndTime: "12:00",
      });
      expect(result.ok).toBe(false);
      expect(store.getState().model).toEqual(before);
    }
  });

  it("preserves ordinary missing-sheet imports and refuses duplicate or invalid confirmation rows", () => {
    const store = currentB();
    store
      .getState()
      .configuration.reviewFlightPlan(
        choice(store.getState().model, "new-flight")
      );
    const confirmed = structuredClone(
      store.getState().model.flightPlanConfirmations
    );
    store.getState().records.applyWorkbookImport({ warnings: [] }, "config");
    expect(store.getState().model.flightPlanConfirmations).toEqual(confirmed);
    for (const invalid of ["duplicate", "time"] as const) {
      const workbook = buildConfigWorkbook(store.getState().model);
      const sheet = workbook.Sheets["航班换季确认"]!;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
      if (invalid === "duplicate") rows.push([...rows[1]!]);
      else rows[1]![2] = "25:00";
      workbook.Sheets["航班换季确认"] = XLSX.utils.aoa_to_sheet(rows);
      const parsed = parseWorkbook(workbook, []);
      expect(parsed.flightPlanConfirmations).toBeUndefined();
      expect(parsed.warnings.join(" ")).toContain("航班换季确认");
    }
  });

  it("shows stale B references after a shared-template import and after save/reload without modifying B", () => {
    const state = seasonalState();
    state.templates = [{ ...state.templates[0]!, flightNo: "OLD100" }];
    const other = structuredClone(state.groups.B);
    const result = applyWorkbookImport(
      state,
      { templates: seasonalState().templates, warnings: [] },
      "config",
      { replaceSharedTemplates: true }
    );
    expect(
      result.flightPlanReview!.find((r) => r.groupId === "B")!
        .unmatchedFlightNos
    ).toContain("OLD100");
    expect(state.groups.B).toEqual(other);
    let saved = "";
    saveState(state, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    expect(
      flightPlanReview(loadState({ getItem: () => saved }), "B")
        .unmatchedFlightNos
    ).toContain("OLD100");
  });

  it("retains old files, refuses broken confirmation tables in complete restore and never applies confirmations in pure history imports", () => {
    const source = seasonalState();
    const workbook = buildConfigWorkbook(source);
    workbook.Sheets["航班换季确认"] = XLSX.utils.aoa_to_sheet([["bad header"]]);
    const target = createDefaultState();
    const before = structuredClone(target);
    expect(
      applyWorkbookImport(target, parseWorkbook(workbook, []), "config", {
        restoreFlightConfiguration: true,
      }).errors?.join(" ")
    ).toContain("航班换季确认");
    expect(target).toEqual(before);
    delete workbook.Sheets["航班换季确认"];
    workbook.SheetNames = workbook.SheetNames.filter(
      (n) => n !== "航班换季确认"
    );
    const imported = parseWorkbook(workbook, []);
    expect(
      applyWorkbookImport(target, imported, "config", {
        restoreFlightConfiguration: true,
      }).errors
    ).toBeUndefined();
    expect(target.flightPlanConfirmations).toEqual([]);
    const store = currentB();
    store
      .getState()
      .configuration.reviewFlightPlan(
        choice(store.getState().model, "new-flight")
      );
    const confirmations = structuredClone(
      store.getState().model.flightPlanConfirmations
    );
    store
      .getState()
      .records.applyWorkbookImport(
        { flightPlanConfirmations: [], warnings: [] },
        "history"
      );
    expect(store.getState().model.flightPlanConfirmations).toEqual(
      confirmations
    );
  });

  it("rejects cancellation and wrong-group commands before writing", async () => {
    for (const allow of [false, true]) {
      const store = currentB();
      const coordinator = createTestApplicationCoordinator(store, {
        preferences,
        confirm: () => allow,
      });
      const before = structuredClone(store.getState().model);
      await coordinator.handle({
        type: "confirm-flight-plan-review",
        groupId: allow ? "A" : "B",
        choice: choice(before, "rename"),
      });
      expect(store.getState().model).toEqual(before);
    }
  });

  it("retires an unmatched old flight in only the current group and preserves history and frequency ledgers", async () => {
    const store = currentB();
    const model = structuredClone(store.getState().model);
    model.staff = [{ ...createDefaultState().staff[0]!, id: "b-person" }];
    const person = model.staff[0]!;
    model.templates.push({
      ...model.templates[0]!,
      id: "old-library",
      flightNo: "OLD100",
    });
    model.settings.latePriorityFlightNumbers = ["OLD100", "NEW100"];
    model.settings.dutyPositionPriorities = [
      {
        id: "old-duty",
        flightNo: "OLD100",
        positionKeyword: "H03",
        enabled: true,
      },
      {
        id: "keep-duty",
        flightNo: "NEW100",
        positionKeyword: "H03",
        enabled: true,
      },
    ];
    model.history = [
      {
        id: "past",
        date: "2026-11-09",
        flightNo: "OLD100",
        position: "H03",
        staffId: person.id,
        staffName: "匿名",
        startTime: "10:00",
        endTime: "12:00",
        workHours: 2,
        fatiguePoints: 2,
        remark: "实际历史",
      },
    ];
    model.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: person.id,
        flightNo: "OLD100",
        kind: "supervisor",
        delta: 2,
      },
    ];
    model.activeScheduleDate = "2026-11-11";
    model.flightPlanConfirmations = [
      {
        kind: "new-flight",
        flightNo: "OLD100",
        templateStartTime: "10:00",
        templateEndTime: "12:00",
        currentStartTime: "",
        currentEndTime: "",
      },
    ];
    store.getState().replaceModel(model);
    const before = structuredClone(store.getState().model);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
      confirm: () => true,
    });
    await coordinator.handle({
      type: "confirm-flight-plan-review",
      groupId: "B",
      choice: {
        action: "retire-flight",
        previousFlightNo: "OLD100",
        expectedSourceFlightNos: flightPlanReview(before).sourceFlightNos,
      },
    });
    const after = store.getState().model;
    expect(after.flights).toEqual([]);
    expect(after.positionRules).toEqual([]);
    expect(after.settings.latePriorityFlightNumbers).toEqual(["NEW100"]);
    expect(after.settings.dutyPositionPriorities.map((r) => r.id)).toEqual([
      "keep-duty",
    ]);
    expect(after.groups.A).toEqual(before.groups.A);
    expect(after.templates).toEqual(before.templates);
    expect(after.weeklyFlightPlans).toEqual(before.weeklyFlightPlans);
    expect(after.history).toEqual(before.history);
    expect(after.latePriorityFrequencyAdjustments).toEqual(
      before.latePriorityFrequencyAdjustments
    );
    expect(after.ordinaryPriorityFrequencyAdjustments).toEqual(
      before.ordinaryPriorityFrequencyAdjustments
    );
    expect(after.activeScheduleDate).toBeNull();
    expect(after.assignments).toEqual([]);
    expect(after.flightPlanConfirmations).toEqual([]);
    expect(flightPlanReview(after).unmatchedFlightNos).not.toContain("OLD100");
    let saved = "";
    saveState(after, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    expect(
      flightPlanReview(loadState({ getItem: () => saved })).unmatchedFlightNos
    ).not.toContain("OLD100");
    const target = currentB();
    const imported = target
      .getState()
      .records.applyWorkbookImport(bytes(after), "config", {
        restoreFlightConfiguration: true,
      });
    expect(imported.errors).toBeUndefined();
    expect(
      flightPlanReview(target.getState().model).unmatchedFlightNos
    ).not.toContain("OLD100");
    expect(target.getState().model.history).toMatchObject(after.history);
  });

  it("refuses cancelled retirement and outdated old-flight choices without changing state", async () => {
    for (const failure of ["cancel", "source-changed", "unknown"] as const) {
      const store = currentB();
      if (failure === "source-changed") {
        const model = structuredClone(store.getState().model);
        model.groups.A.positionRules.push({
          ...model.groups.A.positionRules[0]!,
          id: "source-old",
          flightNo: "OLD100",
        });
        store.getState().replaceModel(model);
      }
      const before = structuredClone(store.getState().model);
      const coordinator = createTestApplicationCoordinator(store, {
        preferences,
        confirm: () => failure !== "cancel",
      });
      await coordinator.handle({
        type: "confirm-flight-plan-review",
        groupId: "B",
        choice: {
          action: "retire-flight",
          previousFlightNo: failure === "unknown" ? "GUESS" : "OLD100",
          expectedSourceFlightNos: flightPlanReview(before).sourceFlightNos,
        },
      });
      expect(store.getState().model).toEqual(before);
    }
  });
});
