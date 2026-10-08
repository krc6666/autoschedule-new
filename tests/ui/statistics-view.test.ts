// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import {
  getMonthlyDutyRoster,
  updateDutyRosterSlot,
} from "../../src/domain/duty-roster/roster";
import type { HistoryRecord } from "../../src/model";
import "../../src/ui/components/statistics-page";
import { mountElement } from "./lit-test-helpers";
import type { UiCommandEvent } from "../../src/ui/events/ui-command";

describe("statistics page", () => {
  it("hides an early departure date if any assigned flight cuts off after 23:00", async () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    person.dutyQualified = false;
    state.staff = [person];
    state.activeScheduleDate = "2026-10-01";
    state.settings.earlyDepartureCutoffTime = "23:30";
    state.flights = [
      {
        id: "flight-AK151",
        flightNo: "AK151",
        startTime: "21:05",
        endTime: "23:05",
        bookedPassengers: 0,
        positions: ["G09"],
        remark: "",
      },
    ];
    state.assignments = [
      {
        id: "released-ak151",
        flightId: "flight-AK151",
        flightNo: "AK151",
        positionRuleId: null,
        position: "G09",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:05",
        endTime: "22:10",
        workHours: 1.08,
        fatiguePoints: 3.5,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", {
      model: state,
      date: "2026-10-01",
    });
    const row = [
      ...element.querySelectorAll<HTMLTableRowElement>(
        ".relaxed-shift-table tbody tr"
      ),
    ].find((candidate) =>
      candidate.cells[0]?.textContent?.includes(person.name)
    );

    expect(row?.cells[1]?.textContent?.trim()).toBe("0");
    expect(row?.cells[2]?.textContent?.trim()).toBe("-");
  });

  it("summarizes ordinary priority positions by staff with expandable count cells", async () => {
    const state = createDefaultState();
    const staff = state.staff
      .filter(
        (person) => person.staffType === "常规" && person.status === "正常"
      )
      .slice(0, 3);
    state.staff = staff;
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AK", position: "G08" },
      { airlineCode: "TR", position: "H02" },
    ];
    const baseRule = state.positionRules[0]!;
    state.positionRules = [
      {
        ...baseRule,
        id: "ordinary-ak-g08",
        flightNo: "AK151",
        name: "G08",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [staff[0]!.id],
      },
      {
        ...baseRule,
        id: "ordinary-tr-h02",
        flightNo: "TR121",
        name: "H02",
        category: "常规",
        remark: "一号",
        qualifiedStaffIds: [staff[1]!.id],
      },
    ];
    state.ordinaryPriorityFrequencyAdjustments = [
      {
        month: "2026-07",
        staffId: staff[0]!.id,
        airlineCode: "AK",
        position: "G08",
        delta: 1,
      },
    ];
    state.history = [
      {
        id: "ordinary-ak-g08",
        date: "2026-07-16",
        flightNo: "AK151",
        position: "G08",
        staffId: staff[0]!.id,
        staffName: staff[0]!.name,
        startTime: "21:00",
        endTime: "23:00",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      },
      {
        id: "ordinary-tr-h02",
        date: "2026-07-16",
        flightNo: "TR121",
        position: "H02",
        staffId: staff[1]!.id,
        staffName: staff[1]!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    const table = element.querySelector(".ordinary-priority-summary-table")!;
    const headers = [...table.querySelectorAll("th")].map((cell) =>
      cell.textContent?.trim()
    );

    expect(headers).toEqual(["人员", "合计", "AK / G08", "TR / H02"]);
    expect(table.querySelectorAll("tbody > tr")).toHaveLength(2);
    expect(
      table.querySelectorAll(".ordinary-priority-count-detail")
    ).toHaveLength(2);
    expect(table.textContent).not.toContain(staff[2]!.name);

    const detail = table.querySelector<HTMLDetailsElement>(
      `.ordinary-priority-count-detail[data-staff-id="${staff[0]!.id}"][data-airline-code="AK"][data-position="G08"]`
    )!;
    expect(detail.open).toBe(false);
    expect(detail.querySelector("summary")?.textContent?.trim()).toBe("2");
    expect(detail.textContent?.replace(/\s+/g, " ")).toContain(
      "实际 1 · 修正 +1"
    );

    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener("autoschedule-command", (event) =>
      commands.push((event as UiCommandEvent).detail)
    );
    detail
      .querySelector<HTMLButtonElement>('button[aria-label="AK/G08增加一次"]')
      ?.click();
    expect(commands).toContainEqual({
      type: "adjust-ordinary-priority-frequency",
      month: "2026-07",
      staffId: staff[0]!.id,
      airlineCode: "AK",
      position: "G08",
      delta: 1,
    });

    const filter = element.querySelector<HTMLButtonElement>(
      'button[aria-label="普通重点岗位筛选：AK / G08"]'
    )!;
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    filter.click();
    await element.updateComplete;

    const filteredTable = element.querySelector(
      ".ordinary-priority-summary-table"
    )!;
    expect(filteredTable.querySelectorAll("tbody > tr")).toHaveLength(1);
    expect(filteredTable.textContent).toContain(staff[0]!.name);
    expect(filteredTable.textContent).not.toContain(staff[1]!.name);
    expect(
      element
        .querySelector<HTMLButtonElement>(
          'button[aria-label="普通重点岗位筛选：AK / G08"]'
        )
        ?.getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("switches ordinary-priority statistics months independently", async () => {
    const state = createDefaultState();
    const person = state.staff.find(
      (item) => item.staffType === "常规" && item.status === "正常"
    )!;
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AK", position: "G08" },
    ];
    const baseRule = state.positionRules[0]!;
    state.positionRules = [
      {
        ...baseRule,
        id: "ordinary-monthly-ak-g08",
        flightNo: "AK151",
        name: "G08",
        category: "常规",
        remark: "",
        qualifiedStaffIds: [person.id],
      },
    ];
    state.activeScheduleDate = "2026-08-18";
    state.assignments = [
      {
        id: "ordinary-month-current-assignment",
        flightId: "ordinary-month-ak151",
        flightNo: "AK151",
        positionRuleId: "ordinary-monthly-ak-g08",
        position: "G08",
        staffId: person.id,
        staffName: person.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.history = ["2026-07-16", "2026-07-18", "2026-08-02"].map(
      (date, index) => ({
        id: `ordinary-month-${index}`,
        date,
        flightNo: "AK151",
        position: "G08",
        staffId: person.id,
        staffName: person.name,
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 5,
        remark: "",
      })
    );
    state.ordinaryPriorityFrequencyAdjustments = [
      {
        month: "2026-07",
        staffId: person.id,
        airlineCode: "AK",
        position: "G08",
        delta: 1,
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-08-18" });
    const monthInput = element.querySelector<HTMLInputElement>(
      'input[aria-label="普通重点岗位统计月份"]'
    )!;
    const count = () =>
      element
        .querySelector<HTMLElement>(
          `.ordinary-priority-count-detail[data-staff-id="${person.id}"]`
        )
        ?.querySelector("summary")
        ?.textContent?.trim();

    expect(monthInput.value).toBe("2026-08");
    expect(count()).toBe("2");
    monthInput.value = "2026-07";
    monthInput.dispatchEvent(new Event("change"));
    await element.updateComplete;

    expect(count()).toBe("3");
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="末班重点岗位统计月份"]'
      )?.value
    ).toBe("2026-08");

    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener("autoschedule-command", (event) =>
      commands.push((event as UiCommandEvent).detail)
    );
    element
      .querySelector<HTMLButtonElement>(
        `.ordinary-priority-count-detail[data-staff-id="${person.id}"] button[aria-label="AK/G08增加一次"]`
      )
      ?.click();
    expect(commands).toContainEqual({
      type: "adjust-ordinary-priority-frequency",
      month: "2026-07",
      staffId: person.id,
      airlineCode: "AK",
      position: "G08",
      delta: 1,
    });
  });

  it("switches duty and standby roster months while preserving workday parity", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-08-18" });
    const roster = element.querySelector<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-duty-roster-details")!;
    const monthInput = roster.querySelector<HTMLInputElement>(
      'input[aria-label="值班与备勤轮换月份"]'
    )!;
    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener("autoschedule-command", (event) =>
      commands.push((event as UiCommandEvent).detail)
    );

    expect(monthInput.value).toBe("2026-08");
    monthInput.value = "2026-07";
    monthInput.dispatchEvent(new Event("change"));
    await roster.updateComplete;

    const rosterSections = roster.querySelectorAll(".duty-roster-details");
    expect(
      rosterSections[0]!.querySelector('select[aria-label="2026-08-18 CX航前"]')
    ).not.toBeNull();
    const generalSection = rosterSections[1]!;
    const target = generalSection.querySelector<HTMLSelectElement>(
      'select[aria-label="2026-07-02 值班人员"]'
    )!;
    expect(target).not.toBeNull();
    expect(
      generalSection.querySelector('select[aria-label="2026-07-01 值班人员"]')
    ).toBeNull();
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="普通重点岗位统计月份"]'
      )?.value
    ).toBe("2026-08");
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="末班重点岗位统计月份"]'
      )?.value
    ).toBe("2026-08");

    const replacement = [...target.options].find(
      (option) => option.value && option.value !== target.value
    )!.value;
    target.value = replacement;
    target.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commands).toContainEqual({
      type: "update-duty-roster",
      date: "2026-07-02",
      slot: "duty",
      staffId: replacement,
    });

    roster
      .querySelector<HTMLButtonElement>('button[aria-label="下载值班备勤模板"]')
      ?.click();
    expect(commands).toContainEqual({
      type: "download-duty-roster-template",
      date: "2026-07-02",
    });
  });

  it("keeps monthly roster, relaxed shifts, position counts, and roster actions", async () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) =>
        item.flightNo === "TR121" &&
        item.name === "H02" &&
        item.category === "常规"
    )!;
    const person = state.staff.find(
      (item) => item.id === rule.qualifiedStaffIds[0]
    )!;
    const record: HistoryRecord = {
      id: "tr-h02",
      date: "2026-07-16",
      flightNo: "TR121",
      position: "H02",
      staffId: person.id,
      staffName: person.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 10,
      remark: "一号",
    };
    state.history = [record];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    const text = element.textContent ?? "";

    expect(text).toContain("月度轮值明细");
    expect(text).toContain("月度轻松班次统计");
    expect(text).toContain("末班重点岗位统计");
    expect(text).toContain("当前统计航班：TR121");
    expect(text).toContain("四类合计");
    expect(text).toContain("督导");
    expect(text).toContain("一号");
    expect(text).toContain("申报");
    expect(text).toContain("送资料");
    expect(text).toContain("允许差值 1");
    expect(text).toContain("允许差值 2");
    expect(text).not.toContain("TR121 / H02 月度承担次数");
    expect(text).toContain(person.name);
    expect(text).toContain("07-16");
    expect(text).toContain("07-16");
    expect(
      element.querySelector(".late-priority-summary-table")
    ).not.toBeNull();
    expect(element.querySelector(".late-priority-count-detail")).not.toBeNull();
    expect(text).toContain("下载值班备勤模板");
    expect(text).toContain("导入值班备勤表");
    expect(
      element.querySelector('select[aria-label*="值班人员"]')
    ).not.toBeNull();
    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener("autoschedule-command", (event) =>
      commands.push((event as UiCommandEvent).detail)
    );
    const adjustmentRow = element.querySelector<HTMLElement>(
      `.late-priority-count-detail[data-staff-id="${person.id}"][data-flight-no="TR121"] .late-priority-adjustment-row[data-late-priority-category="一号"]`
    );
    const adjustmentDetails = adjustmentRow?.closest<HTMLDetailsElement>(
      ".late-priority-count-detail"
    );
    expect(adjustmentRow).not.toBeNull();
    expect(adjustmentDetails?.open).toBe(false);
    expect(
      adjustmentRow?.closest(".late-priority-flight-breakdown")
    ).not.toBeNull();
    adjustmentDetails!.open = true;
    adjustmentRow
      ?.querySelector<HTMLButtonElement>(
        'button[aria-label="TR121一号增加一次"]'
      )
      ?.click();
    expect(commands).toContainEqual({
      type: "adjust-late-priority-frequency",
      month: "2026-07",
      staffId: person.id,
      flightNo: "TR121",
      kind: "number-one",
      delta: 1,
    });
    expect(
      element.querySelector<HTMLInputElement>(
        'input[aria-label="末班重点岗位统计月份"]'
      )?.value
    ).toBe("2026-07");
    element
      .querySelector<HTMLButtonElement>('button[title*="清零当前统计月份"]')
      ?.click();
    expect(commands).toContainEqual({
      type: "reset-monthly-late-priority-frequency-counts",
      month: "2026-07",
      date: "2026-07-18",
    });
  });

  it("switches late-priority statistics between natural months", async () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) =>
        item.flightNo === "TR121" &&
        item.name === "H02" &&
        item.category === "常规"
    )!;
    const person = state.staff.find(
      (item) => item.id === rule.qualifiedStaffIds[0]
    )!;
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      {
        id: "july-number-one",
        date: "2026-07-16",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-08-18" });
    const monthInput = element.querySelector<HTMLInputElement>(
      'input[aria-label="末班重点岗位统计月份"]'
    )!;

    expect(monthInput.value).toBe("2026-08");
    expect(element.textContent).not.toContain("07-16");
    monthInput.value = "2026-07";
    monthInput.dispatchEvent(new Event("change"));
    await element.updateComplete;

    expect(element.textContent).toContain("2026-07");
    expect(
      element
        .querySelector<HTMLDetailsElement>(
          `[data-staff-id="${person.id}"][data-flight-no="TR121"]`
        )
        ?.querySelector('output[aria-label="TR121一号最终次数"]')?.textContent
    ).toBe("1");
  });

  it("switches the summary table display between all categories and one category", async () => {
    const state = createDefaultState();
    const person = state.staff.find((item) => item.status === "正常")!;
    const numberOne = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "一号"
    )!;
    const delivery = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "送资料"
    )!;
    numberOne.qualifiedStaffIds = [person.id];
    delivery.qualifiedStaffIds = [person.id];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [numberOne, delivery].map((rule, index) => ({
      id: `display-filter-${index}`,
      date: "2026-07-16",
      flightNo: "TR121",
      position: rule.name,
      staffId: person.id,
      staffName: person.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 5,
      remark: rule.remark,
    }));
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    const workspace = element.querySelector<HTMLElement>(
      ".late-priority-statistics"
    )!;
    const summary = () =>
      workspace.querySelector(".late-priority-summary-table")!;
    const summaryValue = () =>
      [...summary().querySelectorAll("tbody tr")]
        .find((row) =>
          row.querySelector(
            `.late-priority-count-detail[data-staff-id="${person.id}"]`
          )
        )
        ?.querySelector("td:nth-child(2)")
        ?.textContent?.trim();
    expect(
      workspace
        .querySelector('button[aria-pressed="true"]')
        ?.textContent?.trim()
    ).toBe("全部");
    expect(
      [...summary().querySelectorAll("th")].map((cell) =>
        cell.textContent?.trim()
      )
    ).toEqual(["人员", "四类合计", "TR121"]);
    expect(summaryValue()).toBe("2");

    workspace
      .querySelector<HTMLButtonElement>(
        'button[aria-label="末班重点岗位统计类别：送资料"]'
      )
      ?.click();
    await element.updateComplete;
    expect(
      workspace
        .querySelector('button[aria-pressed="true"]')
        ?.textContent?.trim()
    ).toBe("送资料");
    expect(
      [...summary().querySelectorAll("th")].map((cell) =>
        cell.textContent?.trim()
      )
    ).toEqual(["人员", "送资料", "TR121"]);
    expect(summaryValue()).toBe("1");

    workspace
      .querySelector<HTMLButtonElement>(
        'button[aria-label="末班重点岗位统计类别：一号"]'
      )
      ?.click();
    await element.updateComplete;
    expect(summaryValue()).toBe("1");
  });

  it("filters to qualified staff and sorts the selected category by count", async () => {
    const state = createDefaultState();
    const [most, next, other] = state.staff.filter(
      (item) => item.status === "正常"
    );
    const mostStaff = most!;
    const nextStaff = next!;
    const otherStaff = other!;
    const delivery = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "送资料"
    )!;
    const numberOne = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "一号"
    )!;
    delivery.qualifiedStaffIds = [mostStaff.id, nextStaff.id];
    numberOne.qualifiedStaffIds = [otherStaff.id];
    state.positionRules = [delivery, numberOne];
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      {
        id: "delivery-most-1",
        person: mostStaff,
        date: "2026-07-10",
        numberOne: false,
      },
      {
        id: "delivery-most-2",
        person: mostStaff,
        date: "2026-07-12",
        numberOne: false,
      },
      {
        id: "delivery-next",
        person: nextStaff,
        date: "2026-07-14",
        numberOne: false,
      },
      {
        id: "number-one-other",
        person: otherStaff,
        date: "2026-07-16",
        numberOne: true,
      },
    ].map(({ id, person, date, numberOne: isNumberOne }) => ({
      id,
      date,
      flightNo: "TR121",
      position: isNumberOne ? numberOne.name : delivery.name,
      staffId: person.id,
      staffName: person.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 5,
      remark: isNumberOne ? numberOne.remark : delivery.remark,
    }));
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    const workspace = element.querySelector<HTMLElement>(
      ".late-priority-statistics"
    )!;
    workspace
      .querySelector<HTMLButtonElement>(
        'button[aria-label="末班重点岗位统计类别：送资料"]'
      )
      ?.click();
    await element.updateComplete;

    const rows = [
      ...workspace.querySelectorAll(".late-priority-summary-table tbody tr"),
    ];
    expect(
      rows.map((row) => row.querySelector("td")?.textContent?.trim())
    ).toEqual([mostStaff.name, nextStaff.name]);
    expect(
      rows.map((row) =>
        row.querySelector("td:nth-child(2)")?.textContent?.trim()
      )
    ).toEqual(["2", "1"]);
    expect(
      workspace
        .querySelector(
          `.late-priority-summary-table tbody tr:first-child .late-priority-count-detail[data-staff-id="${mostStaff.id}"] summary`
        )
        ?.textContent?.trim()
    ).toBe("2");
  });

  it("shows correction, actual, and final as zero after a monthly reset", async () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) =>
        item.flightNo === "TR121" &&
        item.name === "H02" &&
        item.category === "常规"
    )!;
    const person = state.staff.find(
      (item) => item.id === rule.qualifiedStaffIds[0]
    )!;
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      {
        id: "august-number-one",
        date: "2026-08-16",
        flightNo: "TR121",
        position: "H02",
        staffId: person.id,
        staffName: person.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 10,
        remark: "一号",
      },
    ];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: person.id,
        flightNo: "TR121",
        kind: "number-one",
        delta: -1,
        resetBaseline: 1,
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-08-18" });
    const row = element.querySelector<HTMLElement>(
      `.late-priority-adjustment-row[data-staff-id="${person.id}"][data-late-priority-category="一号"]`
    )!;

    const text = row.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("0");
    expect(text).toContain("实际 0 · 修正 +0");
  });

  it("shows the persisted duty-roster person when it is not the first option", async () => {
    const state = createDefaultState();
    const dutyStaff = state.staff.filter(
      (person) =>
        person.status === "正常" &&
        person.staffType === "常规" &&
        person.dutyQualified
    );
    const selected = dutyStaff[1]!;
    const rosterDate = getMonthlyDutyRoster(state, "2026-07-18")[0]!.date;
    state.dutyRosterOverrides = [
      {
        date: rosterDate,
        cxPreflightStaffId: null,
        dutyStaffId: selected.id,
        standbyStaffIds: [null, null],
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });

    expect(
      element.querySelector<HTMLSelectElement>(
        `select[aria-label="${rosterDate} 值班人员"]`
      )?.value
    ).toBe(selected.id);
  });

  it("allows a qualified leave-status person in the selected monthly duty roster", async () => {
    const state = createDefaultState();
    const selected = state.staff.find(
      (person) => person.staffType === "常规" && person.dutyQualified
    )!;
    selected.status = "休假";
    const rosterDate = getMonthlyDutyRoster(state, "2026-07-18")[0]!.date;
    state.dutyRosterOverrides = [
      {
        date: rosterDate,
        cxPreflightStaffId: null,
        dutyStaffId: selected.id,
        standbyStaffIds: [null, null],
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    expect(
      element.querySelector<HTMLSelectElement>(
        `select[aria-label="${rosterDate} 值班人员"]`
      )?.value
    ).toBe(selected.id);
  });

  it("keeps the opened adjustment attached to the same person after a count update", async () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) =>
        item.flightNo === "TR121" &&
        item.name === "H02" &&
        item.category === "常规"
    )!;
    const person = state.staff.find(
      (item) => item.id === rule.qualifiedStaffIds[0]
    )!;
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const element = await mountElement<
      HTMLElement & {
        updateComplete: Promise<unknown>;
        requestUpdate(): void;
      }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    const selector = `.late-priority-count-detail[data-staff-id="${person.id}"][data-flight-no="TR121"] .late-priority-adjustment-row[data-late-priority-category="一号"]`;
    const initialDetails = element
      .querySelector(selector)
      ?.closest<HTMLDetailsElement>(".late-priority-count-detail");

    expect(initialDetails?.open).toBe(false);
    initialDetails!.open = true;
    initialDetails!.dispatchEvent(new Event("toggle"));
    state.latePriorityFrequencyAdjustments.push({
      month: "2026-07",
      staffId: person.id,
      flightNo: "TR121",
      kind: "number-one",
      delta: 1,
    });
    element.requestUpdate();
    await element.updateComplete;

    const reorderedRow = element.querySelector(selector);
    const reorderedDetails = reorderedRow?.closest<HTMLDetailsElement>(
      ".late-priority-count-detail"
    );
    expect(reorderedDetails?.open).toBe(true);
    expect(reorderedDetails?.textContent?.replace(/\s+/g, " ")).toContain(
      "实际 0 · 修正 +1"
    );
  });

  it("summarizes all selected late-priority flights in one table", async () => {
    const state = createDefaultState();
    const staffId = state.staff[0]!.id;
    state.flights.push({
      id: "flight-tw616",
      flightNo: "TW616",
      startTime: "22:05",
      endTime: "23:55",
      bookedPassengers: 0,
      positions: ["T01", "T02", "T03", "督导"],
      remark: "",
    });
    state.positionRules.push(
      ...[
        ["T01", "一号"],
        ["T02", "申报"],
        ["T03", "送资料"],
        ["督导", ""],
      ].map(([name, remark], index) => ({
        id: `position-tw616-${index}`,
        flightNo: "TW616",
        name: name!,
        category: "常规" as const,
        remark: remark!,
        qualifiedStaffIds: [staffId],
        manual: false,
        fatiguePoints: 5,
        minPassengers: 0,
        earlyReleaseMinutes: 0,
      }))
    );
    state.settings.latePriorityFlightNumbers = ["TR121", "TW616"];
    state.history = [
      {
        id: "tw-delivery",
        date: "2026-07-16",
        flightNo: "TW616",
        position: "T03",
        staffId,
        staffName: state.staff[0]!.name,
        startTime: "22:05",
        endTime: "23:55",
        workHours: 1.83,
        fatiguePoints: 5,
        remark: "送资料",
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-07-18" });
    const workspace = element.querySelector(
      '[data-late-priority-flights="TR121,TW616"]'
    );
    const workspaceText = (workspace?.textContent ?? "").replace(/\s+/g, " ");

    expect(workspace).not.toBeNull();
    expect(
      element.querySelector('[aria-label="选择末班重点岗位统计航班"]')
    ).toBeNull();
    expect(
      workspace?.querySelectorAll(".late-priority-summary-table")
    ).toHaveLength(1);
    expect(workspaceText).toContain("当前统计航班：TR121、TW616");
    const headers = [...workspace!.querySelectorAll("th")].map((cell) =>
      cell.textContent?.trim()
    );
    expect(headers).toEqual(["人员", "四类合计", "TR121", "TW616"]);
    expect(
      workspace?.querySelector(
        `[data-staff-id="${staffId}"][data-flight-no="TW616"]`
      )
    ).not.toBeNull();
  });

  it("shows only delivery for a combined-only flight", async () => {
    const state = createDefaultState();
    const combinedRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "申报"
    )!;
    combinedRule.remark = "申报/送资料";
    state.positionRules = [combinedRule];
    state.settings.latePriorityFlightNumbers = ["TR121"];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-08-18" });
    const detail = element.querySelector(
      `.late-priority-count-detail[data-flight-no="TR121"]`
    )!;

    expect(
      detail.querySelector('[data-late-priority-category="送资料"]')
    ).not.toBeNull();
    expect(
      detail.querySelector('[data-late-priority-category="申报"]')
    ).toBeNull();
  });

  it("keeps declaration visible when a combined flight also has a separate declaration role", async () => {
    const state = createDefaultState();
    const combinedRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "送资料"
    )!;
    combinedRule.remark = "申报/送资料";
    const declarationRule = state.positionRules.find(
      (rule) => rule.flightNo === "TR121" && rule.remark === "申报"
    )!;
    state.positionRules = [combinedRule, declarationRule];
    state.settings.latePriorityFlightNumbers = ["TR121"];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: state, date: "2026-08-18" });
    const detail = element.querySelector(
      `.late-priority-count-detail[data-flight-no="TR121"]`
    )!;

    expect(
      detail.querySelector('[data-late-priority-category="送资料"]')
    ).not.toBeNull();
    expect(
      detail.querySelector('[data-late-priority-category="申报"]')
    ).not.toBeNull();
  });

  it("shows explicit missing configuration and monthly rebalancing states", async () => {
    const missing = createDefaultState();
    missing.settings.latePriorityFlightNumbers = [];
    const missingElement = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: missing, date: "2026-07-18" });
    expect(missingElement.textContent).toContain("尚未选择统计航班");
    expect(
      missingElement.querySelector(".late-priority-summary-table")
    ).toBeNull();

    const adjusted = createDefaultState();
    adjusted.staff = adjusted.staff.filter(
      (person) => person.status === "正常"
    );
    adjusted.staff.forEach((person) => {
      person.dutyQualified = true;
    });
    const rows = getMonthlyDutyRoster(adjusted, "2026-08-01");
    const repeated = adjusted.staff.find((person) =>
      rows.some((row) => row.dutyStaffId === person.id)
    )!;
    const target = rows.find(
      (row) =>
        row.dutyStaffId !== repeated.id &&
        row.cxPreflightStaffId !== repeated.id &&
        !row.standbyStaffIds.includes(repeated.id)
    )!;
    expect(
      updateDutyRosterSlot(adjusted, target.date, "duty", repeated.id)
    ).toBeNull();
    const adjustedElement = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-statistics-page", { model: adjusted, date: "2026-08-01" });
    expect(adjustedElement.textContent).toContain("值班均衡未完成");
    expect(adjustedElement.textContent).toContain("重新均衡本月");
  });
});
