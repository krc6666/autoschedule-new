import { html } from "lit";

import type { ScheduleFeedbackItem } from "../../domain/feedback/schedule-feedback-model";
import type { AppState } from "../../model";
import type { SchedulePageModel } from "../projections/schedule-page-model";
import { LightDomElement } from "./light-dom-element";

export class ScheduleFeedbackElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    view: { attribute: false },
    date: { type: String },
  };
  model!: AppState;
  view!: SchedulePageModel;
  date = "";

  protected override render() {
    return html`<section class="workspace-section schedule-feedback">
      <div class="section-heading">
        <div>
          <h3>排班反馈</h3>
          <span>${this.date} · 自动核对当前结果、负荷和规则执行</span>
        </div>
      </div>
      ${this.group("flight-staff", "一、航班安排反馈（航班与人员安排）", "航班密度、人员覆盖、工时与航班衔接")}
      ${this.group("rule-execution", "二、规则执行反馈（规则执行情况）", "逐条标明已执行、需复核或暂无历史基准")}
    </section>`;
  }

  private group(
    group: ScheduleFeedbackItem["group"],
    title: string,
    description: string
  ) {
    const items = this.view.feedback.filter((item) => item.group === group);
    const content =
      group === "rule-execution" && this.model.schedulePolicyStale
        ? html`<div class="schedule-feedback-item is-attention">
            <i class="bi bi-exclamation-triangle-fill"></i
            ><strong
              >规则已更新<em class="feedback-status is-attention"
                >待重新排班</em
              ></strong
            ><span
              >当前排班尚未按新规则重新生成；请重新排班后查看规则执行反馈。</span
            >
          </div>`
        : items.map((item) => this.item(item));
    return html`<div class="schedule-feedback-group">
      <div class="schedule-feedback-group-heading">
        <strong>${title}</strong><span>${description}</span>
      </div>
      <div class="schedule-feedback-list">${content}</div>
    </div>`;
  }

  private item(item: ScheduleFeedbackItem) {
    const icon =
      item.level === "ok"
        ? "check-circle-fill"
        : item.level === "attention"
          ? "exclamation-triangle-fill"
          : "info-circle-fill";
    return html`<div class="schedule-feedback-item is-${item.level}">
      <i class="bi bi-${icon}"></i>
      <strong
        >${item.label}<em class="feedback-status is-${item.level}"
          >${item.status}</em
        ></strong
      >
      <span
        >${item.text}${
          item.level === "attention"
            ? html`<details>
                <summary>查看具体原因</summary>
                <div style="white-space: pre-line">${item.evidence}</div>
              </details>`
            : null
        }</span
      >
    </div>`;
  }
}

customElements.define(
  "autoschedule-schedule-feedback",
  ScheduleFeedbackElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-schedule-feedback": ScheduleFeedbackElement;
  }
}
