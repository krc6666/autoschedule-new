import { expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { readFileSync } from "node:fs";
import { createDefaultState } from "../../src/defaults";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { loadState, saveState } from "../../src/infrastructure/storage";
import { scheduleRuleFingerprint } from "../../src/domain/rules/schedule-rule-fingerprint";
import { relaxedShiftFlightScope } from "../../src/domain/statistics/relaxed-shift-flight-scope";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createMemoryStatePersistence,
} from "../helpers/application";
import { relaxedMatrixFixture } from "../helpers/relaxed-flight-matrix";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import {
  renameGroupFlightReferences,
  removeFlightScopedReferences,
} from "../../src/domain/flights/group-flight-references";

const sheetName = "轻松班次航班范围";
const bytes = (book: XLSX.WorkBook) =>
  XLSX.read(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));

it.each([
  { value: null },
  { value: [] },
  { value: ["MF8001", "CX937", "TEST-1"] },
])(
  "roundtrips display scope $value through actual XLSX and storage",
  ({ value }) => {
    const source = relaxedMatrixFixture();
    source.settings.relaxedShiftFlightNumbers = value;
    const parsed = parseWorkbook(bytes(buildConfigWorkbook(source)), []);
    expect(parsed.settings?.relaxedShiftFlightNumbers).toEqual(value);
    const target = createDefaultState();
    applyWorkbookImport(target, parsed, "config");
    expect(target.settings.relaxedShiftFlightNumbers).toEqual(value);
    let saved = "";
    saveState(target, {
      setItem: (_key, text) => {
        saved = text;
      },
    });
    expect(
      loadState({ getItem: () => saved }).settings.relaxedShiftFlightNumbers
    ).toEqual(value);
  }
);

it("preserves missing ordinary import, defaults old complete restore and rejects malformed scopes", () => {
  const book = buildConfigWorkbook(relaxedMatrixFixture());
  delete book.Sheets[sheetName];
  book.SheetNames = book.SheetNames.filter((n) => n !== sheetName);
  const imported = parseWorkbook(bytes(book), []);
  const target = createDefaultState();
  target.settings.relaxedShiftFlightNumbers = ["KEEP1"];
  applyWorkbookImport(target, imported, "config");
  expect(target.settings.relaxedShiftFlightNumbers).toEqual(["KEEP1"]);
  applyWorkbookImport(target, imported, "config", {
    restoreFlightConfiguration: true,
  });
  expect(target.settings.relaxedShiftFlightNumbers).toBeNull();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["选择方式", "航班号"],
      ["默认MF/CX", ""],
      ["指定", "CX937"],
    ]),
    sheetName
  );
  const invalid = parseWorkbook(bytes(book), []);
  expect(invalid.settings?.relaxedShiftFlightNumbers).toBeUndefined();
  expect(invalid.warnings.join(" ")).toContain(sheetName);
  target.settings.relaxedShiftFlightNumbers = ["KEEP1"];
  applyWorkbookImport(target, invalid, "config");
  expect(target.settings.relaxedShiftFlightNumbers).toEqual(["KEEP1"]);
});

it("saves from the real controller, isolates groups and keeps rule fingerprints unchanged", async () => {
  const source = relaxedMatrixFixture();
  const persistence = createMemoryStatePersistence();
  const store = createTestAutoscheduleStore(source, persistence);
  const coordinator = createTestApplicationCoordinator(store, {
    confirm: () => true,
    preferences: {
      loadScheduleDate: () => null,
      saveScheduleDate: () => {},
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => {},
    },
  });
  const fingerprint = scheduleRuleFingerprint(coordinator.model());
  const assignments = structuredClone(coordinator.model().assignments);
  await coordinator.handle({
    type: "set-relaxed-shift-flights",
    flightNumbers: [" cx 937 ", "CX937"],
  });
  expect(coordinator.model().settings.relaxedShiftFlightNumbers).toEqual([
    "CX937",
  ]);
  expect(scheduleRuleFingerprint(coordinator.model())).toBe(fingerprint);
  expect(coordinator.model().assignments).toEqual(assignments);
  expect(persistence.load().settings.relaxedShiftFlightNumbers).toEqual([
    "CX937",
  ]);
  await coordinator.handle({ type: "switch-group", groupId: "B" });
  expect(coordinator.model().settings.relaxedShiftFlightNumbers).toBeNull();
  await coordinator.handle({
    type: "set-relaxed-shift-flights",
    flightNumbers: [],
  });
  await coordinator.handle({ type: "switch-group", groupId: "A" });
  expect(coordinator.model().settings.relaxedShiftFlightNumbers).toEqual([
    "CX937",
  ]);
});

it("provides the same explicit default in the shipped template and missing persisted fields", () => {
  const template = XLSX.read(
    readFileSync("public/template/排班工具配置模板.xlsx")
  );
  expect(template.SheetNames).toContain(sheetName);
  expect(
    parseWorkbook(template, []).settings?.relaxedShiftFlightNumbers
  ).toBeNull();
  const old = createDefaultState();
  Reflect.deleteProperty(old.settings, "relaxedShiftFlightNumbers");
  Reflect.deleteProperty(old.groups.A.settings, "relaxedShiftFlightNumbers");
  const restored = loadState({ getItem: () => JSON.stringify(old) });
  expect(restored.settings.relaxedShiftFlightNumbers).toBeNull();
  expect(
    relaxedShiftFlightScope(restored).selected.every((no) =>
      /^(MF|CX)\d/.test(no)
    )
  ).toBe(true);
});

it("leaves final safety credentials unchanged and consumes the existing rename/remove collection", () => {
  const state = createDefaultState();
  const credential = () =>
    createScheduleSafetySession({
      phase: "final",
      state,
      date: "2026-11-18",
      runFacts: createScheduleRunFacts(state, "2026-11-18"),
    }).createCredential("2026-11-18", []);
  const before = credential();
  state.settings.relaxedShiftFlightNumbers = ["CX937"];
  expect(credential()).toEqual(before);
  renameGroupFlightReferences(state.positionRules, state.settings, (no) =>
    no === "CX937" ? "CX999" : no
  );
  expect(state.settings.relaxedShiftFlightNumbers).toEqual(["CX999"]);
  removeFlightScopedReferences(state.settings, "CX999");
  expect(state.settings.relaxedShiftFlightNumbers).toEqual([]);
});

it.each(
  [
    [
      ["选择方式", "航班号"],
      ["指定", "CX937"],
      ["指定", " cx 937 "],
    ],
    [
      ["选择方式", "航班号"],
      ["指定", ""],
    ],
    [["错误表头"], ["CX937"]],
  ].map((data) => ({ data }))
)("rejects invalid scope sheet without losing settings", ({ data }) => {
  const book = buildConfigWorkbook(createDefaultState());
  book.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(data.map((row) => [...row]));
  const parsed = parseWorkbook(bytes(book), []);
  expect(parsed.settings?.relaxedShiftFlightNumbers).toBeUndefined();
  expect(parsed.warnings.join(" ")).toContain(sheetName);
});
