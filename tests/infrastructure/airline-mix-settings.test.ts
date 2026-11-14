import { expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { saveState, loadState } from "../../src/infrastructure/storage";
import * as XLSX from "xlsx-js-style";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { compileWorkbookConfigurationRestore } from "../../src/infrastructure/workbook-configuration-contract";
import { normalizeAirlineMixCodes } from "../../src/domain/rules/airline-mix-policy";
import { normalizeScheduleSettings } from "../../src/domain/rules/schedule-settings";
import { createTestAutoscheduleStore } from "../helpers/application";

it("defaults FD/AK and keeps editable disabled/custom groups through config and restart", () => {
  const state = createDefaultState();
  expect(state.settings.airlineMixPolicies).toEqual([
    { id: "airline-mix-fd-ak", enabled: true, airlineCodes: ["FD", "AK"] },
  ]);
  state.settings.airlineMixPolicies = [
    { id: "custom", enabled: false, airlineCodes: ["CX", "TR", "KE"] },
  ];
  const book = buildConfigWorkbook(state);
  expect(book.SheetNames).toContain("航司搭配偏好");
  expect(parseWorkbook(book, state.staff).settings?.airlineMixPolicies).toEqual(
    state.settings.airlineMixPolicies
  );
  let saved = "";
  saveState(state, {
    setItem: (_k, value) => {
      saved = value;
    },
  });
  expect(
    loadState({ getItem: () => saved }).settings.airlineMixPolicies
  ).toEqual(state.settings.airlineMixPolicies);
});

it("normalizes codes once and rejects flight numbers and malformed codes", () => {
  expect(normalizeAirlineMixCodes(" fd，AK / fd; tr ")).toEqual([
    "FD",
    "AK",
    "TR",
  ]);
  expect(normalizeAirlineMixCodes("FD573,AK151")).toBeNull();
  expect(normalizeAirlineMixCodes("FD,123")).toBeNull();
  expect(normalizeAirlineMixCodes("FD,$AK")).toBeNull();
  expect(
    normalizeScheduleSettings({ airlineMixPolicies: [] }).airlineMixPolicies
  ).toEqual([]);
});

it("keeps partial imports without the sheet, clears an explicit empty sheet, and rejects all rows of a malformed sheet", () => {
  const target = createDefaultState();
  target.settings.airlineMixPolicies = [
    { id: "keep", enabled: false, airlineCodes: ["CX", "TR"] },
  ];
  const original = structuredClone(target.settings.airlineMixPolicies);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["规则编号", "启用", "航司组合"],
      ["bad", "是", "FD573,AK"],
    ]),
    "航司搭配偏好"
  );
  const invalid = parseWorkbook(workbook, target.staff);
  expect(invalid.warnings.join(" ")).toContain("航司搭配偏好第2行");
  expect(invalid.settings?.airlineMixPolicies).toBeUndefined();
  applyWorkbookImport(target, invalid, "config");
  expect(target.settings.airlineMixPolicies).toEqual(original);
  workbook.Sheets["航司搭配偏好"] = XLSX.utils.aoa_to_sheet([
    ["规则编号", "启用", "航司组合"],
  ]);
  applyWorkbookImport(target, parseWorkbook(workbook, target.staff), "config");
  expect(target.settings.airlineMixPolicies).toEqual([]);
  workbook.SheetNames = [];
  delete workbook.Sheets["航司搭配偏好"];
  target.settings.airlineMixPolicies = original;
  expect(
    parseWorkbook(workbook, target.staff).settings?.airlineMixPolicies
  ).toBeUndefined();
  applyWorkbookImport(target, parseWorkbook(workbook, target.staff), "config");
  expect(target.settings.airlineMixPolicies).toEqual(original);
});

it("rejects duplicate IDs without silently dropping a combination", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["规则编号", "启用", "航司组合"],
      ["same", "是", "FD,AK"],
      ["same", "否", "CX,TR"],
    ]),
    "航司搭配偏好"
  );
  const imported = parseWorkbook(workbook, []);
  expect(imported.settings?.airlineMixPolicies).toBeUndefined();
  expect(imported.warnings.join(" ")).toContain("重复");
});

it("restores a missing legacy field to the default without restoring deleted or disabled rows", () => {
  const state = createDefaultState();
  let saved = "";
  saveState(state, {
    setItem: (_k, v) => {
      saved = v;
    },
  });
  const legacy = JSON.parse(saved);
  delete legacy.settings.airlineMixPolicies;
  for (const group of Object.values(legacy.groups)) {
    if (
      group &&
      typeof group === "object" &&
      "settings" in group &&
      group.settings &&
      typeof group.settings === "object"
    )
      delete (group.settings as Record<string, unknown>).airlineMixPolicies;
  }
  expect(
    loadState({ getItem: () => JSON.stringify(legacy) }).settings
      .airlineMixPolicies
  ).toEqual(state.settings.airlineMixPolicies);
  state.settings.airlineMixPolicies = [];
  saveState(state, {
    setItem: (_k, v) => {
      saved = v;
    },
  });
  expect(
    loadState({ getItem: () => saved }).settings.airlineMixPolicies
  ).toEqual([]);
});

it("uses the same explicit default for preview and complete restore of an older workbook", () => {
  const state = createDefaultState();
  const workbook = buildConfigWorkbook(state);
  workbook.SheetNames = workbook.SheetNames.filter((n) => n !== "航司搭配偏好");
  delete workbook.Sheets["航司搭配偏好"];
  const compiled = compileWorkbookConfigurationRestore(
    parseWorkbook(workbook, state.staff)
  );
  expect(compiled.errors).toEqual([]);
  expect(compiled.imported.settings?.airlineMixPolicies).toEqual(
    state.settings.airlineMixPolicies
  );
  expect(compiled.restoreDefaults.join(" ")).toContain("航司搭配偏好");
});

it("keeps A/B preferences isolated and applies custom Excel bytes only to the active group", () => {
  const source = createDefaultState();
  source.settings.airlineMixPolicies = [
    { id: "custom", enabled: true, airlineCodes: ["KE", "TR"] },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    buildConfigWorkbook(source).Sheets["航司搭配偏好"]!,
    "航司搭配偏好"
  );
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const store = createTestAutoscheduleStore();
  const originalA = structuredClone(
    store.getState().model.settings.airlineMixPolicies
  );
  store.getState().switchGroup("B");
  store
    .getState()
    .records.applyWorkbookImport(
      parseWorkbook(XLSX.read(bytes, { type: "array" }), []),
      "config"
    );
  expect(store.getState().model.settings.airlineMixPolicies).toEqual(
    source.settings.airlineMixPolicies
  );
  store.getState().switchGroup("A");
  expect(store.getState().model.settings.airlineMixPolicies).toEqual(originalA);
  store.getState().switchGroup("B");
  expect(store.getState().model.settings.airlineMixPolicies).toEqual(
    source.settings.airlineMixPolicies
  );
});

it("ships the same default in the downloadable configuration template", () => {
  const book = XLSX.read(
    readFileSync(
      join(process.cwd(), "public", "template", "排班工具配置模板.xlsx")
    ),
    { type: "buffer" }
  );
  expect(parseWorkbook(book, []).settings?.airlineMixPolicies).toEqual(
    createDefaultState().settings.airlineMixPolicies
  );
});
