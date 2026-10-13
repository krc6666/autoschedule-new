// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDefaultState } from "../../src/defaults";
import type { Assignment, PositionRule } from "../../src/model";
import { generateSchedule } from "../helpers/generate-schedule";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";
import { buildMonthlyRelaxedShiftStatistics } from "../../src/domain/statistics/relaxed-shift-statistics";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import "../../src/ui/components/schedule-page";
import { mountElement, settleLit } from "./lit-test-helpers";

describe("schedule page", () => {
  it("keeps vacant person cells free of explanations and usable for manual filling", async () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const rule = state.positionRules.find(
      (row) => row.flightNo === flight.flightNo
    )!;
    state.assignments = [
      {
        id: "vacancy-detail",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "unfilled",
        systemNotes: [
          "上一班做了需要休息保护的晚班岗位，这次换人会让他超过设置规定的下班时间。",
        ],
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-10-15",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    await element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-grid")?.updateComplete;
    const cell = element.querySelector(
      '.schedule-person-cell[data-assignment-id="vacancy-detail"]'
    )!;
    expect(cell.querySelector("details")).toBeNull();
    expect(cell.textContent).not.toContain("上一班做了需要休息保护的晚班岗位");
    expect(cell.classList.contains("is-unfilled")).toBe(true);
    const commands: unknown[] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });
    const input = cell.querySelector<HTMLInputElement>(".schedule-name-input")!;
    expect(input.value).toBe("");
    input.value = "人员甲";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commands).toContainEqual({
      type: "update-assignment",
      id: "vacancy-detail",
      field: "staffName",
      value: "人员甲",
    });
  });
  it("marks only enabled unfilled positions red across passenger thresholds", async () => {
    const state = createDefaultState();
    const baseFlight = state.flights[0]!;
    const baseRule = state.positionRules.find(
      (item) => item.flightNo === baseFlight.flightNo
    )!;
    state.flights = [
      {
        ...baseFlight,
        id: "below-threshold-flight",
        flightNo: "TEST050",
        bookedPassengers: 50,
        positions: ["未达门槛岗位"],
      },
      {
        ...baseFlight,
        id: "enabled-threshold-flight",
        flightNo: "TEST120",
        bookedPassengers: 120,
        positions: ["已达门槛岗位"],
      },
      {
        ...baseFlight,
        id: "always-enabled-flight",
        flightNo: "TEST000",
        bookedPassengers: 0,
        positions: ["零门槛岗位"],
      },
    ];
    state.positionRules = [
      {
        ...baseRule,
        id: "below-threshold-rule",
        flightNo: "TEST050",
        name: "未达门槛岗位",
        minPassengers: 100,
      },
      {
        ...baseRule,
        id: "enabled-threshold-rule",
        flightNo: "TEST120",
        name: "已达门槛岗位",
        minPassengers: 100,
      },
      {
        ...baseRule,
        id: "always-enabled-rule",
        flightNo: "TEST000",
        name: "零门槛岗位",
        minPassengers: 0,
      },
    ];
    state.assignments = state.positionRules.map((rule, index) => {
      const flight = state.flights[index]!;
      return {
        id: `${rule.id}-vacancy`,
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "unfilled" as const,
      };
    });

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-01",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const grid = element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-grid");
    await grid?.updateComplete;

    const cells = (assignmentId: string) => {
      const person = element.querySelector(
        `.schedule-person-cell[data-assignment-id="${assignmentId}"]`
      );
      const position = person
        ?.closest("td")
        ?.previousElementSibling?.querySelector(".schedule-position-cell");
      return { person, position };
    };
    const belowThreshold = cells("below-threshold-rule-vacancy");
    const enabledThreshold = cells("enabled-threshold-rule-vacancy");
    const alwaysEnabled = cells("always-enabled-rule-vacancy");

    expect(belowThreshold.position?.classList.contains("is-unfilled")).toBe(
      false
    );
    expect(belowThreshold.person?.classList.contains("is-unfilled")).toBe(
      false
    );
    expect(
      belowThreshold.person?.querySelector(".schedule-name-input")
    ).not.toBeNull();
    expect(enabledThreshold.position?.classList.contains("is-unfilled")).toBe(
      true
    );
    expect(enabledThreshold.person?.classList.contains("is-unfilled")).toBe(
      true
    );
    expect(alwaysEnabled.position?.classList.contains("is-unfilled")).toBe(
      true
    );
    expect(alwaysEnabled.person?.classList.contains("is-unfilled")).toBe(true);
    const styles = readFileSync(
      join(process.cwd(), "src", "styles.css"),
      "utf8"
    );
    const unfilledRule = styles.match(
      /\.schedule-cell\.is-unfilled(?:\.is-soft-rule-warning|\.is-manual-override-warning)?[^}]*\{(?<declarations>[^}]*)\}/
    )?.groups?.declarations;
    expect(unfilledRule).toContain("#fff0f0");
    expect(unfilledRule).toContain("#d94343");
    expect(styles).toMatch(
      /\.schedule-cell\.is-unfilled\.is-soft-rule-warning,[\s\S]*?background:\s*#fff0f0/
    );
  });

  it("marks an unfilled KE166 mobile supervisor cell red with a dedicated message", async () => {
    const state = createDefaultState();
    const flight = {
      id: "flight-ke166",
      flightNo: "KE166",
      startTime: "09:00",
      endTime: "11:00",
      bookedPassengers: 0,
      positions: ["督导"],
      remark: "",
    };
    const rule = {
      ...state.positionRules[0]!,
      id: "rule-ke166-mobile",
      flightNo: "KE166",
      name: "督导",
      category: "机动督导" as const,
      qualifiedStaffIds: [],
      minPassengers: 100,
    };
    state.flights = [flight];
    state.positionRules = [rule];
    state.assignments = [
      {
        id: "ke166-missing",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "unfilled",
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-01",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const grid = element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-grid");
    await grid?.updateComplete;
    const personCell = element.querySelector(
      ".schedule-person-cell.is-ke166-unfilled"
    );
    const input = personCell?.querySelector<HTMLInputElement>(
      ".schedule-name-input"
    );

    expect(personCell).not.toBeNull();
    expect(input?.placeholder).toBe("KE166机动督导未安排");
    const styles = readFileSync(
      join(process.cwd(), "src", "styles.css"),
      "utf8"
    );
    expect(styles).toMatch(/\.schedule-person-cell\.is-ke166-unfilled\s*\{/);
  });

  it("warns when a refreshed page is showing a restored old schedule", async () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo
    )!;
    const staff = state.staff.find((person) =>
      rule.qualifiedStaffIds.includes(person.id)
    )!;
    state.assignments = [
      {
        id: "restored-old-schedule",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: staff.id,
        staffName: staff.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "assigned",
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-01",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
      restoredScheduleNotice: true,
    });

    expect(element.textContent).toContain("这是旧班表，请重新排班后再使用");
  });

  it("shows only qualified idle staff when a position is selected", async () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo && item.category === "常规"
    )!;
    const [available, busy, unqualified] = state.staff.slice(0, 3);
    state.staff = [available!, busy!, unqualified!];
    rule.qualifiedStaffIds = [available!.id, busy!.id];
    state.assignments = [
      {
        id: "target-assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: null,
        staffName: "",
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 0,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "unfilled",
      },
      {
        id: "busy-assignment",
        flightId: "other-flight",
        flightNo: "OTHER",
        positionRuleId: rule.id,
        position: rule.name,
        staffId: busy!.id,
        staffName: busy!.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "assigned",
      },
    ];
    const commands: UiCommandEvent["detail"][] = [];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-03",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
      halfRestStaffIds: [],
      halfRestModes: {},
    });
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });

    element
      .querySelector<HTMLButtonElement>(
        `button[aria-label="查看${rule.name}可用人员"]`
      )
      ?.click();
    await settleLit();

    const menu = element.querySelector<HTMLElement>(".schedule-candidate-menu");
    expect(menu?.textContent).toContain(available!.name);
    expect(menu?.textContent).not.toContain(busy!.name);
    expect(menu?.textContent).not.toContain(unqualified!.name);

    const candidateTrigger = element.querySelector<HTMLButtonElement>(
      `button[aria-label="查看${rule.name}当前合格空闲人员"]`
    );
    expect(candidateTrigger).toBeTruthy();
    expect(candidateTrigger?.closest(".schedule-position-cell")).toBeTruthy();
    expect(
      element
        .querySelector<HTMLButtonElement>(`.schedule-position-cell .icon-btn`)
        ?.closest(".schedule-position-cell")
    ).toBeTruthy();
    candidateTrigger?.click();
    await settleLit();
    expect(element.querySelector(".schedule-candidate-menu")).toBeNull();
    candidateTrigger?.click();
    await settleLit();
    expect(element.querySelector(".schedule-candidate-menu")).toBeTruthy();

    element
      .querySelector<HTMLButtonElement>(".schedule-candidate-option")
      ?.click();
    expect(commands.at(-1)).toEqual({
      type: "assign-staff",
      assignmentId: "target-assignment",
      staffId: available!.id,
    });

    element
      .querySelector<HTMLButtonElement>('button[aria-label="清空人员"]')
      ?.click();
    expect(commands.at(-1)).toEqual({
      type: "assign-staff",
      assignmentId: "target-assignment",
      staffId: "",
    });
  });

  it("selects multiple regular staff as current-date half-rest preferences", async () => {
    const state = createDefaultState();
    state.assignments = [];
    const selectable = state.staff
      .filter(
        (person) => person.status === "正常" && person.staffType === "常规"
      )
      .slice(0, 2);
    const commands: UiCommandEvent["detail"][] = [];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-03",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
      halfRestStaffIds: [],
    });
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });

    expect(element.textContent).toContain("半休人员");
    expect(element.textContent).toContain("下午半休");
    expect(element.textContent).toContain("上午半休");
    expect(element.textContent).not.toContain("尽早下班");
    expect(element.textContent).not.toContain("晚到班");
    const inputs = selectable.map((person) =>
      element.querySelector<HTMLInputElement>(
        `input[aria-label="${person.name}设为半休"]`
      )
    );
    expect(inputs.every(Boolean)).toBe(true);
    inputs[0]!.click();
    const mode = element.querySelector<HTMLSelectElement>(
      `select[aria-label="${selectable[0]!.name}半休时段"]`
    )!;
    mode.value = "late-start";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    inputs[1]!.click();

    expect(commands.at(-1)).toEqual({
      type: "set-half-rest-staff",
      staffIds: selectable.map((person) => person.id),
      modes: {
        [selectable[0]!.id]: "late-start",
        [selectable[1]!.id]: "early-finish",
      },
    });
  });

  it("marks only half-rest shortages red", async () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const rules = state.positionRules
      .filter((rule) => rule.flightNo === flight.flightNo && !rule.manual)
      .slice(0, 2);
    rules[0]!.minPassengers = flight.bookedPassengers + 1;
    state.assignments = rules.map((rule, index) => ({
      id: `vacancy-${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: null,
      staffName: "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 0,
      fatiguePoints: rule.fatiguePoints,
      remark: rule.remark,
      manualRemark: "",
      status: "unfilled" as const,
      ...(index === 0
        ? { systemNotes: ["半休安排：后续可用人员不足，岗位保持空缺"] }
        : {}),
    }));
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-03",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
      halfRestStaffIds: [],
    });

    expect(
      element.querySelector('[data-assignment-id="vacancy-0"]')?.classList
    ).toContain("is-half-rest-unfilled");
    expect(
      element.querySelector('[data-assignment-id="vacancy-0"]')?.classList
    ).toContain("is-unfilled");
    expect(
      element.querySelector('[data-assignment-id="vacancy-1"]')?.classList
    ).not.toContain("is-half-rest-unfilled");
  });

  it("keeps the administrative switch controlled until its command is applied", async () => {
    const state = createDefaultState();
    state.settings.adminSupportEnabled = false;
    const commands: UiCommandEvent["detail"][] = [];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-toolbar", {
      model: state,
      date: "2026-07-18",
      zoom: 1,
    });
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });
    const input = element.querySelector<HTMLInputElement>(
      ".admin-support-switch input"
    )!;

    input.click();

    expect(commands).toContainEqual({
      type: "toggle-administrative-mode",
      enabled: true,
    });
    expect(input.checked).toBe(false);
  }, 30_000);

  it("opens flight confirmation from the reschedule toolbar action", async () => {
    const state = createDefaultState();
    const commands: UiCommandEvent["detail"][] = [];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-toolbar", {
      model: state,
      date: "2026-08-29",
      zoom: 1,
    });
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });

    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("重新排班"))
      ?.click();

    expect(commands.at(-1)).toEqual({
      type: "open-reschedule-flight-picker",
    });
  });

  it("toggles the nearest earlier archived workday above the current schedule", async () => {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    const person = state.staff[0]!;
    state.assignments = [
      {
        id: "current-assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: null,
        position: "当前岗位",
        staffId: person.id,
        staffName: person.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [
      {
        id: "older",
        date: "2026-07-16",
        flightNo: "CX937",
        position: "旧岗位",
        staffId: "staff-older",
        staffName: "较早人员",
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
      },
      {
        id: "previous",
        date: "2026-07-18",
        flightNo: "TR121",
        position: "上一班岗位",
        staffId: "staff-previous",
        staffName: "上一班人员",
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 4,
        remark: "一号",
      },
      {
        id: "same-date",
        date: "2026-07-20",
        flightNo: "CX931",
        position: "当天归档",
        staffId: "staff-same",
        staffName: "当天人员",
        startTime: "17:50",
        endTime: "19:50",
        workHours: 2,
        fatiguePoints: 3,
        remark: "",
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-20",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const comparisonButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("对比上一班")
    );

    expect(comparisonButton).toBeDefined();
    expect(element.querySelector(".previous-schedule-comparison")).toBeNull();
    comparisonButton?.click();
    await settleLit();

    const comparison = element.querySelector(".previous-schedule-comparison");
    expect(comparison?.textContent).toContain("2026-07-18");
    expect(comparison?.textContent).toContain("上一班人员");
    expect(comparison?.textContent).not.toContain("较早人员");
    expect(comparison?.textContent).not.toContain("当天人员");
    expect(
      comparison?.querySelector('[aria-label="删除这条历史记录"]')
    ).toBeNull();
    expect(element.textContent).toContain("收起上一班");

    [...element.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("收起上一班"))
      ?.click();
    await settleLit();
    expect(element.querySelector(".previous-schedule-comparison")).toBeNull();
  });

  it("disables previous-workday comparison when no earlier archive exists", async () => {
    const state = createDefaultState();
    state.assignments = [
      {
        id: "current-assignment",
        flightId: state.flights[0]!.id,
        flightNo: state.flights[0]!.flightNo,
        positionRuleId: null,
        position: "当前岗位",
        staffId: state.staff[0]!.id,
        staffName: state.staff[0]!.name,
        startTime: state.flights[0]!.startTime,
        endTime: state.flights[0]!.endTime,
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-20",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const unavailableButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("暂无上一班记录")
    );

    expect(unavailableButton).toBeDefined();
    expect(unavailableButton?.hasAttribute("disabled")).toBe(true);
  });

  it("stretches the schedule grid across available desktop width", () => {
    const styles = readFileSync(
      join(process.cwd(), "src", "styles.css"),
      "utf8"
    );
    const scheduleTableRule = styles.match(
      /\.schedule-grid-table\s*\{(?<declarations>[^}]*)\}/
    )?.groups?.declarations;
    const declarations = document.createElement("div").style;
    declarations.cssText = scheduleTableRule ?? "";

    expect(declarations.width).toBe("100%");
    expect(declarations.minWidth).toBe(
      "calc(var(--flight-count) * var(--schedule-flight-width))"
    );
  });

  it("keeps the wide flight table inside its own mobile scroll boundary", () => {
    const styles = readFileSync(
      join(process.cwd(), "src", "styles.css"),
      "utf8"
    );
    const hostRule = styles.match(
      /autoschedule-staff-palette,\s*autoschedule-schedule-grid,\s*autoschedule-duty-roster-summary,\s*autoschedule-schedule-relaxed-shift-summary\s*\{(?<declarations>[^}]*)\}/
    )?.groups?.declarations;
    const boardRule = styles.match(
      /\.schedule-board\s*\{(?<declarations>[^}]*)\}/
    )?.groups?.declarations;
    const host = document.createElement("div").style;
    const board = document.createElement("div").style;
    host.cssText = hostRule ?? "";
    board.cssText = boardRule ?? "";

    expect(host.display).toBe("block");
    expect(host.minWidth).toBe("0");
    expect(host.maxWidth).toBe("100%");
    expect(board.width).toBe("100%");
    expect(board.maxWidth).toBe("100%");
    expect(board.overflowX).toBe("auto");
  });

  it("places the duty summary beside the desktop board and above narrow layouts", () => {
    const styles = readFileSync(
      join(process.cwd(), "src", "styles.css"),
      "utf8"
    );
    const desktop = styles.match(
      /\.schedule-workspace\s*\{(?<declarations>[^}]*)\}/
    )?.groups?.declarations;
    const narrow = styles.match(
      /@media \(max-width: 1000px\)[\s\S]*?\.schedule-workspace\s*\{(?<declarations>[^}]*)\}/
    )?.groups?.declarations;

    expect(desktop).toContain('grid-template-areas: "staff board roster"');
    expect(narrow).toContain(
      'grid-template-areas: "roster roster" "staff board"'
    );
  });

  it("shows today's relaxed-shift lists beside the schedule using statistics-page facts", async () => {
    const state = createDefaultState();
    const [earlyPerson, afternoonFreePerson] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    const rule = state.positionRules.find(
      (item) => item.category === "常规" && !item.manual
    )!;
    state.staff = [earlyPerson!, afternoonFreePerson!];
    state.activeScheduleDate = "2026-07-18";
    state.dutyRosterOverrides = [
      {
        date: "2026-07-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.history = [
      {
        id: "previous-early",
        date: "2026-07-16",
        flightNo: "EARLY100",
        position: rule.name,
        staffId: earlyPerson!.id,
        staffName: earlyPerson!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "current-early",
        flightId: "early-flight",
        flightNo: "EARLY100",
        positionRuleId: rule.id,
        position: rule.name,
        staffId: earlyPerson!.id,
        staffName: earlyPerson!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "current-noon",
        flightId: "noon-flight",
        flightNo: "NOON200",
        positionRuleId: rule.id,
        position: rule.name,
        staffId: afternoonFreePerson!.id,
        staffName: afternoonFreePerson!.name,
        startTime: "10:00",
        endTime: "12:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    const statistics = buildMonthlyRelaxedShiftStatistics(state, "2026-07-18");
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-18",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const summary = element.querySelector(".schedule-relaxed-shift-summary");
    const text = summary?.textContent ?? "";

    expect(summary).not.toBeNull();
    expect(text).toContain("提前下班人员");
    expect(text).toContain("下午无航班人员");
    for (const item of statistics.currentEarlyDepartures) {
      expect(text).toContain(item.staffName);
      expect(text).toContain(`${item.flightNo} / ${item.cutoffTime}`);
      expect(text).toContain(`本月 ${item.monthlyCount} 次`);
    }
    for (const item of statistics.currentAfternoonRest) {
      expect(text).toContain(item.staffName);
      expect(text).toContain(`本月 ${item.monthlyCount} 次`);
    }
  });

  it("queries regular staff flights by workday using compact flight-only tags", async () => {
    const state = createDefaultState();
    const regular = state.staff.find((person) => person.staffType === "常规")!;
    const unassignedRegular = state.staff.find(
      (person) => person.staffType === "常规" && person.id !== regular.id
    )!;
    const administrative = {
      ...regular,
      id: "administrative",
      name: "行政人员",
      staffType: "行政支援" as const,
    };
    state.staff = [regular, unassignedRegular, administrative];
    state.activeScheduleDate = "2026-09-13";
    state.assignments = [
      {
        id: "current-cx-1",
        flightId: "current-cx",
        flightNo: "CX931",
        positionRuleId: null,
        position: "G18",
        staffId: regular.id,
        staffName: regular.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "current-cx-2",
        flightId: "current-cx",
        flightNo: "CX931",
        positionRuleId: null,
        position: "G20",
        staffId: regular.id,
        staffName: regular.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "current-admin",
        flightId: "current-tr",
        flightNo: "TR121",
        positionRuleId: null,
        position: "H02",
        staffId: administrative.id,
        staffName: administrative.name,
        startTime: "12:00",
        endTime: "14:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = [
      {
        id: "archived-ke",
        date: "2026-09-11",
        flightNo: "KE166",
        position: "K01",
        staffId: regular.id,
        staffName: regular.name,
        startTime: "07:00",
        endTime: "09:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        historyCoverage: "complete",
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-09-13",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const statistics = element.querySelector(
      "autoschedule-daily-staff-flight-statistics"
    )!;
    const currentRow = statistics.querySelector(
      '.daily-staff-flight-row[data-staff-id="' + regular.id + '"]'
    )!;

    expect(currentRow.textContent?.replace(/\s+/g, " ").trim()).toContain(
      `${regular.name} 1 CX931`
    );
    expect(currentRow.textContent).not.toContain("G18");
    expect(currentRow.textContent).not.toContain("2026-09-13");
    expect(statistics.textContent).not.toContain(administrative.name);
    expect(
      statistics.querySelector(".daily-staff-flight-unassigned")?.textContent
    ).toContain(unassignedRegular.name);

    const dateInput = statistics.querySelector<HTMLInputElement>(
      'input[aria-label="人员航班查询日期"]'
    )!;
    dateInput.value = "2026-09-11";
    dateInput.dispatchEvent(new Event("change"));
    await settleLit();

    expect(
      statistics
        .querySelector(
          '.daily-staff-flight-row[data-staff-id="' + regular.id + '"]'
        )
        ?.textContent?.replace(/\s+/g, " ")
        .trim()
    ).toContain(`${regular.name} 1 KE166`);
    expect(statistics.textContent).not.toContain("CX931");
  });

  it("shows aligned staff rows with zero counts and supports flight-count sorting", async () => {
    const state = createDefaultState();
    const regularStaff = state.staff
      .filter((person) => person.staffType === "常规")
      .slice(0, 3);
    const [first, second, third] = regularStaff;
    state.staff = regularStaff;
    state.activeScheduleDate = "2026-09-13";
    state.assignments = [
      {
        id: "sort-a",
        flightId: "sort-flight-a",
        flightNo: "CX931",
        positionRuleId: null,
        position: "G01",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "sort-b",
        flightId: "sort-flight-b",
        flightNo: "TR121",
        positionRuleId: null,
        position: "G01",
        staffId: first!.id,
        staffName: first!.name,
        startTime: "12:00",
        endTime: "14:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
      {
        id: "sort-c",
        flightId: "sort-flight-c",
        flightNo: "KE166",
        positionRuleId: null,
        position: "G01",
        staffId: second!.id,
        staffName: second!.name,
        startTime: "09:00",
        endTime: "11:00",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-09-13",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const statistics = element.querySelector(
      "autoschedule-daily-staff-flight-statistics"
    )!;
    const rows = () =>
      [
        ...statistics.querySelectorAll<HTMLElement>(".daily-staff-flight-row"),
      ].map((row) => row.dataset.staffId);

    expect(rows()).toEqual([first!.id, second!.id, third!.id]);
    expect(statistics.textContent).toContain("统计日期 2026-09-13");
    expect(statistics.textContent).toContain("人员总数 3");
    expect(statistics.textContent).toContain("总航班 3");
    expect(
      statistics.querySelector(
        `.daily-staff-flight-row[data-staff-id="${third!.id}"] .daily-staff-flight-count`
      )?.textContent
    ).toBe("0");

    const sort = statistics.querySelector<HTMLSelectElement>(
      'select[aria-label="人员航班排序"]'
    )!;
    sort.value = "asc";
    sort.dispatchEvent(new Event("change"));
    await settleLit();
    expect(rows()).toEqual([third!.id, second!.id, first!.id]);
  });

  it("highlights only the last schedule cell for today's early-departure staff", async () => {
    const state = createDefaultState();
    const [earlyPerson, afternoonFreePerson, regularPerson] = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 3);
    const rule = state.positionRules.find(
      (item) => item.category === "常规" && !item.manual
    )!;
    state.staff = [earlyPerson!, afternoonFreePerson!, regularPerson!];
    state.activeScheduleDate = "2026-07-18";
    state.settings.earlyDepartureCutoffTime = "13:00";
    state.settings.afternoonRestStartTime = "13:00";
    state.settings.afternoonRestEndTime = "17:00";
    state.dutyRosterOverrides = [
      {
        date: "2026-07-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.flights = [
      {
        id: "morning-flight",
        flightNo: "TEST100",
        startTime: "08:00",
        endTime: "09:00",
        remark: "",
        bookedPassengers: 0,
        positions: [],
      },
      {
        id: "noon-flight",
        flightNo: "TEST200",
        startTime: "10:00",
        endTime: "12:00",
        remark: "",
        bookedPassengers: 0,
        positions: [],
      },
      {
        id: "afternoon-flight",
        flightNo: "TEST300",
        startTime: "14:00",
        endTime: "16:00",
        remark: "",
        bookedPassengers: 0,
        positions: [],
      },
      {
        id: "evening-flight",
        flightNo: "TEST400",
        startTime: "18:00",
        endTime: "19:00",
        remark: "",
        bookedPassengers: 0,
        positions: [],
      },
    ];
    const assignment = (
      id: string,
      flightIndex: number,
      staff: (typeof state.staff)[number]
    ) => ({
      id,
      flightId: state.flights[flightIndex]!.id,
      flightNo: state.flights[flightIndex]!.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: staff.id,
      staffName: staff.name,
      startTime: state.flights[flightIndex]!.startTime,
      endTime: state.flights[flightIndex]!.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: "assigned" as const,
    });
    state.assignments = [
      assignment("early-first", 0, earlyPerson!),
      assignment("early-last", 1, earlyPerson!),
      assignment("afternoon-free-last", 3, afternoonFreePerson!),
      assignment("regular-last", 2, regularPerson!),
    ];
    const statistics = buildMonthlyRelaxedShiftStatistics(state, "2026-07-18");

    expect(
      statistics.currentEarlyDepartures.map((item) => item.staffId)
    ).toContain(earlyPerson!.id);
    expect(
      statistics.currentEarlyDepartures.map((item) => item.staffId)
    ).not.toContain(afternoonFreePerson!.id);
    expect(
      statistics.currentAfternoonRest.map((item) => item.staffId)
    ).toContain(afternoonFreePerson!.id);

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-18",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });

    expect(
      element.querySelector('[data-assignment-id="early-first"]')?.classList
    ).not.toContain("is-early-departure-last");
    expect(
      element.querySelector('[data-assignment-id="early-last"]')?.classList
    ).toContain("is-early-departure-last");
    expect(
      element.querySelector('[data-assignment-id="afternoon-free-last"]')
        ?.classList
    ).not.toContain("is-early-departure-last");
    expect(
      element.querySelector('[data-assignment-id="regular-last"]')?.classList
    ).not.toContain("is-early-departure-last");
  });

  it("renders the complete toolbar, aligned grid, remarks, duty summary, feedback, and load controls", async () => {
    const state = createDefaultState();
    state.assignments = (
      await generateSchedule(state, "2026-07-18")
    ).assignments;
    state.activeScheduleDate = "2026-07-18";
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-18",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const text = element.textContent ?? "";

    [
      "重新排班",
      "归档并排后天",
      "导出结果",
      "仅归档",
      "是否启用行政支援模式",
    ].forEach((label) => expect(text).toContain(label));
    [
      "导出 HTML",
      "导出图片",
      "清空排班",
      "缩小排班表",
      "恢复 100%",
      "放大排班表",
    ].forEach((label) =>
      expect(element.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
    );
    expect(element.querySelectorAll('th[colspan="2"]')).toHaveLength(
      state.flights.length
    );
    expect(element.querySelectorAll(".schedule-position-column")).toHaveLength(
      state.flights.length
    );
    expect(text).toContain("申报");
    expect(text).toContain("次日备勤人员");
    expect(text).toContain("排班反馈");
    expect(text).toContain("人员覆盖");
    expect(text).toContain("航班衔接");
    expect(
      element.querySelector('select[aria-label="负荷排序字段"]')
    ).not.toBeNull();
    expect(
      element.querySelector('select[aria-label="负荷排序方向"]')
    ).not.toBeNull();
    const workspace = element.querySelector(".schedule-workspace");
    const palette = workspace?.querySelector(
      ":scope > autoschedule-staff-palette"
    );
    const grid = workspace?.querySelector(
      ":scope > autoschedule-schedule-grid"
    );
    const roster = workspace?.querySelector(
      ":scope > .schedule-side-panel > autoschedule-duty-roster-summary"
    );
    const relaxedShiftSummary = workspace?.querySelector(
      ":scope > .schedule-side-panel > autoschedule-schedule-relaxed-shift-summary"
    );
    expect(palette).not.toBeNull();
    expect(grid).not.toBeNull();
    expect(roster).not.toBeNull();
    expect(relaxedShiftSummary).not.toBeNull();
  }, 30_000);

  it("preserves stale warnings, zoom projection, administrative staff, and soft-rule evidence", async () => {
    const state = createDefaultState();
    state.assignments = (
      await generateSchedule(state, "2026-07-18")
    ).assignments;
    state.settings.adminSupportEnabled = true;
    state.staff.push({
      id: "A1",
      name: "行政一号",
      staffType: "行政支援",
      teamLeader: false,
      cxPreflightQualified: false,
      dutyQualified: false,
      standbyQualified: false,
      nightShift: true,
      status: "正常",
      remark: "",
    });
    const assignment = state.assignments.find(
      (item) => item.status === "assigned"
    )!;
    state.assignments.forEach((item) => delete item.decisionTrace);
    assignment.decisionTrace = [
      schedulingDecision(
        "cross-workday-load",
        "fallback",
        "上一班甲比乙更累，本班仍由甲承担较重岗位"
      ),
      schedulingDecision(
        "late-shift-recovery",
        "fallback",
        "上一班末班重点岗位人员作为最后兜底接替"
      ),
    ];
    state.schedulePolicyStale = true;
    const element = await mountElement<
      HTMLElement & { model: typeof state; updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-18",
      zoom: 1.5,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });

    expect(element.textContent).toContain(
      "排班规则已更新，当前排班尚未按新规则重新生成"
    );
    expect(element.textContent).toContain("行政支援人员");
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="行政支援人员姓名"]'
      )?.value
    ).toBe("行政一号");
    expect(element.textContent).toContain("150%");
    expect(
      element
        .querySelector(".schedule-soft-warning-icon")
        ?.getAttribute("title")
    ).toContain("上一班末班重点岗位人员作为最后兜底接替");
    const rotationWarning =
      "甲在KE166/H02连续承担。\n乙 —— 9/18 做过 TR121 末班岗，下一班不能接 KE166\n这次自动排班没有找到能完成的换人办法，原安排保留。";
    assignment.decisionTrace = [
      schedulingDecision(
        "late-shift-recovery",
        "fallback",
        "这一条是另一种提醒"
      ),
      schedulingDecision("position-rotation", "fallback", rotationWarning),
    ];
    element.model = { ...state, assignments: [...state.assignments] };
    await element.updateComplete;
    const rotationIcon = element.querySelector(".schedule-soft-warning-icon");
    expect(rotationIcon?.getAttribute("title")).toBe(rotationWarning);
    expect(rotationIcon?.closest("button")?.getAttribute("title")).toContain(
      rotationWarning
    );
    const warningButton = element.querySelector<HTMLButtonElement>(
      'button[aria-label="分析这个岗位的调换方案"]'
    );
    expect(warningButton).not.toBeNull();
    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      commands.push((event as UiCommandEvent).detail);
    });
    warningButton?.click();
    expect(commands).toContainEqual({
      type: "open-swap-analysis",
      assignmentId: assignment.id,
    });

    const comparisonOnlyState = structuredClone(state);
    const comparisonOnlyAssignment = comparisonOnlyState.assignments.find(
      (item) => item.id === assignment.id
    )!;
    comparisonOnlyAssignment.decisionTrace = [
      schedulingDecision(
        "cross-workday-load",
        "fallback",
        "上一班甲比乙更累，本班仍由甲承担较重岗位"
      ),
    ];
    element.model = comparisonOnlyState;
    await element.updateComplete;
    const grid = element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-grid");
    await grid?.updateComplete;

    expect(element.querySelector(".schedule-soft-warning-icon")).toBeNull();
    expect(comparisonOnlyAssignment.decisionTrace).toHaveLength(1);
  }, 30_000);

  it("shows a persistent yellow warning icon for a manual override", async () => {
    const state = createDefaultState();
    state.assignments = (
      await generateSchedule(state, "2026-07-18")
    ).assignments;
    const assignment = state.assignments[0]!;
    assignment.manualOverrideWarnings = [
      {
        code: "position-qualification",
        message: `${assignment.staffName || "人员A"} 不具备该岗位资质`,
      },
    ];
    const element = await mountElement<
      HTMLElement & { model: typeof state; updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-07-18",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });

    const icon = element.querySelector(".schedule-manual-warning-icon");
    expect(icon?.getAttribute("title")).toContain("不具备该岗位资质");
    expect(
      icon
        ?.closest(".schedule-cell")
        ?.classList.contains("is-manual-override-warning")
    ).toBe(true);
  }, 30_000);

  it("highlights every assigned cell in a real cross-flight time conflict", async () => {
    const state = createDefaultState();
    const firstStaff = state.staff[0]!;
    const secondStaff = state.staff[1]!;
    const baseFlight = state.flights[0]!;
    const baseRule = state.positionRules[0]!;
    const guideCategory =
      state.positionRules.find((item) => item.category !== baseRule.category)
        ?.category ?? baseRule.category;
    const flights = [
      {
        ...baseFlight,
        id: "time-a",
        flightNo: "TIMEA",
        startTime: "08:00",
        endTime: "10:00",
        positions: ["A"],
      },
      {
        ...baseFlight,
        id: "time-b",
        flightNo: "TIMEB",
        startTime: "09:00",
        endTime: "11:00",
        positions: ["B"],
      },
      {
        ...baseFlight,
        id: "time-c",
        flightNo: "TIMEC",
        startTime: "11:00",
        endTime: "12:00",
        positions: ["C"],
      },
      {
        ...baseFlight,
        id: "time-same",
        flightNo: "TIMESAME",
        startTime: "13:00",
        endTime: "14:00",
        positions: ["regular", "guide"],
      },
    ];
    const rules: PositionRule[] = [
      ...["a", "b", "c"].map((id, index) => ({
        ...baseRule,
        id: `time-rule-${id}`,
        flightNo: flights[index]!.flightNo,
        name: id,
        qualifiedStaffIds: [firstStaff.id],
      })),
      {
        ...baseRule,
        id: "same-regular-rule",
        flightNo: "TIMESAME",
        name: "regular",
        qualifiedStaffIds: [secondStaff.id],
      },
      {
        ...baseRule,
        id: "same-guide-rule",
        flightNo: "TIMESAME",
        name: "guide",
        category: guideCategory,
        qualifiedStaffIds: [secondStaff.id],
      },
      {
        ...baseRule,
        id: "same-conflict-rule",
        flightNo: "TIMESAME",
        name: "conflict",
        qualifiedStaffIds: [secondStaff.id],
      },
    ];
    const makeAssignment = (
      id: string,
      flight: (typeof flights)[number],
      rule: PositionRule,
      staffId: string | null,
      status: "assigned" | "unfilled" = "assigned"
    ): Assignment => ({
      id,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId,
      staffName: staffId
        ? (state.staff.find((person) => person.id === staffId)?.name ?? "")
        : "",
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status,
    });
    const overlapA = makeAssignment(
      "time-assignment-a",
      flights[0]!,
      rules[0]!,
      firstStaff.id
    );
    const overlapB = makeAssignment(
      "time-assignment-b",
      flights[1]!,
      rules[1]!,
      firstStaff.id
    );
    overlapB.manualOverrideWarnings = [
      { code: "position-qualification", message: "manual warning" },
    ];
    const nonOverlap = makeAssignment(
      "time-assignment-c",
      flights[2]!,
      rules[2]!,
      firstStaff.id
    );
    const sameFlightRegular = makeAssignment(
      "same-flight-regular",
      flights[3]!,
      rules[3]!,
      secondStaff.id
    );
    const sameFlightGuide = makeAssignment(
      "same-flight-guide",
      flights[3]!,
      rules[4]!,
      secondStaff.id
    );
    const sameFlightConflict = makeAssignment(
      "same-flight-conflict",
      flights[3]!,
      rules[5]!,
      secondStaff.id
    );
    const missing = makeAssignment(
      "time-assignment-missing",
      flights[1]!,
      rules[1]!,
      null,
      "unfilled"
    );
    state.flights = flights;
    state.positionRules = rules;
    state.assignments = [
      overlapA,
      overlapB,
      nonOverlap,
      sameFlightRegular,
      sameFlightGuide,
      sameFlightConflict,
      missing,
    ];

    const element = await mountElement<
      HTMLElement & { model: typeof state; updateComplete: Promise<unknown> }
    >("autoschedule-schedule-page", {
      model: state,
      date: "2026-08-01",
      zoom: 1,
      loadSortField: "totalFatigue",
      loadSortDirection: "desc",
    });
    const grid = element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-grid");
    await grid?.updateComplete;
    const personCell = (id: string) =>
      element.querySelector<HTMLElement>(
        `.schedule-person-cell[data-assignment-id="${id}"]`
      )!;

    expect(personCell(overlapA.id).classList.contains("is-time-conflict")).toBe(
      true
    );
    expect(personCell(overlapB.id).classList.contains("is-time-conflict")).toBe(
      true
    );
    expect(
      personCell(overlapB.id).classList.contains("is-manual-override-warning")
    ).toBe(true);
    expect(
      personCell(nonOverlap.id).classList.contains("is-time-conflict")
    ).toBe(false);
    expect(
      personCell(sameFlightRegular.id).classList.contains("is-time-conflict")
    ).toBe(true);
    expect(
      personCell(sameFlightGuide.id).classList.contains("is-time-conflict")
    ).toBe(false);
    expect(
      personCell(sameFlightConflict.id).classList.contains("is-time-conflict")
    ).toBe(true);
    expect(personCell(missing.id).classList.contains("is-unfilled")).toBe(true);
    expect(personCell(missing.id).classList.contains("is-time-conflict")).toBe(
      false
    );

    const resolvedState = structuredClone(state);
    const resolvedOverlap = resolvedState.assignments.find(
      (assignment) => assignment.id === overlapB.id
    )!;
    const resolvedFlight = resolvedState.flights.find(
      (flight) => flight.id === resolvedOverlap.flightId
    )!;
    resolvedFlight.startTime = "12:00";
    resolvedFlight.endTime = "13:00";
    resolvedOverlap.startTime = resolvedFlight.startTime;
    resolvedOverlap.endTime = resolvedFlight.endTime;
    element.model = {
      ...resolvedState,
      assignments: [...resolvedState.assignments],
    };
    await element.updateComplete;
    await settleLit();
    const updatedGrid = element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-schedule-grid");
    await updatedGrid?.updateComplete;
    expect(
      element
        .querySelector<HTMLElement>(
          `.schedule-person-cell[data-assignment-id="${overlapA.id}"]`
        )
        ?.classList.contains("is-time-conflict")
    ).toBe(false);
    expect(
      element
        .querySelector<HTMLElement>(
          `.schedule-person-cell[data-assignment-id="${overlapB.id}"]`
        )
        ?.classList.contains("is-time-conflict")
    ).toBe(false);
  }, 30_000);
});
