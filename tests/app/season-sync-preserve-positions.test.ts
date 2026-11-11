import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  configuredFlightNumbers,
  configuredSeasonTemplates,
} from "../../src/domain/flights/configured-flight-positions";
import { flightSeasonSyncPreview } from "../../src/domain/flights/flight-season-sync";
import {
  applyFlightSeasonSync,
  setFlightSeasonEnabled,
} from "../../src/app/flight-season-actions";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { loadState, saveState } from "../../src/infrastructure/storage";
import { createTestAutoscheduleStore } from "../helpers/application";
import { seasonalState } from "../helpers/seasonal-flight-scenario";
import { crossWorkdayReservationTargets } from "../../src/domain/reviews/cross-workday-qualification-reservation";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import { deleteTemplate } from "../../src/app/configuration-actions";

const transfer = (state: ReturnType<typeof createDefaultState>) =>
  parseWorkbook(
    XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "buffer",
        bookType: "xlsx",
      })
    ),
    []
  );

describe("season synchronization without overwriting group jobs", () => {
  it("reads the live current-group projection while an import or action has not yet synchronized the stored group copy", () => {
    const state = seasonalState();
    state.positionRules = [
      { ...state.positionRules[0]!, flightNo: "CURRENT200" },
    ];
    state.templates = [{ ...state.templates[0]!, flightNo: "CURRENT200" }];
    expect(flightSeasonSyncPreview(state).sourceNos).toEqual(["CURRENT200"]);
    expect(state.groups.A.positionRules[0]!.flightNo).toBe("NEW100");
  });
  it("does not recreate a deleted template on export, switching, reload, restore or second export even if another group keeps its jobs", () => {
    const source = seasonalState();
    source.templates.push({
      ...source.templates[0]!,
      id: "old-template",
      flightNo: "OLD100",
      startTime: "",
      endTime: "",
    });
    const store = createTestAutoscheduleStore(source);
    store.getState().configuration.deleteTemplate("old-template");
    expect(
      transfer(store.getState().model).templates!.some(
        (t) => t.flightNo === "OLD100"
      )
    ).toBe(false);
    store.getState().switchGroup("B");
    store.getState().switchGroup("A");
    let saved = "";
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const reloaded = loadState({ getItem: () => saved });
    expect(
      reloaded.groups.B.positionRules.some((r) => r.flightNo === "OLD100")
    ).toBe(true);
    const destination = createDefaultState();
    expect(
      applyWorkbookImport(destination, transfer(reloaded), "config", {
        restoreFlightConfiguration: true,
      }).errors
    ).toBeUndefined();
    expect(
      transfer(destination).templates!.some((t) => t.flightNo === "OLD100")
    ).toBe(false);
    // Direct export is read-only and never invents a template from an orphan job.
    deleteTemplate(reloaded, "new");
    expect(transfer(reloaded).templates).toEqual([]);
  });

  it("handles absent, explicit-empty and corrupt season tables without mixing in device choices", () => {
    const singleSheet = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      singleSheet,
      XLSX.utils.aoa_to_sheet([
        ["航班号", "本季启用"],
        ["NEW100", "否"],
      ]),
      "本季航班状态"
    );
    const seasonOnly = parseWorkbook(singleSheet, []);
    expect(seasonOnly.warnings).toEqual([]);
    const partialTarget = createDefaultState();
    expect(
      applyWorkbookImport(partialTarget, seasonOnly, "config").changedConfig
    ).toBe(true);
    expect(partialTarget.flightSeasonOverrides).toEqual({ NEW100: false });
    for (const kind of ["absent", "empty", "corrupt", "duplicate"] as const) {
      const source = createDefaultState();
      source.flightSeasonOverrides = {
        [source.positionRules[0]!.flightNo]: false,
      };
      const book = buildConfigWorkbook(source);
      if (kind === "absent") {
        delete book.Sheets["本季航班状态"];
        book.SheetNames = book.SheetNames.filter((n) => n !== "本季航班状态");
      }
      if (kind === "empty")
        book.Sheets["本季航班状态"] = XLSX.utils.aoa_to_sheet([
          ["航班号", "本季启用"],
        ]);
      if (kind === "corrupt")
        book.Sheets["本季航班状态"]!["B2"] = { t: "s", v: "invalid" };
      if (kind === "duplicate")
        XLSX.utils.sheet_add_aoa(
          book.Sheets["本季航班状态"]!,
          [[source.positionRules[0]!.flightNo, "是"]],
          { origin: -1 }
        );
      const target = createDefaultState();
      target.flightSeasonOverrides = { DEVICE100: false };
      const before = structuredClone(target);
      const result = applyWorkbookImport(
        target,
        parseWorkbook(book, []),
        "config",
        { restoreFlightConfiguration: true }
      );
      if (kind === "corrupt" || kind === "duplicate") {
        expect(result.errors?.join("")).toContain("本季航班状态");
        expect(target).toEqual(before);
      } else {
        expect(result.errors).toBeUndefined();
        expect(target.flightSeasonOverrides).toEqual({});
      }
    }
    const source = createDefaultState();
    const partial = transfer(source);
    delete partial.flightSeasonOverrides;
    const target = createDefaultState();
    target.flightSeasonOverrides = { DEVICE100: false };
    applyWorkbookImport(target, partial, "config");
    expect(target.flightSeasonOverrides).toEqual({ DEVICE100: false });
  });
  it("retains inactive flight reservation settings without reserving staff for an unused seasonal flight", () => {
    const state = createDefaultState();
    const reservation = {
      id: "reserved",
      enabled: true,
      flightNo: state.positionRules[0]!.flightNo,
      matchField: "position" as const,
      keyword: state.positionRules[0]!.name,
      minimumStaffCount: 1,
    };
    state.settings.crossWorkdayQualificationReservations = [reservation];
    expect(
      crossWorkdayReservationTargets(createScheduleGenerationFacts(state))
    ).toHaveLength(1);
    state.flightSeasonOverrides = { [reservation.flightNo]: false };
    expect(
      crossWorkdayReservationTargets(createScheduleGenerationFacts(state)).some(
        (t) => t.reservation.id === reservation.id
      )
    ).toBe(false);
    expect(state.settings.crossWorkdayQualificationReservations).toContainEqual(
      reservation
    );
  });
  it("synchronizes B to A, keeps inactive jobs and rules verbatim, and waits for new B qualifications", () => {
    const store = createTestAutoscheduleStore(seasonalState());
    store.getState().switchGroup("B");
    const model = structuredClone(store.getState().model);
    const before = structuredClone(model);
    const preview = flightSeasonSyncPreview(model);
    expect(preview.additions).toEqual(["NEW100"]);
    expect(preview.retirements).toEqual(["OLD100"]);
    expect(model).toEqual(before);
    expect(applyFlightSeasonSync(model, preview.fingerprint).ok).toBe(true);
    expect(model.positionRules).toEqual(before.positionRules);
    expect(model.settings).toEqual(before.settings);
    expect(model.staff).toEqual(before.staff);
    expect(model.groups.A).toEqual(before.groups.A);
    expect(model.history).toEqual(before.history);
    expect(
      configuredFlightNumbers(model.positionRules, model.flightSeasonOverrides)
    ).toEqual(["NEW100"]);
    expect(model.flights).toEqual([]);
    expect(
      configuredSeasonTemplates(
        model.templates,
        model.positionRules,
        model.flights,
        model.flightSeasonOverrides
      ).map((f) => f.flightNo)
    ).toEqual(["NEW100"]);
    expect(model.positionRules.some((r) => r.flightNo === "NEW100")).toBe(
      false
    );
    model.templates.push({
      ...model.templates[0]!,
      id: "old",
      flightNo: "OLD100",
    });
    expect(setFlightSeasonEnabled(model, "OLD100", true).ok).toBe(true);
    expect(model.positionRules).toEqual(before.positionRules);
    expect(
      configuredFlightNumbers(model.positionRules, model.flightSeasonOverrides)
    ).toEqual(["NEW100", "OLD100"]);
  });

  it("rejects stale source times, changed target and empty A without any partial write", () => {
    for (const change of ["source-time", "target", "empty-source"] as const) {
      const store = createTestAutoscheduleStore(seasonalState());
      store.getState().switchGroup("B");
      const model = structuredClone(store.getState().model);
      const preview = flightSeasonSyncPreview(model);
      if (change === "source-time") model.templates[0]!.startTime = "14:00";
      if (change === "target") model.positionRules[0]!.category = "分流";
      if (change === "empty-source") model.groups.A.positionRules = [];
      const before = structuredClone(model);
      expect(applyFlightSeasonSync(model, preview.fingerprint).ok).toBe(false);
      expect(model).toEqual(before);
    }
  });

  it("retains overrides through Store switching, storage reload and two actual Excel transfers", () => {
    const source = seasonalState();
    source.groups.B.staff = source.staff.map((person) => ({
      ...person,
      id: `b-${person.id}`,
    }));
    source.groups.B.positionRules[0]!.qualifiedStaffIds = [
      source.groups.B.staff[0]!.id,
    ];
    source.groups.B.positionRules[0]!.category = "分流";
    source.groups.B.positionRules[0]!.fatiguePoints = 0;
    const store = createTestAutoscheduleStore(source);
    store.getState().switchGroup("B");
    store
      .getState()
      .configuration.syncFlightSeason(
        flightSeasonSyncPreview(store.getState().model).fingerprint
      );
    store.getState().switchGroup("A");
    store.getState().switchGroup("B");
    let saved = "";
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    let state = loadState({ getItem: () => saved });
    const jobs = structuredClone(state.positionRules);
    for (let i = 0; i < 2; i++) {
      const parsed = transfer(state);
      const target = createDefaultState();
      const result = applyWorkbookImport(target, parsed, "config", {
        restoreFlightConfiguration: true,
      });
      expect(result.errors).toBeUndefined();
      expect(target.flightSeasonOverrides).toEqual({
        NEW100: true,
        OLD100: false,
      });
      expect(target.positionRules.map(({ id: _id, ...r }) => r)).toEqual(
        jobs.map(({ id: _id, ...r }) => r)
      );
      expect(
        configuredFlightNumbers(
          target.positionRules,
          target.flightSeasonOverrides
        )
      ).toEqual(["NEW100"]);
      state = target;
    }
  });

  it("restores unused templates with empty times, keeps all templates and rejects active or malformed times", () => {
    for (const usage of [
      "unused",
      "season",
      "weekly",
      "day",
      "malformed",
    ] as const) {
      const source = createDefaultState();
      source.templates.push({
        id: "spare",
        flightNo: "SPARE100",
        startTime: "",
        endTime: "",
        positions: [],
        remark: "备用",
      });
      if (usage === "season")
        source.positionRules.push({
          ...source.positionRules[0]!,
          id: "spare-job",
          flightNo: "SPARE100",
        });
      if (usage === "weekly")
        source.weeklyFlightPlans[0]!.flightNos.push("SPARE100");
      if (usage === "day")
        source.flights.push({
          ...source.flights[0]!,
          id: "spare-flight",
          flightNo: "SPARE100",
          startTime: "",
          endTime: "",
        });
      if (usage === "malformed") source.templates.at(-1)!.startTime = "bad";
      const target = createDefaultState();
      const before = structuredClone(target);
      const result = applyWorkbookImport(target, transfer(source), "config", {
        restoreFlightConfiguration: true,
      });
      if (usage === "unused") {
        expect(result.errors).toBeUndefined();
        expect(target.templates.at(-1)).toMatchObject({
          flightNo: "SPARE100",
          startTime: "",
          endTime: "",
          remark: "备用",
        });
        expect(transfer(target).templates!.map((t) => t.flightNo)).toEqual(
          source.templates.map((t) => t.flightNo)
        );
      } else {
        expect(result.errors?.length).toBeGreaterThan(0);
        expect(target).toEqual(before);
      }
    }
  });
});
