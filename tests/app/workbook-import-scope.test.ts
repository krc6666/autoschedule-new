import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";

import { createDefaultState } from "../../src/defaults";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { buildConfigWorkbook } from "../../src/infrastructure/excel";
import type { PositionRule } from "../../src/model";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

function createImportFile(
  positionRules?: PositionRule[],
  includeWeeklyPlan = true,
  weeklyFlightNo = "SHARED200"
) {
  const source = createDefaultState();
  const sourceTemplate = { ...source.templates[0]!, flightNo: "SHARED200" };
  source.templates = [sourceTemplate];
  source.positionRules =
    positionRules ??
    source.positionRules
      .filter((rule) => rule.flightNo === "CX937")
      .map((rule) => ({ ...rule, flightNo: "SHARED200" }));
  source.weeklyFlightPlans = replaceWeeklyFlightPlan(
    source.weeklyFlightPlans,
    2,
    [weeklyFlightNo]
  );
  source.positionRules[0]!.category = "分流";
  source.settings.maxDailyHours = 7.5;
  const workbook = buildConfigWorkbook(source);
  if (!includeWeeklyPlan) {
    delete workbook.Sheets["每周航班计划"];
    workbook.SheetNames = workbook.SheetNames.filter(
      (name) => name !== "每周航班计划"
    );
  }
  const bytes = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  });
  return new File([bytes], "config.xlsx");
}

function createCoordinator() {
  const state = createDefaultState();
  state.groups.A.staff = [{ ...state.staff[0]!, id: "A-only" }];
  state.groups.A.positionRules[0]!.category = "引导";
  state.groups.A.settings.maxDailyHours = 10;
  state.groups.B.staff = [{ ...state.staff[0]!, id: "B-only" }];
  state.groups.B.positionRules[0]!.category = "常规";
  state.groups.B.settings.maxDailyHours = 8.5;
  state.activeGroupId = "B";
  state.staff = state.groups.B.staff;
  state.positionRules = state.groups.B.positionRules;
  state.settings = state.groups.B.settings;
  state.flights = state.groups.B.flights;
  state.history = state.groups.B.history;
  state.dutyRosterOverrides = state.groups.B.dutyRosterOverrides;
  state.assignments = state.groups.B.assignments;
  const store = createTestAutoscheduleStore(state);
  return createTestApplicationCoordinator(store, {
    preferences: {
      loadScheduleDate: () => "2026-10-26",
      saveScheduleDate: () => undefined,
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => undefined,
    },
  });
}

describe("workbook import scope", () => {
  it("previews without writing and imports the workbook weekly plan on confirmation", async () => {
    const coordinator = createCoordinator();
    const before = structuredClone(coordinator.model());
    const file = createImportFile();

    await coordinator.handle({ type: "import-file", file, mode: "config" });
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: true,
    });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });

    const preview = coordinator.view().dialog;
    expect(preview?.kind).toBe("workbook-import");
    if (preview?.kind !== "workbook-import")
      throw new Error("missing workbook import preview");
    expect(preview.sharedTemplatesAvailable).toBe(true);
    expect(preview.replaceSharedTemplates).toBe(false);
    expect(coordinator.model()).toEqual(before);

    await coordinator.handle({ type: "apply-workbook-import" });

    expect(coordinator.model().positionRules[0]!.category).toBe("分流");
    expect(coordinator.model().settings.maxDailyHours).toBe(7.5);
    expect(coordinator.model().templates.map((item) => item.flightNo)).toEqual([
      ...before.templates.map((item) => item.flightNo),
      "SHARED200",
    ]);
    expect(
      coordinator.model().weeklyFlightPlans.find((entry) => entry.weekday === 2)
        ?.flightNos
    ).toEqual(["SHARED200"]);
    expect(coordinator.model().groups.A.positionRules[0]!.category).toBe(
      "引导"
    );
    expect(coordinator.model().groups.A.settings.maxDailyHours).toBe(10);
    expect(coordinator.view().toast?.message).toContain(
      "当前组班表已清空，请到排班页重新排班"
    );
  });

  it("updates shared templates after the preview choice and applies the weekly plan", async () => {
    const coordinator = createCoordinator();

    await coordinator.handle({
      type: "import-file",
      file: createImportFile(),
      mode: "config",
    });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });
    await coordinator.handle({
      type: "set-workbook-import-shared-templates",
      enabled: true,
    });
    await coordinator.handle({ type: "apply-workbook-import" });

    expect(coordinator.model().templates.map((item) => item.flightNo)).toEqual([
      "SHARED200",
    ]);
    expect(
      coordinator.model().weeklyFlightPlans.find((entry) => entry.weekday === 2)
        ?.flightNos
    ).toEqual(["SHARED200"]);
    expect(coordinator.model().groups.A.positionRules[0]!.category).toBe(
      "引导"
    );
    expect(coordinator.model().groups.A.settings.maxDailyHours).toBe(10);
  });

  it("adds imported rule flights before applying the matching weekly selection", async () => {
    const coordinator = createCoordinator();
    const state = coordinator.model();
    const baseRule = state.positionRules[0]!;
    const positionRules = [
      { ...baseRule, id: "a-ke166", flightNo: "KE166", name: "G20" },
      { ...baseRule, id: "a-mf8683", flightNo: "MF8683", name: "H02" },
      { ...baseRule, id: "a-tw616", flightNo: "TW616", name: "G10" },
    ];
    const file = createImportFile(positionRules, true, "KE166");
    const beforeTemplateNos = state.templates.map((item) => item.flightNo);

    await coordinator.handle({ type: "import-file", file, mode: "config" });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });

    const preview = coordinator.view().dialog;
    expect(preview?.kind).toBe("workbook-import");
    if (preview?.kind !== "workbook-import")
      throw new Error("missing workbook import preview");
    expect(preview.replaceSharedTemplates).toBe(false);
    await coordinator.handle({ type: "apply-workbook-import" });

    expect(coordinator.model().templates.map((item) => item.flightNo)).toEqual([
      ...beforeTemplateNos,
      "KE166",
      "MF8683",
      "TW616",
    ]);
    expect(
      coordinator.model().weeklyFlightPlans.find((entry) => entry.weekday === 2)
        ?.flightNos
    ).toEqual(["KE166"]);
  });

  it("imports every weekday selection without replacing all shared templates", async () => {
    const coordinator = createCoordinator();
    const beforeA = structuredClone(coordinator.model().groups.A.positionRules);
    const source = createDefaultState();
    const baseTemplate = source.templates[0]!;
    const baseRules = source.positionRules.filter(
      (rule) => rule.flightNo === baseTemplate.flightNo
    );
    const flightNos = Array.from(
      { length: 7 },
      (_, index) => `WEEK${index + 1}`
    );
    source.templates = flightNos.map((flightNo, index) => ({
      ...baseTemplate,
      id: `weekly-template-${index}`,
      flightNo,
    }));
    source.positionRules = flightNos.flatMap((flightNo, flightIndex) =>
      baseRules.map((rule, ruleIndex) => ({
        ...rule,
        id: `weekly-rule-${flightIndex}-${ruleIndex}`,
        flightNo,
      }))
    );
    source.weeklyFlightPlans = source.weeklyFlightPlans.map((entry) => ({
      ...entry,
      flightNos: [flightNos[entry.weekday - 1]!],
    }));
    const file = new File(
      [
        XLSX.write(buildConfigWorkbook(source), {
          type: "array",
          bookType: "xlsx",
        }),
      ],
      "weekly-config.xlsx"
    );

    await coordinator.handle({ type: "import-file", file, mode: "config" });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });

    const preview = coordinator.view().dialog;
    expect(preview?.kind).toBe("workbook-import");
    if (preview?.kind !== "workbook-import")
      throw new Error("missing workbook import preview");
    expect(preview.replaceSharedTemplates).toBe(false);
    expect(
      preview.weeklyPlanPreview?.plans.map((entry) => entry.flightNos)
    ).toEqual(flightNos.map((flightNo) => [flightNo]));
    expect(preview.weeklyPlanPreview?.unavailableFlightNos).toEqual([]);
    await coordinator.handle({ type: "apply-workbook-import" });

    expect(
      coordinator.model().weeklyFlightPlans.map((entry) => entry.flightNos)
    ).toEqual(flightNos.map((flightNo) => [flightNo]));
    expect(
      coordinator.model().templates.map((template) => template.flightNo)
    ).toEqual(expect.arrayContaining(flightNos));
    expect(coordinator.model().groups.A.positionRules).toEqual(
      expect.arrayContaining(beforeA)
    );
  });

  it("shows unavailable plan flights and recalculates preview when template replacement changes", async () => {
    const coordinator = createCoordinator();
    const source = createDefaultState();
    const plannedFlight = "PLANONLY";
    source.templates = [{ ...source.templates[0]!, flightNo: plannedFlight }];
    source.positionRules = [];
    source.weeklyFlightPlans = replaceWeeklyFlightPlan(
      source.weeklyFlightPlans,
      2,
      [plannedFlight]
    );
    const file = new File(
      [
        XLSX.write(buildConfigWorkbook(source), {
          type: "array",
          bookType: "xlsx",
        }),
      ],
      "plan-only-config.xlsx"
    );

    await coordinator.handle({ type: "import-file", file, mode: "config" });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });

    const initialPreview = coordinator.view().dialog;
    expect(initialPreview?.kind).toBe("workbook-import");
    if (initialPreview?.kind !== "workbook-import")
      throw new Error("missing workbook import preview");
    expect(initialPreview.weeklyPlanPreview?.unavailableFlightNos).toEqual([
      plannedFlight,
    ]);
    expect(
      initialPreview.weeklyPlanPreview?.plans.find(
        (entry) => entry.weekday === 2
      )?.flightNos
    ).toEqual([]);

    await coordinator.handle({
      type: "set-workbook-import-shared-templates",
      enabled: true,
    });

    const updatedPreview = coordinator.view().dialog;
    expect(updatedPreview?.kind).toBe("workbook-import");
    if (updatedPreview?.kind !== "workbook-import")
      throw new Error("missing updated workbook import preview");
    expect(updatedPreview.weeklyPlanPreview?.unavailableFlightNos).toEqual([]);
    expect(
      updatedPreview.weeklyPlanPreview?.plans.find(
        (entry) => entry.weekday === 2
      )?.flightNos
    ).toEqual([plannedFlight]);
    expect(
      coordinator.model().weeklyFlightPlans.find((entry) => entry.weekday === 2)
        ?.flightNos
    ).toEqual([]);
  });

  it("preserves existing weekly plans when the workbook has no weekly plan sheet", async () => {
    const coordinator = createCoordinator();
    const beforePlan = structuredClone(coordinator.model().weeklyFlightPlans);

    await coordinator.handle({
      type: "import-file",
      file: createImportFile(undefined, false),
      mode: "config",
    });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });
    await coordinator.handle({ type: "apply-workbook-import" });

    expect(coordinator.model().weeklyFlightPlans).toEqual(beforePlan);
  });
});
