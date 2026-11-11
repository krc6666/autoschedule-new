import { html } from "lit";
import { withConfiguredFlightPositions } from "../../domain/flights/configured-flight-positions";

import type { AppState, FlightTemplate } from "../../model";
import { currentFlightsWithoutTemplates } from "../../domain/flights/next-workday-flight-plan";
import { dispatchUiCommand } from "../events/ui-command";
import { configurationInput } from "./configuration-field";
import { LightDomElement } from "./light-dom-element";

export class ConfigurationSettingsSectionElement extends LightDomElement {
  static override properties = { model: { attribute: false } };
  model!: AppState;

  protected override render() {
    const settings = this.model.settings;
    return html`<section class="workspace-section settings-section">
        <div>
          <div class="section-heading"><h3>排班约束</h3></div>
          <div class="form-grid">
            ${this.setting("maxDailyHours", settings.maxDailyHours, "每日工时上限", { min: 1, max: 24, step: 0.5 })}
            ${this.setting("historyWindowDays", settings.historyWindowDays, "历史统计天数", { min: 1, max: 90 })}
            ${this.setting("consecutiveDayPenalty", settings.consecutiveDayPenalty, "连续工作惩罚", { min: 0, step: 0.5 })}
            ${this.setting("nightStart", settings.nightStart, "夜班开始时间", { type: "time" })}
            ${this.setting("nightEnd", settings.nightEnd, "夜班结束时间", { type: "time" })}
          </div>
        </div>
      </section>
      <section class="workspace-section flight-template-section">
        <div>
          <div class="section-heading">
            <div>
              <h3>航班计划模板（航班资料 A、B 共用）</h3>
              <span
                >岗位随当前 ${this.model.activeGroupId}
                组自动显示，请在上方“岗位配置”维护。本季航班以岗位配置为准，这里可保留往季备用航班；模板资料
                A/B 共用。</span
              >
            </div>
            <button
              class="btn btn-primary"
              type="button"
              @click=${() => dispatchUiCommand(this, { type: "add-template" })}
            >
              <i class="bi bi-plus-lg me-2"></i>新增航班模板
            </button>
          </div>
          <div class="template-editor">
            ${
              this.model.templates.length
                ? withConfiguredFlightPositions(
                    this.model.templates,
                    this.model.positionRules
                  ).map((template) => this.template(template))
                : html`<div class="empty-state">尚无航班模板</div>`
            }
          </div>
          ${this.flightNameRepair()}
        </div>
      </section>`;
  }

  private flightNameRepair() {
    const unmatched = currentFlightsWithoutTemplates(
      this.model.templates,
      this.model.flights
    );
    if (!unmatched.length) return null;
    return html`<details
      class="config-collapsible mt-3"
      data-flight-name-repair
    >
      <summary>检查当前航班名称（${unmatched.length} 项未匹配模板）</summary>
      <p>
        这些航班可以是独立添加的航班，可继续保留。如果是改名后遗留的旧名称，请选择正确模板并确认修正。只改名称，保留当天人数、时段、岗位和备注；历史不变。
      </p>
      ${unmatched.map(
        (flight) =>
          html`<label class="form-label d-block">
            ${flight.flightNo} →
            <select
              class="form-select"
              aria-label=${`修正 ${flight.flightNo} 的航班名称`}
              @change=${(event: Event) => {
                const select = event.currentTarget as HTMLSelectElement;
                const templateId = select.value;
                select.value = "";
                if (templateId)
                  dispatchUiCommand(this, {
                    type: "rename-current-flight-to-template",
                    flightId: flight.id,
                    templateId,
                  });
              }}
            >
              <option value="">选择正确的模板航班号</option>
              ${this.model.templates.map((template) => html`<option value=${template.id}>${template.flightNo}</option>`)}
            </select>
          </label>`
      )}
    </details>`;
  }

  private setting(
    field: string,
    value: string | number,
    label: string,
    options: { type?: string; min?: number; max?: number; step?: number }
  ) {
    return html`<label class="form-label"
      >${label}${configurationInput(this, "settings", "", field, value, label, {
        type: options.type ?? "number",
        ...options,
      })}</label
    >`;
  }

  private template(template: FlightTemplate) {
    return html`<div class="template-row">
      ${configurationInput(this, "template", template.id, "flightNo", template.flightNo, "模板航班号", { className: "code-input" })}
      <div class="time-range">
        ${configurationInput(this, "template", template.id, "startTime", template.startTime, "模板开始时间", { type: "time" })}
        <span>至</span>
        ${configurationInput(this, "template", template.id, "endTime", template.endTime, "模板结束时间", { type: "time" })}
      </div>
      <div class="template-positions" aria-label="模板岗位">
        ${template.positions.length ? template.positions.join("、") : "尚未配置岗位"}
      </div>
      ${configurationInput(this, "template", template.id, "remark", template.remark, "模板备注")}
      <button
        class="btn btn-sm btn-outline-danger icon-btn"
        type="button"
        title="删除模板"
        aria-label="删除模板"
        @click=${() => dispatchUiCommand(this, { type: "delete-template", id: template.id })}
      >
        <i class="bi bi-trash3"></i>
      </button>
    </div>`;
  }
}

customElements.define(
  "autoschedule-configuration-settings",
  ConfigurationSettingsSectionElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-configuration-settings": ConfigurationSettingsSectionElement;
  }
}
