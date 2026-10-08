import { html } from "lit";

import type { AppState } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import "./weekly-flight-plan-section";

export class FlightsPageElement extends LightDomElement {
  static override properties = { model: { attribute: false } };
  model!: AppState;

  protected override render() {
    return html`
      <section class="workspace-section flights-query-section">
        <div class="d-flex justify-content-end">
          ${this.actionButton(
            "cloud-download",
            "在线查询航班",
            "open-flight-query",
            "btn-outline-primary"
          )}
        </div>
      </section>
      <autoschedule-weekly-flight-plan
        .model=${this.model}
      ></autoschedule-weekly-flight-plan>
    `;
  }

  private actionButton(
    icon: string,
    label: string,
    type: "open-flight-query",
    style: string
  ) {
    return html`<button
      class="btn ${style}"
      type="button"
      @click=${() => dispatchUiCommand(this, { type })}
    >
      <i class="bi bi-${icon} me-2"></i>${label}
    </button>`;
  }
}

customElements.define("autoschedule-flights-page", FlightsPageElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-flights-page": FlightsPageElement;
  }
}
