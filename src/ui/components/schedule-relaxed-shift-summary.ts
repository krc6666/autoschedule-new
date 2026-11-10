import { html } from "lit";

import { buildMonthlyRelaxedShiftStatistics } from "../../domain/statistics/relaxed-shift-statistics";
import type { AppState } from "../../model";
import { LightDomElement } from "./light-dom-element";

export class ScheduleRelaxedShiftSummaryElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
  };
  model!: AppState;
  date = "";

  protected override render() {
    const statistics = buildMonthlyRelaxedShiftStatistics(
      this.model,
      this.date
    );
    return html`<aside
      class="schedule-relaxed-shift-summary"
      aria-label="当日轻松班次"
    >
      <div class="schedule-relaxed-shift-head">
        <div>
          <h3>当日轻松班次</h3>
          <span>${this.date}</span>
        </div>
        <i class="bi bi-clock-history"></i>
      </div>
      <div class="schedule-relaxed-shift-lists">
        <section aria-labelledby="schedule-early-departure-title">
          <h4 id="schedule-early-departure-title">
            <i class="bi bi-box-arrow-right"></i>提前下班人员
          </h4>
          <div class="schedule-relaxed-shift-list">
            ${
              statistics.currentEarlyDepartures.length
                ? statistics.currentEarlyDepartures.map(
                    (item) =>
                      html`<div class="schedule-relaxed-shift-person">
                        <span>
                          <strong>${item.staffName}</strong>
                          <small>${item.flightNo} / ${item.cutoffTime}</small>
                        </span>
                        <em>本月 ${item.monthlyCount} 次</em>
                      </div>`
                  )
                : html`<p class="schedule-relaxed-shift-empty">今日暂无</p>`
            }
          </div>
        </section>
        <section aria-labelledby="schedule-afternoon-rest-title">
          <h4 id="schedule-afternoon-rest-title">
            <i class="bi bi-sun"></i>下午无航班人员
          </h4>
          <p class="small text-muted">
            ${this.model.settings.afternoonRestStartTime}—${this.model.settings.afternoonRestEndTime}，当天有航班且个人无岗位重叠才计次
          </p>
          <div class="schedule-relaxed-shift-list">
            ${
              statistics.currentAfternoonRest.length
                ? statistics.currentAfternoonRest.map(
                    (item) =>
                      html`<div class="schedule-relaxed-shift-person">
                        <strong>${item.staffName}</strong>
                        <em>本月 ${item.monthlyCount} 次</em>
                      </div>`
                  )
                : html`<p class="schedule-relaxed-shift-empty">今日暂无</p>`
            }
          </div>
        </section>
      </div>
    </aside>`;
  }
}

customElements.define(
  "autoschedule-schedule-relaxed-shift-summary",
  ScheduleRelaxedShiftSummaryElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-schedule-relaxed-shift-summary": ScheduleRelaxedShiftSummaryElement;
  }
}
