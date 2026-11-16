import { html } from "lit";

import type { AppState } from "../../model";
import type { PolicyEditingView } from "../../app/policy-editing-session";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import "./policy-rule-ledger";
import "./policy-settings-form";
import "./policy-structured-rules";
import "./team-leader-gap-fill-protection-settings";

export class PolicyPageElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
    editing: { attribute: false },
  };
  model!: AppState;
  query = "";
  editing?: PolicyEditingView;

  protected override render() {
    return html`<section class="workspace-section policy-workspace">
      <div class="section-heading">
        <div>
          <h3>排班规则</h3>
          <span>修改先保留为草稿，点击“保存规则”后统一生效</span>
        </div>
        <div class="policy-search">
          <i class="bi bi-search"></i
          ><input
            class="form-control form-control-sm"
            type="search"
            placeholder="搜索规则名称、说明、参数或配置内容"
            .value=${this.query}
            @input=${(event: Event) => {
              this.query = (event.currentTarget as HTMLInputElement).value;
              this.requestUpdate();
            }}
          />
        </div>
      </div>
      <div
        class="policy-save-bar d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3 p-3 border rounded bg-body"
        aria-label="规则统一保存"
      >
        <span role="status"
          >${this.editing?.dirty ? "规则有未保存的修改" : "规则无未保存修改"}</span
        >
        <div class="d-flex gap-2">
          <button
            type="button"
            class="btn btn-outline-secondary"
            ?disabled=${!this.editing?.dirty}
            @click=${() => dispatchUiCommand(this, { type: "discard-policy" })}
          >
            放弃修改
          </button>
          <button
            type="button"
            class="btn btn-primary"
            ?disabled=${!this.editing?.dirty}
            @click=${() => dispatchUiCommand(this, { type: "save-policy" })}
          >
            <i class="bi bi-check2-circle me-2"></i>保存规则
          </button>
        </div>
        <small class="text-secondary w-100"
          >保存后请重新排班。云端版还需点击顶部“保存到云端”上传。</small
        >
      </div>
      <autoschedule-policy-settings
        .model=${this.model}
        .query=${this.query}
      ></autoschedule-policy-settings>
      <autoschedule-team-leader-gap-fill-protection-settings
        .model=${this.model}
        .query=${this.query}
      ></autoschedule-team-leader-gap-fill-protection-settings>
      <autoschedule-policy-structured-rules
        .model=${this.model}
        .query=${this.query}
        .editing=${this.editing}
      ></autoschedule-policy-structured-rules>
      <autoschedule-policy-rule-ledger
        .model=${this.model}
        .query=${this.query}
      ></autoschedule-policy-rule-ledger>
    </section>`;
  }
}

customElements.define("autoschedule-policy-page", PolicyPageElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-policy-page": PolicyPageElement;
  }
}
