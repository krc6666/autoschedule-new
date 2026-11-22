import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";

import type { HistoryRecord } from "../../model";
import type { ArchivedScheduleDayView } from "../projections/archived-schedule-view";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

export class ArchivedScheduleBoardElement extends LightDomElement {
  static override properties = {
    view: { attribute: false },
    allowDelete: { type: Boolean },
  };
  view!: ArchivedScheduleDayView;
  allowDelete = false;

  protected override render() {
    const groups = this.view.groups;
    const styles = {
      "--flight-count": String(Math.max(1, groups.length)),
      "--schedule-column-width": "64px",
      "--schedule-person-column-width": "64px",
      "--schedule-flight-width": "128px",
      "--schedule-header-height": "50px",
      "--schedule-cell-height": "40px",
      "--schedule-flight-size": "14px",
      "--schedule-position-size": "11px",
      "--schedule-small-size": "10px",
      "--schedule-tiny-size": "9px",
    };
    return html`<div class="history-schedule-board">
      ${this.view.flightLeaderWarnings === undefined ? html`<p class="small text-muted" data-flight-leader-unrecorded>负责人保障：当时未设置或未记录，不按当前配置推算。</p>` : null}
      ${(this.view.flightLeaderWarnings ?? []).map((warning) => html`<p class="alert alert-warning py-2" data-flight-leader-warning>${warning}</p>`)}
      <table
        class="schedule-grid-table history-schedule-grid"
        style=${styleMap(styles)}
      >
        <colgroup>
          ${groups.flatMap(() => [html`<col class="schedule-position-column" />`, html`<col class="schedule-person-column" />`])}
        </colgroup>
        <thead>
          <tr>
            ${groups.map(
              (group) =>
                html`<th scope="col" colspan="2">
                  <div class="schedule-flight-head">
                    <div>
                      <strong>${group.flightNo}</strong
                      ><span
                        >${group.startTime && group.endTime ? `${group.startTime}–${group.endTime}` : "未记录时段"}</span
                      >
                    </div>
                  </div>
                </th>`
            )}
          </tr>
          <tr class="schedule-subhead-row">
            ${groups.flatMap(() => [html`<th scope="col" class="schedule-subhead-position">岗位</th>`, html`<th scope="col" class="schedule-subhead-person">人员</th>`])}
          </tr>
        </thead>
        <tbody>
          ${Array.from(
            { length: this.view.rowCount },
            (_, rowIndex) =>
              html`<tr>
                ${groups.map((group) => this.recordCells(group.records[rowIndex]))}
              </tr>`
          )}
        </tbody>
      </table>
    </div>`;
  }

  private recordCells(record?: HistoryRecord) {
    if (!record)
      return [
        html`<td class="schedule-grid-slot schedule-position-slot">
          <div class="schedule-cell history-empty-cell"></div>
        </td>`,
        html`<td class="schedule-grid-slot schedule-person-slot">
          <div class="schedule-cell history-empty-cell"></div>
        </td>`,
      ];
    return [
      html`<td class="schedule-grid-slot schedule-position-slot">
        <article class="schedule-cell schedule-position-cell is-assigned">
          <div class="schedule-position-content">
            <strong class="schedule-position" title=${record.position}
              >${record.position}</strong
            >${record.remark ? html`<span class="position-remark">${record.remark}</span>` : null}
          </div>
        </article>
      </td>`,
      html`<td class="schedule-grid-slot schedule-person-slot">
        <article class="schedule-cell schedule-person-cell is-assigned">
          <strong class="history-person">${record.staffName}</strong
          ><span class="history-load"
            >${record.workHours.toFixed(1)}h · 疲劳
            ${record.fatiguePoints.toFixed(1)}</span
          >
          ${
            this.allowDelete
              ? html`<div class="schedule-cell-actions">
                  <button
                    class="btn btn-sm btn-light icon-btn"
                    type="button"
                    title="删除这条历史记录"
                    aria-label="删除这条历史记录"
                    @click=${() => dispatchUiCommand(this, { type: "delete-history", id: record.id })}
                  >
                    <i class="bi bi-trash3"></i>
                  </button>
                </div>`
              : null
          }
        </article>
      </td>`,
    ];
  }
}

customElements.define(
  "autoschedule-archived-schedule-board",
  ArchivedScheduleBoardElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-archived-schedule-board": ArchivedScheduleBoardElement;
  }
}
