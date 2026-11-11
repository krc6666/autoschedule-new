// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import "../../src/ui/components/app-dialog";
import { mountElement, settleLit } from "./lit-test-helpers";
import * as XLSX from "xlsx-js-style";
import { buildConfigWorkbook } from "../../src/infrastructure/excel";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";
import "../../src/ui/components/autoschedule-app";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";

it("previews missing new sections, permits confirmation, and applies exactly the announced defaults", async () => {
  const source = createDefaultState();
  source.templates[0]!.startTime = "07:45";
  source.flights[0]!.startTime = "07:55";
  const book = buildConfigWorkbook(source);
  const optionalKeys = [
    "morningStatsStartTime",
    "morningStatsEndTime",
    "eveningStatsStartTime",
    "eveningStatsEndTime",
  ];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets["规则参数"]!, {
    header: 1,
  });
  book.Sheets["规则参数"] = XLSX.utils.aoa_to_sheet(
    rows.filter((row) => !optionalKeys.includes(String(row[0])))
  );
  for (const sheet of ["休假类别", "半休选择"]) {
    delete book.Sheets[sheet];
    book.SheetNames = book.SheetNames.filter((name) => name !== sheet);
  }
  const target = createDefaultState();
  target.settings.morningStatsStartTime = "04:23";
  target.leaveTypes = [{ id: "local", name: "本机假别", enabled: true }];
  target.halfRestSelections = [
    { date: "2026-11-19", modes: { [target.staff[0]!.id]: "early-finish" } },
  ];
  const store = createTestAutoscheduleStore(target);
  const before = structuredClone(store.getState().model);
  let element: AutoscheduleAppElement | undefined;
  const coordinator = createTestApplicationCoordinator(store, {
    preferences: {
      loadScheduleDate: () => "2026-11-19",
      saveScheduleDate: () => undefined,
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => undefined,
    },
    onViewChange: (view) => {
      if (element) element.view = view;
    },
  });
  element = await mountElement<AutoscheduleAppElement>("autoschedule-app", {
    model: coordinator.model(),
    view: coordinator.view(),
    commandHandler: coordinator,
  });
  const unsubscribe = store.subscribe((state) => {
    element!.model = state.model;
  });
  try {
    await coordinator.handle({
      type: "import-file",
      mode: "config",
      file: new File(
        [XLSX.write(book, { type: "array", bookType: "xlsx" })],
        "config.xlsx"
      ),
    });
    await settleLit();
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: true,
      restoreDefaults: expect.arrayContaining([
        "休假类别：无自建类别",
        "半休选择：无半休人员",
      ]),
    });
    expect(element.textContent).toContain("文件未记录以下新增项目");
    expect(
      element.querySelector<HTMLButtonElement>(
        "autoschedule-workbook-import-dialog .btn-primary"
      )!.disabled
    ).toBe(false);
    expect(store.getState().model).toEqual(before);

    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });
    await settleLit();
    expect(element.textContent).not.toContain("文件未记录以下新增项目");
    expect(store.getState().model).toEqual(before);
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: true,
    });
    await settleLit();
    expect(element.textContent).toContain("文件未记录以下新增项目");
    element
      .querySelector<HTMLButtonElement>(
        "autoschedule-workbook-import-dialog .btn-primary"
      )!
      .click();
    await settleLit();
    const restored = store.getState().model;
    expect(coordinator.view().dialog).toBeNull();
    expect(restored.settings.morningStatsStartTime).toBe(
      source.settings.morningStatsStartTime
    );
    expect(restored.leaveTypes).toEqual([]);
    expect(restored.halfRestSelections).toEqual([]);
    expect(restored.templates[0]!.startTime).toBe("07:45");
    expect(restored.flights[0]!.startTime).toBe("07:55");
  } finally {
    unsubscribe();
  }
});

it("offers explicit device restore and explains the shared template, current group and history scopes", async () => {
  const model = createDefaultState();
  const dialog = {
    kind: "workbook-import" as const,
    mode: "config" as const,
    imported: {
      flights: model.flights,
      templates: model.templates,
      warnings: [],
    },
    recognized: "航班配置",
    changedConfig: true,
    sharedTemplatesAvailable: true,
    replaceSharedTemplates: false,
    restoreFlightConfiguration: false,
    warnings: [],
  };
  const element = await mountElement<
    HTMLElement & { dialog: typeof dialog; updateComplete: Promise<unknown> }
  >("autoschedule-app-dialog", { model, dialog });
  const input = element.querySelector<HTMLInputElement>(
    "input[data-flight-restore]"
  );
  expect(input).not.toBeNull();
  expect(input!.checked).toBe(false);
  const commands: UiCommandEvent["detail"][] = [];
  element.addEventListener(UI_COMMAND_EVENT, (event) =>
    commands.push((event as UiCommandEvent).detail)
  );
  input!.checked = true;
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commands).toEqual([
    { type: "set-workbook-import-flight-restore", enabled: true },
  ]);
  element.dialog = { ...dialog, restoreFlightConfiguration: true };
  await element.updateComplete;
  expect(element.textContent).toContain("换设备完整恢复配置");
  expect(element.textContent).toContain("文件中没有的旧航班会移除");
  expect(element.textContent).toContain("历史仍按原方式合并");
  expect(
    element.querySelector<HTMLInputElement>("input:not([data-flight-restore])")!
      .disabled
  ).toBe(true);
});

it("routes an actual restore checkbox click through the app and renders only the file templates after confirmation", async () => {
  const source = createDefaultState();
  source.templates = [
    {
      ...source.templates[0]!,
      flightNo: "AK151",
      startTime: "21:05",
      endTime: "23:05",
    },
  ];
  source.flights = [
    {
      ...source.flights[0]!,
      flightNo: "AK151",
      startTime: "21:05",
      endTime: "23:05",
    },
  ];
  const stale = createDefaultState();
  stale.templates = ["KE166", "CX937（早）", "CX937（晚）"].map(
    (flightNo, index) => ({
      ...stale.templates[0]!,
      id: `old-${index}`,
      flightNo,
      startTime: "",
      endTime: "",
    })
  );
  const store = createTestAutoscheduleStore(stale);
  let element: AutoscheduleAppElement | undefined;
  const coordinator = createTestApplicationCoordinator(store, {
    preferences: {
      loadScheduleDate: () => "2026-11-19",
      saveScheduleDate: () => undefined,
      loadScheduleZoom: () => null,
      saveScheduleZoom: () => undefined,
    },
    onViewChange: (view) => {
      if (element) element.view = view;
    },
  });
  await coordinator.handle({ type: "navigate", section: "config" });
  element = await mountElement<AutoscheduleAppElement>("autoschedule-app", {
    model: coordinator.model(),
    view: coordinator.view(),
    commandHandler: coordinator,
  });
  const unsubscribe = store.subscribe((state) => {
    element!.model = state.model;
  });
  try {
    const broken = buildConfigWorkbook(source);
    broken.Sheets["岗位衔接规则"]!["I2"] = { t: "s", v: "错误模式" };
    const before = structuredClone(store.getState().model);
    await coordinator.handle({
      type: "import-file",
      mode: "config",
      file: new File(
        [XLSX.write(broken, { type: "array", bookType: "xlsx" })],
        "broken.xlsx"
      ),
    });
    await settleLit();
    expect(
      element.querySelector<HTMLInputElement>("input[data-flight-restore]")!
        .checked
    ).toBe(true);
    expect(
      element.querySelector<HTMLButtonElement>(
        "autoschedule-workbook-import-dialog .btn-primary"
      )!.disabled
    ).toBe(true);
    expect(element.textContent).toContain("完整恢复未通过检查");
    await coordinator.handle({ type: "apply-workbook-import" });
    expect(store.getState().model).toEqual(before);
    await coordinator.handle({
      type: "set-workbook-import-flight-restore",
      enabled: false,
    });
    await settleLit();
    expect(
      element.querySelector<HTMLButtonElement>(
        "autoschedule-workbook-import-dialog .btn-primary"
      )!.disabled
    ).toBe(false);
    await coordinator.handle({ type: "close-dialog" });
    await coordinator.handle({
      type: "import-file",
      mode: "config",
      file: new File(
        [
          XLSX.write(buildConfigWorkbook(source), {
            type: "array",
            bookType: "xlsx",
          }),
        ],
        "config.xlsx"
      ),
    });
    await settleLit();
    const checkbox = element.querySelector<HTMLInputElement>(
      "input[data-flight-restore]"
    )!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    await settleLit();
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: false,
    });
    checkbox.click();
    await settleLit();
    expect(coordinator.view().dialog).toMatchObject({
      restoreFlightConfiguration: true,
    });
    element
      .querySelector<HTMLButtonElement>(
        "autoschedule-workbook-import-dialog .modal-footer .btn-primary"
      )!
      .click();
    await settleLit();
    expect(coordinator.view().dialog).toBeNull();
    expect(store.getState().model.templates.map((f) => f.flightNo)).toEqual([
      "AK151",
    ]);
    expect(
      [
        ...element.querySelectorAll<HTMLInputElement>(
          'input[aria-label="模板航班号"]'
        ),
      ].map((input) => input.value)
    ).toEqual(["AK151"]);
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="模板开始时间"]'
      )!.value
    ).toBe("21:05");
  } finally {
    unsubscribe();
  }
});
