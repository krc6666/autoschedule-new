// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import { saveSupervisorFillRule } from "../../src/app/policy-actions";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import { loadState } from "../../src/infrastructure/storage";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { evaluateSupervisorFillFacts } from "../../src/domain/coverage/supervisor-fill-facts";
import { diagnoseSupervisorFillRuleConfiguration } from "../../src/domain/coverage/supervisor-fill-facts";
import type { Assignment } from "../../src/model";
import { mountElement, settleLit } from "../ui/lit-test-helpers";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { normalizeSupervisorAssignments } from "../../src/domain/assignments/schedule-adjustment";
import type { ApplicationDialog } from "../../src/app/application-view-state";
import "../../src/ui/components/policy-page";
import "../../src/ui/components/position-rules-section";
import "../../src/ui/components/next-workday-flight-picker-dialog";

function scenario() {
  const state = createDefaultState();
  const flight = {
    ...state.flights[0]!,
    id: "f",
    flightNo: "F100",
    startTime: "13:00",
    endTime: "15:00",
    positions: ["督导", "H05"],
  };
  state.templates = [{ ...flight, id: "template" }];
  state.flights = [flight];
  state.staff = [
    {
      ...state.staff[0]!,
      id: "s",
      name: "示例人员",
      status: "正常",
      staffType: "常规",
      nightShift: true,
    },
  ];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "source",
      flightNo: "F100",
      name: "督导",
      category: "机动督导",
      qualifiedStaffIds: ["s"],
      manual: false,
      minPassengers: 0,
    },
    {
      ...state.positionRules[0]!,
      id: "target",
      flightNo: "F100",
      name: "H05",
      category: "常规",
      qualifiedStaffIds: ["s"],
      manual: false,
      minPassengers: 0,
    },
  ];
  state.settings.mobileSupervisorFillRules = [];
  state.settings.positionTransitionPolicies = [];
  state.settings.minimumRegularTransitionMinutes = 0;
  state.assignments = state.positionRules.map((rule, index): Assignment => ({
    id: `a${index}`,
    flightId: "f",
    flightNo: "F100",
    positionRuleId: rule.id,
    position: rule.name,
    staffId: index ? null : "s",
    staffName: index ? "" : "示例人员",
    startTime: "13:00",
    endTime: "15:00",
    workHours: 2,
    fatiguePoints: 2,
    remark: "",
    manualRemark: "",
    status: index ? "unfilled" : "assigned",
  }));
  return state;
}
const input = {
  id: "fill",
  enabled: true,
  sourceFlightNo: "F100",
  sourcePositionKeyword: "督导",
  targetFlightNo: "F100",
  targetPositionKeyword: "H05",
  allowAutomatic: true,
  allowManual: true,
};

describe("unified supervisor fill configuration", () => {
  it("same-flight: rejects saving or running a cross-flight relation and preserves it pending on restore", () => {
    const state = scenario();
    state.templates.push({
      ...state.templates[0]!,
      id: "t2",
      flightNo: "F200",
    });
    state.flights.push({
      ...state.flights[0]!,
      id: "f2",
      flightNo: "F200",
      startTime: "18:00",
      endTime: "20:00",
    });
    state.positionRules[1]!.flightNo = "F200";
    Object.assign(state.assignments[1]!, {
      flightId: "f2",
      flightNo: "F200",
      startTime: "18:00",
      endTime: "20:00",
    });
    const cross = {
      ...input,
      targetFlightNo: "F200",
      requiresConfirmation: false,
    };
    expect(saveSupervisorFillRule(state, cross).ok).toBe(false);
    state.settings.mobileSupervisorFillRules = [cross];
    expect(
      evaluateSupervisorFillFacts(
        state,
        state.assignments,
        state.assignments[0]!,
        state.assignments[1]!,
        "manual"
      ).allowed
    ).toBe(false);
    const imported = parseWorkbook(buildConfigWorkbook(state), state.staff);
    expect(imported.settings!.mobileSupervisorFillRules![0]).toMatchObject({
      sourceFlightNo: "F100",
      targetFlightNo: "F200",
      requiresConfirmation: true,
    });
    const restored = loadState({ getItem: () => JSON.stringify(state) });
    expect(restored.settings.mobileSupervisorFillRules[0]).toMatchObject({
      sourceFlightNo: "F100",
      targetFlightNo: "F200",
      requiresConfirmation: true,
    });
  });
  it("same-flight: provides one flight selector and two position selectors", async () => {
    const page = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: scenario() });
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "新增补位关系")!
      .click();
    await settleLit();
    const editor = page.querySelector('[aria-label="编辑督导补位关系"]')!;
    expect(editor.querySelectorAll('select[aria-label="航班"]').length).toBe(1);
    expect(editor.querySelector('[aria-label="来源航班"]')).toBeNull();
    expect(editor.querySelector('[aria-label="目标航班"]')).toBeNull();
    expect(editor.querySelectorAll("select").length).toBe(3);
  });
  it.each(["pending"] as const)(
    "does not convert a %s configured fill into generic coverage during restoration",
    (mutation) => {
      const state = scenario();
      saveSupervisorFillRule(state, input);
      const source = state.assignments[0]!;
      const target = state.assignments[1]!;
      Object.assign(target, {
        staffId: source.staffId,
        staffName: source.staffName,
        status: "assigned",
        supervisorSourceAssignmentId: source.id,
        supervisorFillRuleId: "fill",
        workHours: 0,
        fatiguePoints: 0,
        remark: "",
      });
      normalizeSupervisorAssignments(state);
      expect(target.supervisorFillRuleId).toBe("fill");
      if (mutation === "pending")
        state.settings.mobileSupervisorFillRules[0]!.requiresConfirmation = true;
      normalizeSupervisorAssignments(state);
      expect(target).toMatchObject({ staffId: null, status: "unfilled" });
      expect(target.supervisorFillRuleId).toBeUndefined();
      expect(source.staffId).toBe("s");
    }
  );
  it("keeps a damaged confirmation value pending when restoring current data", () => {
    const persisted = JSON.parse(JSON.stringify(scenario()));
    persisted.settings.mobileSupervisorFillRules = [
      { ...input, requiresConfirmation: "invalid" },
    ];
    const restored = loadState({ getItem: () => JSON.stringify(persisted) });
    expect(
      restored.settings.mobileSupervisorFillRules[0]!.requiresConfirmation
    ).toBe(true);
  });
  it("flags current-only references so seasonal template changes cannot silently miss them", () => {
    const state = scenario();
    state.templates = [];
    expect(diagnoseSupervisorFillRuleConfiguration(state, input)).toMatchObject(
      { code: "source-template-missing", severity: "warning" }
    );
  });
  it("saves once without a second position flag and retains runtime safety", () => {
    const state = scenario();
    expect(saveSupervisorFillRule(state, input)).toEqual({ ok: true });
    const evaluate = () =>
      evaluateSupervisorFillFacts(
        state,
        state.assignments,
        state.assignments[0]!,
        state.assignments[1]!,
        "automatic"
      );
    expect(evaluate().allowed).toBe(true);
    state.staff[0]!.status = "休假";
    expect(evaluate().allowed).toBe(false);
  });
  it("rejects invalid saves atomically and requires a real template reference", () => {
    const state = scenario();
    expect(saveSupervisorFillRule(state, input).ok).toBe(true);
    const before = structuredClone(state);
    expect(
      saveSupervisorFillRule(state, {
        ...input,
        targetPositionKeyword: "missing",
      }).ok
    ).toBe(false);
    expect(state).toEqual(before);
    state.templates = [];
    expect(saveSupervisorFillRule(state, input).ok).toBe(false);
  });
  it("synchronizes both groups when the template is renamed", () => {
    const state = scenario();
    saveSupervisorFillRule(state, input);
    state.groups.A.positionRules = structuredClone(state.positionRules);
    state.groups.A.settings = structuredClone(state.settings);
    state.groups.B.positionRules = structuredClone(state.positionRules);
    state.groups.B.settings = structuredClone(state.settings);
    updateConfigurationField(state, "template", "template", "flightNo", "F200");
    expect(state.settings.mobileSupervisorFillRules[0]).toMatchObject({
      sourceFlightNo: "F200",
      targetFlightNo: "F200",
    });
    expect(state.groups.B.settings.mobileSupervisorFillRules[0]).toMatchObject({
      sourceFlightNo: "F200",
      targetFlightNo: "F200",
    });
  });
  it("migrates old incomplete relations to pending without activating them and remains idempotent", () => {
    const state = scenario();
    state.settings.mobileSupervisorFillRules = [input];
    const old = { ...state, version: 11 };
    const restored = loadState({ getItem: () => JSON.stringify(old) });
    expect(
      restored.settings.mobileSupervisorFillRules[0]!.requiresConfirmation
    ).toBe(true);
    expect(
      evaluateSupervisorFillFacts(
        restored,
        state.assignments,
        state.assignments[0]!,
        state.assignments[1]!,
        "automatic"
      ).allowed
    ).toBe(false);
    const again = loadState({ getItem: () => JSON.stringify(restored) });
    expect(again.settings.mobileSupervisorFillRules).toEqual(
      restored.settings.mobileSupervisorFillRules
    );
    expect(saveSupervisorFillRule(again, input).ok).toBe(true);
    expect(
      again.settings.mobileSupervisorFillRules[0]!.requiresConfirmation
    ).not.toBe(true);
  });
  it("keeps valid old relations and preserves a marker-only post as a pending configuration", () => {
    const state = scenario();
    state.positionRules[1]!.coverageRole = "supervisor-fill";
    state.settings.mobileSupervisorFillRules = [input];
    const valid = loadState({
      getItem: () => JSON.stringify({ ...state, version: 11 }),
    });
    expect(
      valid.settings.mobileSupervisorFillRules[0]!.requiresConfirmation
    ).not.toBe(true);
    state.settings.mobileSupervisorFillRules = [];
    const orphan = loadState({
      getItem: () => JSON.stringify({ ...state, version: 11 }),
    });
    expect(orphan.settings.mobileSupervisorFillRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPositionKeyword: "H05",
          requiresConfirmation: true,
          enabled: false,
          sourcePositionKeyword: "",
        }),
      ])
    );
  });
  it("round trips confirmation state and canonical categories through XLSX bytes", () => {
    const state = scenario();
    state.settings.mobileSupervisorFillRules = [
      { ...input, requiresConfirmation: true },
    ];
    const workbook = XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "array",
        bookType: "xlsx",
      }),
      { type: "array" }
    );
    const imported = parseWorkbook(workbook, state.staff);
    expect(
      imported.settings?.mobileSupervisorFillRules?.[0]!.requiresConfirmation
    ).toBe(true);
    expect(
      imported.positionRules?.find((rule) => rule.name === "H05")?.category
    ).toBe("常规");
  });
  it("shows a readonly position relationship instead of another editable flag", async () => {
    const state = scenario();
    state.settings.mobileSupervisorFillRules = [input];
    const page = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-position-rules", { model: state });
    expect(page.querySelector('select[aria-label="补位性质"]')).toBeNull();
    expect(page.textContent).toContain("F100 / 督导");
    expect(page.querySelector('[aria-label="管理督导补位"]')).not.toBeNull();
  });
  it("shows pending counts even while the rule card is collapsed", async () => {
    const state = scenario();
    state.settings.mobileSupervisorFillRules = [
      { ...input, requiresConfirmation: true },
    ];
    const page = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const card = page.querySelector<HTMLDetailsElement>(
      "[data-supervisor-fill]"
    )!;
    expect(card.open).toBe(false);
    expect(card.querySelector("summary")!.textContent).toContain("需处理 1 条");
    expect(card.querySelector('input[aria-label="来源航班"]')).toBeNull();
  });

  it("edits a local draft, cancels without writing, then saves through the real controller", async () => {
    const store = createTestAutoscheduleStore(scenario());
    const coordinator = createTestApplicationCoordinator(store, {
      preferences: {
        loadScheduleDate: () => null,
        saveScheduleDate: () => {},
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => {},
      },
    });
    const page = await mountElement<
      HTMLElement & {
        model: ReturnType<typeof scenario>;
        updateComplete: Promise<unknown>;
      }
    >("autoschedule-policy-page", { model: store.getState().model });
    let action = Promise.resolve();
    page.addEventListener(UI_COMMAND_EVENT, (event) => {
      action = coordinator.handle((event as UiCommandEvent).detail).then(() => {
        page.model = store.getState().model;
      });
    });
    const clickText = async (text: string) => {
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === text)!
        .click();
      await action;
      await settleLit();
    };
    const select = async (label: string, value: string) => {
      const element = page.querySelector<HTMLSelectElement>(
        `[aria-label="编辑督导补位关系"] select[aria-label="${label}"]`
      )!;
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await settleLit();
    };
    await clickText("新增补位关系");
    await select("航班", "F100");
    expect(store.getState().model.settings.mobileSupervisorFillRules).toEqual(
      []
    );
    await clickText("取消");
    expect(store.getState().model.settings.mobileSupervisorFillRules).toEqual(
      []
    );
    await clickText("新增补位关系");
    await clickText("保存补位关系");
    expect(coordinator.view().toast?.tone).toBe("warning");
    expect(
      page.querySelector('[aria-label="编辑督导补位关系"]')
    ).not.toBeNull();
    await select("航班", "F100");
    await select("督导岗位", "督导");
    await select("补位岗位", "H05");
    await clickText("保存补位关系");
    expect(store.getState().model.settings.mobileSupervisorFillRules).toEqual([
      expect.objectContaining({
        ...input,
        id: expect.any(String),
        requiresConfirmation: false,
      }),
    ]);
    expect(page.querySelector('[aria-label="编辑督导补位关系"]')).toBeNull();
    expect(store.getState().model.positionRules[1]).not.toHaveProperty(
      "coverageRole"
    );
    await coordinator.handle({ type: "open-supervisor-fill-settings" });
    expect(coordinator.view()).toMatchObject({
      section: "policy",
      policyQuery: "督导补位关系",
    });
    store.getState().switchGroup("B");
    expect(
      store.getState().model.settings.mobileSupervisorFillRules
    ).not.toContainEqual(expect.objectContaining({ sourceFlightNo: "F100" }));
    store.getState().switchGroup("A");
    expect(
      store.getState().model.settings.mobileSupervisorFillRules[0]!
        .sourceFlightNo
    ).toBe("F100");
  });

  it("invalidates an unfinished draft on template rename and offers the new number", async () => {
    const state = scenario();
    saveSupervisorFillRule(state, input);
    const page = await mountElement<
      HTMLElement & { model: typeof state; updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    page
      .querySelector<HTMLButtonElement>('[aria-label="编辑补位关系"]')!
      .click();
    await settleLit();
    const renamed = structuredClone(state);
    updateConfigurationField(
      renamed,
      "template",
      "template",
      "flightNo",
      "F200"
    );
    page.model = renamed;
    await settleLit();
    expect(page.querySelector('[aria-label="编辑督导补位关系"]')).toBeNull();
    page
      .querySelector<HTMLButtonElement>('[aria-label="编辑补位关系"]')!
      .click();
    await settleLit();
    expect(
      page.querySelector<HTMLSelectElement>(
        '[aria-label="编辑督导补位关系"] [aria-label="航班"]'
      )!.value
    ).toBe("F200");

    expect(page.textContent).not.toContain("F100");
  });

  it("imports old relationship and position-only workbooks conservatively", () => {
    const state = scenario();
    state.settings.mobileSupervisorFillRules = [input];
    const old = buildConfigWorkbook(state);
    const sheet = XLSX.utils.sheet_to_json<unknown[]>(
      old.Sheets["督导补位关系"]!,
      { header: 1 }
    );
    old.Sheets["督导补位关系"] = XLSX.utils.aoa_to_sheet(
      sheet.map((row) => row.slice(0, 8))
    );
    const imported = parseWorkbook(old, state.staff);
    expect(
      imported.settings!.mobileSupervisorFillRules![0]!.requiresConfirmation
    ).toBe(true);
    const positionOnly = XLSX.utils.book_new();
    const positions = XLSX.utils.sheet_to_json<unknown[]>(
      old.Sheets["岗位配置"]!,
      { header: 1 }
    );
    const categoryIndex = positions[0]!.indexOf("项目分类");
    expect(categoryIndex).toBeGreaterThanOrEqual(0);
    positions[2]![categoryIndex] = "督导补位";
    XLSX.utils.book_append_sheet(
      positionOnly,
      XLSX.utils.aoa_to_sheet(positions),
      "岗位配置"
    );
    const destination = scenario();
    const partial = parseWorkbook(positionOnly, destination.staff);
    expect(partial.settings?.mobileSupervisorFillRules).toBeUndefined();
    applyWorkbookImport(destination, partial, "config");
    expect(destination.settings.mobileSupervisorFillRules).toContainEqual(
      expect.objectContaining({
        targetPositionKeyword: "H05",
        requiresConfirmation: true,
        enabled: false,
      })
    );
    expect(
      destination.positionRules.every(
        (position) => position.coverageRole === undefined
      )
    ).toBe(true);
  });

  it.each([
    "schedule-preflight",
    "reschedule-flight-picker",
    "next-workday-flight-picker",
  ] as const)("diagnoses the selected draft flights in %s", async (kind) => {
    const state = scenario();
    saveSupervisorFillRule(state, input);
    const dialog: Extract<
      ApplicationDialog,
      {
        kind:
          | "schedule-preflight"
          | "reschedule-flight-picker"
          | "next-workday-flight-picker";
      }
    > = {
      kind,
      adminSupportEnabled: false,
      date: "2026-11-10",
      sourceDate: "2026-11-08",
      groupId: "A",
      weekday: 2,
      candidates: [
        { ...state.flights[0]!, selectedByDefault: true, sourceFlightId: "f" },
      ],
      selectedIds: [],
      staffStatuses: {},
    };
    const page = await mountElement<
      HTMLElement & { dialog: typeof dialog; updateComplete: Promise<unknown> }
    >("autoschedule-next-workday-flight-picker", { model: state, dialog });
    expect(page.textContent).toContain("本次不适用");
    page.dialog = { ...dialog, selectedIds: ["f"] };
    await settleLit();
    expect(page.textContent).not.toContain("本次不适用");
    state.settings.mobileSupervisorFillRules[0]!.requiresConfirmation = true;
    page.dialog = { ...dialog, selectedIds: ["f"] };
    await settleLit();
    expect(page.textContent).toContain("待确认，不参与补位");
  });
});
