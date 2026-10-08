import { html } from "lit";

import type { AppState } from "../../model";
import { LightDomElement } from "./light-dom-element";
import "./configuration-settings-section";
import "./position-rules-section";
import "./staff-config-section";

export class ConfigPageElement extends LightDomElement {
  static override properties = { model: { attribute: false } };
  model!: AppState;

  protected override render() {
    return html`
      <autoschedule-staff-config
        .model=${this.model}
      ></autoschedule-staff-config>
      <autoschedule-position-rules
        .model=${this.model}
      ></autoschedule-position-rules>
      <autoschedule-configuration-settings
        .model=${this.model}
      ></autoschedule-configuration-settings>
    `;
  }
}

customElements.define("autoschedule-config-page", ConfigPageElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-config-page": ConfigPageElement;
  }
}
