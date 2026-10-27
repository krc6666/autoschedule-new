import { html } from "lit";

import {
  ISO_WEEKDAYS,
  normalizeWeeklyFlightNo,
  weekdayLabel,
} from "../../domain/flights/weekly-flight-plan";
import type { AppState, IsoWeekday } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

export class WeeklyFlightPlanSectionElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    selectedWeekday: { state: true },
  };
  model!: AppState;
  private selectedWeekday: IsoWeekday = 1;

  protected override render() {
    const selected = new Set(
      this.model.weeklyFlightPlans
        .find((entry) => entry.weekday === this.selectedWeekday)
        ?.flightNos.map(normalizeWeeklyFlightNo) ?? []
    );
    return html`<section class="workspace-section weekly-flight-plan-section">
      <div class="section-heading weekly-flight-plan-heading">
        <div>
          <h3>每周航班计划（A、B 共用）</h3>
          <span
            >${weekdayLabel(this.selectedWeekday)} · ${selected.size}
            个航班</span
          >
        </div>
      </div>
      <div
        class="btn-group weekly-flight-weekdays"
        role="group"
        aria-label="选择星期"
      >
        ${ISO_WEEKDAYS.map(
          (weekday) =>
            html`<button
              class=${`btn btn-sm ${weekday === this.selectedWeekday ? "btn-primary" : "btn-outline-secondary"}`}
              type="button"
              data-weekday=${weekday}
              aria-pressed=${weekday === this.selectedWeekday ? "true" : "false"}
              @click=${() => (this.selectedWeekday = weekday)}
            >
              ${weekdayLabel(weekday).replace("星期", "周")}
            </button>`
        )}
      </div>
      ${
        this.model.templates.length
          ? html`<div class="weekly-flight-template-list">
              ${this.model.templates.map((template) => {
                const flightNo = normalizeWeeklyFlightNo(template.flightNo);
                return html`<label class="weekly-flight-template-row">
                  <input
                    class="form-check-input"
                    type="checkbox"
                    aria-label=${`${weekdayLabel(this.selectedWeekday)} ${flightNo}`}
                    .checked=${selected.has(flightNo)}
                    @change=${(event: Event) =>
                    dispatchUiCommand(this, {
                      type: "set-weekly-flight-template",
                      weekday: this.selectedWeekday,
                      flightNo,
                      selected: (event.currentTarget as HTMLInputElement)
                        .checked,
                    })}
                  />
                  <strong>${flightNo}</strong>
                  <span>${template.startTime}-${template.endTime}</span>
                  <span>${template.positions.length} 岗</span>
                </label>`;
              })}
            </div>`
          : html`<div class="empty-state">尚无航班模板</div>`
      }
    </section>`;
  }
}

customElements.define(
  "autoschedule-weekly-flight-plan",
  WeeklyFlightPlanSectionElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-weekly-flight-plan": WeeklyFlightPlanSectionElement;
  }
}
