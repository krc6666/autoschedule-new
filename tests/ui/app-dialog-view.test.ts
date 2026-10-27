// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { analyzeManualSwap } from "../../src/domain/reviews/manual-swap-analysis";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import { schedulingDecision } from "../../src/domain/rules/schedule-rule-contract";
import "../../src/ui/components/app-dialog";
import { mountElement } from "./lit-test-helpers";

describe("application dialog", () => {
  it("shows late-priority count scope and blocks an invalid preview", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model: createDefaultState(),
      dialog: {
        kind: "late-priority-counts-import",
        preview: {
          month: "2026-08",
          referenceDate: "2026-08-20",
          flightNumbers: ["TR121"],
          targets: [],
          errors: ["文件缺少 1 项记录"],
          canApply: false,
        },
      },
    });

    expect(element.textContent).toContain("末班重点岗位次数导入预览");
    expect(element.textContent).toContain("TR121");
    expect(element.textContent).toContain("文件缺少 1 项记录");
    expect(
      element.querySelector<HTMLButtonElement>("button.btn-primary")?.disabled
    ).toBe(true);
  });

  it("shows concrete gap-fill warnings and rejected candidate reasons", async () => {
    const model = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "team-leader-gap-fill",
        selectedTeamLeaderId: "1",
        selectedVacancyAssignmentIds: ["vacancy"],
        planning: false,
        reasons: [],
        preview: {
          date: "2026-09-26",
          teamLeaderId: "1",
          vacancyAssignmentIds: ["vacancy"],
          baselineFingerprint: "baseline",
          changes: [
            {
              assignmentId: "ak-guide",
              flightNo: "AK151",
              position: "引导",
              fromStaffId: "7",
              fromStaffName: "刘翔",
              toStaffId: "1",
              toStaffName: "刘红",
              workHours: 0,
            },
          ],
          warnings: [
            "黄灯：下一工作班TR121/收费/引导要求至少保留1名合格人员；合格人员：华嘉慧、肖萍、刘燕琼；华嘉慧（TR121/H08（21:55-23:55））、肖萍（TR121/H09（21:55-23:55））、刘燕琼（TR121/收费/引导（21:55-23:55））因23:00后岗位被消耗；预留人数从1变为0。",
            "刘翔上一工作班承担TR121/H02（21:55-23:55，一号），本次补差安排到AK151/引导（21:05-23:05）；跨工作日恢复本应尽量避开，本方案为补空缺让步。",
            "刘燕琼补差后承担TR121/收费/引导（21:55-23:55），与FD573/G09（15:25-17:25）均为高负荷岗位，间隔不超过360分钟，触发高负荷疲劳保护；本方案为补空缺黄灯让步。",
            "刘燕琼补差后承担TR121/收费/引导（21:55-23:55），其开始前360分钟内累计疲劳将超过8点，触发滚动负荷保护；本方案为补空缺黄灯让步。",
          ],
          rejectedCandidates: [
            "刘红尝试接AK151/G09（21:05-23:05）失败：这个时段已经安排了其他岗位：CX931/G14（17:50-19:50）",
          ],
        },
      },
    });

    const text = element.textContent.replace(/\s+/g, " ").trim();
    expect(text).toContain("黄灯提醒");
    expect(text).toContain("AK151/引导：刘翔 → 刘红");
    expect(text).toContain("预留人数从1变为0");
    expect(text).toContain("华嘉慧、肖萍、刘燕琼");
    expect(text).toContain("刘翔上一工作班承担TR121/H02");
    expect(text).toContain("刘燕琼补差后承担TR121/收费/引导");
    expect(text).toContain("触发高负荷疲劳保护");
    expect(text).toContain("触发滚动负荷保护");
    expect(text).toContain("未采用的候选方案");
    expect(text).toContain("CX931/G14（17:50-19:50）");
    expect(text).not.toContain("infeasible");
  });

  it("counts every structured rule collection in configuration import preview", async () => {
    const model = createDefaultState();
    model.settings.crossFlightPriorityPolicies = [
      {
        id: "preview-priority",
        enabled: true,
        flightNo: "KE166",
        staffIds: ["staff-1"],
      },
    ];
    const expectedCount =
      model.settings.positionTransitionPolicies.length +
      model.settings.dutyPositionPriorities.length +
      model.settings.nextWorkdayRecoveryTargets.length +
      model.settings.lateShiftRecoveryPositionRules.length +
      model.settings.mobileSupervisorCoverageRules.length +
      model.settings.crossWorkdayQualificationReservations.length +
      model.settings.crossFlightPriorityPolicies.length;
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "workbook-import",
        mode: "config",
        imported: {
          templates: model.templates,
          weeklyFlightPlans: model.weeklyFlightPlans,
          settings: model.settings,
          positionRules: model.positionRules,
          warnings: [],
        },
        recognized: "规则配置",
        changedConfig: true,
        sharedTemplatesAvailable: true,
        replaceSharedTemplates: false,
        warnings: [],
      },
    });

    expect(element.textContent).toContain("结构化规则");
    expect(element.textContent).toContain(`${expectedCount} 条`);
    expect(element.textContent).toContain("配置目标：A 组");
    expect(element.textContent).toContain("导入配置");
    expect(element.textContent).toContain("确认导入配置");
    expect(element.textContent).toContain("当前组未归档的排班结果会清空");
    expect(element.textContent).not.toContain("重新排班");
    expect(element.textContent).toContain(
      "岗位配置中的新航班会自动补入 A、B 共用模板"
    );
    expect(element.textContent).toContain(
      "文件中的每周计划会导入，并同步到 A、B 两组"
    );
    expect(element.textContent).toContain("A、B 两组都会更新");
    const commands: UiCommandEvent["detail"][] = [];
    element.addEventListener(UI_COMMAND_EVENT, (event) =>
      commands.push((event as UiCommandEvent).detail)
    );
    const checkbox = element.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commands).toEqual([
      { type: "set-workbook-import-shared-templates", enabled: true },
    ]);
  });

  it("shows the seven effective weekly selections and unavailable flights in import preview", async () => {
    const model = createDefaultState();
    const plans = model.weeklyFlightPlans.map((entry, index) => ({
      ...entry,
      flightNos: [`WEEK${index + 1}`],
    }));
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "workbook-import",
        mode: "config",
        imported: {
          weeklyFlightPlans: plans,
          weeklyFlightPlanStatus: "valid",
          warnings: [],
        },
        weeklyPlanPreview: {
          plans,
          unavailableFlightNos: ["MISSING100"],
        },
        recognized: "每周航班计划",
        changedConfig: true,
        sharedTemplatesAvailable: false,
        replaceSharedTemplates: false,
        warnings: [],
      },
    });

    const text = element.textContent.replace(/\s+/g, " ").trim();
    expect(text).toContain("星期一");
    expect(text).toContain("WEEK1");
    expect(text).toContain("星期日");
    expect(text).toContain("因模板不存在而不会导入：MISSING100");
    expect(text).toContain("文件中的每周计划会导入，并同步到 A、B 两组");
  });

  it("distinguishes an invalid weekly plan sheet from a missing sheet", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model: createDefaultState(),
      dialog: {
        kind: "workbook-import",
        mode: "config",
        imported: {
          weeklyFlightPlanStatus: "invalid",
          warnings: ["每周航班计划工作表不完整，现有计划保留"],
        },
        recognized: "规则配置",
        changedConfig: true,
        sharedTemplatesAvailable: false,
        replaceSharedTemplates: false,
        warnings: ["每周航班计划工作表不完整，现有计划保留"],
      },
    });

    expect(element.textContent).toContain(
      "每周航班计划工作表有问题，现有计划保留"
    );
    expect(element.textContent).not.toContain("文件未包含每周计划");
  });

  it("previews history merge counts without claiming that a history-only import clears the active schedule", async () => {
    const model = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "workbook-import",
        mode: "history",
        imported: { warnings: [] },
        recognized: "4 条历史负荷",
        changedConfig: false,
        sharedTemplatesAvailable: false,
        replaceSharedTemplates: false,
        historySummary: {
          total: 4,
          added: 2,
          replaced: 1,
          unmatchedStaff: 1,
        },
        warnings: [],
      },
    });

    const text = element.textContent.replace(/\s+/g, " ").trim();
    expect(text).toContain("工作簿导入预览");
    expect(text).toContain(
      "共 4 条；新增 2 条；覆盖 1 条；无法匹配当前人员 1 条"
    );
    expect(text).toContain("当前尚未归档的排班结果保持不变");
    expect(text).toContain("导入历史");
    expect(text).toContain("确认导入历史");
    expect(text).not.toContain("确认导入并重新排班");
  });

  it("gives legacy schedule import content a constrained scrolling host", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model: createDefaultState(),
      dialog: {
        kind: "legacy-schedule-import",
        date: "2026-08-19",
        preview: {
          records: [],
          sheets: 1,
          recognizedSheets: 1,
          readyRecords: 0,
          reviewRecords: 0,
          warnings: [],
        },
      },
    });

    expect(
      element
        .querySelector("autoschedule-legacy-schedule-import-dialog")
        ?.classList.contains("modal-content-stack")
    ).toBe(true);
    expect(
      element.querySelector<HTMLInputElement>("#legacy-import-date")?.value
    ).toBe("2026-08-19");
  });

  it("gives online flight query content a constrained scrolling host", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model: createDefaultState(),
      dialog: {
        kind: "flight-query",
        date: "2026-08-05",
        loading: false,
        reconciliation: null,
        fetchedAt: "",
        error: "",
      },
    });

    expect(
      element
        .querySelector("autoschedule-flight-query-dialog")
        ?.classList.contains("modal-content-stack")
    ).toBe(true);
  });

  it("shows a compact swap analysis and only enables a valid confirmation", async () => {
    const model = createDefaultState();
    const flight = model.flights.find((item) => item.flightNo === "TR121")!;
    const rules = model.positionRules.filter(
      (item) =>
        item.flightNo === flight.flightNo && ["H02", "H08"].includes(item.name)
    );
    rules.forEach((rule) => {
      rule.qualifiedStaffIds = [model.staff[0]!.id, model.staff[1]!.id];
    });
    model.settings.rollingLoadProtectionEnabled = false;
    model.assignments = rules.map((rule, index) => ({
      id: `swap-${index}`,
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: model.staff[index]!.id,
      staffName: model.staff[index]!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: rule.fatiguePoints,
      remark: rule.remark,
      manualRemark: "",
      status: "assigned" as const,
    }));
    const analysis = analyzeManualSwap(model, "2026-08-21", "swap-0", "swap-1");
    model.assignments[0]!.decisionTrace = [
      schedulingDecision(
        "position-rotation",
        "fallback",
        "甲连续承担TR121/H02。\n乙 —— 8/19 做过 TR121 末班岗，下一班不能接 TR121\n这次自动排班没有找到能完成的换人办法，原安排保留。"
      ),
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-dialog", {
      model,
      dialog: {
        kind: "swap-analysis",
        sourceAssignmentId: "swap-0",
        targetAssignmentId: "swap-1",
        analysis,
      },
    });

    expect(element.textContent).toContain("调整原因分析");
    expect(element.textContent).toContain("选择交换人员");
    expect(element.textContent).toContain("可以安全调整");
    expect(element.textContent).toContain("乙 —— 8/19 做过 TR121 末班岗");
    expect(element.textContent).toContain("自动排班没换成的人");
    expect(
      element.querySelector<HTMLButtonElement>(
        'button[aria-label="确认交换岗位"]'
      )?.disabled
    ).toBe(false);
  });
});
