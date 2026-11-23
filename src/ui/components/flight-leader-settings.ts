import { html, nothing } from "lit";
import type { AppState } from "../../model";
import { flightIdentityLabel } from "../../domain/flights/flight-identities";
import { normalizeWeeklyFlightNo } from "../../domain/flights/weekly-flight-plan";
import { flightLeaderMinimum } from "../../domain/rules/flight-leader-coverage";
import { dispatchUiCommand } from "../events/ui-command";
import { matchesFlightPolicySearch } from "../projections/policy-search";
import { LightDomElement } from "./light-dom-element";

export class FlightLeaderSettingsElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
  };
  model!: AppState;
  query = "";

  protected override render() {
    const settings = this.model.settings;
    const rows = settings.flightLeaderRequirements ?? [];
    const flights = [
      ...new Set(
        [
          ...this.model.positionRules.map((row) => row.flightNo),
          ...this.model.templates.map((row) => row.flightNo),
          ...this.model.flights.map((row) => row.flightNo),
          ...rows.map((row) => row.flightNo),
        ].map(normalizeWeeklyFlightNo)
      ),
    ].filter(Boolean);
    if (
      !matchesFlightPolicySearch(
        this.model,
        this.query,
        "航班负责人保障",
        "默认负责人人数",
        flights
      )
    )
      return nothing;
    return html`<section data-flight-leader-settings>
      <h4>航班负责人保障</h4>
      <p class="small text-secondary">
        未单独设置的航班使用默认人数（初始1名）。现有规则优先；不足只提示，允许保存和归档。修改后点击上方“保存规则”，再重新排班。
      </p>
      <label class="form-check form-switch mb-3"
        ><input
          class="form-check-input"
          type="checkbox"
          data-policy-setting="flightLeaderCoverageEnabled"
          .checked=${settings.flightLeaderCoverageEnabled}
          @change=${(event: Event) => dispatchUiCommand(this, { type: "edit-policy-input", input: { flightLeaderCoverageEnabled: (event.currentTarget as HTMLInputElement).checked } })}
        />启用航班负责人保障</label
      >
      <label class="form-label"
        >默认负责人人数<input
          class="form-control"
          type="number"
          min="1"
          max="100"
          step="1"
          data-policy-setting="minimumFlightLeaders"
          .value=${String(settings.minimumFlightLeaders)}
          @input=${(event: Event) => dispatchUiCommand(this, { type: "edit-policy-input", input: { minimumFlightLeaders: Number((event.currentTarget as HTMLInputElement).value) } })}
      /></label>
      <div class="table-responsive">
        <table class="table align-middle">
          <thead>
            <tr>
              <th>航班</th>
              <th>单独人数</th>
              <th>当前要求</th>
            </tr>
          </thead>
          <tbody>
            ${flights.map((flightNo) => {
              const row = rows.find((row) => row.flightNo === flightNo);
              return html`<tr>
                <td>${flightIdentityLabel(this.model, flightNo)}</td>
                <td>
                  <input
                    class="form-control"
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    placeholder="使用默认"
                    aria-label=${`${flightNo}负责人人数`}
                    data-flight-leader-flight=${flightNo}
                    .value=${row ? String(row.minimum) : ""}
                    @input=${(event: Event) => {
                      const value = (event.currentTarget as HTMLInputElement)
                        .value;
                      dispatchUiCommand(this, {
                        type: "edit-policy-input",
                        input: {
                          flightLeaderRequirements: [
                            ...rows.filter(
                              (item) => item.flightNo !== flightNo
                            ),
                            ...(value.trim()
                              ? [{ flightNo, minimum: Number(value) }]
                              : []),
                          ],
                        },
                      });
                    }}
                  />
                </td>
                <td>
                  ${flightLeaderMinimum(this.model, flightNo)}名${row ? "（单独设置）" : "（默认或档案共用）"}
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </section>`;
  }
}
customElements.define(
  "autoschedule-flight-leader-settings",
  FlightLeaderSettingsElement
);
