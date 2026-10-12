// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { ACTIVE_SCHEDULING_RULES } from "../../src/domain/rules/schedule-rule-contract";
import "../../src/ui/components/policy-page";
import { mountElement, settleLit } from "./lit-test-helpers";

describe("rules page", () => {
  it("offers the two flight-count exemption checkboxes and saves their values", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const form = element.querySelector("autoschedule-policy-settings")!;
    const halfRest = form.querySelector<HTMLInputElement>(
      'input[data-policy-setting="dailyFlightCountBalanceExemptHalfRest"]'
    )!;
    const teamLeader = form.querySelector<HTMLInputElement>(
      'input[data-policy-setting="dailyFlightCountBalanceExemptTeamLeaders"]'
    )!;
    let command: CustomEvent | undefined;
    element.addEventListener("autoschedule-command", (event) => {
      command = event as CustomEvent;
    });

    expect(halfRest.checked).toBe(true);
    expect(teamLeader.checked).toBe(true);
    expect(form.textContent).toContain("半休人员豁免");
    expect(form.textContent).toContain("分队长豁免");

    halfRest.checked = false;
    halfRest.dispatchEvent(new Event("change", { bubbles: true }));
    form.querySelector<HTMLButtonElement>("button.btn-primary")!.click();

    expect(command?.detail).toMatchObject({
      type: "apply-policy",
      input: {
        dailyFlightCountBalanceExemptHalfRest: false,
        dailyFlightCountBalanceExemptTeamLeaders: true,
      },
    });
  });

  it("shows editable supervisor-fill relationships separately from coverage rules", async () => {
    const state = createDefaultState();
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: "KE166",
        sourcePositionKeyword: "机动督导",
        targetFlightNo: "KE166",
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: false,
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const card = element.querySelector<HTMLElement>("[data-supervisor-fill]")!;

    expect(card).not.toBeNull();
    expect(card.textContent).toContain("督导补位关系");
    expect(card.textContent).toContain("人手不足");
    expect(
      card.querySelector<HTMLInputElement>('input[aria-label="来源航班"]')
        ?.value
    ).toBe("KE166");
    expect(
      card.querySelector<HTMLInputElement>('input[aria-label="目标岗位"]')
        ?.value
    ).toBe("H05");
    const switches = card.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect([...switches].map((input) => input.checked)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("reports when a configured target position is not marked for supervisor fill", async () => {
    const state = createDefaultState();
    const flightNo = state.flights[0]!.flightNo;
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "target-h05",
      flightNo,
      name: "H05",
      category: "常规",
      coverageRole: "none",
    });
    state.positionRules.push({
      ...state.positionRules[0]!,
      id: "source-supervisor",
      flightNo,
      name: "机动督导",
      category: "机动督导",
      coverageRole: "none",
    });
    state.settings.mobileSupervisorFillRules = [
      {
        id: "ke166-h05-fill",
        enabled: true,
        sourceFlightNo: flightNo,
        sourcePositionKeyword: "机动督导",
        targetFlightNo: flightNo,
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];

    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const card = element.querySelector<HTMLElement>("[data-supervisor-fill]")!;

    expect(card.textContent).toContain("目标岗位未标记为督导补位");
  });

  it("configures cross-flight priority by current-group people instead of positions", async () => {
    const state = createDefaultState();
    const selected = state.staff[0]!;
    state.settings.crossFlightPriorityPolicies = [
      {
        id: "priority-1",
        enabled: true,
        flightNo: "KE166",
        staffIds: [selected.id, "B-1"],
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const card = element.querySelector<HTMLElement>(
      "[data-cross-flight-priorities]"
    )!;

    expect(card.textContent).toContain("跨航班重点人员优先");
    expect(card.textContent).toContain("优先人员");
    expect(card.textContent).toContain(`${selected.name}（${selected.id}）`);
    expect(card.textContent).not.toContain("优先岗位");
    expect(card.textContent).not.toContain("B-1");
    expect(
      card.querySelector<HTMLInputElement>('input[type="checkbox"]:checked')
        ?.checked
    ).toBe(true);
  });

  it("renders configurable same-flight staff exclusions with an optional flight", async () => {
    const state = createDefaultState();
    state.settings.sameFlightStaffExclusions = [
      {
        id: "pair-1",
        enabled: false,
        firstStaffId: state.staff[0]!.id,
        secondStaffId: state.staff[1]!.id,
        flightNo: "KE166",
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const card = element.querySelector<HTMLElement>(
      "[data-same-flight-staff-exclusions]"
    );

    expect(card?.textContent).toContain("同航班人员互斥");
    expect(card?.textContent).toContain("新增互斥规则");
    expect(card?.textContent?.replace(/\s+/g, " ")).toContain("0/1 条启用");
    expect(
      card?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked
    ).toBe(false);
    const selects = card?.querySelectorAll<HTMLSelectElement>("select");
    expect(selects).toHaveLength(3);
    expect(selects?.[0]?.value).toBe(state.staff[0]!.id);
    expect(selects?.[1]?.value).toBe(state.staff[1]!.id);
    expect(selects?.[2]?.value).toBe("KE166");
    expect(selects?.[2]?.textContent).toContain("全部航班");
    expect(card?.querySelector('button[aria-label="删除"]')).not.toBeNull();
  });

  it("keeps the ordinary-priority position collection compact and editable", async () => {
    const state = createDefaultState();
    state.settings.ordinaryPriorityPositions = [
      { airlineCode: "AK", position: "G08" },
      { airlineCode: "TR", position: "H02" },
      { airlineCode: "CX", position: "一号" },
      { airlineCode: "KE", position: "控制" },
      { airlineCode: "MU", position: "送资料" },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const collection = element.querySelector<HTMLDetailsElement>(
      ".ordinary-priority-position-scope"
    )!;
    const summary = collection.querySelector("summary")!;

    expect(collection.open).toBe(false);
    expect(summary.textContent).toContain("5 项");
    expect(summary.textContent).toContain("AK / G08");
    expect(summary.textContent).toContain("KE / 控制");
    expect(summary.textContent).not.toContain("MU / 送资料");
    expect(
      collection.querySelector(".ordinary-priority-position-content .row")
    ).not.toBeNull();
    expect(
      collection.querySelectorAll(".ordinary-priority-position-row")
    ).toHaveLength(5);
    expect(
      collection.querySelectorAll('input[aria-label="普通重点航司"]')
    ).toHaveLength(5);
    expect(
      collection.querySelectorAll('input[aria-label="普通重点规范岗位"]')
    ).toHaveLength(5);
    expect(
      collection.querySelectorAll('button[aria-label="删除普通重点岗位"]')
    ).toHaveLength(5);

    let emitted: CustomEvent | undefined;
    element.addEventListener("autoschedule-command", (event) => {
      emitted = event as CustomEvent;
    });
    collection.querySelector<HTMLButtonElement>("summary button")!.click();
    expect(collection.open).toBe(true);
    expect(emitted?.detail.type).toBe("add-ordinary-priority-position");
  });

  it("projects settings, structured rules, and the central rule ledger", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const text = element.textContent ?? "";

    expect(text).toContain("排班规则");
    expect(text).not.toContain("排班策略");
    expect(text).toContain("核心保护与公平参数");
    expect(text).toContain("分队长补差岗位保护");
    expect(text).toContain("固定保护");
    expect(text).toContain("允许参与补差换人");
    expect(text).toContain("跨工作日恢复保护");
    expect(text).toContain("跨工作日恢复目标强度");
    expect(text).toContain("优先避开");
    expect(text).toContain("严格限制");
    expect(
      element.querySelector(
        "autoschedule-policy-structured-rules [data-policy-recovery-mode]"
      )
    ).not.toBeNull();
    expect(
      element.querySelector(
        "autoschedule-policy-settings [data-policy-recovery-mode]"
      )
    ).toBeNull();
    expect(text).toContain("普通岗位最小衔接间隔");
    expect(text).toContain("TR121/H02 冷却工作班数");
    expect(
      element.querySelector<HTMLInputElement>(
        'input[data-policy-setting="tr121H02CooldownWorkdays"]'
      )?.value
    ).toBe(String(state.settings.tr121H02CooldownWorkdays));
    expect(text).toContain("每日工时上限");
    expect(
      element.querySelector<HTMLInputElement>(
        'input[data-policy-setting="maxDailyHours"]'
      )?.value
    ).toBe(String(state.settings.maxDailyHours));
    expect(text).toContain("跨工作日资质预留");
    expect(text).not.toContain("下班次值班人员预休");
    expect(text).toContain("机动督导兼任范围");
    expect(text).toContain("规则如何执行");
    expect(text).toContain("必须遵守");
    expect(text).toContain("保护与均衡");
    expect(text).toContain(
      "若整体缺员使晚班不可避免，则保留晚班并优先安全撤掉其截止前岗位"
    );
    expect(text).toContain(
      "晚班不可避免时，在不制造岗位空缺的前提下优先安全撤掉其截止前岗位"
    );
    expect(text).toContain("多人冲突时先保护截止更早的人");
    expect(text).not.toContain("后续晚班只有少数人能做时");
    expect(text).not.toContain("早班重点岗位");
    expect(text).not.toContain("规则启用与优先顺序");
    expect(text).not.toContain("扩展规则文件");
    expect(element.querySelector('input[type="search"]')).not.toBeNull();
    expect(element.querySelector('input[type="file"]')).toBeNull();
    for (const rule of ACTIVE_SCHEDULING_RULES) {
      expect(text).toContain(rule.label);
      expect(text).not.toContain(rule.id);
    }
    [
      "Hook",
      "API 1",
      "hard-constraint",
      "candidate-priority",
      "post-schedule",
      "protection",
    ].forEach((internalTerm) => expect(text).not.toContain(internalTerm));
  });

  it("shows concrete gap-fill positions and emits single-position and category updates", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const settings = element.querySelector<HTMLElement>(
      "autoschedule-team-leader-gap-fill-protection-settings"
    )!;
    const configurable = settings.querySelector<HTMLInputElement>(
      "input[data-gap-fill-position-movable]:not(:disabled)"
    )!;
    let emitted: CustomEvent | undefined;
    settings.addEventListener("autoschedule-command", (event) => {
      emitted = event as CustomEvent;
    });

    expect(settings.textContent).toContain("TR121");
    configurable.checked = !configurable.checked;
    configurable.dispatchEvent(new Event("change", { bubbles: true }));
    expect(emitted?.detail).toMatchObject({
      type: "set-team-leader-gap-fill-positions-movable",
      positionRuleIds: [configurable.dataset.positionRuleId],
      movable: configurable.checked,
    });

    const bulk = settings.querySelector<HTMLButtonElement>(
      "button[data-gap-fill-category-allow]"
    )!;
    bulk.click();
    expect(emitted?.detail.type).toBe(
      "set-team-leader-gap-fill-positions-movable"
    );
    expect(emitted?.detail.positionRuleIds.length).toBeGreaterThan(1);
  });

  it("emits the selected recovery mode from the recovery module", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const structuredRules = element.querySelector(
      "autoschedule-policy-structured-rules"
    )!;
    const select = structuredRules.querySelector<HTMLSelectElement>(
      "[data-policy-recovery-mode] select"
    )!;
    let emitted: CustomEvent | undefined;
    structuredRules.addEventListener("autoschedule-command", (event) => {
      emitted = event as CustomEvent;
    });

    select.value = "forbid";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(emitted?.detail.type).toBe("apply-policy");
    expect(emitted?.detail.input.nextWorkdayRecoveryMode).toBe("forbid");
  });

  it("searches actual structured-rule values and hides unrelated rule cards", async () => {
    const state = createDefaultState();
    state.settings.crossWorkdayQualificationReservations = [
      {
        id: "search-reservation",
        enabled: true,
        flightNo: "CX931",
        matchField: "position",
        keyword: "控制",
        minimumStaffCount: 1,
      },
    ];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const search = element.querySelector<HTMLInputElement>(
      'input[type="search"]'
    )!;

    search.value = "CX931";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();

    const text = element.textContent ?? "";
    expect(text).toContain("跨工作日资质预留");
    const visibleValues = [
      ...element.querySelectorAll<HTMLInputElement>(
        "autoschedule-policy-structured-rules input"
      ),
    ].map((input) => input.value);
    expect(visibleValues).toContain("CX931");
    expect(visibleValues).toContain("控制");
    expect(text).not.toContain("值班任务规则");
    expect(text).not.toContain("规则如何执行");
    expect(
      element.querySelector<HTMLDetailsElement>(".policy-rule-card")?.open
    ).toBe(true);
  });

  it("searches field labels and central rule descriptions across the whole page", async () => {
    const state = createDefaultState();
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const search = element.querySelector<HTMLInputElement>(
      'input[type="search"]'
    )!;

    search.value = "最大工时差";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    expect(element.textContent).toContain("核心保护与公平参数");
    expect(element.textContent).not.toContain("值班任务规则");

    search.value = "历史疲劳";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    expect(element.textContent).toContain("规则如何执行");
    expect(element.textContent).toContain("历史疲劳");
    expect(element.textContent).not.toContain("核心保护与公平参数");
    expect(element.textContent).not.toContain("岗位衔接间隔规则");
  });

  it("shows persisted non-default structured-rule selections after remount", async () => {
    const state = createDefaultState();
    const transition = state.settings.positionTransitionPolicies[0]!;
    transition.mode = "forbid";
    const reservation = {
      id: "non-default-reservation",
      enabled: true,
      flightNo: "TEST931",
      matchField: "remark" as const,
      keyword: "控制",
      minimumStaffCount: 1,
    };
    state.settings.crossWorkdayQualificationReservations = [reservation];
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: state });
    const transitionSelect = element.querySelector<HTMLSelectElement>(
      ".transition-policy-grid select"
    );
    const reservationRow = [
      ...element.querySelectorAll<HTMLElement>(".supervisor-coverage-row"),
    ].find((row) =>
      [...row.querySelectorAll<HTMLInputElement>('input[type="text"]')].some(
        (input) => input.value === reservation.flightNo
      )
    );

    expect(transitionSelect?.value).toBe("forbid");
    expect(reservationRow?.querySelector("select")?.value).toBe("remark");
  });
});
