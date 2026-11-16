import { html, nothing } from "lit";

import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "../../domain/rules/built-in-rule-registry";
import type { AppState } from "../../model";
import {
  USER_RULE_FLOW,
  USER_SCHEDULING_RULES,
} from "../projections/policy-rule-presentation";
import {
  matchesPolicySearch,
  normalizePolicySearchQuery,
} from "../projections/policy-search";
import { LightDomElement } from "./light-dom-element";

export class PolicyRuleLedgerElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
  };
  model!: AppState;
  query = "";

  protected override render() {
    const flow = USER_RULE_FLOW.map((stage) => stage.label).join(" → ");
    const preferenceById = new Map(
      builtInRulePreferences(this.model.settings).map((item) => [item.id, item])
    );
    const status = (ruleId: (typeof USER_SCHEDULING_RULES)[number]["id"]) =>
      BUILT_IN_RULE_REGISTRY.definition(ruleId)?.configurable
        ? preferenceById.get(ruleId)?.enabled
          ? "已启用"
          : "已停用"
        : "始终执行";
    const rows = USER_SCHEDULING_RULES.filter((rule) =>
      matchesPolicySearch(
        this.query,
        rule.label,
        rule.stage.label,
        rule.stage.summary,
        rule.description,
        status(rule.id)
      )
    );
    if (this.query.trim() && !rows.length) return nothing;
    return html`<details
      class="policy-rule-card policy-ledger"
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span><strong>规则如何执行</strong><small>${flow}</small></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content table-responsive">
        <table class="table align-middle data-table policy-ledger-table">
          <thead>
            <tr>
              <th>顺序</th>
              <th>处理环节</th>
              <th>规则</th>
              <th>当前状态</th>
              <th>生效方式</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (rule, index) =>
                html`<tr>
                  <td>${index + 1}</td>
                  <td>
                    <strong>${rule.stage.label}</strong
                    ><small class="d-block text-secondary"
                      >${rule.stage.summary}</small
                    >
                  </td>
                  <td><strong>${rule.label}</strong></td>
                  <td>${status(rule.id)}</td>
                  <td>${rule.description}</td>
                </tr>`
            )}
          </tbody>
        </table>
      </div>
    </details>`;
  }
}

customElements.define(
  "autoschedule-policy-rule-ledger",
  PolicyRuleLedgerElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-policy-rule-ledger": PolicyRuleLedgerElement;
  }
}
