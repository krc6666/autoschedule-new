// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import type { Assignment, PositionRule } from "../../src/model";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";
import { scheduleRuleFingerprint } from "../../src/domain/rules/schedule-rule-fingerprint";
import { buildScheduleWorkbook } from "../../src/infrastructure/excel";
import {
  createStatePersistence,
  loadState,
} from "../../src/infrastructure/storage";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import { SchedulePageElement } from "../../src/ui/components/schedule-page";
import { mountElement, settleLit } from "../ui/lit-test-helpers";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
} from "../helpers/application";

const date = "2026-11-03";

function exampleState(count = 7) {
  const state = createDefaultState();
  const person = state.staff[0]!;
  person.name = "测试人员甲";
  const flight = state.flights[0]!;
  state.flights = [
    flight,
    { ...flight, id: "second-flight", flightNo: "TEST002" },
  ];
  const baseRule = state.positionRules[0]!;
  const categories: PositionRule["category"][] = [
    "机动督导",
    "常规",
    "引导",
    "行政支援",
    "常规",
    "分流",
    "常规",
  ];
  state.positionRules = Array.from({ length: count }, (_, index) => ({
    ...baseRule,
    id: `clear-rule-${index}`,
    flightNo: state.flights[index % 2]!.flightNo,
    name: `测试岗位${index}`,
    category: categories[index % categories.length]!,
    qualifiedStaffIds: [person.id],
    manual: index === 4,
    remark: `岗位备注${index}`,
  }));
  state.assignments = state.positionRules.map((rule, index): Assignment => ({
    id: `clear-assignment-${index}`,
    flightId: state.flights[index % 2]!.id,
    flightNo: rule.flightNo,
    positionRuleId: index === 6 ? null : rule.id,
    position: rule.name,
    staffId: person.id,
    staffName: person.name,
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints: 3,
    remark: rule.remark,
    manualRemark: `手工备注${index}`,
    status: index === 6 ? "manual" : "assigned",
    layoutGroup: index === 6 ? "bottom" : "primary",
    layoutIndex: index,
    systemNotes: ["旧自动安排说明"],
    decisionTrace: [
      schedulingDecision("position-rotation", "fallback", "旧决定"),
    ],
    decisionEvidence: {
      scheduleRunId: "old-run",
      ruleFingerprint: "old-fingerprint",
    },
    manualOverrideWarnings: [
      { code: "position-qualification", message: "旧人员的资质提醒" },
    ],
  }));
  // Put the source before the linked target: clearing it must not lose the
  // target's original person before its first manual-count baseline is captured.
  state.assignments[2]!.flightId = flight.id;
  state.assignments[2]!.flightNo = flight.flightNo;
  state.assignments[2]!.supervisorSourceAssignmentId = state.assignments[0]!.id;
  state.assignments[2]!.supervisorFillRuleId = "old-fill-rule";
  state.assignments[2]!.workHours = 0;
  state.activeScheduleDate = date;
  state.scheduleRuleFingerprint = scheduleRuleFingerprint(state);
  return state;
}

function setup(state = exampleState(), accepted = true) {
  const memory = new Map<string, string>();
  const persistence = {
    ...createStatePersistence({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    }),
  };
  const confirm = vi.fn(() => accepted);
  const save = vi.spyOn(persistence, "save");
  const store = createTestAutoscheduleStore(state, persistence);
  const coordinator = createTestApplicationCoordinator(store, {
    confirm,
    preferences: {
      loadScheduleDate: () => date,
      saveScheduleDate: () => undefined,
      loadScheduleZoom: () => 1,
      saveScheduleZoom: () => undefined,
    },
  });
  return { coordinator, persistence, confirm, save };
}

function structure(assignments: readonly Assignment[]) {
  return assignments.map((a) => ({
    id: a.id,
    flightId: a.flightId,
    flightNo: a.flightNo,
    positionRuleId: a.positionRuleId,
    position: a.position,
    startTime: a.startTime,
    endTime: a.endTime,
    remark: a.remark,
    manualRemark: a.manualRemark,
    layoutGroup: a.layoutGroup,
    layoutIndex: a.layoutIndex,
  }));
}

describe("红叉清空全部人员", () => {
  it("真实工具栏命令保留所有航班和岗位，空格仍可手工填写", async () => {
    const { coordinator, confirm } = setup();
    const before = structuredClone(coordinator.model());
    const element = await mountElement<SchedulePageElement>(
      "autoschedule-schedule-page",
      {
        model: coordinator.model(),
        date,
        zoom: 1,
        loadSortField: "totalFatigue",
        loadSortDirection: "desc",
      }
    );
    let handled: Promise<void> | undefined;
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      handled = coordinator.handle((event as UiCommandEvent).detail);
    });
    element
      .querySelector<HTMLButtonElement>("button:has(.bi-x-circle)")!
      .click();
    await handled;
    element.model = coordinator.model();
    await settleLit();

    expect(coordinator.model().assignments).toHaveLength(
      before.assignments.length
    );
    expect(structure(coordinator.model().assignments)).toEqual(
      structure(before.assignments)
    );
    expect(coordinator.model().flights).toEqual(before.flights);
    expect(coordinator.model().activeScheduleDate).toBe(date);
    expect(confirm).toHaveBeenCalledWith(
      "确认清空当前班表所有岗位的人员？航班、岗位和备注都会保留。"
    );
    expect(element.querySelector('[aria-label="清空全部人员"]')).not.toBeNull();
    expect(element.querySelectorAll('th[colspan="2"]')).toHaveLength(2);
    expect(element.querySelectorAll(".schedule-name-input")).toHaveLength(
      before.assignments.length
    );
    expect(
      [
        ...element.querySelectorAll<HTMLInputElement>(".schedule-name-input"),
      ].every((input) => input.value === "")
    ).toBe(true);
    expect(element.textContent).not.toContain("尚未生成排班");
    const input = element.querySelector<HTMLInputElement>(
      ".schedule-name-input"
    )!;
    input.value = before.staff[0]!.name;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await handled;
    expect(coordinator.model().assignments[0]!.staffId).toBe(
      before.staff[0]!.id
    );
  });

  it("清空督导关联及旧证据，先保留整表基准，重复清空不丢基准", async () => {
    const { coordinator } = setup();
    const before = structuredClone(coordinator.model());
    await coordinator.handle({ type: "clear-schedule" });
    const cleared = coordinator.model();
    expect(cleared.assignments).toHaveLength(before.assignments.length);
    cleared.assignments.forEach((a, index) => {
      expect(a.staffId).toBeNull();
      expect(a.staffName).toBe("");
      expect(a.status).toBe([3, 4, 6].includes(index) ? "manual" : "unfilled");
      expect(a.systemNotes).toBeUndefined();
      expect(a.decisionTrace).toBeUndefined();
      expect(a.decisionEvidence).toBeUndefined();
      expect(a.manualOverrideWarnings).toBeUndefined();
      expect(a.supervisorSourceAssignmentId).toBeUndefined();
      expect(a.supervisorFillRuleId).toBeUndefined();
      expect(a.countBaseline?.staffId).toBe(
        index === 6 ? null : before.staff[0]!.id
      );
    });
    const baseline = cleared.assignments.map((a) => a.countBaseline);
    await coordinator.handle({ type: "clear-schedule" });
    expect(coordinator.model().assignments.map((a) => a.countBaseline)).toEqual(
      baseline
    );
  });

  it("保存后恢复仍保留空岗位、临时岗位、历史、另一组及规则过期标记", async () => {
    const state = exampleState();
    state.schedulePolicyStale = true;
    state.groups.B.assignments = [
      { ...state.assignments[0]!, id: "b-assignment" },
    ];
    const { coordinator, persistence, save } = setup(state);
    const before = structuredClone(coordinator.model());
    const restoredBefore = loadState({ getItem: () => JSON.stringify(before) });
    await coordinator.handle({ type: "clear-schedule" });
    expect(save).toHaveBeenCalledTimes(1);
    const restored = persistence.load();
    expect(structure(restored.assignments)).toEqual(
      structure(before.assignments)
    );
    expect(restored.assignments.every((a) => !a.staffId && !a.staffName)).toBe(
      true
    );
    expect(coordinator.model().groups.B).toEqual(before.groups.B);
    expect(restored.groups.B).toEqual(restoredBefore.groups.B);
    expect(restored.history).toEqual(before.history);
    expect(restored.dutyRosterOverrides).toEqual(before.dutyRosterOverrides);
    expect(restored.settings).toEqual(before.settings);
    expect(restored.schedulePolicyStale).toBe(true);
    expect(restored.activeScheduleDate).toBe(date);
    await coordinator.handle({ type: "switch-group", groupId: "B" });
    expect(coordinator.model().assignments).toEqual(
      before.groups.B.assignments
    );
    await coordinator.handle({ type: "switch-group", groupId: "A" });
    expect(
      coordinator.model().assignments.every((a) => !a.staffId && !a.staffName)
    ).toBe(true);
  });

  it("取消和空班表不修改或保存任何数据", async () => {
    const { coordinator, save } = setup(exampleState(), false);
    const before = structuredClone(coordinator.model());
    await coordinator.handle({ type: "clear-schedule" });
    expect(coordinator.model()).toEqual(before);
    expect(save).not.toHaveBeenCalled();
    const state = exampleState();
    state.assignments = [];
    const empty = setup(state);
    await empty.coordinator.handle({ type: "clear-schedule" });
    expect(empty.confirm).not.toHaveBeenCalled();
    expect(empty.save).not.toHaveBeenCalled();
  });

  it("整表人员清空后Excel排班结果保留每个岗位和空人员", async () => {
    const { coordinator } = setup();
    const before = structuredClone(coordinator.model());
    await coordinator.handle({ type: "clear-schedule" });
    const workbook = buildScheduleWorkbook(coordinator.model(), date);
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const restored = XLSX.read(bytes, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(
      restored.Sheets["排班结果"]!,
      { header: 1, defval: "" }
    );
    expect(rows).toHaveLength(before.assignments.length + 1);
    const header = rows[0]!;
    const nameIndex = header.indexOf("姓名");
    const staffIndex = header.indexOf("人员编号");
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(staffIndex).toBeGreaterThanOrEqual(0);
    expect(
      rows
        .slice(1)
        .every((row) => row[nameIndex] === "" && row[staffIndex] === "")
    ).toBe(true);
    expect(rows.slice(1).map((row) => row[header.indexOf("岗位")])).toEqual(
      before.assignments.map((a) => a.position)
    );
  });

  it("大班表清空全部300个岗位，无漏清或自动回填", async () => {
    const { coordinator } = setup(exampleState(300));
    await coordinator.handle({ type: "clear-schedule" });
    expect(coordinator.model().assignments).toHaveLength(300);
    expect(
      coordinator.model().assignments.every((a) => !a.staffId && !a.staffName)
    ).toBe(true);
  });
});
