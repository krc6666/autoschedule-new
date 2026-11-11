import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { loadState, saveState } from "../../src/infrastructure/storage";
import { buildCurrentScheduleFlightCandidates } from "../../src/domain/flights/next-workday-flight-plan";
import type { Flight, FlightTemplate } from "../../src/model";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

const restoreOptions = { restoreFlightConfiguration: true };
const flightValues = (flights: readonly (Flight | FlightTemplate)[]) =>
  flights.map(({ flightNo, startTime, endTime, positions, remark }) => ({
    flightNo,
    startTime,
    endTime,
    positions,
    remark,
  }));

function sourceState() {
  const source = createDefaultState();
  const base = source.flights[0]!;
  source.templates = [
    {
      ...base,
      id: "template-ak",
      flightNo: "AK151",
      startTime: "21:05",
      endTime: "23:05",
      positions: ["督导/引导", "G10"],
      remark: "换季",
    },
    {
      ...base,
      id: "template-new",
      flightNo: "NEW200",
      startTime: "22:10",
      endTime: "00:10",
      positions: ["收费/引导", "G12"],
      remark: "新增跨午夜",
    },
  ];
  source.flights = [
    {
      ...base,
      id: "flight-ak",
      flightNo: "AK151",
      startTime: "21:15",
      endTime: "23:15",
      positions: ["督导/引导", "G10"],
      bookedPassengers: 80,
      remark: "当天调整",
    },
  ];
  source.positionRules = source.templates.flatMap((template) =>
    template.positions.map((name, index) => ({
      ...source.positionRules[0]!,
      id: `${template.id}-${index}`,
      flightNo: template.flightNo,
      name,
    }))
  );
  source.weeklyFlightPlans = source.weeklyFlightPlans.map((row) => ({
    ...row,
    flightNos: ["AK151", "NEW200"],
  }));
  return source;
}

function staleState() {
  const target = createDefaultState();
  const otherFlight = { ...target.flights[0]!, id: "b-existing-flight" };
  const otherRule = target.groups.B.positionRules.find(
    (r) => r.flightNo === otherFlight.flightNo
  )!;
  target.groups.B.flights = [otherFlight];
  target.groups.B.assignments = [
    {
      id: "b-existing-position",
      flightId: otherFlight.id,
      flightNo: otherFlight.flightNo,
      positionRuleId: otherRule.id,
      position: otherRule.name,
      staffId: null,
      staffName: "",
      startTime: otherFlight.startTime,
      endTime: otherFlight.endTime,
      workHours: 0,
      fatiguePoints: 0,
      remark: "",
      manualRemark: "",
      status: "unfilled",
    },
  ];
  target.groups.B.activeScheduleDate = "2026-11-18";
  target.templates = [
    { ...target.templates[0]!, flightNo: "AK151", startTime: "", endTime: "" },
    { ...target.templates[1]!, flightNo: "OLD999" },
  ];
  target.shared.templates = target.templates;
  target.flights = [
    { ...target.flights[0]!, flightNo: "AK151", startTime: "", endTime: "" },
    { ...target.flights[1]!, flightNo: "OLD999" },
  ];
  return target;
}

function workbookImport(source = sourceState()) {
  return parseWorkbook(
    XLSX.read(
      XLSX.write(buildConfigWorkbook(source), {
        bookType: "xlsx",
        type: "buffer",
      })
    ),
    []
  );
}

describe("device flight configuration restore", () => {
  it("preserves whole slash position names in templates and current flights across XLSX bytes", () => {
    const source = sourceState();
    const parsed = workbookImport(source);
    expect(flightValues(parsed.templates!)).toEqual(
      flightValues(source.templates)
    );
    expect(flightValues(parsed.flights!)).toEqual(flightValues(source.flights));
  });

  it.each(["config", "all"] as const)(
    "restores file flights and templates in %s mode without old blank times or old flights",
    (mode) => {
      const source = sourceState();
      const target = staleState();
      const other = structuredClone(target.groups.B);
      const parsed = workbookImport(source);
      const applied = applyWorkbookImport(target, parsed, mode, restoreOptions);
      expect(applied.errors).toBeUndefined();
      expect(flightValues(target.templates)).toEqual(
        flightValues(source.templates)
      );
      expect(flightValues(target.flights)).toEqual(
        flightValues(source.flights)
      );
      const candidates = buildCurrentScheduleFlightCandidates(
        target.templates,
        target.flights
      );
      expect(candidates.map((f) => f.flightNo)).toEqual(["AK151", "NEW200"]);
      expect(candidates[0]).toMatchObject({
        startTime: "21:15",
        endTime: "23:15",
        bookedPassengers: 80,
      });
      expect(target.groups.B.staff).toEqual(other.staff);
      expect(target.groups.B.settings).toEqual(other.settings);
      expect(target.groups.B.flights).toEqual(other.flights);
      expect(target.groups.B.assignments).toEqual(other.assignments);
      expect(target.groups.B.activeScheduleDate).toBe(other.activeScheduleDate);
      for (const rule of other.positionRules)
        expect(target.groups.B.positionRules).toContainEqual(rule);
    }
  );

  it("does not let rule-template synchronization recreate a flight absent from the authoritative file templates", () => {
    const source = sourceState();
    source.positionRules.push({
      ...source.positionRules[0]!,
      id: "orphan-rule",
      flightNo: "OLD999",
    });
    const target = staleState();
    applyWorkbookImport(
      target,
      workbookImport(source),
      "config",
      restoreOptions
    );
    expect(target.templates.map((f) => f.flightNo)).toEqual([
      "AK151",
      "NEW200",
    ]);
    expect(target.positionRules.some((r) => r.flightNo === "OLD999")).toBe(
      true
    );
  });

  it.each(["flights", "templates"] as const)(
    "rejects complete restore missing %s before changing any data",
    (key) => {
      const imported = workbookImport();
      delete imported[key];
      const target = staleState();
      const before = structuredClone(target);
      const applied = applyWorkbookImport(
        target,
        imported,
        "config",
        restoreOptions
      );
      expect(applied.errors?.join("")).toContain("完整恢复");
      expect(target).toEqual(before);
    }
  );

  it("rejects partially invalid flight rows instead of silently dropping one flight during complete restore", () => {
    const book = buildConfigWorkbook(sourceState());
    book.Sheets["航班配置"]!["B3"] = { t: "s", v: "" };
    const imported = parseWorkbook(book, []);
    const target = staleState();
    const before = structuredClone(target);
    const applied = applyWorkbookImport(
      target,
      imported,
      "config",
      restoreOptions
    );
    expect(applied.errors?.join("")).toContain("航班配置第3行");
    expect(target).toEqual(before);
  });

  it.each(["航班计划", "航班配置"])(
    "rejects duplicate rows or invalid headers in %s without partial writes",
    (sheetName) => {
      for (const duplicate of [true, false]) {
        const book = buildConfigWorkbook(sourceState());
        const sheet = book.Sheets[sheetName]!;
        if (duplicate)
          XLSX.utils.sheet_add_aoa(
            sheet,
            [XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })[1]!],
            { origin: -1 }
          );
        else sheet["A1"] = { t: "s", v: "错误表头" };
        const target = staleState();
        const before = structuredClone(target);
        const result = applyWorkbookImport(
          target,
          parseWorkbook(book, []),
          "config",
          restoreOptions
        );
        expect(result.errors?.join("")).toContain(sheetName);
        expect(target).toEqual(before);
      }
    }
  );

  it("treats valid empty flight tables as explicit clears and keeps history merge semantics", () => {
    const source = sourceState();
    source.flights = [];
    source.templates = [];
    const person = source.staff[0]!;
    const record = {
      id: "incoming",
      date: "2026-11-12",
      flightNo: "AK151",
      position: "G10",
      staffId: person.id,
      staffName: person.name,
      startTime: "21:05",
      endTime: "23:05",
      workHours: 2,
      fatiguePoints: 3,
      remark: "",
    };
    source.history = [record];
    const target = staleState();
    target.history = [{ ...record, id: "existing", date: "2026-11-17" }];
    const result = applyWorkbookImport(
      target,
      workbookImport(source),
      "config",
      restoreOptions
    );
    expect(result.errors).toBeUndefined();
    expect(target.flights).toEqual([]);
    expect(target.templates).toEqual([]);
    expect(target.history.map((r) => r.date).sort()).toEqual([
      "2026-11-12",
      "2026-11-17",
    ]);
  });

  it("keeps ordinary import, template-only replacement and history-only import behavior", () => {
    const imported = workbookImport();
    for (const options of [{}, { replaceSharedTemplates: true }]) {
      const target = staleState();
      const current = structuredClone(target.flights);
      applyWorkbookImport(target, structuredClone(imported), "config", options);
      expect(target.flights).toEqual(current);
    }
    const target = staleState();
    const before = structuredClone(target);
    applyWorkbookImport(target, imported, "history", restoreOptions);
    expect(target).toEqual(before);
  });

  it("retains restored flights through Store, A/B switching, storage reload and a second export/import", () => {
    const source = sourceState();
    const store = createTestAutoscheduleStore(staleState());
    store
      .getState()
      .records.applyWorkbookImport(
        workbookImport(source),
        "config",
        restoreOptions
      );
    store.getState().switchGroup("B");
    store.getState().switchGroup("A");
    let saved = "";
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const reloaded = loadState({ getItem: () => saved });
    expect(flightValues(reloaded.templates)).toEqual(
      flightValues(source.templates)
    );
    expect(flightValues(reloaded.flights)).toEqual(
      flightValues(source.flights)
    );
    const second = staleState();
    applyWorkbookImport(
      second,
      workbookImport(reloaded),
      "config",
      restoreOptions
    );
    expect(flightValues(second.templates)).toEqual(
      flightValues(source.templates)
    );
    expect(flightValues(second.flights)).toEqual(flightValues(source.flights));
  });

  it("previews without writes, can cancel the restore choice, and uses restored times in generation and reschedule preparation", async () => {
    const source = sourceState();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(staleState()),
      {
        preferences: {
          loadScheduleDate: () => "2026-11-19",
          saveScheduleDate: () => undefined,
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => undefined,
        },
      }
    );
    const before = structuredClone(coordinator.model());
    const file = new File(
      [
        XLSX.write(buildConfigWorkbook(source), {
          type: "array",
          bookType: "xlsx",
        }),
      ],
      "config.xlsx"
    );
    await coordinator.handle({ type: "import-file", file, mode: "config" });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: true,
    });
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: true,
    });
    expect(coordinator.model()).toEqual(before);
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: false,
    });
    await coordinator.handle({ type: "close-dialog" });
    expect(coordinator.model()).toEqual(before);
    await coordinator.handle({ type: "import-file", file, mode: "config" });
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: true,
    });
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: true,
    });
    await coordinator.handle({ type: "apply-workbook-import" });
    expect(flightValues(coordinator.model().flights)).toEqual(
      flightValues(source.flights)
    );
    await coordinator.handle({ type: "generate-schedule" });
    expect(coordinator.view().dialog).toMatchObject({
      kind: "schedule-preflight",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          flightNo: "AK151",
          startTime: "21:15",
          endTime: "23:15",
        }),
      ]),
    });
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({ type: "open-reschedule-flight-picker" });
    expect(coordinator.view().dialog).toMatchObject({
      kind: "reschedule-flight-picker",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          flightNo: "AK151",
          startTime: "21:15",
          endTime: "23:15",
        }),
      ]),
    });
  });
});
