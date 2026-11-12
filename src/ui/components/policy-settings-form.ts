import { html, nothing } from "lit";

import type { SchedulePolicyInput } from "../../app/policy-actions";
import type { AppState } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { matchesPolicySearch } from "../projections/policy-search";
import { LightDomElement } from "./light-dom-element";
import { latePriorityFlightScopeCandidates } from "../../domain/statistics/late-priority-flight-scope";
import {
  diagnoseLatePriorityScope,
  diagnoseOrdinaryPriorityPosition,
  diagnoseScalarPolicySetting,
} from "../../domain/rules/policy-configuration-diagnostics";
import { renderPolicyDiagnostics } from "./policy-diagnostic";
import { STATISTICS_TIME_WINDOWS } from "../../domain/rules/schedule-settings";

const POLICY_FIELDS: readonly (keyof SchedulePolicyInput)[] = [
  "maxDailyHours",
  "minimumRegularTransitionMinutes",
  "highLoadProtectionEnabled",
  "highLoadFatigueThreshold",
  "highLoadRecoveryMinutes",
  "remarkedPositionHighLoad",
  "rollingLoadProtectionEnabled",
  "rollingLoadWindowMinutes",
  "rollingLoadMaxFatigue",
  "positionRotationEnabled",
  "sameDayCrossFlightPriorityEnabled",
  "dailyPrimaryPositionUniqueEnabled",
  "tr121H02CooldownWorkdays",
  "latePriorityFlightNumbers",
  "lateShiftRecoveryEnabled",
  "lateShiftEndTime",
  "teamLeaderConcurrentSupervisionMaxOverlapMinutes",
  "workloadBalanceEnabled",
  "dailyFlightCountBalanceExemptHalfRest",
  "dailyFlightCountBalanceExemptTeamLeaders",
  "maxWorkHoursDifference",
  "maxTodayFatigueDifference",
  "dutyFatiguePoints",
  "earlyDepartureCutoffTime",
  "earlyDepartureBalanceEnabled",
  "earlyDepartureMaxDifference",
  "afternoonRestBalanceEnabled",
  "afternoonRestMaxDifference",
  "morningStatsStartTime",
  "morningStatsEndTime",
  "afternoonRestStartTime",
  "afternoonRestEndTime",
  "eveningStatsStartTime",
  "eveningStatsEndTime",
];

const POLICY_SETTING_SEARCH_TEXT = [
  "核心保护与公平参数",
  "保存后当前班表会标记为需要重新生成",
  "每日工时上限",
  "普通岗位最小衔接间隔（分钟）",
  "高负荷岗位恢复",
  "优先避开恢复期内人员",
  "高负荷疲劳阈值",
  "恢复时间（分钟）",
  "备注岗位视为高负荷",
  "一号、申报、控制等备注参与判定",
  "滚动负荷保护",
  "限制短时间连续高疲劳",
  "滚动窗口（分钟）",
  "滚动疲劳上限",
  "重点岗位频率与轮岗",
  "重点岗位优先，普通岗位防止连续第三班",
  "同日同航司控制/一号优先避免",
  "有安全替代时优先分开，无替代时允许安排并报警",
  "同一班表一号岗位单人限一次",
  "每个人最多承担一次非督导首个岗位，无法安排时保留空岗",
  "TR121/H02 冷却工作班数",
  "0 表示关闭，默认避开随后 3 个已归档工作班",
  "末班重点岗位航班范围",
  "勾选后参与四类合计轮换、差值控制和统计",
  "全选",
  "清空",
  "跨工作日恢复保护",
  "全局开放链优先避免连续晚间重岗位",
  "末班结束界线（晚于）",
  "分队长并行督导最大重叠",
  "工时与疲劳均衡",
  "压力不宽松时启用",
  "同一工作班航班数均衡",
  "半休人员豁免",
  "分队长豁免",
  "勾选后不参与航班数比较",
  "航班数差值必须不超过 1，无法安全做到时保留岗位空缺并说明原因",
  "最大工时差",
  "最大当日疲劳差",
  "值班疲劳点",
  "提前下班截载节点",
  "启用提前下班均衡",
  "提前下班本月次数目标差距",
  "启用下午无航班均衡",
  "下午无航班本月次数目标差距",
  "下午统计开始",
  "下午统计结束",
  "统计时段设置",
  "上午统计开始",
  "上午统计结束",
  "晚上统计开始",
  "晚上统计结束",
  "保存规则",
] as const;

function policyInput(model: AppState): SchedulePolicyInput {
  return Object.fromEntries(
    POLICY_FIELDS.map((field) => [field, model.settings[field]])
  ) as unknown as SchedulePolicyInput;
}

export class PolicySettingsFormElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
  };
  model!: AppState;
  query = "";
  private sourceModel?: AppState;
  private draft!: SchedulePolicyInput;

  protected override render() {
    if (this.sourceModel !== this.model) {
      this.sourceModel = this.model;
      this.draft = policyInput(this.model);
    }
    if (
      !matchesPolicySearch(
        this.query,
        POLICY_SETTING_SEARCH_TEXT,
        Object.values(this.draft),
        latePriorityFlightScopeCandidates(this.model.positionRules)
      )
    ) {
      return nothing;
    }
    return html`
      <details class="policy-rule-card" open>
        <summary>
          <span
            ><strong>核心保护与公平参数</strong
            ><small>保存后当前班表会标记为需要重新生成</small></span
          ><i class="bi bi-chevron-down"></i>
        </summary>
        <div class="policy-rule-content">
          <div class="schedule-policy-controls">
            ${this.number("maxDailyHours", "每日工时上限", 1, 24, 0.5)}
            ${this.number("minimumRegularTransitionMinutes", "普通岗位最小衔接间隔（分钟）", 0, 1440, 1)}
            ${this.toggle("highLoadProtectionEnabled", "高负荷岗位恢复", "优先避开恢复期内人员")}
            ${this.number("highLoadFatigueThreshold", "高负荷疲劳阈值", 0.5, 50, 0.5)}
            ${this.number("highLoadRecoveryMinutes", "恢复时间（分钟）", 0, 1440, 30)}
            ${this.toggle("remarkedPositionHighLoad", "备注岗位视为高负荷", "一号、申报、控制等备注参与判定")}
            ${this.toggle("rollingLoadProtectionEnabled", "滚动负荷保护", "限制短时间连续高疲劳")}
            ${this.number("rollingLoadWindowMinutes", "滚动窗口（分钟）", 0, 1440, 30)}
            ${this.number("rollingLoadMaxFatigue", "滚动疲劳上限", 0.5, 100, 0.5)}
            ${this.toggle("positionRotationEnabled", "重点岗位频率与轮岗", "重点岗位优先，普通岗位防止连续第三班")}
            ${this.toggle("sameDayCrossFlightPriorityEnabled", "同日同航司控制/一号优先避免", "有安全替代时优先分开，无替代时允许安排并报警")}
            ${this.toggle("dailyPrimaryPositionUniqueEnabled", "同一班表一号岗位单人限一次", "每个人最多承担一次非督导首个岗位，无法安排时保留空岗")}
            ${this.number("tr121H02CooldownWorkdays", "TR121/H02 冷却工作班数", 0, 30, 1)}
            ${this.latePriorityFlightScope()}
            ${this.ordinaryPriorityPositionCollection()}
            ${this.toggle("lateShiftRecoveryEnabled", "跨工作日恢复保护", "全局开放链优先避免连续晚间重岗位")}
            ${this.time("lateShiftEndTime", "末班结束界线（晚于）")}
            ${this.toggle("workloadBalanceEnabled", "工时与疲劳均衡", "压力不宽松时启用")}
            ${this.toggle("dailyFlightCountBalanceExemptHalfRest", "半休人员豁免", "勾选后半休人员不参与航班数比较")}
            ${this.toggle("dailyFlightCountBalanceExemptTeamLeaders", "分队长豁免", "勾选后分队长不参与航班数比较")}
            ${this.number("maxWorkHoursDifference", "最大工时差", 0, 24, 0.5)}
            ${this.number("maxTodayFatigueDifference", "最大当日疲劳差", 0, 100, 0.5)}
            ${this.number("dutyFatiguePoints", "值班疲劳点", 0, 100, 0.5)}
            ${this.time("earlyDepartureCutoffTime", "提前下班截载节点")}
            ${this.toggle("earlyDepartureBalanceEnabled", "启用提前下班均衡", "尽量把机会分给本月次数少的人；关闭仍统计")}
            ${this.number("earlyDepartureMaxDifference", "提前下班本月次数目标差距", 0, 31, 1)}
            ${this.toggle("afternoonRestBalanceEnabled", "启用下午无航班均衡", "尽量把机会分给本月次数少的人；关闭仍统计")}
            ${this.number("afternoonRestMaxDifference", "下午无航班本月次数目标差距", 0, 31, 1)}
          </div>
          <p class="small text-muted mt-3">
            两项默认开启、目标差距1，保存后重新排班。只参考本月此前已归档完整班表；保留正常排班的休息机会和岗位，资格、锁定、值班、半休及晚班保护优先，无法安全换人时允许超过目标。
          </p>
          <details data-statistics-periods class="mt-3">
            <summary>统计时段设置（上午／下午／晚上）</summary>
            <p class="small text-muted mt-2">
              仅定义统计时段，不改变半休、值班或夜班资格。当前计次使用下午时段，上午和晚上可预先维护。结束早于开始表示跨午夜。
            </p>
            <p class="small text-muted">
              当天下午有航班时才计次；个人任何已排岗位与下午时段重叠就算上班，包含引导和督导补位。全天无排班人员不计。
            </p>
            <div class="schedule-policy-controls">
              ${STATISTICS_TIME_WINDOWS.map(
                ({ label, start, end }) => html`
                  ${this.time(start, `${label}统计开始`)}
                  ${this.time(end, `${label}统计结束`)}
                  ${this.draft[start] === this.draft[end] ? html`<p role="alert">${label}开始和结束不能相同，请调整后保存。</p>` : nothing}
                `
              )}
            </div>
          </details>
          <div class="d-flex justify-content-end mt-3">
            <button
              class="btn btn-primary"
              type="button"
              ?disabled=${STATISTICS_TIME_WINDOWS.some(({ start, end }) => this.draft[start] === this.draft[end])}
              @click=${this.save}
            >
              <i class="bi bi-check2-circle me-2"></i>保存规则
            </button>
          </div>
        </div>
      </details>
    `;
  }

  private updateDraft<K extends keyof SchedulePolicyInput>(
    field: K,
    value: SchedulePolicyInput[K]
  ): void {
    this.draft = { ...this.draft, [field]: value };
    this.requestUpdate();
  }

  private toggle(
    field: keyof SchedulePolicyInput,
    label: string,
    note: string
  ) {
    return html`<div>
      <label class="policy-switch"
        ><span><strong>${label}</strong><small>${note}</small></span
        ><span class="form-check form-switch m-0"
          ><input
            class="form-check-input"
            data-policy-setting=${field}
            type="checkbox"
            .checked=${Boolean(this.draft[field])}
            @change=${(event: Event) => this.updateDraft(field, (event.currentTarget as HTMLInputElement).checked as never)} /></span></label
      >${this.settingDiagnostics(field, label)}
    </div>`;
  }

  private number(
    field: keyof SchedulePolicyInput,
    label: string,
    min: number,
    max: number,
    step: number
  ) {
    return html`<div>
      <label class="form-label"
        >${label}<input
          class="form-control"
          data-policy-setting=${field}
          type="number"
          min=${min}
          max=${max}
          step=${step}
          .value=${String(this.draft[field])}
          @input=${(event: Event) => this.updateDraft(field, Number((event.currentTarget as HTMLInputElement).value) as never)} /></label
      >${this.settingDiagnostics(field, label)}
    </div>`;
  }

  private time(field: keyof SchedulePolicyInput, label: string) {
    return html`<div>
      <label class="form-label"
        >${label}<input
          class="form-control"
          type="time"
          data-policy-setting=${field}
          .value=${String(this.draft[field])}
          @input=${(event: Event) => this.updateDraft(field, (event.currentTarget as HTMLInputElement).value as never)} /></label
      >${this.settingDiagnostics(field, label)}
    </div>`;
  }

  private settingDiagnostics(field: keyof SchedulePolicyInput, label: string) {
    return renderPolicyDiagnostics(
      diagnoseScalarPolicySetting(field, this.draft[field], label),
      `corePolicySettings:${field}`
    );
  }

  private latePriorityFlightScope() {
    const candidates = [
      ...new Set([
        ...latePriorityFlightScopeCandidates(this.model.positionRules),
        ...this.draft.latePriorityFlightNumbers,
      ]),
    ];
    const selected = new Set(this.draft.latePriorityFlightNumbers);
    const setScope = (flightNumbers: string[]): void =>
      this.updateDraft("latePriorityFlightNumbers", flightNumbers);
    return html`<fieldset class="late-priority-flight-scope">
      <legend>
        <span
          ><strong>末班重点岗位航班范围</strong
          ><small
            >勾选后参与末班岗位轮换、统计及上一班末班人员晚班轻岗保护</small
          ></span
        >
        <span class="btn-group btn-group-sm" role="group">
          <button
            class="btn btn-outline-secondary"
            type="button"
            @click=${() => setScope(candidates)}
          >
            <i class="bi bi-check2-square me-1"></i>全选
          </button>
          <button
            class="btn btn-outline-secondary"
            type="button"
            @click=${() => setScope([])}
          >
            <i class="bi bi-x-square me-1"></i>清空
          </button>
        </span>
      </legend>
      <div>
        ${
          candidates.length
            ? candidates.map(
                (flightNo) =>
                  html`<label class="form-check">
                    <input
                      class="form-check-input"
                      type="checkbox"
                      .checked=${selected.has(flightNo)}
                      @change=${(event: Event) => {
                        const checked = (
                          event.currentTarget as HTMLInputElement
                        ).checked;
                        setScope(
                          candidates.filter((candidate) =>
                            candidate === flightNo
                              ? checked
                              : selected.has(candidate)
                          )
                        );
                      }}
                    />
                    <span class="form-check-label">${flightNo}</span>
                  </label>`
              )
            : html`<small class="text-body-secondary"
                >当前岗位配置中没有督导、一号、申报或送资料航班</small
              >`
        }
      </div>
      ${renderPolicyDiagnostics(diagnoseLatePriorityScope(this.model, this.draft.latePriorityFlightNumbers), "latePriorityFlightNumbers")}
    </fieldset>`;
  }

  private ordinaryPriorityPositionCollection() {
    const items = this.model.settings.ordinaryPriorityPositions;
    const preview = items
      .slice(0, 4)
      .map((item) => `${item.airlineCode} / ${item.position}`)
      .join(" · ");
    return html`<details class="ordinary-priority-position-scope">
      <summary>
        <span class="ordinary-priority-position-heading">
          <strong>普通重点岗位集合</strong>
          <small>${items.length} 项 · ${preview || "暂未配置"}</small>
        </span>
        <span class="ordinary-priority-position-actions">
          <button
            class="btn btn-sm btn-outline-secondary"
            type="button"
            @click=${(event: Event) => {
              event.preventDefault();
              const collection = (
                event.currentTarget as HTMLButtonElement
              ).closest<HTMLDetailsElement>("details");
              if (collection) collection.open = true;
              dispatchUiCommand(this, {
                type: "add-ordinary-priority-position",
              });
            }}
          >
            <i class="bi bi-plus-lg me-1" aria-hidden="true"></i>新增
          </button>
          <i class="bi bi-chevron-down" aria-hidden="true"></i>
        </span>
      </summary>
      <div class="ordinary-priority-position-content">
        <small class="text-body-secondary"
          >只认这里配置的航司 + 规范岗位，集合外关键词岗位按普通岗位轮岗</small
        >
        <div class="row g-2">
          ${items.map(
            (item, index) =>
              html`<div class="col-12 col-md-6">
                <div class="ordinary-priority-position-row">
                  <input
                    class="form-control form-control-sm"
                    aria-label="普通重点航司"
                    .value=${item.airlineCode}
                    @change=${(event: Event) =>
                      dispatchUiCommand(this, {
                        type: "update-ordinary-priority-position",
                        index,
                        field: "airlineCode",
                        value: (event.currentTarget as HTMLInputElement).value,
                      })}
                  />
                  <input
                    class="form-control form-control-sm"
                    aria-label="普通重点规范岗位"
                    .value=${item.position}
                    @change=${(event: Event) =>
                      dispatchUiCommand(this, {
                        type: "update-ordinary-priority-position",
                        index,
                        field: "position",
                        value: (event.currentTarget as HTMLInputElement).value,
                      })}
                  />
                  <button
                    class="btn btn-sm btn-outline-danger"
                    type="button"
                    title="删除"
                    aria-label="删除普通重点岗位"
                    @click=${() =>
                      dispatchUiCommand(this, {
                        type: "delete-ordinary-priority-position",
                        airlineCode: item.airlineCode,
                        position: item.position,
                      })}
                  >
                    <i class="bi bi-trash3" aria-hidden="true"></i>
                  </button>
                </div>
                ${renderPolicyDiagnostics(diagnoseOrdinaryPriorityPosition(this.model, index), `ordinaryPriorityPositions:${index}`)}
              </div>`
          )}
        </div>
      </div>
    </details>`;
  }

  private save(): void {
    dispatchUiCommand(this, { type: "apply-policy", input: this.draft });
  }
}

customElements.define(
  "autoschedule-policy-settings",
  PolicySettingsFormElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-policy-settings": PolicySettingsFormElement;
  }
}
