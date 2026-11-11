import { withConfiguredFlightPositions } from "../../src/domain/flights/configured-flight-positions";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import type { AppState } from "../../src/model";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  SCHEDULE_SETTING_DEFINITIONS,
  applyScheduleSettingsPatch,
} from "../../src/domain/rules/schedule-settings";
import { updatePolicyEntityField } from "../../src/app/policy-actions";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

const restore = { restoreFlightConfiguration: true };
const parse = (state: AppState) =>
  parseWorkbook(
    XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "buffer",
        bookType: "xlsx",
      })
    ),
    []
  );
function facts(state: AppState) {
  const { adminSupportEnabled: _mode, ...settings } = state.settings;
  return {
    settings,
    staff: state.staff,
    leaveTypes: state.leaveTypes,
    halfRestSelections: state.halfRestSelections,
    flights: withConfiguredFlightPositions(
      state.flights,
      state.positionRules
    ).map(({ id: _id, ...v }) => v),
    templates: withConfiguredFlightPositions(
      state.templates,
      state.positionRules
    ).map(({ id: _id, ...v }) => v),
    positionRules: state.positionRules.map(
      ({ id: _id, coverageRole: _role, ...v }) => v
    ),
    weeklyFlightPlans: state.weeklyFlightPlans,
    dutyRosterOverrides: state.dutyRosterOverrides,
    latePriorityFrequencyAdjustments: state.latePriorityFrequencyAdjustments,
    ordinaryPriorityFrequencyAdjustments:
      state.ordinaryPriorityFrequencyAdjustments,
  };
}
describe("complete configuration device transfer", () => {
  it("accounts for every declared setting and group field so new fields cannot silently miss Excel", () => {
    const source = ts.createSourceFile(
      "model.ts",
      readFileSync("src/model.ts", "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const fields = (name: string) => {
      const declaration = source.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(statement) && statement.name.text === name
      );
      expect(declaration, `missing model interface ${name}`).toBeDefined();
      return declaration!.members
        .map((member) => member.name!.getText(source))
        .sort();
    };
    const imported = parse(createDefaultState());
    expect(Object.keys(imported.settings!).sort()).toEqual(
      fields("ScheduleSettings").filter((key) => key !== "adminSupportEnabled")
    );
    const persistedConfiguration = [
      "flightPlanConfirmations",
      "halfRestSelections",
      "leaveTypes",
      "flights",
      "staff",
      "positionRules",
      "settings",
      "history",
      "dutyRosterOverrides",
      "latePriorityFrequencyAdjustments",
      "ordinaryPriorityFrequencyAdjustments",
    ];
    // Configuration restores invalidate the current result; these are generated state.
    const regeneratedSchedule = [
      "assignments",
      "activeScheduleDate",
      "schedulePolicyStale",
      "scheduleRuleFingerprint",
    ];
    expect([...persistedConfiguration, ...regeneratedSchedule].sort()).toEqual(
      fields("GroupWorkspace")
    );
    for (const field of persistedConfiguration)
      expect(
        imported[field as keyof typeof imported],
        `Excel omitted group field ${field}`
      ).toBeDefined();
  });

  it("preserves compound rule positions, zero fatigue and manual qualifications through actual XLSX bytes", () => {
    const source = createDefaultState();
    source.settings.positionTransitionPolicies[0]!.sourcePositions = [
      "督导/引导",
      "送资料",
    ];
    source.positionRules[0]!.fatiguePoints = 0;
    source.positionRules[1]!.manual = true;
    source.positionRules[1]!.qualifiedStaffIds = [source.staff[0]!.id];
    const imported = parse(source);
    expect(imported.settings!.positionTransitionPolicies).toEqual(
      source.settings.positionTransitionPolicies
    );
    expect(imported.positionRules!.map((r) => r.fatiguePoints)).toEqual(
      source.positionRules.map((r) => r.fatiguePoints)
    );
    expect(
      imported.positionRules!.find(
        (r) =>
          r.flightNo === source.positionRules[1]!.flightNo &&
          r.name === source.positionRules[1]!.name
      )
    ).toMatchObject({ manual: true, qualifiedStaffIds: [source.staff[0]!.id] });
  });

  it("restores all scalar and structured rules on a device with different existing settings, then survives save/reload and re-export", () => {
    const source = createDefaultState();
    const patch = Object.fromEntries(
      SCHEDULE_SETTING_DEFINITIONS.map((d) => [
        d.key,
        d.type === "boolean"
          ? !d.defaultValue
          : d.type === "time"
            ? "16:23"
            : d.type === "mode"
              ? "forbid"
              : d.defaultValue === d.min
                ? (d.max ?? Number(d.defaultValue) + 1)
                : (d.min ?? 0),
      ])
    );
    source.settings = applyScheduleSettingsPatch(source.settings, patch);
    source.settings.crossWorkdayQualificationReservations = [
      {
        id: "reserve",
        enabled: false,
        flightNo: "TW616",
        matchField: "position",
        keyword: "G16",
        minimumStaffCount: 3,
      },
    ];
    source.settings.crossFlightPriorityPolicies = [
      {
        id: "priority",
        enabled: false,
        flightNo: "TW616",
        staffIds: source.staff.slice(0, 2).map((s) => s.id),
      },
    ];
    source.settings.sameFlightStaffExclusions = [
      {
        id: "exclusion",
        enabled: false,
        flightNo: "TW616",
        firstStaffId: source.staff[0]!.id,
        secondStaffId: source.staff[1]!.id,
      },
    ];
    source.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: "TW616", position: "G16", movable: true },
    ];
    source.settings.mobileSupervisorFillRules[0]!.requiresConfirmation = false;
    source.halfRestSelections = [
      { date: "2026-11-19", modes: { [source.staff[0]!.id]: "early-finish" } },
    ];
    source.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: source.staff[0]!.id,
        flightNo: "TW616",
        kind: "supervisor",
        delta: 2,
      },
    ];
    source.ordinaryPriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: source.staff[0]!.id,
        airlineCode: "TW",
        position: "G16",
        delta: 1,
      },
    ];
    const store = createTestAutoscheduleStore(createDefaultState());
    const result = store
      .getState()
      .records.applyWorkbookImport(parse(source), "config", restore);
    expect(result.errors).toBeUndefined();
    expect(facts(store.getState().model)).toEqual(facts(source));
    let saved = "";
    saveState(store.getState().model, {
      setItem: (_k, v) => {
        saved = v;
      },
    });
    const reloaded = loadState({ getItem: () => saved });
    expect(facts(reloaded)).toEqual(facts(source));
    const second = createDefaultState();
    applyWorkbookImport(second, parse(reloaded), "config", restore);
    expect(facts(second)).toEqual(facts(source));
  });

  it("keeps the source position-rule set even when a template has a deliberately missing position", () => {
    const source = createDefaultState();
    source.positionRules = source.positionRules.filter(
      (r) =>
        !(
          r.flightNo === source.templates[0]!.flightNo &&
          r.name === source.templates[0]!.positions[0]
        )
    );
    const target = createDefaultState();
    const result = applyWorkbookImport(
      target,
      parse(source),
      "config",
      restore
    );
    expect(result.errors).toBeUndefined();
    expect(facts(target)).toEqual(facts(source));
  });

  it.each(["规则参数", "岗位衔接规则"])(
    "rejects missing %s before changing anything in complete restore",
    (sheetName) => {
      const book = buildConfigWorkbook(createDefaultState());
      delete book.Sheets[sheetName];
      book.SheetNames = book.SheetNames.filter((n) => n !== sheetName);
      const target = createDefaultState(),
        before = structuredClone(target);
      const result = applyWorkbookImport(
        target,
        parseWorkbook(book, []),
        "config",
        restore
      );
      expect(result.errors?.join(" ")).toContain(sheetName);
      expect(target).toEqual(before);
    }
  );

  it("rejects a missing scalar and a broken rule table without mixing old settings, while ordinary import remains partial", () => {
    for (const invalidRule of [false, true]) {
      const book = buildConfigWorkbook(createDefaultState());
      if (invalidRule)
        book.Sheets["岗位衔接规则"]!["I2"] = { t: "s", v: "invalid" };
      else {
        const data = XLSX.utils.sheet_to_json<unknown[]>(
          book.Sheets["规则参数"]!,
          { header: 1 }
        );
        book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
          data.filter((r) => r[0] !== "minimumRegularTransitionMinutes")
        );
      }
      const target = createDefaultState(),
        before = structuredClone(target);
      const imported = parseWorkbook(book, []);
      expect(
        applyWorkbookImport(target, imported, "config", restore).errors?.length
      ).toBeGreaterThan(0);
      expect(target).toEqual(before);
      expect(
        applyWorkbookImport(target, imported, "config").errors
      ).toBeUndefined();
    }
  });

  it("restores a file missing only newer statistics, leave types and half-rest sections using device-independent initial values", () => {
    const source = createDefaultState();
    const book = buildConfigWorkbook(source);
    const newKeys = [
      "morningStatsStartTime",
      "morningStatsEndTime",
      "eveningStatsStartTime",
      "eveningStatsEndTime",
    ];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["规则参数"]!, {
      header: 1,
    });
    book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
      rows.filter((row) => !newKeys.includes(String(row[0])))
    );
    for (const sheet of ["休假类别", "半休选择"]) {
      delete book.Sheets[sheet];
      book.SheetNames = book.SheetNames.filter((n) => n !== sheet);
    }
    const imported = parseWorkbook(book, []);
    for (const variant of [false, true]) {
      const target = createDefaultState();
      target.settings.morningStatsStartTime = variant ? "04:23" : "07:23";
      target.settings.eveningStatsStartTime = variant ? "17:23" : "20:23";
      target.leaveTypes = [
        { id: "local-only", name: "本机旧假别", enabled: true },
      ];
      target.halfRestSelections = [
        {
          date: "2026-11-19",
          modes: { [target.staff[0]!.id]: "early-finish" },
        },
      ];
      const applied = applyWorkbookImport(
        target,
        structuredClone(imported),
        "config",
        restore
      );
      expect(applied.errors).toBeUndefined();
      expect(applied).toMatchObject({ restoreDefaults: expect.any(Array) });
      expect(facts(target)).toEqual(facts(source));
      const second = createDefaultState();
      applyWorkbookImport(second, parse(target), "config", restore);
      expect(facts(second)).toEqual(facts(source));
    }
    const ordinary = createDefaultState();
    ordinary.settings.morningStatsStartTime = "04:23";
    ordinary.leaveTypes = [
      { id: "local-only", name: "本机旧假别", enabled: true },
    ];
    applyWorkbookImport(ordinary, structuredClone(imported), "config");
    expect(ordinary.settings.morningStatsStartTime).toBe("04:23");
    expect(ordinary.leaveTypes).toHaveLength(1);
  });

  it.each(["休假类别", "半休选择"])(
    "rejects malformed existing %s instead of treating it as a missing optional sheet",
    (sheet) => {
      const book = buildConfigWorkbook(createDefaultState());
      XLSX.utils.sheet_add_aoa(
        book.Sheets[sheet]!,
        [["bad-date-or-id", "{invalid-json", "invalid-enabled"]],
        { origin: -1 }
      );
      const target = createDefaultState(),
        before = structuredClone(target);
      expect(
        applyWorkbookImport(target, parseWorkbook(book, []), "config", restore)
          .errors?.length
      ).toBeGreaterThan(0);
      expect(target).toEqual(before);
    }
  );

  it.each([false, true])(
    "rejects an empty statistics interval after compiling defaults (missing end: %s), without retaining device-specific values",
    (missingEnd) => {
      const book = buildConfigWorkbook(createDefaultState());
      const rows = XLSX.utils.sheet_to_json<unknown[]>(
        book.Sheets["规则参数"]!,
        { header: 1 }
      );
      for (const row of rows) {
        if (row[0] === "morningStatsStartTime") row[2] = "12:00";
      }
      book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
        missingEnd
          ? rows.filter((row) => row[0] !== "morningStatsEndTime")
          : rows
      );
      const target = createDefaultState();
      target.settings.morningStatsStartTime = "04:23";
      const before = structuredClone(target);
      const applied = applyWorkbookImport(
        target,
        parseWorkbook(book, []),
        "config",
        restore
      );
      expect(applied.errors?.join(" ")).toContain("上午统计时段");
      expect(target).toEqual(before);
    }
  );

  it("rejects a recorded invalid new parameter instead of replacing it with its default", () => {
    const book = buildConfigWorkbook(createDefaultState());
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["规则参数"]!, {
      header: 1,
    });
    rows.find((row) => row[0] === "morningStatsStartTime")![2] = "invalid-time";
    book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(rows);
    const target = createDefaultState(),
      before = structuredClone(target);
    expect(
      applyWorkbookImport(
        target,
        parseWorkbook(book, []),
        "config",
        restore
      ).errors?.join(" ")
    ).toContain("上午统计开始的值无效");
    expect(target).toEqual(before);
  });

  it("preselects complete restore for a full exported configuration without writing before confirmation", async () => {
    const source = createDefaultState();
    source.templates[0]!.startTime = "07:45";
    source.flights[0]!.startTime = "07:55";
    const store = createTestAutoscheduleStore(createDefaultState());
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-11-19",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    });
    const before = structuredClone(store.getState().model);
    await coordinator.handle({
      type: "import-file",
      mode: "config",
      file: new File(
        [
          XLSX.write(buildConfigWorkbook(source), {
            type: "array",
            bookType: "xlsx",
          }),
        ],
        "config.xlsx"
      ),
    });
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: true,
    });
    expect(store.getState().model).toEqual(before);
    await coordinator.handle({ type: "apply-workbook-import" });
    expect(store.getState().model.templates[0]!.startTime).toBe("07:45");
    expect(store.getState().model.flights[0]!.startTime).toBe("07:55");
  });

  it.each([
    { sheet: "人员信息", cells: { A2: "" } },
    { sheet: "岗位配置", cells: { C2: "" } },
    { sheet: "岗位配置", cells: { F2: "无效疲劳" } },
    {
      sheet: "末班重点次数修正",
      cells: {
        A2: "2026-11",
        B2: "1",
        C2: "TW616",
        D2: "supervisor",
        E2: "错误次数",
      },
    },
    {
      sheet: "普通重点次数修正",
      cells: { A2: "2026-11", B2: "1", C2: "TW", D2: "G16", E2: "错误次数" },
    },
  ])(
    "rejects a malformed $sheet row instead of silently dropping or changing it",
    ({ sheet, cells }) => {
      const book = buildConfigWorkbook(createDefaultState());
      for (const [cell, value] of Object.entries(cells))
        book.Sheets[sheet]![cell] = { t: "s", v: value };
      book.Sheets[sheet]!["!ref"] =
        sheet === "人员信息" || sheet === "岗位配置"
          ? book.Sheets[sheet]!["!ref"]
          : "A1:F2";
      const target = createDefaultState(),
        before = structuredClone(target);
      const applied = applyWorkbookImport(
        target,
        parseWorkbook(book, []),
        "config",
        restore
      );
      expect(applied.errors?.join(" ")).toContain(sheet);
      expect(target).toEqual(before);
    }
  );

  it("preserves slash names in transition-policy editors; flight positions are read-only", () => {
    const store = createTestAutoscheduleStore(createDefaultState());
    for (const entity of ["template", "flight"]) {
      const model = store.getState().model;
      const id =
        entity === "template" ? model.templates[0]!.id : model.flights[0]!.id;
      const before = structuredClone(model);
      store
        .getState()
        .configuration.updateField(entity, id, "positions", "督导/引导,G16");
      expect(store.getState().model).toEqual(before);
    }
    const model = createDefaultState(),
      id = model.settings.positionTransitionPolicies[0]!.id;
    updatePolicyEntityField(
      model,
      "transition-policy",
      id,
      "sourcePositions",
      "督导/引导、送资料"
    );
    expect(
      model.settings.positionTransitionPolicies[0]!.sourcePositions
    ).toEqual(["督导/引导", "送资料"]);
  });

  it("updates every current-group rule reference when editing the current flight number", () => {
    const source = createDefaultState();
    const old = source.flights[0]!.flightNo;
    const visit = (v: unknown, oldNo: string, nextNo: string) => {
      if (!v || typeof v !== "object") return;
      for (const [k, item] of Object.entries(v)) {
        if (
          ["flightNo", "sourceFlightNo", "targetFlightNo"].includes(k) &&
          item === oldNo
        )
          (v as Record<string, unknown>)[k] = nextNo;
        else visit(item, oldNo, nextNo);
      }
    };
    source.settings.latePriorityFlightNumbers = [old];
    for (const policy of source.settings.positionTransitionPolicies) {
      policy.sourceFlightNo = old;
      policy.targetFlightNo = old;
    }
    source.settings.dutyPositionPriorities[0]!.flightNo = old;
    source.settings.nextWorkdayRecoveryTargets[0]!.flightNo = old;
    source.settings.mobileSupervisorCoverageRules[0]!.flightNo = old;
    source.settings.lateShiftRecoveryPositionRules[0]!.flightNo = old;
    source.settings.crossWorkdayQualificationReservations = [
      {
        id: "r",
        enabled: true,
        flightNo: old,
        matchField: "position",
        keyword: "G16",
        minimumStaffCount: 1,
      },
    ];
    source.settings.crossFlightPriorityPolicies = [
      {
        id: "p",
        enabled: false,
        flightNo: old,
        staffIds: [source.staff[0]!.id],
      },
    ];
    source.settings.sameFlightStaffExclusions = [
      {
        id: "e",
        enabled: false,
        flightNo: old,
        firstStaffId: source.staff[0]!.id,
        secondStaffId: source.staff[1]!.id,
      },
    ];
    source.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: old, position: "G16", movable: true },
    ];
    source.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: source.staff[0]!.id,
        flightNo: old,
        kind: "supervisor",
        delta: 1,
      },
    ];
    const store = createTestAutoscheduleStore(source),
      before = structuredClone(store.getState().model);
    const expected = structuredClone(before.settings);
    visit(expected, old, "NEW100");
    expected.latePriorityFlightNumbers = ["NEW100"];
    store
      .getState()
      .configuration.updateField(
        "flight",
        before.flights[0]!.id,
        "flightNo",
        "NEW100"
      );
    expect(store.getState().model.settings).toEqual(expected);
    expect(
      store.getState().model.latePriorityFrequencyAdjustments[0]!.flightNo
    ).toBe("NEW100");
    expect(store.getState().model.groups.B).toEqual(before.groups.B);
    expect(store.getState().model.templates).toEqual(before.templates);
    expect(store.getState().model.history).toEqual(before.history);
  });
});
