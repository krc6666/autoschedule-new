import { html, nothing } from "lit";

import type { AppState } from "../../model";
import { STRUCTURED_POLICY_DEFINITIONS } from "../../domain/rules/structured-policy-settings";
import type { StructuredPolicyKey } from "../../domain/rules/structured-policy-contract";
import { diagnosePolicyConfiguration } from "../../domain/rules/policy-configuration-diagnostics";
import { renderPolicyDiagnostics } from "./policy-diagnostic";
import { dispatchUiCommand, inputValue } from "../events/ui-command";
import {
  matchesPolicySearch,
  normalizePolicySearchQuery,
} from "../projections/policy-search";
import { LightDomElement } from "./light-dom-element";
import { dynamicSelectValue } from "./dynamic-select";

type RegisteredPolicyCollection =
  (typeof STRUCTURED_POLICY_DEFINITIONS)[keyof typeof STRUCTURED_POLICY_DEFINITIONS]["uiCollection"];
type Collection = Exclude<RegisteredPolicyCollection, "team-leader-gap-fill">;
type PolicyStructuredRuleKey = Exclude<
  StructuredPolicyKey,
  "teamLeaderGapFillPositionPolicies"
>;

export class PolicyStructuredRulesElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
  };
  model!: AppState;
  query = "";

  protected override render() {
    return html`
      ${this.sameFlightStaffExclusions()} ${this.dutyPriorities()}
      ${this.crossFlightPriorities()} ${this.crossWorkdayReservations()}
      ${this.recoveryRules()} ${this.supervisorFillRules()}
      ${this.supervisorRules()} ${this.transitionRules()}
    `;
  }

  private sameFlightStaffExclusions() {
    const items = this.model.settings.sameFlightStaffExclusions;
    if (
      !matchesPolicySearch(
        this.query,
        "同航班人员互斥",
        "两人不能同时安排在同一个航班",
        "人员 A",
        "人员 B",
        "适用航班",
        "全部航班",
        "新增互斥规则",
        items.map((item) => [
          item.enabled ? "启用" : "停用",
          this.model.staff.find((person) => person.id === item.firstStaffId)
            ?.name,
          this.model.staff.find((person) => person.id === item.secondStaffId)
            ?.name,
          item.flightNo,
        ])
      )
    )
      return nothing;
    return html`<details
      class="policy-rule-card"
      data-same-flight-staff-exclusions
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>同航班人员互斥</strong
          ><small
            >${items.filter((item) => item.enabled).length}/${items.length}
            条启用 · 启用项为硬互斥</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("sameFlightStaffExclusions", "新增互斥规则")}
        </div>
        <div class="supervisor-coverage-list">
          ${items.map(
            (item) =>
              html`<div
                class="supervisor-coverage-row same-flight-exclusion-row"
              >
                ${this.toggle(
                  "same-flight-staff-exclusion",
                  item.id,
                  "enabled",
                  item.enabled,
                  "启用"
                )}
                ${this.staffSelect(
                  item.id,
                  "firstStaffId",
                  item.firstStaffId,
                  "人员 A"
                )}
                ${this.staffSelect(
                  item.id,
                  "secondStaffId",
                  item.secondStaffId,
                  "人员 B"
                )}
                ${this.flightScopeSelect(item.id, item.flightNo)}
                ${this.deleteButton("sameFlightStaffExclusions", item.id)}
                ${this.diagnostics("sameFlightStaffExclusions", item.id)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private crossFlightPriorities() {
    const items = this.model.settings.crossFlightPriorityPolicies;
    if (
      !matchesPolicySearch(
        this.query,
        "跨航班重点人员优先",
        "优先航班",
        "优先人员",
        "新增规则",
        items.map((item) => [
          item.flightNo,
          item.staffIds.flatMap((staffId) => {
            const person = this.model.staff.find(
              (candidate) => candidate.id === staffId
            );
            return person ? [`${person.name} ${person.id}`] : [];
          }),
        ])
      )
    )
      return nothing;
    return html`<details
      class="policy-rule-card"
      data-cross-flight-priorities
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>跨航班重点人员优先</strong
          ><small
            >${items.filter((item) => item.enabled).length} 条启用 ·
            从上到下依次优先；同时段冲突时优先把选中人员留在该航班</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("crossFlightPriorityPolicies", "新增规则")}
        </div>
        <div class="supervisor-coverage-list">
          ${items.map(
            (item, index) =>
              html`<div class="supervisor-coverage-row">
                ${this.toggle("cross-flight-priority", item.id, "enabled", item.enabled, "启用")}
                ${this.flightSelect("cross-flight-priority", item.id, item.flightNo, "优先航班")}
                ${this.priorityStaffCheckboxes(item.id, item.staffIds)}
                <div class="d-flex gap-1">
                  ${this.moveCrossFlightPriority(item.id, -1, index === 0)}${this.moveCrossFlightPriority(item.id, 1, index === items.length - 1)}${this.deleteButton("crossFlightPriorityPolicies", item.id)}
                </div>
                ${this.diagnostics("crossFlightPriorityPolicies", item.id)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private crossWorkdayReservations() {
    const items = this.model.settings.crossWorkdayQualificationReservations;
    if (
      !matchesPolicySearch(
        this.query,
        "跨工作日资质预留",
        "从上到下依次保留",
        "新增预留目标",
        "启用",
        "下一工作班航班",
        "匹配位置",
        "岗位名称",
        "岗位备注",
        "岗位关键词",
        "至少保留人数",
        items.map((item) => [
          item.flightNo,
          item.keyword,
          item.minimumStaffCount,
        ])
      )
    ) {
      return nothing;
    }
    return html`<details
      class="policy-rule-card"
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>跨工作日资质预留</strong
          ><small
            >${items.filter((item) => item.enabled).length} 条启用 ·
            从上到下依次保留</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("crossWorkdayQualificationReservations", "新增预留目标")}
        </div>
        <div class="supervisor-coverage-list">
          ${items.map(
            (item, index) =>
              html`<div class="supervisor-coverage-row">
                ${this.toggle("cross-workday-reservation", item.id, "enabled", item.enabled, "启用")}
                ${this.field("cross-workday-reservation", item.id, "flightNo", item.flightNo, "下一工作班航班")}
                ${this.select(
                  "cross-workday-reservation",
                  item.id,
                  "matchField",
                  item.matchField,
                  "匹配位置",
                  [
                    ["position", "岗位名称"],
                    ["remark", "岗位备注"],
                  ]
                )}
                ${this.field("cross-workday-reservation", item.id, "keyword", item.keyword, "岗位关键词")}
                ${this.field("cross-workday-reservation", item.id, "minimumStaffCount", item.minimumStaffCount, "至少保留人数", "", "number")}
                <div class="d-flex gap-1">
                  ${this.moveReservation(item.id, -1, index === 0)}
                  ${this.moveReservation(item.id, 1, index === items.length - 1)}
                  ${this.deleteButton("crossWorkdayQualificationReservations", item.id)}
                </div>
                ${this.diagnostics("crossWorkdayQualificationReservations", item.id)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private dutyPriorities() {
    const items = this.model.settings.dutyPositionPriorities;
    if (
      !matchesPolicySearch(
        this.query,
        "值班任务规则",
        "按顺序逐项尝试",
        "新增优先项",
        "航班号",
        "岗位或备注关键词",
        "启用",
        items.map((item) => [item.flightNo, item.positionKeyword])
      )
    ) {
      return nothing;
    }
    return html`<details
      class="policy-rule-card"
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>值班任务规则</strong
          ><small
            >${items.filter((item) => item.enabled).length} 个优先项 ·
            按顺序逐项尝试</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("dutyPositionPriorities", "新增优先项")}
        </div>
        <div class="duty-priority-list">
          ${items.map(
            (item, index) =>
              html`<div class="duty-priority-row">
                <span class="duty-priority-order">${index + 1}</span>
                ${this.field("duty-priority", item.id, "flightNo", item.flightNo, "航班号")}
                ${this.field("duty-priority", item.id, "positionKeyword", item.positionKeyword, "岗位或备注关键词")}
                ${this.toggle("duty-priority", item.id, "enabled", item.enabled, "启用")}
                <div class="duty-priority-actions">
                  ${this.moveDuty(item.id, -1, index === 0)}${this.moveDuty(item.id, 1, index === items.length - 1)}${this.deleteButton("dutyPositionPriorities", item.id)}
                </div>
                ${this.diagnostics("dutyPositionPriorities", item.id)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private recoveryRules() {
    const settings = this.model.settings;
    if (
      !matchesPolicySearch(
        this.query,
        "跨工作日恢复目标",
        "末班重点岗位",
        "新增规则",
        "适用航班",
        "匹配位置",
        "岗位名称",
        "岗位备注",
        "关键词",
        "次班截止时间",
        "次班早班避让目标",
        "新增目标",
        "目标航班",
        "岗位或备注关键词",
        "跨工作日恢复目标强度",
        "优先避开",
        "严格限制",
        settings.lateShiftRecoveryPositionRules.map((rule) => [
          rule.flightNo,
          rule.keyword,
          rule.nextWorkdayCutoffTime,
        ]),
        settings.nextWorkdayRecoveryTargets.map((target) => [
          target.flightNo,
          target.positionKeyword,
        ])
      )
    ) {
      return nothing;
    }
    return html`<details
      class="policy-rule-card"
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>跨工作日恢复目标</strong
          ><small
            >${settings.lateShiftRecoveryPositionRules.filter((item) => item.enabled).length}
            条末班规则 ·
            ${settings.nextWorkdayRecoveryTargets.filter((item) => item.enabled).length}
            个次班目标</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="policy-recovery-mode mb-3" data-policy-recovery-mode>
          <label class="form-label mb-0">
            <strong>跨工作日恢复目标强度</strong>
            <select
              class="form-select form-select-sm"
              .value=${settings.nextWorkdayRecoveryMode}
              @change=${(event: Event) =>
                dispatchUiCommand(this, {
                  type: "apply-policy",
                  input: {
                    ...settings,
                    nextWorkdayRecoveryMode: (
                      event.currentTarget as HTMLSelectElement
                    ).value as "prefer" | "forbid",
                  },
                })}
            >
              <option value="prefer">优先避开</option>
              <option value="forbid">严格限制</option>
            </select>
          </label>
          <small class="text-muted"
            >严格限制时，上一班末班重点岗位人员不得承担已配置的次班恢复目标；无安全完整方案则保留原班表。</small
          >
        </div>
        <div class="d-flex justify-content-between align-items-center">
          <strong>末班重点岗位</strong
          >${this.addButton("lateShiftRecoveryPositionRules", "新增规则")}
        </div>
        <div class="supervisor-coverage-list mt-2">
          ${settings.lateShiftRecoveryPositionRules.map(
            (rule) =>
              html`<div class="supervisor-coverage-row">
                ${this.toggle("late-shift-recovery-position", rule.id, "enabled", rule.enabled, "启用")}
                ${this.field("late-shift-recovery-position", rule.id, "flightNo", rule.flightNo, "适用航班", "留空=全部")}
                ${this.select(
                  "late-shift-recovery-position",
                  rule.id,
                  "matchField",
                  rule.matchField,
                  "匹配位置",
                  [
                    ["position", "岗位名称"],
                    ["remark", "岗位备注"],
                  ]
                )}
                ${this.field("late-shift-recovery-position", rule.id, "keyword", rule.keyword, "关键词")}
                ${this.field("late-shift-recovery-position", rule.id, "nextWorkdayCutoffTime", rule.nextWorkdayCutoffTime, "次班截止时间", "", "time")}
                ${this.deleteButton("lateShiftRecoveryPositionRules", rule.id)}
                ${this.diagnostics("lateShiftRecoveryPositionRules", rule.id)}
              </div>`
          )}
        </div>
        <div class="d-flex justify-content-between align-items-center mt-3">
          <strong>次班早班避让目标</strong
          >${this.addButton("nextWorkdayRecoveryTargets", "新增目标")}
        </div>
        <div class="duty-priority-list mt-2">
          ${settings.nextWorkdayRecoveryTargets.map(
            (target) =>
              html`<div class="duty-priority-row">
                ${this.toggle("recovery-target", target.id, "enabled", target.enabled, "启用")}
                ${this.field("recovery-target", target.id, "flightNo", target.flightNo, "目标航班")}
                ${this.field("recovery-target", target.id, "positionKeyword", target.positionKeyword, "岗位或备注关键词")}
                ${this.deleteButton("nextWorkdayRecoveryTargets", target.id)}
                ${this.diagnostics("nextWorkdayRecoveryTargets", target.id)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private supervisorRules() {
    const items = this.model.settings.mobileSupervisorCoverageRules;
    if (
      !matchesPolicySearch(
        this.query,
        "机动督导兼任范围",
        "自动排班与人工拖拽共用",
        "禁止优先",
        "新增规则",
        "适用航班",
        "匹配位置",
        "岗位名称",
        "岗位备注",
        "关键词",
        "处理方式",
        "禁止兼任",
        "允许兼任",
        items.map((item) => [item.flightNo, item.keyword])
      )
    ) {
      return nothing;
    }
    return html`<details
      class="policy-rule-card"
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>机动督导兼任范围</strong
          ><small>自动排班与人工拖拽共用 · 禁止优先</small></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("mobileSupervisorCoverageRules", "新增规则")}
        </div>
        <div class="supervisor-coverage-list">
          ${items.map(
            (rule) =>
              html`<div class="supervisor-coverage-row">
                ${this.toggle("supervisor-coverage", rule.id, "enabled", rule.enabled, "启用")}
                ${this.field("supervisor-coverage", rule.id, "flightNo", rule.flightNo, "适用航班", "留空=全部")}
                ${this.select(
                  "supervisor-coverage",
                  rule.id,
                  "matchField",
                  rule.matchField,
                  "匹配位置",
                  [
                    ["position", "岗位名称"],
                    ["remark", "岗位备注"],
                  ]
                )}
                ${this.field("supervisor-coverage", rule.id, "keyword", rule.keyword, "关键词")}
                ${this.select(
                  "supervisor-coverage",
                  rule.id,
                  "mode",
                  rule.mode,
                  "处理方式",
                  [
                    ["forbid", "禁止兼任"],
                    ["allow", "允许兼任"],
                  ]
                )}
                ${this.deleteButton("mobileSupervisorCoverageRules", rule.id)}
                ${this.diagnostics("mobileSupervisorCoverageRules", rule.id)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private supervisorFillRules() {
    const items = this.model.settings.mobileSupervisorFillRules;
    if (
      !matchesPolicySearch(
        this.query,
        "督导补位关系",
        "人手不足",
        "来源航班",
        "来源岗位",
        "目标航班",
        "目标岗位",
        items.map((item) => [
          item.sourceFlightNo,
          item.sourcePositionKeyword,
          item.targetFlightNo,
          item.targetPositionKeyword,
        ])
      )
    )
      return nothing;
    return html`<details
      class="policy-rule-card"
      data-supervisor-fill
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>督导补位关系</strong
          ><small
            >${items.filter((item) => item.enabled).length} 条启用 ·
            仅在人手不足且没有安全普通候选时生效</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("mobileSupervisorFillRules", "新增补位关系")}
        </div>
        <div class="supervisor-coverage-list">
          ${items.map((rule) => {
            return html`<div
              class="supervisor-coverage-row supervisor-fill-row"
            >
              ${this.toggle("supervisor-fill", rule.id, "enabled", rule.enabled, "启用")}
              ${this.field("supervisor-fill", rule.id, "sourceFlightNo", rule.sourceFlightNo, "来源航班")}
              ${this.field("supervisor-fill", rule.id, "sourcePositionKeyword", rule.sourcePositionKeyword, "来源岗位")}
              ${this.field("supervisor-fill", rule.id, "targetFlightNo", rule.targetFlightNo, "目标航班")}
              ${this.field("supervisor-fill", rule.id, "targetPositionKeyword", rule.targetPositionKeyword, "目标岗位")}
              ${this.toggle("supervisor-fill", rule.id, "allowAutomatic", rule.allowAutomatic, "自动补位")}
              ${this.toggle("supervisor-fill", rule.id, "allowManual", rule.allowManual, "人工补位")}
              ${this.deleteButton("mobileSupervisorFillRules", rule.id)}
              ${this.diagnostics("mobileSupervisorFillRules", rule.id)}
            </div>`;
          })}
        </div>
      </div>
    </details>`;
  }

  private transitionRules() {
    const items = this.model.settings.positionTransitionPolicies;
    if (
      !matchesPolicySearch(
        this.query,
        "岗位衔接间隔规则",
        "新增衔接规则",
        "规则名称",
        "启用规则",
        "前序航班",
        "前序晚撤岗位",
        "目标航班",
        "目标岗位",
        "最小间隔（分钟）",
        "执行强度",
        "优先避开",
        "严格限制",
        items.map((item) => [
          item.name,
          item.sourceFlightNo,
          item.sourcePositions,
          item.targetFlightNo,
          item.targetPosition,
          item.minimumGapMinutes,
        ])
      )
    ) {
      return nothing;
    }
    return html`<details
      class="policy-rule-card"
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>岗位衔接间隔规则</strong
          ><small
            >${items.filter((item) => item.enabled).length} 条启用</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <div class="d-flex justify-content-end mb-2">
          ${this.addButton("positionTransitionPolicies", "新增衔接规则")}
        </div>
        <div class="policy-card-list">
          ${items.map(
            (rule) =>
              html`<article
                class="transition-policy-grid border-bottom pb-3 mb-3"
              >
                ${this.field("transition-policy", rule.id, "name", rule.name, "规则名称")}
                ${this.toggle("transition-policy", rule.id, "enabled", rule.enabled, "启用规则")}
                ${this.field("transition-policy", rule.id, "sourceFlightNo", rule.sourceFlightNo, "前序航班")}
                ${this.field("transition-policy", rule.id, "sourcePositions", rule.sourcePositions.join(", "), "前序晚撤岗位")}
                ${this.field("transition-policy", rule.id, "targetFlightNo", rule.targetFlightNo, "目标航班")}
                ${this.field("transition-policy", rule.id, "targetPosition", rule.targetPosition, "目标岗位")}
                ${this.field("transition-policy", rule.id, "minimumGapMinutes", rule.minimumGapMinutes, "最小间隔（分钟）", "", "number")}
                ${this.select(
                  "transition-policy",
                  rule.id,
                  "mode",
                  rule.mode,
                  "执行强度",
                  [
                    ["prefer", "优先避开"],
                    ["forbid", "严格限制"],
                  ]
                )}
                <div>
                  ${this.deleteButton("positionTransitionPolicies", rule.id)}
                </div>
                ${this.diagnostics("positionTransitionPolicies", rule.id)}
              </article>`
          )}
        </div>
      </div>
    </details>`;
  }

  private field(
    entity: string,
    id: string,
    field: string,
    value: string | number,
    label: string,
    placeholder = "",
    type = "text"
  ) {
    return html`<label class="form-label"
      >${label}<input
        class="form-control form-control-sm"
        type=${type}
        placeholder=${placeholder}
        aria-label=${label}
        .value=${String(value)}
        @change=${(event: Event) => dispatchUiCommand(this, { type: "update-policy", entity, id, field, value: inputValue(event.currentTarget as HTMLInputElement) })}
    /></label>`;
  }

  private select(
    entity: string,
    id: string,
    field: string,
    value: string,
    label: string,
    choices: readonly (readonly [string, string])[]
  ) {
    return html`<label class="form-label"
      >${label}<select
        ${dynamicSelectValue(value)}
        class="form-select form-select-sm"
        aria-label=${label}
        .value=${value}
        @change=${(event: Event) => dispatchUiCommand(this, { type: "update-policy", entity, id, field, value: (event.currentTarget as HTMLSelectElement).value })}
      >
        ${choices.map(
          ([choice, text]) => html`<option .value=${choice}>${text}</option>`
        )}
      </select></label
    >`;
  }

  private flightSelect(
    entity: string,
    id: string,
    value: string,
    label: string
  ) {
    const choices = [
      ...new Set(
        [
          ...this.model.flights.map((flight) => flight.flightNo.trim()),
          ...this.model.positionRules.map((rule) => rule.flightNo.trim()),
        ].filter(Boolean)
      ),
    ];
    return this.select(
      entity,
      id,
      "flightNo",
      value,
      label,
      choices.map((flightNo) => [flightNo, flightNo] as const)
    );
  }

  private staffSelect(
    id: string,
    field: "firstStaffId" | "secondStaffId",
    value: string,
    label: string
  ) {
    return this.select(
      "same-flight-staff-exclusion",
      id,
      field,
      value,
      label,
      this.model.staff.map((person) => [person.id, person.name] as const)
    );
  }

  private flightScopeSelect(id: string, value: string) {
    const flightNumbers = [
      ...new Set(
        [
          ...this.model.flights.map((flight) => flight.flightNo.trim()),
          ...this.model.templates.map((flight) => flight.flightNo.trim()),
          ...this.model.positionRules.map((rule) => rule.flightNo.trim()),
        ].filter(Boolean)
      ),
    ];
    if (value && !flightNumbers.includes(value)) flightNumbers.unshift(value);
    return this.select(
      "same-flight-staff-exclusion",
      id,
      "flightNo",
      value,
      "适用航班",
      [
        ["", "全部航班"],
        ...flightNumbers.map((flightNo) => [flightNo, flightNo] as const),
      ]
    );
  }

  private priorityStaffCheckboxes(id: string, selected: string[]) {
    return html`<fieldset class="form-label">
      <legend class="form-label mb-1">优先人员</legend>
      <div class="d-flex flex-wrap gap-2">
        ${this.model.staff.map(
          (person) =>
            html`<label class="form-check mb-0"
              ><input
                class="form-check-input"
                type="checkbox"
                .checked=${selected.includes(person.id)}
                @change=${(event: Event) => {
                  const checked = (event.currentTarget as HTMLInputElement)
                    .checked;
                  const next = checked
                    ? [...selected, person.id]
                    : selected.filter((item) => item !== person.id);
                  dispatchUiCommand(this, {
                    type: "update-policy",
                    entity: "cross-flight-priority",
                    id,
                    field: "staffIds",
                    value: next.join(","),
                  });
                }}
              /><span class="form-check-label"
                >${person.name}（${person.id}）</span
              ></label
            >`
        )}
      </div>
    </fieldset>`;
  }

  private toggle(
    entity: string,
    id: string,
    field: string,
    checked: boolean,
    label: string
  ) {
    return html`<label class="form-check form-switch supervisor-coverage-switch"
      ><input
        class="form-check-input"
        type="checkbox"
        .checked=${checked}
        @change=${(event: Event) => dispatchUiCommand(this, { type: "update-policy", entity, id, field, value: (event.currentTarget as HTMLInputElement).checked })}
      /><span class="form-check-label">${label}</span></label
    >`;
  }

  private addButton(key: PolicyStructuredRuleKey, label: string) {
    const collection = this.policyCollection(key);
    return html`<button
      class="btn btn-sm btn-outline-secondary"
      type="button"
      @click=${() => dispatchUiCommand(this, { type: "add-policy-item", collection })}
    >
      <i class="bi bi-plus-lg me-1"></i>${label}
    </button>`;
  }

  private diagnostics(key: PolicyStructuredRuleKey, id: string) {
    return renderPolicyDiagnostics(
      diagnosePolicyConfiguration(this.model, key, id),
      `${key}:${id}`
    );
  }

  private deleteButton(key: PolicyStructuredRuleKey, id: string) {
    const collection = this.policyCollection(key);
    return html`<button
      class="btn btn-sm icon-btn text-danger"
      type="button"
      title="删除"
      aria-label="删除"
      @click=${() => dispatchUiCommand(this, { type: "delete-policy-item", collection, id })}
    >
      <i class="bi bi-trash3"></i>
    </button>`;
  }

  private policyCollection(key: PolicyStructuredRuleKey): Collection {
    return STRUCTURED_POLICY_DEFINITIONS[key].uiCollection;
  }

  private moveDuty(id: string, direction: -1 | 1, disabled: boolean) {
    return html`<button
      class="btn btn-sm icon-btn"
      type="button"
      title=${direction < 0 ? "提高优先级" : "降低优先级"}
      ?disabled=${disabled}
      @click=${() => dispatchUiCommand(this, { type: "move-duty-priority", id, direction })}
    >
      <i class="bi bi-arrow-${direction < 0 ? "up" : "down"}"></i>
    </button>`;
  }

  private moveReservation(id: string, direction: -1 | 1, disabled: boolean) {
    return html`<button
      class="btn btn-sm icon-btn"
      type="button"
      title=${direction < 0 ? "提高优先级" : "降低优先级"}
      ?disabled=${disabled}
      @click=${() =>
        dispatchUiCommand(this, {
          type: "move-cross-workday-reservation",
          id,
          direction,
        })}
    >
      <i class="bi bi-arrow-${direction < 0 ? "up" : "down"}"></i>
    </button>`;
  }

  private moveCrossFlightPriority(
    id: string,
    direction: -1 | 1,
    disabled: boolean
  ) {
    return html`<button
      class="btn btn-sm icon-btn"
      type="button"
      title=${direction < 0 ? "提高优先级" : "降低优先级"}
      ?disabled=${disabled}
      @click=${() => dispatchUiCommand(this, { type: "move-cross-flight-priority", id, direction })}
    >
      <i class="bi bi-arrow-${direction < 0 ? "up" : "down"}"></i>
    </button>`;
  }
}

customElements.define(
  "autoschedule-policy-structured-rules",
  PolicyStructuredRulesElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-policy-structured-rules": PolicyStructuredRulesElement;
  }
}
