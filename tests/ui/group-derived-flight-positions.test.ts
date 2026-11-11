// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { loadState, saveState } from "../../src/infrastructure/storage";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { mountElement, settleLit } from "./lit-test-helpers";
import "../../src/ui/components/configuration-settings-section";
import "../../src/ui/components/weekly-flight-plan-section";
import "../../src/ui/components/template-picker-dialog";

function fixture() {
  const state = createDefaultState();
  const template = {
    ...state.templates[0]!,
    flightNo: "TEST100",
    positions: ["STALE"],
  };
  state.templates = [template];
  state.shared.templates = state.templates;
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "a-1",
      flightNo: template.flightNo,
      name: "督导/引导",
      category: "机动督导" as const,
    },
    {
      ...base,
      id: "a-2",
      flightNo: template.flightNo,
      name: "H02",
      category: "常规" as const,
    },
    {
      ...base,
      id: "a-3",
      flightNo: template.flightNo,
      name: "H02",
      category: "行政支援" as const,
    },
  ];
  state.groups.A.positionRules = state.positionRules;
  state.groups.B.positionRules = [
    { ...base, id: "b-1", flightNo: template.flightNo, name: "B01" },
  ];
  state.flights = [
    {
      ...state.flights[0]!,
      flightNo: template.flightNo,
      positions: ["STALE-CURRENT"],
    },
  ];
  return state;
}

describe("current-group configured positions own template views and transfers", () => {
  it("keeps spare seasons in the template library but excludes them from weekly and daily selection and all preparation entries", async () => {
    const state = fixture();
    state.templates.push({
      ...state.templates[0]!,
      id: "spare-season",
      flightNo: "SPARE100",
    });
    const store = createTestAutoscheduleStore(state);
    const before = structuredClone(store.getState().model);
    const library = await mountElement("autoschedule-configuration-settings", {
      model: before,
    });
    expect(
      library.querySelector(
        'input[aria-label="模板航班号"][value="SPARE100"]'
      ) ??
        [
          ...library.querySelectorAll<HTMLInputElement>(
            'input[aria-label="模板航班号"]'
          ),
        ].find((input) => input.value === "SPARE100")
    ).toBeTruthy();
    for (const tag of [
      "autoschedule-weekly-flight-plan",
      "autoschedule-template-picker",
    ]) {
      const element = await mountElement(tag, { model: before });
      expect(element.textContent).toContain("TEST100");
      expect(element.textContent).not.toContain("SPARE100");
    }
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-11-11",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    });
    for (const type of [
      "generate-schedule",
      "open-reschedule-flight-picker",
    ] as const) {
      await coordinator.handle({ type });
      const dialog = coordinator.view().dialog;
      expect(
        dialog && "candidates" in dialog
          ? dialog.candidates.map((r) => r.flightNo)
          : []
      ).toEqual(["TEST100"]);
    }
    expect(
      store.getState().configuration.addTemplateFlight("spare-season")
    ).toBe(false);
    expect(
      store
        .getState()
        .configuration.setWeeklyFlightPlanFlight(1, "SPARE100", true)
    ).toBe(false);
    expect(store.getState().model).toEqual(before);
  });
  it("shows a read-only list that follows the active group's add, rename, sort and delete operations without changing the other group", async () => {
    const store = createTestAutoscheduleStore(fixture());
    const other = structuredClone(
      store.getState().model.groups.B.positionRules
    );
    const element = await mountElement<
      HTMLElement & {
        model: ReturnType<typeof fixture>;
        updateComplete: Promise<unknown>;
      }
    >("autoschedule-configuration-settings", { model: store.getState().model });
    const names = () =>
      element.querySelector<HTMLElement>('[aria-label="模板岗位"]')!
        .textContent;
    expect(element.querySelector('input[aria-label="模板岗位"]')).toBeNull();
    expect(names()).toContain("督导/引导");
    expect(names()).toContain("H02");
    expect(names()).not.toContain("STALE");
    store
      .getState()
      .configuration.updateField("position", "a-2", "name", "H03");
    store.getState().configuration.deletePosition("a-3");
    store.getState().configuration.addPositions("TEST100", 1);
    const added = store.getState().model.positionRules.at(-1)!;
    store
      .getState()
      .configuration.updateField("position", added.id, "name", "H04");
    store.getState().configuration.movePosition(added.id, -1);
    element.model = store.getState().model;
    await settleLit();
    expect(names()).toContain("H03");
    expect(names()).not.toContain("H02");
    expect(names()!.indexOf("H04")).toBeLessThan(names()!.indexOf("H03"));
    expect(store.getState().model.groups.B.positionRules).toEqual(other);
    store.getState().switchGroup("B");
    element.model = store.getState().model;
    await settleLit();
    expect(names()).toContain("B01");
    expect(names()).not.toContain("H03");
    store.getState().configuration.deletePosition("b-1");
    element.model = store.getState().model;
    await settleLit();
    expect(names()).toContain("尚未配置岗位");
  });

  it.each(["autoschedule-weekly-flight-plan", "autoschedule-template-picker"])(
    "uses current-group unique configured counts in %s",
    async (tag) => {
      const element = await mountElement<
        HTMLElement & { updateComplete: Promise<unknown> }
      >(tag, { model: fixture() });
      expect(element.textContent).toMatch(/2\s*岗/);
      expect(element.textContent).not.toMatch(/1\s*岗/);
    }
  );

  it("uses current-group rules in generation and reschedule previews and when adding from a template", async () => {
    const store = createTestAutoscheduleStore(fixture());
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-11-19",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    });
    for (const type of [
      "generate-schedule",
      "open-reschedule-flight-picker",
    ] as const) {
      await coordinator.handle({ type });
      expect(coordinator.view().dialog).toMatchObject({
        candidates: [
          expect.objectContaining({ positions: ["督导/引导", "H02"] }),
        ],
      });
      await coordinator.handle({ type: "close-dialog" });
    }
    store
      .getState()
      .configuration.addTemplateFlight(store.getState().model.templates[0]!.id);
    expect(store.getState().model.flights.at(-1)!.positions).toEqual([
      "督导/引导",
      "H02",
    ]);
  });

  it("exports derived snapshots and preserves authoritative group rules through complete import, save/reload, and a second export", () => {
    const source = fixture();
    const before = structuredClone(source);
    const parsed = parseWorkbook(
      XLSX.read(
        XLSX.write(buildConfigWorkbook(source), {
          type: "buffer",
          bookType: "xlsx",
        })
      ),
      []
    );
    expect(parsed.templates![0]!.positions).toEqual(["督导/引导", "H02"]);
    expect(parsed.flights![0]!.positions).toEqual(["督导/引导", "H02"]);
    expect(source).toEqual(before);
    const store = createTestAutoscheduleStore(createDefaultState());
    const other = structuredClone(
      store.getState().model.groups.B.positionRules
    );
    expect(
      store.getState().records.applyWorkbookImport(parsed, "config", {
        restoreFlightConfiguration: true,
      }).errors
    ).toBeUndefined();
    expect(store.getState().model.positionRules.map((r) => r.name)).toEqual(
      source.positionRules.map((r) => r.name)
    );
    expect(store.getState().model.groups.B.positionRules).toEqual(other);
    store
      .getState()
      .configuration.deletePosition(
        store.getState().model.positionRules.find((r) => r.name === "H02")!.id
      );
    store
      .getState()
      .configuration.deletePosition(
        store.getState().model.positionRules.find((r) => r.name === "H02")!.id
      );
    let saved = "";
    saveState(store.getState().model, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const reloaded = loadState({ getItem: () => saved });
    const again = parseWorkbook(buildConfigWorkbook(reloaded), []);
    expect(again.templates![0]!.positions).toEqual(["督导/引导"]);
    expect(again.positionRules!.map((r) => r.name)).toEqual(["督导/引导"]);
  });

  it("uses the current-group list for archive-and-next-day preparation without writing history or replacing current flights", async () => {
    const state = fixture();
    state.templates.push({
      ...state.templates[0]!,
      id: "spare-next",
      flightNo: "SPARE100",
    });
    const flight = state.flights[0]!;
    const person = state.staff.find(
      (p) => p.staffType === "常规" && p.status === "正常"
    )!;
    state.assignments = [
      {
        id: "assigned",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: "a-2",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    const store = createTestAutoscheduleStore(state);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-11-19",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    });
    const before = structuredClone(store.getState().model);
    await coordinator.handle({ type: "archive-next-duty-day" });
    expect(coordinator.view().dialog).toMatchObject({
      kind: "next-workday-flight-picker",
      candidates: [
        expect.objectContaining({ positions: ["督导/引导", "H02"] }),
      ],
    });
    const nextDialog = coordinator.view().dialog;
    expect(
      nextDialog && "candidates" in nextDialog
        ? nextDialog.candidates.map((r) => r.flightNo)
        : []
    ).toEqual(["TEST100"]);
    expect(store.getState().model).toEqual(before);
    await coordinator.handle({ type: "close-dialog" });
    expect(store.getState().model).toEqual(before);
  });
});
