import { html } from "lit";

import type { ApplicationDialog } from "../../app/application-view-state";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

type FlightQueryDialog = Extract<ApplicationDialog, { kind: "flight-query" }>;

export class FlightQueryDialogElement extends LightDomElement {
  static override properties = { dialog: { attribute: false } };
  dialog!: FlightQueryDialog;
  private sourceReconciliation: FlightQueryDialog["reconciliation"] = null;
  private additions = new Set<string>();
  private removals = new Set<string>();
  private queryDate = "";

  protected override render() {
    this.resetSelection();
    const result = this.dialog.reconciliation;
    return html`<div class="modal-body online-flight-query">
        <div class="online-flight-query-form">
          <label class="form-label"
            >查询日期
            <input
              class="form-control"
              type="date"
              .value=${this.queryDate || this.dialog.date}
              @change=${this.changeDate}
            />
          </label>
          <button
            class="btn btn-primary"
            type="button"
            ?disabled=${this.dialog.loading}
            @click=${this.runQuery}
          >
            ${
              this.dialog.loading
                ? html`<span
                      class="spinner-border spinner-border-sm me-2"
                      aria-hidden="true"
                    ></span
                    >查询中`
                : html`<i class="bi bi-search me-2"></i>查询该日期`
            }
          </button>
        </div>
        <p class="online-flight-query-note">
          ${"工作日边界：排除当日 00:00-06:00，纳入次日 00:00-06:00。计划起飞时间只用于核对；只可新增岗位配置中的本季航班，保障时段读取同名模板，岗位读取本组配置。"}
        </p>
        ${
          this.dialog.error
            ? html`<div class="alert alert-danger py-2" role="alert">
                ${this.dialog.error}
              </div>`
            : null
        }
        ${result ? this.results(result) : html`<div class="empty-state">选择日期后查询在线航班计划</div>`}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-bs-dismiss="modal">
          关闭
        </button>
        ${
          result
            ? html`<button
                class="btn btn-primary"
                type="button"
                @click=${this.apply}
              >
                <i class="bi bi-check2-square me-2"></i>应用航班计划对账
              </button>`
            : null
        }
      </div>`;
  }

  private results(result: NonNullable<FlightQueryDialog["reconciliation"]>) {
    return html`<div class="online-flight-reconciliation-summary">
        <span>继续保留 <strong>${result.retained.length}</strong></span>
        <span>建议新增 <strong>${result.additions.length}</strong></span>
        <span>待确认删减 <strong>${result.removals.length}</strong></span>
        ${
          this.dialog.fetchedAt
            ? html`<small
                >数据时间
                ${new Date(this.dialog.fetchedAt).toLocaleString("zh-CN")}</small
              >`
            : null
        }
      </div>
      ${
        result.removalBlockedReason
          ? html`<div class="alert alert-warning py-2" role="alert">
              ${result.removalBlockedReason}
            </div>`
          : null
      }
      <section class="online-flight-query-section">
        <h4>线上查询结果</h4>
        <div class="table-responsive">
          <table
            class="table align-middle data-table online-flight-query-table"
          >
            <thead>
              <tr>
                <th>新增</th>
                <th>航班</th>
                <th>计划起飞</th>
                <th>目的地</th>
                <th>国家/地区</th>
                <th>排班模板</th>
                <th>对账结果</th>
              </tr>
            </thead>
            <tbody>
              ${
                result.onlineFlights.length
                  ? result.onlineFlights.map((item) => this.onlineRow(item))
                  : html`<tr>
                      <td colspan="7" class="empty-cell">
                        没有查询到符合条件的国际或地区航班
                      </td>
                    </tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
      <section class="online-flight-query-section">
        <div class="online-flight-query-section-heading">
          <h4>待确认删减</h4>
          <small>线上未查到不代表停飞，默认不选择，确认后才会删除。</small>
        </div>
        <div class="table-responsive">
          <table
            class="table align-middle data-table online-flight-query-table"
          >
            <thead>
              <tr>
                <th>删除</th>
                <th>当前航班</th>
                <th>保障时段</th>
                <th>预定人数</th>
                <th>对账结果</th>
              </tr>
            </thead>
            <tbody>
              ${
                result.removals.length
                  ? result.removals.map(
                      (flight) =>
                        html`<tr>
                          <td>
                            <input
                              class="form-check-input"
                              type="checkbox"
                              .checked=${this.removals.has(flight.id)}
                              ?disabled=${!result.removalAllowed}
                              aria-label="删除 ${flight.flightNo}"
                              @change=${(event: Event) => this.toggle(this.removals, flight.id, event)}
                            />
                          </td>
                          <td><strong>${flight.flightNo}</strong></td>
                          <td>${flight.startTime}-${flight.endTime}</td>
                          <td>${flight.bookedPassengers}</td>
                          <td>
                            <span class="badge text-bg-warning"
                              >待确认删减</span
                            >
                          </td>
                        </tr>`
                    )
                  : html`<tr>
                      <td
                        colspan="5"
                        class="empty-cell online-flight-query-empty"
                      >
                        当前计划没有待删航班
                      </td>
                    </tr>`
              }
            </tbody>
          </table>
        </div>
      </section>`;
  }

  private onlineRow(
    item: NonNullable<
      FlightQueryDialog["reconciliation"]
    >["onlineFlights"][number]
  ) {
    const canAdd = Boolean(item.template && !item.currentFlight);
    const status = item.currentFlight
      ? "继续保留"
      : item.template
        ? "建议新增"
        : "不在本组本季航班资料中";
    const style = item.currentFlight
      ? "text-bg-light"
      : item.template
        ? "text-bg-success"
        : "text-bg-warning";
    return html`<tr>
      <td>
        <input
          class="form-check-input"
          type="checkbox"
          .checked=${Boolean(item.template && this.additions.has(item.template.id))}
          ?disabled=${!canAdd}
          aria-label="新增 ${item.flight.flightNo}"
          @change=${(event: Event) => item.template && this.toggle(this.additions, item.template.id, event)}
        />
      </td>
      <td>
        <strong>${item.flight.flightNo}</strong
        ><small class="d-block text-secondary">${item.flight.date}</small>
      </td>
      <td>${item.flight.departureTime}</td>
      <td>
        <strong>${item.flight.destination}</strong
        ><small class="d-block text-secondary"
          >${item.flight.destinationCity}</small
        >
      </td>
      <td>${item.flight.country}</td>
      <td>
        ${item.template ? html`<strong>${item.template.flightNo}</strong><small class="d-block text-secondary">保障 ${item.template.startTime}-${item.template.endTime}</small>` : html`<span class="text-secondary">未匹配</span>`}
      </td>
      <td><span class="badge ${style}">${status}</span></td>
    </tr>`;
  }

  private resetSelection(): void {
    if (!this.queryDate) this.queryDate = this.dialog.date;
    if (this.sourceReconciliation === this.dialog.reconciliation) return;
    this.sourceReconciliation = this.dialog.reconciliation;
    this.queryDate = this.dialog.date;
    this.additions = new Set(
      this.dialog.reconciliation?.additions.map((item) => item.template.id) ??
        []
    );
    this.removals = new Set();
  }

  private changeDate(event: Event): void {
    this.queryDate = (event.currentTarget as HTMLInputElement).value;
    this.requestUpdate();
  }

  private runQuery(): void {
    dispatchUiCommand(this, { type: "run-flight-query", date: this.queryDate });
  }

  private toggle(selection: Set<string>, id: string, event: Event): void {
    if ((event.currentTarget as HTMLInputElement).checked) selection.add(id);
    else selection.delete(id);
    this.requestUpdate();
  }

  private apply(): void {
    dispatchUiCommand(this, {
      type: "apply-flight-query",
      templateIds: [...this.additions],
      flightIds: [...this.removals],
    });
  }
}

customElements.define(
  "autoschedule-flight-query-dialog",
  FlightQueryDialogElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-flight-query-dialog": FlightQueryDialogElement;
  }
}
