import { describe, expect, it, vi } from "vitest";

import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  createMemoryStatePersistence,
  setTestScheduleRunner,
} from "../helpers/application";
import type { ApplicationPreferences } from "../../src/app/application-preferences";
import { createDefaultState } from "../../src/defaults";
import { replaceWeeklyFlightPlan } from "../../src/domain/flights/weekly-flight-plan";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import type { ScheduleResult } from "../../src/model";
import { createScheduleSafetySession } from "../../src/domain/kernel/schedule-safety-session";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { generateSchedule } from "../helpers/generate-schedule";
import {
  buildLatePriorityCountsWorkbook,
  parseLatePriorityCountsWorkbook,
} from "../../src/infrastructure/late-priority-counts-excel";

const historicalExportMocks = vi.hoisted(() => ({
  buildScheduleWorkbook: vi.fn(() => ({ SheetNames: [], Sheets: {} })),
  writeWorkbook: vi.fn(),
  exportShareHtml: vi.fn(),
  exportSharePng: vi.fn(async () => undefined),
}));

vi.mock("../../src/infrastructure/excel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/excel")>()),
  buildScheduleWorkbook: historicalExportMocks.buildScheduleWorkbook,
  writeWorkbook: historicalExportMocks.writeWorkbook,
}));

vi.mock("../../src/infrastructure/share", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/share")>()),
  exportShareHtml: historicalExportMocks.exportShareHtml,
  exportSharePng: historicalExportMocks.exportSharePng,
}));

const preferences: ApplicationPreferences = {
  loadScheduleDate: () => null,
  saveScheduleDate: () => undefined,
  loadScheduleZoom: () => null,
  saveScheduleZoom: () => undefined,
};

function certifiedResult(
  date: string,
  assignments: ScheduleResult["assignments"] = []
): ScheduleResult {
  const result = {
    assignments,
    warnings: [],
    unfilledCount: assignments.filter((item) => item.status === "unfilled")
      .length,
  };
  const state = createDefaultState();
  return {
    ...result,
    safetyCredential: createScheduleSafetySession({
      phase: "final",
      state,
      date,
      runFacts: createScheduleRunFacts(state, date),
    }).createCredential(date, assignments),
  };
}

describe("application persistence feedback", () => {
  it("切换组前提示保存未保存改动，确认后只显示目标组数据", async () => {
    const state = createDefaultState();
    state.groups.B.staff = [
      { ...state.staff[0]!, id: "group-b", name: "B组人员" },
    ];
    state.groups.B.flights = [];
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences, confirm: vi.fn(() => true) }
    );

    coordinator.store.getState().configuration.addStaff();
    await coordinator.handle({ type: "switch-group", groupId: "B" });

    expect(coordinator.model().activeGroupId).toBe("B");
    expect(coordinator.model().staff.map((person) => person.id)).toEqual([
      "group-b",
    ]);
    expect(coordinator.view().halfRestStaffIds).toEqual([]);
  });

  it("取消切组确认时保留当前组", async () => {
    const state = createDefaultState();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences, confirm: vi.fn(() => false) }
    );
    coordinator.store.getState().configuration.addStaff();
    await coordinator.handle({ type: "switch-group", groupId: "B" });
    expect(coordinator.model().activeGroupId).toBe("A");
  });

  it("applies a validated late-priority count preview through the records controller", async () => {
    const state = createDefaultState();
    state.settings.latePriorityFlightNumbers = ["TR121"];
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "一号"
    )!;
    const staffId = rule.qualifiedStaffIds[0]!;
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "number-one",
        delta: 3,
      },
    ];
    const workbook = buildLatePriorityCountsWorkbook(state, "2026-08-20");
    const targetState = createDefaultState();
    targetState.settings.latePriorityFlightNumbers = ["TR121"];
    const preview = parseLatePriorityCountsWorkbook(
      workbook,
      targetState,
      "2026-08-20"
    );
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(targetState),
      { preferences }
    );
    coordinator.updateView({
      dialog: { kind: "late-priority-counts-import", preview },
    });

    await coordinator.handle({ type: "apply-late-priority-counts-import" });

    expect(coordinator.view().dialog).toBeNull();
    expect(
      buildMonthlyLatePriorityStatistics(
        coordinator.model(),
        "2026-08-20"
      ).rows.find((row) => row.staff.id === staffId)!.flights.TR121!.categories
        .一号.effectiveCount
    ).toBe(3);
    expect(coordinator.view().toast?.message).toContain("已导入 2026-08");
  });

  it("confirms monthly late-priority reset before committing the zero baseline", async () => {
    const state = createDefaultState();
    const rule = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.remark === "一号"
    )!;
    const staffId = rule.qualifiedStaffIds[0]!;
    state.settings.latePriorityFlightNumbers = ["TR121"];
    state.history = [
      {
        id: "reset-controller-history",
        date: "2026-08-10",
        flightNo: "TR121",
        position: rule.name,
        staffId,
        staffName: state.staff.find((person) => person.id === staffId)!.name,
        startTime: "21:55",
        endTime: "23:55",
        workHours: 2,
        fatiguePoints: 5,
        remark: rule.remark,
      },
    ];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "number-one",
        delta: 2,
      },
    ];
    let confirmed = false;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences, confirm: () => confirmed }
    );

    await coordinator.handle({
      type: "reset-monthly-late-priority-frequency-counts",
      month: "2026-08",
      date: "2026-08-18",
    });
    expect(coordinator.model().latePriorityFrequencyAdjustments[0]?.delta).toBe(
      2
    );

    confirmed = true;
    await coordinator.handle({
      type: "reset-monthly-late-priority-frequency-counts",
      month: "2026-08",
      date: "2026-08-18",
    });
    expect(coordinator.model().latePriorityFrequencyAdjustments).toEqual([
      {
        month: "2026-08",
        staffId,
        flightNo: "TR121",
        kind: "number-one",
        delta: -1,
        resetBaseline: 1,
      },
    ]);
  });

  it("shows an important warning when saved data approaches browser capacity", () => {
    const state = createDefaultState();
    const persistence = createMemoryStatePersistence();
    persistence.save = vi.fn((model) => ({
      state: model,
      sizeBytes: 4 * 1024 * 1024,
      nearCapacity: true,
    }));
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state, persistence),
      { preferences }
    );

    coordinator.commit("人员信息已保存");

    expect(coordinator.view().toast).toMatchObject({
      tone: "warning",
      message: expect.stringContaining("接近浏览器存储上限"),
    });
  });

  it("keeps in-memory data and reports a failed quota write", () => {
    const state = createDefaultState();
    state.history = [
      {
        id: "unsaved-history",
        date: "2026-07-20",
        flightNo: "TR121",
        position: "H02",
        staffId: state.staff[0]!.id,
        staffName: state.staff[0]!.name,
        startTime: "20:00",
        endTime: "22:00",
        workHours: 2,
        fatiguePoints: 4,
        remark: "一号",
      },
    ];
    const quotaError = new Error("quota exceeded");
    quotaError.name = "QuotaExceededError";
    const persistence = createMemoryStatePersistence();
    persistence.save = vi.fn(() => {
      throw quotaError;
    });
    const store = createTestAutoscheduleStore(state, persistence);
    const coordinator = createTestApplicationCoordinator(store, {
      preferences,
    });

    expect(() => coordinator.commit("历史排班已保存")).not.toThrow();
    expect(store.getState().model.history).toHaveLength(1);
    expect(coordinator.view().toast).toMatchObject({
      tone: "danger",
      message: expect.stringContaining("存储空间不足"),
    });
  });
});

describe("historical schedule editing", () => {
  function editableHistoricalState() {
    const state = createDefaultState();
    state.settings.dutyFatiguePoints = 0;
    const template = state.templates[0]!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === template.flightNo
    )!;
    const person = state.staff.find((item) =>
      rule.qualifiedStaffIds.includes(item.id)
    )!;
    state.activeScheduleDate = "2026-08-22";
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
        status: "assigned" as const,
      },
    ];
    state.history = [
      {
        id: "other-date",
        date: "2026-08-18",
        flightNo: template.flightNo,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: template.startTime,
        endTime: template.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        historyCoverage: "complete" as const,
      },
      {
        id: "target-date",
        date: "2026-08-20",
        flightNo: template.flightNo,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: template.startTime,
        endTime: template.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        historyCoverage: "complete" as const,
      },
    ];
    return state;
  }

  const historicalPreferences: ApplicationPreferences = {
    ...preferences,
    loadScheduleDate: () => "2026-08-22",
  };

  it("opens the archived date as an isolated draft and cancels back to the current schedule", async () => {
    const state = editableHistoricalState();
    const originalFlights = structuredClone(state.flights);
    const originalAssignments = structuredClone(state.assignments);
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: historicalPreferences, confirm: () => true }
    );

    await coordinator.handle({
      type: "edit-history-date",
      date: "2026-08-20",
    });

    expect(coordinator.view()).toMatchObject({
      section: "schedule",
      date: "2026-08-20",
      historyEditDate: "2026-08-20",
    });
    expect(coordinator.model().activeScheduleDate).toBe("2026-08-20");
    expect(coordinator.model().flights[0]?.flightNo).toBe(
      state.history[1]!.flightNo
    );
    expect(coordinator.model().history).toEqual(state.history);

    await coordinator.handle({ type: "cancel-history-edit" });

    expect(coordinator.view()).toMatchObject({
      section: "schedule",
      date: "2026-08-22",
      historyEditDate: null,
    });
    expect(coordinator.model().flights).toEqual(originalFlights);
    expect(coordinator.model().assignments).toEqual(originalAssignments);
    expect(coordinator.model().activeScheduleDate).toBe("2026-08-22");
    expect(coordinator.model().history).toEqual(state.history);
  });

  it("saves only the target history date and restores the current schedule", async () => {
    const persistence = createMemoryStatePersistence();
    const save = vi.spyOn(persistence, "save");
    const state = editableHistoricalState();
    const originalFlights = structuredClone(state.flights);
    const originalAssignments = structuredClone(state.assignments);
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state, persistence),
      { preferences: historicalPreferences, confirm: () => true }
    );

    await coordinator.handle({
      type: "edit-history-date",
      date: "2026-08-20",
    });
    const targetAssignment = coordinator
      .model()
      .assignments.find((item) => item.staffId)!;
    await coordinator.handle({
      type: "update-assignment",
      id: targetAssignment.id,
      field: "staffName",
      value: "",
    });
    expect(save).not.toHaveBeenCalled();

    await coordinator.handle({ type: "save-history-edit" });

    expect(coordinator.view().historyEditDate).toBeNull();
    expect(coordinator.model().flights).toEqual(originalFlights);
    expect(coordinator.model().assignments).toEqual(originalAssignments);
    expect(coordinator.model().activeScheduleDate).toBe("2026-08-22");
    expect(
      coordinator.model().history.filter((item) => item.date === "2026-08-20")
    ).toEqual([]);
    expect(
      coordinator.model().history.filter((item) => item.date === "2026-08-18")
    ).toEqual([state.history[0]]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and history unchanged when overwrite confirmation is declined", async () => {
    const state = editableHistoricalState();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: historicalPreferences, confirm: () => false }
    );

    await coordinator.handle({
      type: "edit-history-date",
      date: "2026-08-20",
    });
    await coordinator.handle({ type: "save-history-edit" });

    expect(coordinator.view().historyEditDate).toBe("2026-08-20");
    expect(coordinator.model().history).toEqual(state.history);
  });

  it("exports the target historical draft while keeping mutating commands blocked", async () => {
    historicalExportMocks.buildScheduleWorkbook.mockClear();
    historicalExportMocks.writeWorkbook.mockClear();
    historicalExportMocks.exportShareHtml.mockClear();
    historicalExportMocks.exportSharePng.mockClear();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(editableHistoricalState()),
      { preferences: historicalPreferences, confirm: () => true }
    );

    await coordinator.handle({
      type: "edit-history-date",
      date: "2026-08-20",
    });
    const historicalDraft = coordinator.model();

    await coordinator.handle({ type: "export-schedule" });
    await coordinator.handle({ type: "export-share-html" });
    await coordinator.handle({ type: "export-share-png" });

    expect(historicalExportMocks.buildScheduleWorkbook).toHaveBeenCalledWith(
      historicalDraft,
      "2026-08-20"
    );
    expect(historicalExportMocks.writeWorkbook).toHaveBeenCalledWith(
      expect.anything(),
      "保障明细_2026-08-20.xlsx"
    );
    expect(historicalExportMocks.exportShareHtml).toHaveBeenCalledWith(
      historicalDraft,
      "2026-08-20"
    );
    expect(historicalExportMocks.exportSharePng).toHaveBeenCalledWith(
      historicalDraft,
      "2026-08-20"
    );
    expect(coordinator.view().historyEditDate).toBe("2026-08-20");

    await coordinator.handle({ type: "open-reschedule-flight-picker" });

    expect(coordinator.view().dialog).toBeNull();
    expect(coordinator.view().toast).toMatchObject({
      tone: "warning",
      message: "历史排班正在编辑，请先保存或取消编辑",
    });
  });
});

describe("application scheduling exclusivity", () => {
  it("keeps the pre-run schedule when calculation is stopped without a result", async () => {
    const state = createDefaultState();
    state.assignments = [
      {
        id: "existing",
        flightId: state.flights[0]!.id,
        flightNo: state.flights[0]!.flightNo,
        positionRuleId: null,
        position: "原岗位",
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
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockResolvedValue({ kind: "stopped-without-result" }),
      isRunning: () => false,
    });

    await coordinator.handle({ type: "generate-schedule" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "schedule-preflight")
      throw new Error("missing preflight");
    await coordinator.handle({
      type: "confirm-schedule-preflight",
      selectedIds: dialog.selectedIds,
    });

    expect(coordinator.model().assignments).toHaveLength(1);
    expect(coordinator.model().assignments[0]!.id).toBe("existing");
    expect(coordinator.view().toast?.message).toContain("原班表保持不变");
  });

  it("installs only the complete safe result selected by stop-and-adopt", async () => {
    const state = createDefaultState();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );
    const safeResult: ScheduleResult = {
      ...certifiedResult(coordinator.view().date),
      warnings: ["已安全复核"],
    };
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockResolvedValue({
        kind: "stopped-with-result",
        result: safeResult,
      }),
      isRunning: () => false,
    });

    await coordinator.handle({ type: "open-reschedule-flight-picker" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker")
      throw new Error("missing picker");
    await coordinator.handle({
      type: "confirm-reschedule-flight-picker",
      selectedIds: dialog.selectedIds,
    });

    expect(coordinator.model().activeScheduleDate).toBe(
      coordinator.view().date
    );
    expect(coordinator.view().toast?.message).toContain("完整安全方案");
  });

  it("reserves a schedule run before asynchronous command routing", async () => {
    const state = createDefaultState();
    state.settings.adminSupportEnabled = false;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );
    const result: ScheduleResult = {
      assignments: [],
      warnings: [],
      unfilledCount: 0,
    };
    let running = false;
    let finishFirst!: () => void;
    const calculate = vi.fn(() => {
      if (running)
        return Promise.reject(new Error("排班正在运行，请等待当前任务完成"));
      running = true;
      return new Promise<{ kind: "completed"; result: ScheduleResult }>(
        (resolve) => {
          finishFirst = () => {
            running = false;
            resolve({ kind: "completed", result });
          };
        }
      );
    });
    setTestScheduleRunner(coordinator, {
      calculate,
      isRunning: () => running,
    });

    await coordinator.handle({ type: "generate-schedule" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "schedule-preflight")
      throw new Error("missing preflight");
    const generate = coordinator.handle({
      type: "confirm-schedule-preflight",
      selectedIds: dialog.selectedIds,
    });
    const toggle = coordinator.handle({
      type: "toggle-administrative-mode",
      enabled: true,
    });

    await toggle;
    await vi.waitFor(() => expect(calculate).toHaveBeenCalled());
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(coordinator.model().settings.adminSupportEnabled).toBe(false);
    expect(coordinator.view().toast).toMatchObject({
      tone: "warning",
      message: "排班正在计算，请等待当前任务完成",
    });
    finishFirst();
    await generate;
  });

  it("blocks data-changing commands while a schedule calculation is running", async () => {
    const state = createDefaultState();
    state.settings.adminSupportEnabled = false;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );
    const calculate = vi
      .fn()
      .mockRejectedValue(new Error("排班正在运行，请等待当前任务完成"));
    setTestScheduleRunner(coordinator, {
      calculate,
      isRunning: () => true,
    });

    await coordinator.handle({
      type: "toggle-administrative-mode",
      enabled: true,
    });

    expect(coordinator.model().settings.adminSupportEnabled).toBe(false);
    expect(calculate).not.toHaveBeenCalled();
    expect(coordinator.view().toast).toMatchObject({
      tone: "warning",
      message: "排班正在计算，请等待当前任务完成",
    });
  });
});

describe("manual swap analysis workflow", () => {
  it("rechecks a proposed swap before applying it", async () => {
    const state = createDefaultState();
    const flight = state.flights.find((item) => item.flightNo === "TR121")!;
    const h02 = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "H02"
    )!;
    const h08 = state.positionRules.find(
      (item) => item.flightNo === "TR121" && item.name === "H08"
    )!;
    const people = state.staff.slice(0, 2);
    h02.qualifiedStaffIds = people.map((person) => person.id);
    h08.qualifiedStaffIds = people.map((person) => person.id);
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.workloadBalanceEnabled = false;
    state.assignments = [h02, h08].map((rule, index) => ({
      id: `swap-${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: people[index]!.id,
      staffName: people[index]!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: rule.fatiguePoints,
      remark: rule.remark,
      manualRemark: "",
      status: "assigned" as const,
    }));
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences }
    );

    await coordinator.handle({
      type: "open-swap-analysis",
      assignmentId: "swap-0",
    });
    await coordinator.handle({
      type: "select-swap-target",
      assignmentId: "swap-1",
    });
    expect(coordinator.view().dialog).toMatchObject({
      kind: "swap-analysis",
      analysis: { outcome: "safe" },
    });

    h02.qualifiedStaffIds = [people[0]!.id];
    coordinator
      .model()
      .positionRules.find((item) => item.id === h02.id)!.qualifiedStaffIds = [
      people[0]!.id,
    ];
    await coordinator.handle({ type: "apply-swap-analysis" });

    expect(coordinator.model().assignments[0]!.staffId).toBe(people[1]!.id);
    expect(coordinator.view().toast).toMatchObject({
      tone: "warning",
      message: expect.stringContaining("资质"),
    });
  });
});

describe("team leader gap fill workflow", () => {
  it("previews a local chain and applies it only after confirmation", async () => {
    const state = createDefaultState();
    const [leader, worker] = state.staff;
    leader!.teamLeader = true;
    worker!.teamLeader = false;
    state.staff = [leader!, worker!];
    state.staff.forEach((person) => {
      person.status = "正常";
      person.staffType = "常规";
      person.dutyQualified = false;
    });
    const [sourceFlight, vacancyFlight] = state.flights.slice(0, 2);
    sourceFlight!.flightNo = "AK151";
    sourceFlight!.startTime = "10:00";
    sourceFlight!.endTime = "12:00";
    vacancyFlight!.flightNo = "TR100";
    vacancyFlight!.startTime = "10:00";
    vacancyFlight!.endTime = "12:00";
    state.flights = [sourceFlight!, vacancyFlight!];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "gap-source-rule",
        flightNo: "AK151",
        name: "G01",
        category: "常规",
        remark: "",
        manual: false,
        qualifiedStaffIds: [leader!.id, worker!.id],
      },
      {
        ...base,
        id: "gap-vacancy-rule",
        flightNo: "TR100",
        name: "G02",
        category: "常规",
        remark: "",
        manual: false,
        qualifiedStaffIds: [worker!.id],
      },
    ];
    state.settings.positionRotationEnabled = false;
    state.settings.highLoadProtectionEnabled = false;
    state.settings.rollingLoadProtectionEnabled = false;
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.ordinaryPriorityPositions = [];
    state.assignments = state.positionRules.map((rule, index) => ({
      id: index ? "gap-vacancy" : "gap-source",
      flightId: state.flights[index]!.id,
      flightNo: state.flights[index]!.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: index ? null : worker!.id,
      staffName: index ? "" : worker!.name,
      startTime: "10:00",
      endTime: "12:00",
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: index ? ("unfilled" as const) : ("assigned" as const),
    }));
    state.activeScheduleDate = "2026-09-22";
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: { ...preferences, loadScheduleDate: () => "2026-09-22" } }
    );

    await coordinator.handle({ type: "open-team-leader-gap-fill" });
    await coordinator.handle({
      type: "update-team-leader-gap-fill-leader",
      staffId: leader!.id,
    });
    await coordinator.handle({
      type: "update-team-leader-gap-fill-vacancies",
      assignmentIds: ["gap-vacancy"],
    });
    const before = structuredClone(coordinator.model().assignments);
    await coordinator.handle({ type: "preview-team-leader-gap-fill" });

    expect(coordinator.model().assignments).toEqual(before);
    expect(coordinator.view().dialog).toMatchObject({
      kind: "team-leader-gap-fill",
      preview: {
        changes: expect.arrayContaining([
          expect.objectContaining({
            assignmentId: "gap-source",
            toStaffId: leader!.id,
          }),
        ]),
      },
    });

    await coordinator.handle({ type: "confirm-team-leader-gap-fill" });
    expect(coordinator.view().dialog).toBeNull();
    expect(coordinator.model().assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gap-source",
          staffId: leader!.id,
          teamLeaderGapFill: true,
        }),
        expect.objectContaining({
          id: "gap-vacancy",
          staffId: worker!.id,
          status: "assigned",
        }),
      ])
    );
  });
});

describe("next workday flight picker workflow", () => {
  const nextWorkdayPreferences: ApplicationPreferences = {
    ...preferences,
    loadScheduleDate: () => "2026-08-15",
  };

  function stateWithCurrentSchedule() {
    const state = createDefaultState();
    state.weeklyFlightPlans = replaceWeeklyFlightPlan(
      state.weeklyFlightPlans,
      1,
      [state.templates[1]!.flightNo]
    );
    const flight = state.flights[0]!;
    const rule = state.positionRules.find(
      (item) => item.flightNo === flight.flightNo && item.category === "常规"
    )!;
    const person = state.staff.find((item) =>
      rule.qualifiedStaffIds.includes(item.id)
    )!;
    state.assignments = [
      {
        id: "current-assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: rule.remark,
        manualRemark: "",
        status: "assigned" as const,
      },
    ];
    return state;
  }

  it("keeps manual late-priority balance through repeated archive-and-next-workday runs", async () => {
    const state = createDefaultState();
    const qualified = state.staff
      .filter((person) => person.status === "正常")
      .slice(0, 2);
    state.staff = qualified;
    state.staff.forEach((person) => {
      person.dutyQualified = false;
      person.nightShift = true;
    });
    state.flights = [
      {
        id: "late-declaration",
        flightNo: "LATE100",
        startTime: "21:00",
        endTime: "23:30",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      },
    ];
    state.templates = [
      {
        id: "template-late-declaration",
        flightNo: "LATE100",
        startTime: "21:00",
        endTime: "23:30",
        positions: ["H04"],
        remark: "",
      },
    ];
    const base = state.positionRules[0]!;
    state.positionRules = [
      {
        ...base,
        id: "late-declaration-rule",
        flightNo: "LATE100",
        name: "H04",
        remark: "申报",
        category: "常规",
        qualifiedStaffIds: qualified.map((person) => person.id),
        minPassengers: 0,
        fatiguePoints: 1,
      },
    ];
    state.settings.latePriorityFlightNumbers = ["LATE100"];
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.workloadBalanceEnabled = false;
    for (const weekday of [1, 3, 4, 6] as const) {
      state.weeklyFlightPlans = replaceWeeklyFlightPlan(
        state.weeklyFlightPlans,
        weekday,
        ["LATE100"]
      );
    }
    state.dutyRosterOverrides = [
      {
        date: "2026-08-18",
        cxPreflightStaffId: null,
        dutyStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-08",
        staffId: qualified[0]!.id,
        flightNo: "LATE100",
        kind: "declaration",
        delta: 1,
      },
    ];
    const initialDate = "2026-08-18";
    const initialResult = await generateSchedule(state, initialDate);
    state.assignments = initialResult.assignments;
    state.activeScheduleDate = initialDate;
    let savedDate = initialDate;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      {
        preferences: {
          ...preferences,
          loadScheduleDate: () => initialDate,
          saveScheduleDate: (date) => (savedDate = date),
        },
        confirm: () => true,
      }
    );
    setTestScheduleRunner(coordinator, {
      calculate: async (
        model: ReturnType<typeof coordinator.model>,
        date: string
      ) => ({
        kind: "completed" as const,
        result: await generateSchedule(model, date),
      }),
      isRunning: () => false,
    });
    const assignedStaffIds = [state.assignments[0]!.staffId];

    for (let round = 0; round < 4; round += 1) {
      await coordinator.handle({ type: "archive-next-duty-day" });
      const dialog = coordinator.view().dialog;
      if (dialog?.kind !== "next-workday-flight-picker")
        throw new Error("缺少选择窗口");
      expect(dialog.selectedIds).toHaveLength(1);
      await coordinator.handle({
        type: "confirm-next-workday-flight-picker",
        selectedIds: dialog.selectedIds,
      });
      expect(coordinator.view().toast?.tone).not.toBe("danger");
      assignedStaffIds.push(coordinator.model().assignments[0]!.staffId);
    }

    expect(savedDate).toBe("2026-08-26");
    expect([
      ...new Set(coordinator.model().history.map((item) => item.date)),
    ]).toEqual(["2026-08-18", "2026-08-20", "2026-08-22", "2026-08-24"]);
    expect(coordinator.model().latePriorityFrequencyAdjustments).toEqual(
      state.latePriorityFrequencyAdjustments
    );
    expect(new Set(assignedStaffIds)).toEqual(
      new Set(qualified.map((person) => person.id))
    );
    const statistics = buildMonthlyLatePriorityStatistics(
      coordinator.model(),
      savedDate
    );
    expect(
      qualified.map(
        (person) =>
          statistics.rows.find((row) => row.staff.id === person.id)!.categories
            .申报.effectiveCount
      )
    ).toEqual([3, 3]);
  });

  it("opens local flight selection before changing history or starting calculation", async () => {
    const state = stateWithCurrentSchedule();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: nextWorkdayPreferences, confirm: () => true }
    );
    const calculate = vi.fn();
    setTestScheduleRunner(coordinator, {
      calculate,
      isRunning: () => false,
    });

    await coordinator.handle({ type: "archive-next-duty-day" });

    expect(coordinator.view().dialog?.kind).toBe("next-workday-flight-picker");
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker")
      throw new Error("缺少选择窗口");
    expect(dialog.weekday).toBe(1);
    expect(
      dialog.candidates
        .filter((candidate) => dialog.selectedIds.includes(candidate.id))
        .map((candidate) => candidate.flightNo)
    ).toEqual([state.templates[1]!.flightNo]);
    const weeklyBeforeTemporaryChange = structuredClone(
      coordinator.model().weeklyFlightPlans
    );
    await coordinator.handle({
      type: "update-next-workday-flight-picker-selection",
      selectedIds: dialog.candidates.map((candidate) => candidate.id),
    });
    await coordinator.handle({
      type: "update-next-workday-flight-picker-passengers",
      candidateId: dialog.candidates[0]!.id,
      bookedPassengers: 128,
    });
    expect(coordinator.model().weeklyFlightPlans).toEqual(
      weeklyBeforeTemporaryChange
    );
    const updatedDialog = coordinator.view().dialog;
    expect(
      updatedDialog?.kind === "next-workday-flight-picker"
        ? updatedDialog.candidates[0]!.bookedPassengers
        : null
    ).toBe(128);
    expect(coordinator.model().history).toHaveLength(0);
    expect(coordinator.model().activeScheduleDate).toBeNull();
    expect(calculate).not.toHaveBeenCalled();
  });

  it("keeps the original model when the selected next schedule fails", async () => {
    const state = stateWithCurrentSchedule();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: nextWorkdayPreferences, confirm: () => true }
    );
    const original = structuredClone(coordinator.model());
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockRejectedValue(new Error("测试失败")),
      isRunning: () => false,
    });

    await coordinator.handle({ type: "archive-next-duty-day" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker")
      throw new Error("缺少选择窗口");
    await coordinator.handle({
      type: "confirm-next-workday-flight-picker",
      selectedIds: dialog.selectedIds,
    });

    expect(coordinator.model()).toEqual(original);
    expect(coordinator.view().toast?.message).toContain("后天排班生成失败");
  });

  it("keeps the original model when the run is stopped, even with a latest result", async () => {
    const state = stateWithCurrentSchedule();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: nextWorkdayPreferences, confirm: () => true }
    );
    const original = structuredClone(coordinator.model());
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockResolvedValue({
        kind: "stopped-with-result",
        result: { assignments: [], warnings: [], unfilledCount: 0 },
      }),
      isRunning: () => false,
    });

    await coordinator.handle({ type: "archive-next-duty-day" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker")
      throw new Error("缺少选择窗口");
    await coordinator.handle({
      type: "confirm-next-workday-flight-picker",
      selectedIds: dialog.selectedIds,
    });

    expect(coordinator.model()).toEqual(original);
    expect(coordinator.view().toast?.message).toContain("原班表保持不变");
  });

  it("commits archive, selected flights, date, and result only after success", async () => {
    const state = stateWithCurrentSchedule();
    state.templates.push({
      id: "template-ke166",
      flightNo: "KE166",
      startTime: "12:00",
      endTime: "14:00",
      positions: ["G18"],
      remark: "本地模板",
    });
    let savedDate: string | null = null;
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      {
        preferences: {
          ...nextWorkdayPreferences,
          saveScheduleDate: (date) => (savedDate = date),
        },
        confirm: () => true,
      }
    );
    const calculate = vi.fn().mockResolvedValue({
      kind: "completed",
      result: certifiedResult("2026-08-17"),
    });
    setTestScheduleRunner(coordinator, {
      calculate,
      isRunning: () => false,
    });

    await coordinator.handle({ type: "archive-next-duty-day" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker")
      throw new Error("缺少选择窗口");
    const selectedId = dialog.candidates.find(
      (item) => item.flightNo === "KE166"
    )?.id;
    if (!selectedId) throw new Error("缺少本地模板航班");
    await coordinator.handle({
      type: "update-next-workday-flight-picker-passengers",
      candidateId: selectedId,
      bookedPassengers: 186,
    });
    await coordinator.handle({
      type: "confirm-next-workday-flight-picker",
      selectedIds: [selectedId],
    });

    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        flights: [
          expect.objectContaining({
            flightNo: "KE166",
            bookedPassengers: 186,
          }),
        ],
        assignments: [],
      }),
      "2026-08-17"
    );
    expect(coordinator.model().flights.map((item) => item.flightNo)).toEqual([
      "KE166",
    ]);
    expect(coordinator.model().history.length).toBeGreaterThan(0);
    expect(
      coordinator.model().history.every((item) => item.date === "2026-08-15")
    ).toBe(true);
    expect(coordinator.model().activeScheduleDate).toBe("2026-08-17");
    expect(savedDate).toBe("2026-08-17");
  });
});

describe("current schedule flight picker workflow", () => {
  const currentDate = "2026-08-29";
  const currentPreferences: ApplicationPreferences = {
    ...preferences,
    loadScheduleDate: () => currentDate,
  };

  function stateWithCurrentSchedule() {
    const state = createDefaultState();
    const flight = state.flights[0]!;
    flight.bookedPassengers = 88;
    state.flights = [flight];
    state.assignments = [
      {
        id: "existing-assignment",
        flightId: flight.id,
        flightNo: flight.flightNo,
        positionRuleId: state.positionRules[0]!.id,
        position: state.positionRules[0]!.name,
        staffId: state.staff[1]!.id,
        staffName: state.staff[1]!.name,
        startTime: flight.startTime,
        endTime: flight.endTime,
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    state.activeScheduleDate = currentDate;
    state.history = [
      {
        id: "history-before-reschedule",
        date: "2026-08-27",
        flightNo: "CX937",
        position: "G12",
        staffId: state.staff[1]!.id,
        staffName: state.staff[1]!.name,
        startTime: "08:30",
        endTime: "10:30",
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
      },
    ];
    return state;
  }

  it("opens every local flight and defaults to the current day's selection without mutating state", async () => {
    const state = stateWithCurrentSchedule();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: currentPreferences, confirm: () => true }
    );
    const original = structuredClone(coordinator.model());
    const calculate = vi.fn();
    setTestScheduleRunner(coordinator, {
      calculate,
      isRunning: () => false,
    });

    await coordinator.handle({ type: "open-reschedule-flight-picker" });

    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker")
      throw new Error("缺少重新排班航班窗口");
    expect(dialog.candidates.map((item) => item.flightNo)).toEqual(
      expect.arrayContaining(state.templates.map((item) => item.flightNo))
    );
    expect(
      dialog.candidates
        .filter((item) => dialog.selectedIds.includes(item.id))
        .map((item) => item.flightNo)
    ).toEqual(
      expect.arrayContaining(state.flights.map((item) => item.flightNo))
    );
    expect(
      dialog.candidates.find((item) => item.flightNo === "CX937")
        ?.bookedPassengers
    ).toBe(88);

    const selected = dialog.candidates.find(
      (item) => item.flightNo === "CX937"
    )!;
    await coordinator.handle({
      type: "update-reschedule-flight-picker-passengers",
      candidateId: selected.id,
      bookedPassengers: 128,
    });

    expect(coordinator.model()).toEqual(original);
    expect(calculate).not.toHaveBeenCalled();
  });

  it("commits selected flights, passenger counts, and the new schedule only after success", async () => {
    const state = stateWithCurrentSchedule();
    const originalHistory = structuredClone(state.history);
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: currentPreferences, confirm: () => true }
    );
    const result = certifiedResult(currentDate);
    const calculate = vi.fn().mockResolvedValue({
      kind: "completed",
      result,
    });
    setTestScheduleRunner(coordinator, {
      calculate,
      isRunning: () => false,
    });

    await coordinator.handle({ type: "open-reschedule-flight-picker" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker")
      throw new Error("缺少重新排班航班窗口");
    const addedFlightNo = state.templates[1]!.flightNo;
    const target = dialog.candidates.find(
      (item) => item.flightNo === addedFlightNo
    )!;
    await coordinator.handle({
      type: "update-reschedule-flight-picker-passengers",
      candidateId: target.id,
      bookedPassengers: 186,
    });
    await coordinator.handle({
      type: "confirm-reschedule-flight-picker",
      selectedIds: [target.id],
    });

    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        flights: [
          expect.objectContaining({
            flightNo: addedFlightNo,
            bookedPassengers: 186,
          }),
        ],
        assignments: [],
      }),
      currentDate,
      { halfRestStaffIds: [], halfRestModes: {} }
    );
    expect(coordinator.model().flights).toEqual([
      expect.objectContaining({
        flightNo: addedFlightNo,
        bookedPassengers: 186,
      }),
    ]);
    expect(coordinator.model().assignments).toEqual(result.assignments);
    expect(coordinator.model().activeScheduleDate).toBe(currentDate);
    expect(coordinator.model().history).toEqual(originalHistory);
  });

  it("keeps the original flights and schedule when recalculation fails", async () => {
    const state = stateWithCurrentSchedule();
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: currentPreferences, confirm: () => true }
    );
    const original = structuredClone(coordinator.model());
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockRejectedValue(new Error("测试失败")),
      isRunning: () => false,
    });

    await coordinator.handle({ type: "open-reschedule-flight-picker" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker")
      throw new Error("缺少重新排班航班窗口");
    await coordinator.handle({
      type: "confirm-reschedule-flight-picker",
      selectedIds: dialog.selectedIds,
    });

    expect(coordinator.model()).toEqual(original);
    expect(coordinator.view().toast).toMatchObject({
      tone: "danger",
      message: expect.stringContaining("重新排班失败"),
    });
  });

  it("atomically adopts selected flights and a safe result when stop-and-adopt is requested", async () => {
    const state = stateWithCurrentSchedule();
    const original = structuredClone(state);
    const coordinator = createTestApplicationCoordinator(
      createTestAutoscheduleStore(state),
      { preferences: currentPreferences, confirm: () => true }
    );
    setTestScheduleRunner(coordinator, {
      calculate: vi.fn().mockResolvedValue({
        kind: "stopped-with-result",
        result: certifiedResult("2026-08-29"),
      }),
      isRunning: () => false,
    });

    await coordinator.handle({ type: "open-reschedule-flight-picker" });
    const dialog = coordinator.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker")
      throw new Error("缺少重新排班航班窗口");
    await coordinator.handle({
      type: "confirm-reschedule-flight-picker",
      selectedIds: dialog.selectedIds,
    });

    expect(coordinator.model().flights).toEqual(original.flights);
    expect(coordinator.model().assignments).toEqual([]);
    expect(coordinator.model().history).toEqual(original.history);
    expect(coordinator.view().toast?.message).toContain("完整安全方案");
  });
});
