import { html } from "lit";
import {
  configuredSeasonTemplates,
  withConfiguredFlightPositions,
} from "../../domain/flights/configured-flight-positions";

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
    const season = configuredSeasonTemplates(
      this.model.templates,
      this.model.positionRules,
      this.model.flights,
      this.model.flightSeasonOverrides
    );
    const seasonNos = new Set(
      season.map((r) => normalizeWeeklyFlightNo(r.flightNo))
    );
    const selected = new Set(
      this.model.weeklyFlightPlans
        .find((entry) => entry.weekday === this.selectedWeekday)
        ?.flightNos.map(normalizeWeeklyFlightNo)
        .filter((no) => seasonNos.has(no)) ?? []
    );
    return html`<section class="workspace-section weekly-flight-plan-section">
      <div class="section-heading weekly-flight-plan-heading">
        <div>
          <h3>每周航班计划（A、B 共用）</h3>
          <span
            >${weekdayLabel(this.selectedWeekday)} · ${selected.size}
            个航班</span
          >
          <span>只列当前组岗位配置中的本季航班，备用航班保留在模板库。</span>
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
        season.length
          ? html`<div class="weekly-flight-template-list">
              ${withConfiguredFlightPositions(
                season,
                this.model.positionRules
              ).map((template) => {
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
          : html`<div class="empty-state">
              当前组尚无本季航班，请先配置岗位
            </div>`
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
