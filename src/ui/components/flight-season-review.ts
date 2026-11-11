import { html } from "lit";
import type { AppState, FlightTemplate } from "../../model";
import {
  flightPlanReview,
  type FlightPlanReviewChoice,
  type FlightPlanTemplateReviewChoice,
} from "../../domain/flights/flight-plan-review";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import { flightSeasonSyncPreview } from "../../domain/flights/flight-season-sync";

export class FlightSeasonReviewElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    choices: { state: true },
  };
  model!: AppState;
  private choices: Record<string, string> = {};

  private choice(
    template: FlightTemplate,
    patch: Pick<FlightPlanTemplateReviewChoice, "action"> &
      Partial<FlightPlanTemplateReviewChoice>
  ): FlightPlanTemplateReviewChoice {
    return {
      templateId: template.id,
      expectedFlightNo: template.flightNo,
      expectedStartTime: template.startTime,
      expectedEndTime: template.endTime,
      expectedSourceFlightNos: flightPlanReview(this.model).sourceFlightNos,
      ...patch,
    };
  }

  private confirm(choice: FlightPlanReviewChoice) {
    this.choices = {};
    dispatchUiCommand(this, {
      type: "confirm-flight-plan-review",
      groupId: this.model.activeGroupId,
      choice,
    });
  }

  protected override render() {
    const reviews = (["B"] as const).map((id) =>
      flightPlanReview(this.model, id)
    );
    const sync = flightSeasonSyncPreview(this.model);
    if (
      !reviews.some((r) => r.count) &&
      !(this.model.activeGroupId === "B" && sync.count)
    )
      return null;
    const review = reviews[0]!;
    const syncDisabledReason =
      sync.error || (!sync.count ? "B组已与A组一致，无需更新" : "");
    return html`<aside
      class="alert alert-warning"
      data-flight-season-review
      role="status"
    >
      <strong>航班核对</strong
      >：本季航班固定以A组为准，B组跟随更新；各组岗位性质和人员资质仍独立，备用模板继续保留。两组一致且B组岗位已配齐后，此提醒自动消失。
      <div class="d-flex gap-2 mt-2">
        ${
          this.model.activeGroupId === "B"
            ? html`<button
                class="btn btn-sm btn-primary"
                type="button"
                data-sync-b-season
                title=${syncDisabledReason || "查看B组按A组更新的具体变化"}
                ?disabled=${Boolean(sync.error) || !sync.count}
                @click=${() => dispatchUiCommand(this, { type: "sync-b-flight-season", fingerprint: sync.fingerprint })}
              >
                ${!sync.error && !sync.count ? "B组已与A组一致，无需更新" : "B组本季航班按A组更新"}
              </button>`
            : ""
        }
        ${reviews.filter((r) => r.count).map((r) => html`<button class="btn btn-sm btn-outline-dark" type="button" @click=${() => dispatchUiCommand(this, { type: "switch-group", groupId: r.groupId })}>以 ${r.sourceGroupId} 组为准，核对 ${r.groupId} 组（${r.count} 项）</button>`)}
      </div>
      ${this.model.activeGroupId === "B" ? html`<p class="small mt-2 mb-0">${syncDisabledReason || `将新增/启用：${sync.additions.join("、") || "无"}；暂不使用：${sync.retirements.join("、") || "无"}。B组岗位性质、资质及历史保留。`}${sync.missingPositions.length ? ` 待配置B组岗位及资质：${sync.missingPositions.join("、")}` : ""}</p>` : ""}
      ${
        review.count && this.model.activeGroupId === "B"
          ? html`<details class="mt-2">
              <summary>
                按 ${review.sourceGroupId} 组本季名单核对当前 ${review.groupId}
                组（确认前保留原数据）
              </summary>
              ${review.unmatchedFlightNos.length ? html`<p class="mt-2">本组比 ${review.sourceGroupId} 组本季名单多出：${review.unmatchedFlightNos.join("、")}。请确认是换号还是退出本季；不会自动删除。</p>` : ""}
              ${review.unmatchedFlightNos.map((no) => html`<div class="d-flex flex-wrap align-items-center gap-2 mt-2"><strong>${no}</strong><button class="btn btn-sm btn-outline-danger" type="button" data-retire-flight=${no} @click=${() => this.confirm({ action: "retire-flight", previousFlightNo: no, expectedSourceFlightNos: review.sourceFlightNos })}>旧航班已停用，删除本组</button><span class="small">模板库继续保留；换号请在下方新航班中选择对应旧号。</span></div>`)}
              ${review.missingPositions.map(({ template }) => {
                const missing = review.missingPositions.find(
                  (r) => r.template.id === template.id
                );
                if (!missing && !review.unmatchedFlightNos.length) return null;
                const key = `${review.groupId}:${template.flightNo}:${template.startTime}:${template.endTime}`;
                const selected = this.choices[key] ?? "";
                return html`<div class="border rounded p-2 mt-2">
                  <strong>${template.flightNo}</strong>
                  ${template.startTime}–${template.endTime}
                  ${missing ? html`<span> · ${missing.confirmedNew ? "已确认为新增，待配置本组岗位与资质" : "本组尚未配置岗位，请确认航班来源"}</span>` : ""}
                  <div class="d-flex flex-wrap gap-2 mt-1">
                    <select
                      class="form-select form-select-sm w-auto"
                      aria-label=${`${template.flightNo} 航班来源`}
                      .value=${selected}
                      @change=${(event: Event) => {
                        this.choices = {
                          ...this.choices,
                          [key]: (event.currentTarget as HTMLSelectElement)
                            .value,
                        };
                      }}
                    >
                      <option value="">请选择新增或旧航班换号</option>
                      ${missing && !missing.confirmedNew ? html`<option value="new">这是新增航班</option>` : ""}
                      ${review.unmatchedFlightNos.map((no) => html`<option value=${`rename:${no}`}>旧航班 ${no} 换成此航班号</option>`)}
                    </select>
                    <button
                      class="btn btn-sm btn-primary"
                      type="button"
                      ?disabled=${!selected}
                      @click=${() => {
                        if (selected === "new")
                          this.confirm(
                            this.choice(template, { action: "new-flight" })
                          );
                        else if (selected.startsWith("rename:"))
                          this.confirm(
                            this.choice(template, {
                              action: "rename",
                              previousFlightNo: selected.slice(7),
                            })
                          );
                      }}
                    >
                      确认航班来源
                    </button>
                  </div>
                </div>`;
              })}
              ${review.timeDifferences.map(({ flight, template }) => {
                const base = {
                  flightId: flight.id,
                  expectedCurrentStartTime: flight.startTime,
                  expectedCurrentEndTime: flight.endTime,
                };
                return html`<div class="border rounded p-2 mt-2">
                  <strong>${flight.flightNo}</strong> 本组当天
                  ${flight.startTime}–${flight.endTime}；共用模板
                  ${template.startTime}–${template.endTime}。也可能是当天临时调整，请自行确认。
                  <div class="d-flex flex-wrap gap-2 mt-1">
                    <button
                      class="btn btn-sm btn-primary"
                      type="button"
                      @click=${() => this.confirm(this.choice(template, { ...base, action: "use-template-time" }))}
                    >
                      按模板更新时间</button
                    ><button
                      class="btn btn-sm btn-outline-dark"
                      type="button"
                      @click=${() => this.confirm(this.choice(template, { ...base, action: "keep-current-time" }))}
                    >
                      保留本组当天时间
                    </button>
                  </div>
                </div>`;
              })}
              <p class="small mt-2 mb-0">
                新增确认后请配置本组岗位，配好前持续提醒。换号保留本组岗位资质并更新相关规则与时段；退出本季只清理本组。历史、次数记录、另一组和备用模板不因退出本季被删除。
              </p>
            </details>`
          : ""
      }
    </aside>`;
  }
}
customElements.define(
  "autoschedule-flight-season-review",
  FlightSeasonReviewElement
);
