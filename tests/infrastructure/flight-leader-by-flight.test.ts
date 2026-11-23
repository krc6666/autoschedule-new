import { expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { readFileSync, writeFileSync } from "node:fs";
import { generateSchedule } from "../helpers/generate-schedule";
import { LEADER_DATE } from "../helpers/flight-leader-scenario";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { previewFlightIdentityChange } from "../../src/domain/flights/flight-identity-change";
import { flightLeaderScenario } from "../helpers/flight-leader-scenario";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { compileWorkbookConfigurationRestore } from "../../src/infrastructure/workbook-configuration-contract";
import { createTestAutoscheduleStore } from "../helpers/application";
import { loadState, saveState } from "../../src/infrastructure/storage";

const roundtrip = (book: XLSX.WorkBook) =>
  XLSX.read(XLSX.write(book, { type: "array", bookType: "xlsx" }), {
    type: "array",
  });
it("roundtrips per-flight overrides through actual XLSX, Store groups and JSON restart", () => {
  const source = flightLeaderScenario();
  source.settings.flightLeaderRequirements = [
    { flightNo: "ZZ100", minimum: 2 },
  ];
  const imported = parseWorkbook(roundtrip(buildConfigWorkbook(source)), []);
  expect(imported.settings?.flightLeaderRequirements).toEqual(
    source.settings.flightLeaderRequirements
  );
  const store = createTestAutoscheduleStore(flightLeaderScenario());
  expect(
    store.getState().records.applyWorkbookImport(imported, "config", {
      restoreFlightConfiguration: true,
    }).errors
  ).toBeUndefined();
  store.getState().switchGroup("B");
  expect(store.getState().model.settings.flightLeaderRequirements).toEqual([]);
  store.getState().switchGroup("A");
  let saved = "";
  saveState(store.getState().model, {
    setItem: (_key, value) => {
      saved = value;
    },
  });
  expect(
    loadState({ getItem: () => saved }).settings.flightLeaderRequirements
  ).toEqual(source.settings.flightLeaderRequirements);
});

it("retains partial missing/bad rows, clears explicit empty tables and defaults old full restore", () => {
  const state = flightLeaderScenario();
  state.settings.flightLeaderRequirements = [{ flightNo: "ZZ100", minimum: 2 }];
  const book = buildConfigWorkbook(state);
  delete book.Sheets["航班负责人人数"];
  book.SheetNames = book.SheetNames.filter((no) => no !== "航班负责人人数");
  const old = parseWorkbook(roundtrip(book), state.staff);
  applyWorkbookImport(state, old, "config");
  expect(state.settings.flightLeaderRequirements).toHaveLength(1);
  expect(
    compileWorkbookConfigurationRestore(old).imported.settings
      ?.flightLeaderRequirements
  ).toEqual([]);
  expect(
    compileWorkbookConfigurationRestore(old).restoreDefaults.join(" ")
  ).toContain("单独设置");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["航班号", "至少负责人人数"],
      ["ZZ100", 0],
    ]),
    "航班负责人人数"
  );
  const bad = parseWorkbook(roundtrip(book), state.staff);
  expect(bad.warnings.join(" ")).toContain("保留已有设置");
  applyWorkbookImport(state, bad, "config");
  expect(state.settings.flightLeaderRequirements).toHaveLength(1);
  expect(
    compileWorkbookConfigurationRestore(bad).errors.length
  ).toBeGreaterThan(0);
  book.Sheets["航班负责人人数"] = XLSX.utils.aoa_to_sheet([
    ["航班号", "至少负责人人数"],
  ]);
  applyWorkbookImport(
    state,
    parseWorkbook(roundtrip(book), state.staff),
    "config"
  );
  expect(state.settings.flightLeaderRequirements).toEqual([]);
});

it("includes a blank override table in the downloadable template", () => {
  const book = XLSX.read(readFileSync("public/template/排班工具配置模板.xlsx"));
  expect(parseWorkbook(book, []).settings?.flightLeaderRequirements).toEqual(
    []
  );
});

it("uses migrated per-flight requirements in the complete pipeline and archives the final real counts", async () => {
  const state = flightLeaderScenario(2, 3, 3);
  state.settings.flightLeaderRequirements = [{ flightNo: "ZZ101", minimum: 2 }];
  const imported = parseWorkbook(roundtrip(buildConfigWorkbook(state)), []);
  applyWorkbookImport(state, imported, "config", {
    restoreFlightConfiguration: true,
  });
  const facts = createScheduleGenerationFacts(state);
  expect(structuredClone(facts).settings.flightLeaderRequirements).toEqual([
    { flightNo: "ZZ101", minimum: 2 },
  ]);
  const result = await generateSchedule(facts, LEADER_DATE);
  const store = createTestAutoscheduleStore(state);
  store.getState().schedule.install(LEADER_DATE, result);
  store
    .getState()
    .records.replaceHistory(
      LEADER_DATE,
      currentScheduleHistory(store.getState().model, LEADER_DATE)
    );
  const model = store.getState().model;
  const output = XLSX.write(buildScheduleWorkbook(model, LEADER_DATE), {
    type: "buffer",
    bookType: "xlsx",
  });
  const book = XLSX.read(output),
    rows = XLSX.utils.sheet_to_json<Record<string, string>>(
      book.Sheets["排班结果"]!
    );
  const leaders = new Set(["worker-0", "worker-1", "worker-2"]);
  const counts = ["ZZ100", "ZZ101"].map(
    (flight) =>
      new Set(
        rows
          .filter(
            (row) => row["航班号"] === flight && leaders.has(row["人员编号"]!)
          )
          .map((row) => row["人员编号"])
      ).size
  );
  expect(counts).toEqual([1, 2]);
  expect(rows).toHaveLength(6);
  expect(
    model.flightLeaderCoverageHistory?.[0]?.flights.map((row) => row.required)
  ).toEqual([1, 2]);
  expect(
    model.flightLeaderCoverageHistory?.[0]?.flights.map((row) => row.actual)
  ).toEqual(counts);
  writeFileSync(
    "docs/acceptance/evidence/2026-11-22-flight-leader-by-flight-result.xlsx",
    output
  );
  writeFileSync(
    "docs/acceptance/evidence/2026-11-22-flight-leader-by-flight-final.json",
    JSON.stringify(
      {
        counts,
        requirements: [1, 2],
        jobs: rows.length,
        safetyCredential: result.safetyCredential?.phase,
        archived: model.flightLeaderCoverageHistory,
        checked: "从最终XLSX人员编号独立去重，不调用负责人投影",
      },
      null,
      2
    ) + "\n"
  );
});

it("rejects a shared flight identity with conflicting leader requirements", () => {
  const state = flightLeaderScenario();
  state.settings.flightLeaderRequirements = [
    { flightNo: "ZZ100", minimum: 2 },
    { flightNo: "ZZ101", minimum: 3 },
  ];
  const preview = previewFlightIdentityChange(state, [
    {
      id: "shared",
      displayName: "同航班",
      aliases: [{ flightNo: "ZZ100" }, { flightNo: "ZZ101" }],
    },
  ]);
  expect(preview.errors.join(" ")).toContain("负责人人数冲突");
});

it("rejects conflicting partial Excel settings even when the workbook omits the identity directory", () => {
  const state = flightLeaderScenario();
  state.shared.flightIdentities = [
    {
      id: "shared",
      displayName: "同航班",
      aliases: [{ flightNo: "ZZ100" }, { flightNo: "ZZ101" }],
    },
  ];
  const original = structuredClone(state);
  const applied = applyWorkbookImport(
    state,
    {
      warnings: [],
      settings: {
        flightLeaderRequirements: [
          { flightNo: "ZZ100", minimum: 2 },
          { flightNo: "ZZ101", minimum: 3 },
        ],
      },
    },
    "config"
  );
  expect(applied.errors?.join(" ")).toContain("负责人人数冲突");
  expect(state).toEqual(original);
});
