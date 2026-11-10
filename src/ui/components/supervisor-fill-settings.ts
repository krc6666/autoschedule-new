import { html, nothing } from "lit";
import type { AppState } from "../../model";
import type { MobileSupervisorFillRule } from "../../domain/rules/structured-policy-contract";
import {
  fillPositionMatches,
  isSameFlightSupervisorFillRule,
  normalizeFillReference,
} from "../../domain/coverage/supervisor-fill-configuration";
import { diagnoseSupervisorFillRuleConfiguration } from "../../domain/coverage/supervisor-fill-facts";
import { dispatchUiCommand } from "../events/ui-command";
import {
  matchesPolicySearch,
  normalizePolicySearchQuery,
} from "../projections/policy-search";
import { LightDomElement } from "./light-dom-element";
import { dynamicSelectValue } from "./dynamic-select";
import { renderPolicyDiagnostics } from "./policy-diagnostic";

export class SupervisorFillSettingsElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    query: { type: String },
  };
  model!: AppState;
  query = "";
  private draft: MobileSupervisorFillRule | null = null;
  private draftContext = "";

  private contextKey() {
    return JSON.stringify([
      this.model.activeGroupId,
      this.model.templates,
      this.model.positionRules,
      this.model.settings.mobileSupervisorFillRules,
    ]);
  }

  protected override render() {
    // A group/template/position change invalidates an unfinished selection.
    if (this.draft && this.draftContext !== this.contextKey())
      this.draft = null;
    const items = this.model.settings.mobileSupervisorFillRules;
    if (
      !matchesPolicySearch(
        this.query,
        "督导补位关系",
        "人手不足",
        "来源航班",
        "来源岗位",
        "目标航班",
        "目标岗位",
        items.map((item) => [
          item.sourceFlightNo,
          item.sourcePositionKeyword,
          item.targetFlightNo,
          item.targetPositionKeyword,
        ])
      )
    )
      return nothing;
    const issues = items.map((rule) =>
      diagnoseSupervisorFillRuleConfiguration(this.model, rule)
    );
    const pending = issues.filter(
      (issue) => issue?.severity === "warning"
    ).length;
    return html`<details
      class="policy-rule-card"
      data-supervisor-fill
      ?open=${Boolean(normalizePolicySearchQuery(this.query))}
    >
      <summary>
        <span
          ><strong>督导补位关系</strong
          ><small
            >${items.filter((item) => item.enabled && !item.requiresConfirmation && isSameFlightSupervisorFillRule(item)).length}
            条启用 · 需处理 ${pending} 条</small
          ></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="policy-rule-content">
        <p class="small text-secondary">
          只选一个模板航班，再选择该航班的督导岗位和补位岗位。仅在人手不足且没有安全普通候选时生效。
        </p>
        <button
          type="button"
          class="btn btn-sm btn-outline-primary mb-2"
          @click=${() => this.edit()}
        >
          新增补位关系
        </button>
        ${this.draft ? this.editor() : nothing}
        ${items.map(
          (rule, index) =>
            html`<article
              class="border-bottom py-2"
              data-supervisor-fill-id=${rule.id}
            >
              <div>
                ${isSameFlightSupervisorFillRule(rule) ? `${rule.sourceFlightNo}：${rule.sourcePositionKeyword} → ${rule.targetPositionKeyword}` : `待处理：${rule.sourceFlightNo || "待选航班"} / ${rule.sourcePositionKeyword || "待选督导"} → ${rule.targetFlightNo} / ${rule.targetPositionKeyword}`}
              </div>
              <small
                >${rule.requiresConfirmation ? "待确认" : rule.enabled ? "启用" : "停用"}
                · 自动补位${rule.allowAutomatic ? "开启" : "关闭"} ·
                人工补位${rule.allowManual ? "开启" : "关闭"}</small
              >
              <div class="d-flex gap-2 mt-1">
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary"
                  aria-label="编辑补位关系"
                  @click=${() => this.edit(rule)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-outline-danger"
                  aria-label="删除规则项"
                  @click=${() => dispatchUiCommand(this, { type: "delete-policy-item", collection: "supervisor-fill", id: rule.id })}
                >
                  删除
                </button>
              </div>
              ${issues[index] ? renderPolicyDiagnostics([issues[index]!], `mobileSupervisorFillRules:${rule.id}`) : html`<small class="text-secondary">配置有效；实际补位仍需满足缺人、普通人员优先及安全条件。</small>`}
            </article>`
        )}
      </div>
    </details>`;
  }

  private edit(rule?: MobileSupervisorFillRule) {
    this.draft = rule
      ? { ...rule }
      : {
          id: "",
          enabled: true,
          sourceFlightNo: "",
          sourcePositionKeyword: "",
          targetFlightNo: "",
          targetPositionKeyword: "",
          allowAutomatic: true,
          allowManual: true,
        };
    if (rule) {
      for (const side of ["source", "target"] as const) {
        const matches = this.model.positionRules.filter(
          (position) =>
            fillPositionMatches(
              position,
              rule[`${side}FlightNo`],
              rule[`${side}PositionKeyword`]
            ) && position.category === (side === "source" ? "机动督导" : "常规")
        );
        this.draft[`${side}PositionKeyword`] =
          matches.length === 1 ? matches[0]!.name : "";
      }
    }
    if (rule && !isSameFlightSupervisorFillRule(rule)) {
      this.draft.sourceFlightNo = this.draft.targetFlightNo = "";
      this.draft.sourcePositionKeyword = this.draft.targetPositionKeyword = "";
    }
    this.draftContext = this.contextKey();
    this.requestUpdate();
  }

  private flightSelector(draft: MobileSupervisorFillRule) {
    const flights = [
      ...new Set(
        this.model.templates.map((template) =>
          normalizeFillReference(template.flightNo)
        )
      ),
    ];
    return html`<label class="col-md-4 form-label"
      >航班<select
        class="form-select form-select-sm"
        aria-label="航班"
        ${dynamicSelectValue(draft.sourceFlightNo)}
        .value=${draft.sourceFlightNo}
        @change=${(event: Event) => {
          draft.sourceFlightNo = draft.targetFlightNo = (
            event.currentTarget as HTMLSelectElement
          ).value;
          draft.sourcePositionKeyword = draft.targetPositionKeyword = "";
          this.requestUpdate();
        }}
      >
        <option value="">请选择模板航班</option>
        ${draft.sourceFlightNo && !flights.includes(draft.sourceFlightNo) ? html`<option value=${draft.sourceFlightNo} disabled>${draft.sourceFlightNo}（模板已不存在）</option>` : nothing}
        ${flights.map((flightNo) => html`<option value=${flightNo}>${flightNo}</option>`)}
      </select></label
    >`;
  }

  private editor() {
    const draft = this.draft!;
    return html`<section
      class="border rounded p-3 mb-3"
      aria-label="编辑督导补位关系"
    >
      <div class="row g-2">
        ${this.flightSelector(draft)}
        ${(["source", "target"] as const).map((side) => {
          const label = side === "source" ? "督导岗位" : "补位岗位";
          const field = `${side}PositionKeyword` as const;
          const positions = this.model.positionRules.filter(
            (position) =>
              normalizeFillReference(position.flightNo) ===
                normalizeFillReference(draft.sourceFlightNo) &&
              position.category === (side === "source" ? "机动督导" : "常规")
          );
          return html`<label class="col-md-4 form-label"
            >${label}<select
              class="form-select form-select-sm"
              aria-label=${label}
              ${dynamicSelectValue(draft[field])}
              .value=${draft[field]}
              @change=${(event: Event) => {
                draft[field] = (event.currentTarget as HTMLSelectElement).value;
                this.requestUpdate();
              }}
            >
              <option value="">请选择${label}</option>
              ${positions.map((position) => html`<option value=${position.name}>${position.name}</option>`)}
            </select></label
          >`;
        })}
      </div>
      <div class="d-flex flex-wrap gap-3 my-2">
        ${(
          [
            ["enabled", "启用"],
            ["allowAutomatic", "自动补位"],
            ["allowManual", "人工补位"],
          ] as const
        ).map(
          ([field, label]) =>
            html`<label class="form-check"
              ><input
                type="checkbox"
                class="form-check-input"
                aria-label=${label}
                .checked=${draft[field]}
                @change=${(event: Event) => {
                  draft[field] = (
                    event.currentTarget as HTMLInputElement
                  ).checked;
                }}
              />${label}</label
            >`
        )}
      </div>
      <button
        type="button"
        class="btn btn-sm btn-primary me-2"
        @click=${() => dispatchUiCommand(this, { type: "save-supervisor-fill", rule: { ...draft } })}
      >
        保存补位关系
      </button>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        @click=${() => {
          this.draft = null;
          this.requestUpdate();
        }}
      >
        取消
      </button>
    </section>`;
  }
}
customElements.define(
  "autoschedule-supervisor-fill-settings",
  SupervisorFillSettingsElement
);
