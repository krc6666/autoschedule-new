import { html, nothing } from "lit";

import type { AppState, PositionRule } from "../../model";
import { teamLeaderGapFillPositionDisposition } from "../../domain/coverage/team-leader-gap-fill-protection";
import { isOrdinaryPriorityPosition } from "../../domain/reviews/position-rotation-policy";
import { dispatchUiCommand } from "../events/ui-command";
import { matchesPolicySearch } from "../projections/policy-search";
import { LightDomElement } from "./light-dom-element";
import { diagnoseGapFillReferences } from "../../domain/rules/policy-configuration-diagnostics";
import { renderPolicyDiagnostics } from "./policy-diagnostic";

const POSITION_CATEGORIES: readonly PositionRule["category"][] = [
  "常规",
  "引导",
  "分流",
  "机动督导",
  "行政支援",
];

const SEARCH_TEXT = [
  "分队长补差岗位保护",
  "允许参与补差换人",
  "固定保护",
  "值班人员当前岗位",
  "KE166",
  "人工岗位",
  "行政支援",
  "已补差落地岗位",
  "督导兼任关联格",
  "特殊布局关联格",
] as const;

export class TeamLeaderGapFillProtectionSettingsElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
  };
  model!: AppState;
  query = "";

  protected override render() {
    if (
      !matchesPolicySearch(
        this.query,
        SEARCH_TEXT,
        this.model.positionRules.flatMap((rule) => [
          rule.flightNo,
          rule.name,
          rule.category,
        ])
      )
    )
      return nothing;

    return html`<details
      class="policy-rule-card team-leader-gap-fill-protection"
      open
    >
      <summary>
        <span
          ><strong>分队长补差岗位保护</strong
          ><small>当前岗位范围与固定保护</small></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        ${renderPolicyDiagnostics(diagnoseGapFillReferences(this.model), "teamLeaderGapFillPositionPolicies")}
        <div class="alert alert-light border py-2 mb-3" role="note">
          <strong>固定保护</strong
          >：值班人员当前岗位、KE166、人工岗位、行政支援、已补差落地岗位、督导兼任关联格和特殊布局关联格。
        </div>
        <div class="team-leader-gap-fill-protection-groups">
          ${POSITION_CATEGORIES.map((category) =>
            this.categoryGroup(
              category,
              this.model.positionRules.filter(
                (rule) => rule.category === category
              )
            )
          )}
        </div>
      </div>
    </details>`;
  }

  private categoryGroup(
    category: PositionRule["category"],
    rules: PositionRule[]
  ) {
    if (!rules.length) return nothing;
    const configurableIds = rules
      .filter(
        (rule) => !teamLeaderGapFillPositionDisposition(this.model, rule).fixed
      )
      .map((rule) => rule.id);
    return html`<details class="team-leader-gap-fill-protection-group">
      <summary>
        <span
          ><strong>${category}</strong
          ><small>${rules.length} 个岗位</small></span
        >
        <span class="btn-group btn-group-sm" role="group">
          <button
            class="btn btn-outline-secondary"
            type="button"
            data-gap-fill-category-protect
            ?disabled=${!configurableIds.length}
            @click=${(event: Event) => {
              event.preventDefault();
              this.setMovable(configurableIds, false);
            }}
          >
            <i class="bi bi-shield-lock me-1"></i>全部保护
          </button>
          <button
            class="btn btn-outline-primary"
            type="button"
            data-gap-fill-category-allow
            ?disabled=${!configurableIds.length}
            @click=${(event: Event) => {
              event.preventDefault();
              this.setMovable(configurableIds, true);
            }}
          >
            <i class="bi bi-unlock me-1"></i>全部允许
          </button>
        </span>
      </summary>
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0">
          <thead>
            <tr>
              <th>航班</th>
              <th>岗位</th>
              <th>当前规则</th>
              <th>补差换人</th>
            </tr>
          </thead>
          <tbody>
            ${rules.map((rule) => this.positionRow(rule))}
          </tbody>
        </table>
      </div>
    </details>`;
  }

  private positionRow(rule: PositionRule) {
    const disposition = teamLeaderGapFillPositionDisposition(this.model, rule);
    const priority = isOrdinaryPriorityPosition(
      rule,
      this.model.settings.ordinaryPriorityPositions
    );
    return html`<tr>
      <td><span class="font-monospace">${rule.flightNo}</span></td>
      <td>${rule.name}</td>
      <td>
        ${priority ? html`<span class="badge text-bg-warning me-1">普通重点</span>` : nothing}
        <span class=${disposition.fixed ? "text-danger" : "text-body-secondary"}
          >${disposition.reason}</span
        >
      </td>
      <td>
        ${
          disposition.fixed
            ? html`<span class="badge text-bg-danger">固定保护</span>`
            : html`<label class="form-check form-switch m-0">
                <input
                  class="form-check-input"
                  type="checkbox"
                  data-gap-fill-position-movable
                  data-position-rule-id=${rule.id}
                  .checked=${disposition.movable}
                  aria-label=${`${rule.flightNo}/${rule.name}允许参与分队长补差换人`}
                  @change=${(event: Event) =>
                    this.setMovable(
                      [rule.id],
                      (event.currentTarget as HTMLInputElement).checked
                    )}
                />
                <span class="form-check-label">允许参与补差换人</span>
              </label>`
        }
      </td>
    </tr>`;
  }

  private setMovable(positionRuleIds: string[], movable: boolean): void {
    dispatchUiCommand(this, {
      type: "set-team-leader-gap-fill-positions-movable",
      positionRuleIds,
      movable,
    });
  }
}

customElements.define(
  "autoschedule-team-leader-gap-fill-protection-settings",
  TeamLeaderGapFillProtectionSettingsElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-team-leader-gap-fill-protection-settings": TeamLeaderGapFillProtectionSettingsElement;
  }
}
