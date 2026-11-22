import { expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import { restoreCloudModel } from "../../src/infrastructure/supabase-backend";
import { compileWorkbookConfigurationRestore } from "../../src/infrastructure/workbook-configuration-contract";
import {
  lateAirlineScenario,
  LATE_AIRLINE_DATE,
} from "../helpers/late-airline-scenario";
import { memoryPersistence } from "../helpers/history-sync";
import { improveStaffAirlineMix } from "../../src/domain/reviews/staff-airline-mix";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { scheduleRuleFingerprint } from "../../src/domain/rules/schedule-rule-fingerprint";
import { buildHistoricalScheduleDraft } from "../../src/app/history-actions";

it.each([true, false])(
  "keeps setting=%s and its actual effect after byte export, clean import, JSON restart and cloud restore",
  async (enabled) => {
    const source = Object.assign(createDefaultState(), lateAirlineScenario());
    source.settings.lateAirlineRotationEnabled = enabled;
    const parsed = parseWorkbook(
      XLSX.read(
        XLSX.write(buildConfigWorkbook(source), {
          type: "buffer",
          bookType: "xlsx",
        }),
        { type: "buffer" }
      ),
      []
    );
    expect(parsed.settings?.lateAirlineRotationEnabled).toBe(enabled);
    const destination = createDefaultState();
    destination.staff = [];
    destination.history = [];
    destination.positionRules = [];
    destination.flights = [];
    destination.templates = [];
    const otherGroup = structuredClone(destination.groups.B);
    const applied = applyWorkbookImport(destination, parsed, "all", {
      replaceSharedTemplates: true,
      restoreFlightConfiguration: true,
    });
    expect(applied.errors).toBeUndefined();
    const persistence = memoryPersistence();
    const store = createAutoscheduleStore({
      initialState: destination,
      persistence,
    });
    store.getState().persist();
    const restored = persistence.load();
    expect(restored.settings.lateAirlineRotationEnabled).toBe(enabled);
    expect(restored.groups.B).toEqual(otherGroup);
    const cloud = restoreCloudModel(JSON.parse(JSON.stringify(restored)));
    expect(cloud.settings.lateAirlineRotationEnabled).toBe(enabled);
    const draft = buildHistoricalScheduleDraft(cloud, "2026-11-12");
    expect(draft.warnings).toEqual([]);
    cloud.flights = draft.flights;
    const result = await improveStaffAirlineMix({
      state: cloud,
      date: LATE_AIRLINE_DATE,
      assignments: draft.assignments,
      solver: defaultHighsSolver,
      facts: createScheduleRunFacts(cloud, LATE_AIRLINE_DATE),
      lockedAssignmentIds: new Set(),
      assertSafe: () => {},
    });
    expect(result.find((a) => a.flightNo === "AK103")?.staffId).toBe(
      enabled ? "peer-a" : "peer-b"
    );
  }
);

it("keeps old workbook partial imports unchanged, and explicitly defaults only a full restore", () => {
  const source = Object.assign(createDefaultState(), lateAirlineScenario());
  const book = buildConfigWorkbook(source),
    rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["规则参数"]!, {
      header: 1,
    });
  book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
    rows.filter((r) => r[0] !== "lateAirlineRotationEnabled")
  );
  const parsed = parseWorkbook(book, []);
  expect(parsed.settings?.lateAirlineRotationEnabled).toBeUndefined();
  const partial = createDefaultState();
  partial.settings.lateAirlineRotationEnabled = false;
  applyWorkbookImport(partial, parsed, "config");
  expect(partial.settings.lateAirlineRotationEnabled).toBe(false);
  const full = compileWorkbookConfigurationRestore(parsed);
  expect(full.errors).toEqual([]);
  expect(full.imported.settings?.lateAirlineRotationEnabled).toBe(true);
  expect(full.restoreDefaults.some((s) => s.includes("末班航司交替"))).toBe(
    true
  );
});

it("upgrades missing old cloud settings safely, retains explicit false and invalidates old rule fingerprints", () => {
  const source = createDefaultState();
  const before = scheduleRuleFingerprint(source);
  source.settings.lateAirlineRotationEnabled = false;
  expect(scheduleRuleFingerprint(source)).not.toBe(before);
  const legacy = JSON.parse(JSON.stringify(createDefaultState()));
  delete legacy.settings.lateAirlineRotationEnabled;
  delete legacy.groups.A.settings.lateAirlineRotationEnabled;
  delete legacy.groups.B.settings.lateAirlineRotationEnabled;
  const input = JSON.stringify(legacy);
  const restored = restoreCloudModel(legacy);
  expect(restored.settings.lateAirlineRotationEnabled).toBe(true);
  expect(restored.groups.B.settings.lateAirlineRotationEnabled).toBe(true);
  expect(JSON.stringify(legacy)).toBe(input);
});
