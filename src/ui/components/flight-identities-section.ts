import { html } from "lit";
import type { AppState, FlightIdentity } from "../../model";
import { createId } from "../../utils";
import {
  flightIdentityChangeFingerprint,
  previewFlightIdentityChange,
} from "../../domain/flights/flight-identity-change";
import { groupFlightReferenceNumbers } from "../../domain/flights/group-flight-references";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

export class FlightIdentitiesSectionElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    editing: { attribute: false },
  };
  model!: AppState;
  editing?: import("../../app/flight-identity-editing-session").FlightIdentityEditingView;

  private change(edit: (rows: FlightIdentity[]) => void) {
    const rows = structuredClone(
      this.editing?.identities ?? this.model.shared.flightIdentities ?? []
    );
    edit(rows);
    dispatchUiCommand(this, {
      type: "edit-flight-identities",
      identities: rows,
    });
  }
  protected override render() {
    const rows =
      this.editing?.identities ?? this.model.shared.flightIdentities ?? [];
    const known = [
      ...new Set([
        ...this.model.templates.map((f) => f.flightNo),
        ...["A", "B"].flatMap((id) => {
          const g =
            id === this.model.activeGroupId
              ? this.model
              : this.model.groups[id as "A" | "B"];
          return [
            ...g.flights.map((f) => f.flightNo),
            ...g.history.map((h) => h.flightNo),
            ...groupFlightReferenceNumbers(g.positionRules, g.settings),
          ];
        }),
      ]),
    ].filter((no) => no && no !== "轮值" && !no.startsWith("@"));
    const preview = this.editing?.dirty
      ? previewFlightIdentityChange(this.model, rows)
      : null;
    return html`<section
      class="workspace-section flight-identities-section"
      aria-label="航班长期档案"
    >
      <div class="section-heading">
        <div>
          <h3>航班长期档案（A、B共用）</h3>
          <p>
            把新旧名称放在同一档案，规则自动共用、统计合为一列。早晚两班仍分别排班；历史原名和时间保留。未关联名称继续独立计算。
          </p>
        </div>
        <button
          class="btn btn-outline-primary"
          @click=${() => this.change((items) => items.push({ id: createId("flight"), displayName: "", aliases: [] }))}
        >
          新建航班档案
        </button>
      </div>
      ${
        rows.length
          ? rows.map(
              (identity, index) =>
                html`<details class="policy-card" open>
                  <summary>
                    ${identity.displayName || "新航班档案"} ·
                    ${identity.aliases.length}个名称
                  </summary>
                  <label class="form-label"
                    >统计统一名称<input
                      class="form-control"
                      aria-label="航班档案统一名称"
                      .value=${identity.displayName}
                      @input=${(e: Event) =>
                        this.change((items) => {
                          items[index]!.displayName = (
                            e.target as HTMLInputElement
                          ).value;
                        })}
                  /></label>
                  <div class="table-responsive">
                    <table class="table flight-identity-alias-table">
                      <thead>
                        <tr>
                          <th>原名称 / 新航班号</th>
                          <th>生效日期（可留空）</th>
                          <th>截至日期（可留空）</th>
                          <th>新号沿用岗位版本</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${identity.aliases.map(
                          (alias, aliasIndex) =>
                            html`<tr>
                              <td>
                                <input
                                  class="form-control"
                                  list="flight-identity-known-names"
                                  aria-label="档案航班名称"
                                  .value=${alias.flightNo}
                                  @input=${(e: Event) =>
                                    this.change((items) => {
                                      items[index]!.aliases[
                                        aliasIndex
                                      ]!.flightNo = (
                                        e.target as HTMLInputElement
                                      ).value;
                                    })}
                                />
                              </td>
                              <td>
                                <input
                                  type="date"
                                  class="form-control"
                                  aria-label="名称生效日期"
                                  .value=${alias.from ?? ""}
                                  @change=${(e: Event) =>
                                    this.change((items) => {
                                      const a =
                                        items[index]!.aliases[aliasIndex]!;
                                      a.from =
                                        (e.target as HTMLInputElement).value ||
                                        undefined;
                                    })}
                                />
                              </td>
                              <td>
                                <input
                                  type="date"
                                  class="form-control"
                                  aria-label="名称截至日期"
                                  .value=${alias.until ?? ""}
                                  @change=${(e: Event) =>
                                    this.change((items) => {
                                      const a =
                                        items[index]!.aliases[aliasIndex]!;
                                      a.until =
                                        (e.target as HTMLInputElement).value ||
                                        undefined;
                                    })}
                                />
                              </td>
                              <td>
                                <select
                                  class="form-select"
                                  aria-label="沿用岗位版本"
                                  .value=${alias.positionSourceFlightNo ?? ""}
                                  @change=${(e: Event) =>
                                    this.change((items) => {
                                      items[index]!.aliases[
                                        aliasIndex
                                      ]!.positionSourceFlightNo =
                                        (e.target as HTMLSelectElement).value ||
                                        undefined;
                                    })}
                                >
                                  <option value="">使用该名称自己的岗位</option>
                                  ${identity.aliases.filter((a) => a.flightNo && a.flightNo !== alias.flightNo).map((a) => html`<option value=${a.flightNo}>沿用 ${a.flightNo} 的本组岗位</option>`)}
                                </select>
                              </td>
                              <td>
                                <button
                                  class="btn btn-sm btn-outline-danger"
                                  aria-label="移除航班名称"
                                  @click=${() => this.change((items) => items[index]!.aliases.splice(aliasIndex, 1))}
                                >
                                  移除
                                </button>
                              </td>
                            </tr>`
                        )}
                      </tbody>
                    </table>
                  </div>
                  <button
                    class="btn btn-sm btn-outline-primary"
                    @click=${() => this.change((items) => items[index]!.aliases.push({ flightNo: "" }))}
                  >
                    添加新旧名称
                  </button>
                  <button
                    class="btn btn-sm btn-outline-danger"
                    @click=${() => this.change((items) => items.splice(index, 1))}
                  >
                    移除档案
                  </button>
                </details>`
            )
          : html`<p>尚未关联航班。请只添加你确认属于同一航班的名称。</p>`
      }
      <datalist id="flight-identity-known-names">
        ${known.map((no) => html`<option value=${no}></option>`)}
      </datalist>
      ${
        preview
          ? html`<div role="status">
                ${
                  preview.errors.length
                    ? html`<ul>
                        ${preview.errors.map((e) => html`<li>${e}</li>`)}
                      </ul>`
                    : html`<p>
                        ${preview.groups.map((g) => `${g.groupId}组：${g.affectedRules}处规则关联、${g.historyRecords}条历史归属${g.needsReschedule ? "，已有班表需重排" : ""}`).join("；")}。历史原文不改，旧人工次数按来源保留。
                      </p>`
                }
              </div>
              <button
                class="btn btn-primary"
                ?disabled=${preview.errors.length > 0}
                @click=${() => dispatchUiCommand(this, { type: "save-flight-identities", identities: structuredClone(rows), fingerprint: this.editing?.fingerprint ?? flightIdentityChangeFingerprint(this.model) })}
              >
                确认并保存航班档案
              </button>
              <button
                class="btn btn-outline-secondary"
                @click=${() => dispatchUiCommand(this, { type: "discard-flight-identities" })}
              >
                放弃修改 / 重新载入
              </button>
              ${JSON.stringify(rows) === JSON.stringify(this.model.shared.flightIdentities ?? []) ? html`<span>档案已保存</span>` : html`<span>尚未保存；离开前请确认保存</span>`}`
          : ""
      }
    </section>`;
  }
}
customElements.define(
  "autoschedule-flight-identities",
  FlightIdentitiesSectionElement
);
