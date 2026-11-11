// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { seasonalState } from "../helpers/seasonal-flight-scenario";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { mountElement, settleLit } from "./lit-test-helpers";
import { buildConfigWorkbook } from "../../src/infrastructure/excel";
import * as XLSX from "xlsx-js-style";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import "../../src/ui/components/autoschedule-app";

describe("seasonal group review at the real app seam", () => {
  it("offers retired-old-flight removal without requiring a replacement flight", async () => {
    const store = createTestAutoscheduleStore(seasonalState());
    store.getState().switchGroup("B");
    const prompts: string[] = [];
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-11-11",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
      confirm: (message) => {
        prompts.push(message);
        return true;
      },
    });
    const element = await mountElement<AutoscheduleAppElement>(
      "autoschedule-app",
      {
        model: store.getState().model,
        view: coordinator.view(),
        commandHandler: coordinator,
      }
    );
    const before = structuredClone(store.getState().model);
    const button = element.querySelector<HTMLButtonElement>(
      '[data-retire-flight="OLD100"]'
    );
    expect(button?.textContent).toContain("旧航班已停用，删除本组");
    button!.click();
    await settleLit();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("历史");
    expect(store.getState().model.flights).toEqual([]);
    expect(store.getState().model.positionRules).toEqual([]);
    expect(store.getState().model.groups.A).toEqual(before.groups.A);
  });

  it("warns about B's old references even while A is active and offers explicit new-versus-renamed choices after switching", async () => {
    const store = createTestAutoscheduleStore(seasonalState());
    const coordinator = createTestApplicationCoordinator(store, {
      confirm: () => true,
      preferences: {
        loadScheduleDate: () => "2026-11-11",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    });
    const element = await mountElement<
      HTMLElement & {
        model: ReturnType<typeof seasonalState>;
        updateComplete: Promise<unknown>;
      }
    >("autoschedule-app", {
      model: store.getState().model,
      view: coordinator.view(),
      commandHandler: coordinator,
    });
    expect(
      element.querySelector("[data-flight-season-review]")?.textContent
    ).toContain("B");
    expect(
      element.querySelector("[data-flight-season-review]")?.textContent
    ).toContain("航班核对");
    await coordinator.handle({ type: "switch-group", groupId: "B" });
    element.model = coordinator.model();
    await element.updateComplete;
    expect(element.textContent).toContain("这是新增航班");
    expect(element.textContent).toContain("OLD100");
    expect(element.textContent).toContain("NEW100");
  });

  it.each(["new", "rename:OLD100"])(
    "handles the actual dropdown and confirmation for %s without a hidden guess",
    async (selection) => {
      const store = createTestAutoscheduleStore(seasonalState());
      store.getState().switchGroup("B");
      const prompts: string[] = [];
      const coordinator = createTestApplicationCoordinator(store, {
        confirm: (message) => {
          prompts.push(message);
          return true;
        },
        preferences: {
          loadScheduleDate: () => "2026-11-11",
          saveScheduleDate: () => undefined,
          loadScheduleZoom: () => null,
          saveScheduleZoom: () => undefined,
        },
      });
      const element = await mountElement<AutoscheduleAppElement>(
        "autoschedule-app",
        {
          model: store.getState().model,
          view: coordinator.view(),
          commandHandler: coordinator,
        }
      );
      const unsubscribe = store.subscribe((s) => {
        element.model = s.model;
      });
      try {
        const select = element.querySelector<HTMLSelectElement>(
          '[aria-label="NEW100 航班来源"]'
        )!;
        const before = structuredClone(store.getState().model);
        select.value = selection;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await settleLit();
        expect(store.getState().model).toEqual(before);
        select
          .closest(".border")!
          .querySelector<HTMLButtonElement>("button")!
          .click();
        await settleLit();
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain(
          selection === "new" ? "新增航班" : "OLD100"
        );
        expect(store.getState().model.positionRules[0]!.flightNo).toBe(
          selection === "new" ? "OLD100" : "NEW100"
        );
        expect(store.getState().model.positionRules[0]!.name).toBe("H03");
        expect(store.getState().model.groups.A).toEqual(before.groups.A);
        if (selection === "new")
          expect(element.textContent).toContain("已确认为新增");
      } finally {
        unsubscribe();
      }
    }
  );

  it("previews B differences in a real file import and keeps both groups unchanged when cancelled", async () => {
    const target = seasonalState();
    target.templates = [{ ...target.templates[0]!, flightNo: "OLD100" }];
    const store = createTestAutoscheduleStore(target);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => "2026-11-11",
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
          XLSX.write(buildConfigWorkbook(seasonalState()), {
            type: "array",
            bookType: "xlsx",
          }),
        ],
        "season.xlsx"
      ),
    });
    expect(coordinator.view().dialog).toMatchObject({
      kind: "workbook-import",
      flightPlanReview: expect.arrayContaining([
        expect.objectContaining({
          groupId: "B",
          unmatchedFlightNos: expect.arrayContaining(["OLD100"]),
        }),
      ]),
    });
    const element = await mountElement<AutoscheduleAppElement>(
      "autoschedule-app",
      {
        model: store.getState().model,
        view: coordinator.view(),
        commandHandler: coordinator,
      }
    );
    expect(
      element.querySelector("[data-import-flight-review]")!.textContent
    ).toContain("OLD100");
    expect(
      element.querySelector("[data-import-flight-review]")!.textContent
    ).toContain("B");
    expect(store.getState().model).toEqual(before);
    await coordinator.handle({ type: "close-dialog" });
    expect(store.getState().model).toEqual(before);
  });
});
