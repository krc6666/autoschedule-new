import { expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { readFileSync } from "node:fs";
import { createDefaultState } from "../../src/defaults";
import {
  flightLeaderScenario,
  LEADER_DATE,
} from "../helpers/flight-leader-scenario";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { compileWorkbookConfigurationRestore } from "../../src/infrastructure/workbook-configuration-contract";
import { normalizeScheduleSettings } from "../../src/domain/rules/schedule-settings";
import { createTestAutoscheduleStore } from "../helpers/application";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { buildArchivedScheduleDays } from "../../src/ui/projections/archived-schedule-view";
import { loadState, saveState } from "../../src/infrastructure/storage";

const bytes = (book: XLSX.WorkBook) =>
  XLSX.read(XLSX.write(book, { type: "array", bookType: "xlsx" }), {
    type: "array",
  });

it("defaults old personnel and rules to off/one without recalculating archived schedules", () => {
  const old = createDefaultState();
  old.staff.forEach((p) => delete p.flightLeaderQualified);
  const settings = { ...old.settings };
  Reflect.deleteProperty(settings, "flightLeaderCoverageEnabled");
  Reflect.deleteProperty(settings, "minimumFlightLeaders");
  expect(normalizeScheduleSettings(settings)).toMatchObject({
    flightLeaderCoverageEnabled: false,
    minimumFlightLeaders: 1,
  });
  expect(
    normalizeScheduleSettings({ minimumFlightLeaders: 0 }).minimumFlightLeaders
  ).toBe(1);
  expect(
    normalizeScheduleSettings({ minimumFlightLeaders: 2 }).minimumFlightLeaders
  ).toBe(2);
  expect(
    createDefaultState().staff.every((p) => p.flightLeaderQualified === false)
  ).toBe(true);
});

it("keeps tags and adjustable rules through real configuration XLSX bytes and explicit full restore", () => {
  const source = flightLeaderScenario();
  source.settings.minimumFlightLeaders = 2;
  const imported = parseWorkbook(bytes(buildConfigWorkbook(source)), []);
  expect(imported.staff?.map((p) => p.flightLeaderQualified)).toEqual([
    true,
    true,
    false,
    false,
  ]);
  const target = createDefaultState();
  const applied = applyWorkbookImport(target, imported, "config", {
    restoreFlightConfiguration: true,
  });
  expect(applied.errors).toBeUndefined();
  expect(target.settings).toMatchObject({
    flightLeaderCoverageEnabled: true,
    minimumFlightLeaders: 2,
  });
  expect(target.staff.map((p) => p.flightLeaderQualified)).toEqual([
    true,
    true,
    false,
    false,
  ]);
});

it("retains existing tags and rules when ordinary old-file import omits fields; explicit false clears", () => {
  const source = flightLeaderScenario(),
    book = buildConfigWorkbook(source);
  const staffRows = XLSX.utils.sheet_to_json<unknown[]>(
    book.Sheets["人员信息"]!,
    { header: 1 }
  );
  book.Sheets["人员信息"] = XLSX.utils.aoa_to_sheet(
    staffRows.map((row) => row.slice(0, -1))
  );
  const rules = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["规则参数"]!, {
    header: 1,
  });
  book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
    rules.filter(
      (row) =>
        !["flightLeaderCoverageEnabled", "minimumFlightLeaders"].includes(
          String(row[0])
        )
    )
  );
  const target = flightLeaderScenario();
  target.settings.minimumFlightLeaders = 3;
  const imported = parseWorkbook(bytes(book), target.staff);
  applyWorkbookImport(target, imported, "config");
  expect(target.staff[0]!.flightLeaderQualified).toBe(true);
  expect(target.settings.minimumFlightLeaders).toBe(3);
  expect(target.settings.flightLeaderCoverageEnabled).toBe(true);
  const compiled = compileWorkbookConfigurationRestore(imported);
  expect(compiled.restoreDefaults.join(" ")).toContain("可担任负责人");
  expect(compiled.imported.staff![0]!.flightLeaderQualified).toBe(false);
  expect(compiled.imported.settings).toMatchObject({
    flightLeaderCoverageEnabled: false,
    minimumFlightLeaders: 1,
  });
  source.staff[0]!.flightLeaderQualified = false;
  applyWorkbookImport(
    target,
    parseWorkbook(bytes(buildConfigWorkbook(source)), target.staff),
    "config"
  );
  expect(target.staff[0]!.flightLeaderQualified).toBe(false);
});

it("saves and archives shortages, including an entirely empty flight, with immutable history counts and group isolation", () => {
  const state = flightLeaderScenario();
  state.assignments.slice(2).forEach((a) => {
    a.staffId = null;
    a.staffName = "";
    a.status = "unfilled";
  });
  const store = createTestAutoscheduleStore(state);
  store.getState().persist();
  store
    .getState()
    .records.replaceHistory(
      LEADER_DATE,
      currentScheduleHistory(store.getState().model, LEADER_DATE)
    );
  let model = store.getState().model;
  expect(
    model.flightLeaderCoverageHistory?.[0]!.flights.map((f) => f.actual)
  ).toEqual([2, 0]);
  expect(
    buildArchivedScheduleDays(model)[0]!.flightLeaderWarnings?.join(" ")
  ).toContain("ZZ101无负责人");
  store
    .getState()
    .configuration.updateField(
      "staff",
      "worker-0",
      "flightLeaderQualified",
      false
    );
  expect(store.getState().model.assignments).toHaveLength(4);
  expect(
    buildArchivedScheduleDays(store.getState().model)[0]!.flightLeaderWarnings
  ).toEqual(buildArchivedScheduleDays(model)[0]!.flightLeaderWarnings);
  store.getState().switchGroup("B");
  expect(store.getState().model.flightLeaderCoverageHistory ?? []).toEqual([]);
  expect(store.getState().model.settings.flightLeaderCoverageEnabled).toBe(
    false
  );
  store.getState().switchGroup("A");
  model = store.getState().model;
  let saved = "";
  saveState(model, {
    setItem: (_key, value) => {
      saved = value;
    },
  });
  const restored = loadState({ getItem: () => saved });
  expect(restored.flightLeaderCoverageHistory).toEqual(
    model.flightLeaderCoverageHistory
  );
  expect(
    buildScheduleFeedback(restored, LEADER_DATE).find(
      (f) => f.key === "flight-leader-coverage"
    )?.level
  ).toBe("attention");
  const target = createDefaultState();
  applyWorkbookImport(
    target,
    parseWorkbook(bytes(buildConfigWorkbook(restored)), []),
    "all"
  );
  expect(target.flightLeaderCoverageHistory).toEqual(
    model.flightLeaderCoverageHistory
  );
});

it("writes the current warning evidence into result XLSX without preventing export or creating jobs", () => {
  const state = flightLeaderScenario();
  const book = bytes(buildScheduleWorkbook(state, LEADER_DATE));
  const imported = parseWorkbook(book, state.staff);
  expect(
    imported.flightLeaderCoverageHistory?.[0]?.flights.map((f) => f.actual)
  ).toEqual([2, 0]);
  const jobs = XLSX.utils.sheet_to_json(book.Sheets["排班结果"]!);
  expect(jobs).toHaveLength(4);
});

it("preserves history on absent or malformed snapshot tables and merges imported dates independently", () => {
  const state = flightLeaderScenario();
  const store = createTestAutoscheduleStore(state);
  store
    .getState()
    .records.replaceHistory(
      LEADER_DATE,
      currentScheduleHistory(state, LEADER_DATE)
    );
  const model = structuredClone(store.getState().model),
    old = structuredClone(model.flightLeaderCoverageHistory);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["日期", "航班负责人人数(JSON)"],
      [LEADER_DATE, "broken"],
    ]),
    "负责人保障记录"
  );
  const imported = parseWorkbook(book, model.staff);
  expect(imported.warnings.join(" ")).toContain("保留已有记录");
  applyWorkbookImport(model, imported, "history");
  expect(model.flightLeaderCoverageHistory).toEqual(old);
  applyWorkbookImport(
    model,
    {
      warnings: [],
      flightLeaderCoverageHistory: [{ date: "2026-11-24", flights: [] }],
    },
    "history"
  );
  expect(model.flightLeaderCoverageHistory?.map((day) => day.date)).toEqual([
    LEADER_DATE,
    "2026-11-24",
  ]);
});

it("ships the fields in the built-in configuration template", () => {
  const book = XLSX.read(readFileSync("public/template/排班工具配置模板.xlsx"));
  const parsed = parseWorkbook(book, []);
  expect(parsed.settings?.flightLeaderCoverageEnabled).toBe(false);
  expect(parsed.settings?.minimumFlightLeaders).toBe(1);
  expect(parsed.staff?.every((p) => p.flightLeaderQualified === false)).toBe(
    true
  );
  expect(book.SheetNames).toContain("负责人保障记录");
});

it("does not turn a malformed personnel tag into an explicit false", () => {
  const state = flightLeaderScenario(),
    book = buildConfigWorkbook(state);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["人员信息"]!, {
    header: 1,
  });
  rows[1]![rows[0]!.indexOf("可担任负责人")] = "不明";
  book.Sheets["人员信息"] = XLSX.utils.aoa_to_sheet(rows);
  const imported = parseWorkbook(bytes(book), state.staff);
  expect(imported.warnings.join(" ")).toContain("未覆盖已有标记");
  applyWorkbookImport(state, imported, "config");
  expect(state.staff[0]!.flightLeaderQualified).toBe(true);
  expect(
    compileWorkbookConfigurationRestore(imported).errors.length
  ).toBeGreaterThan(0);
});
