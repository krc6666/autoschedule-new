import { html } from "lit";

import type {
  DutyRosterAssignment,
  DutyRosterPersonStats,
  DutyRosterSlot,
} from "../../domain/duty-roster/roster";
import { addIsoDays } from "../../domain/shared/time";
import type { AppState, Staff } from "../../model";
import {
  buildDutyRosterPageModel,
  type DutyRosterPageModel,
} from "../projections/duty-roster-page-model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import { dynamicSelectValue } from "./dynamic-select";

export class DutyRosterDetailsElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
  };
  model!: AppState;
  date = "";
  private selectedDutyStandbyMonth = "";

  protected override render() {
    const view = buildDutyRosterPageModel(this.model, this.date);
    const dutyStandbyDate = this.dutyStandbyReferenceDate();
    const dutyStandbyView = buildDutyRosterPageModel(
      this.model,
      dutyStandbyDate
    );
    return html`<section class="workspace-section duty-roster-details-section">
      <div class="section-heading">
        <div>
          <h3>月度轮值明细</h3>
          <span>${this.date} · 值班对应工作班，备勤对应次日休息日</span>
        </div>
        <div class="d-flex flex-wrap gap-2">
          <label class="d-inline-flex align-items-center gap-2 mb-0">
            <span class="small text-body-secondary">轮值月份</span>
            <input
              class="form-control form-control-sm"
              type="month"
              aria-label="值班与备勤轮换月份"
              .value=${this.dutyStandbyMonth()}
              @change=${(event: Event) =>
                this.selectDutyStandbyMonth(
                  (event.currentTarget as HTMLInputElement).value
                )}
            />
          </label>
          <button
            class="btn btn-sm btn-outline-secondary"
            type="button"
            aria-label="下载值班备勤模板"
            @click=${() => dispatchUiCommand(this, { type: "download-duty-roster-template", date: dutyStandbyDate })}
          >
            <i class="bi bi-download me-1"></i>下载值班备勤模板
          </button>
          <button
            class="btn btn-sm btn-primary"
            type="button"
            @click=${() => dispatchUiCommand(this, { type: "open-import", mode: "duty-roster", date: dutyStandbyDate })}
          >
            <i class="bi bi-file-earmark-arrow-up me-1"></i>导入值班备勤表
          </button>
        </div>
      </div>
      <div class="duty-roster-groups">
        ${this.cxSection(view)}
        ${this.generalSection(dutyStandbyView, dutyStandbyDate)}
      </div>
    </section>`;
  }

  private cxSection(view: DutyRosterPageModel) {
    return html`<details class="duty-roster-details">
      <summary>
        <span><i class="bi bi-airplane-engines me-2"></i>CX航前轮换</span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="duty-roster-detail-body">
        <div class="duty-balance-summary">
          <span>资质人员 <strong>${view.cxStaff.length}</strong></span
          ><span
            >次数范围
            <strong>${view.cxRange.min}-${view.cxRange.max}</strong></span
          ><span>航前差值 <strong>${view.cxRange.difference}</strong></span>
        </div>
        <div class="table-responsive">
          <table class="table table-sm align-middle duty-roster-fairness-table">
            <thead>
              <tr>
                <th>资格人员</th>
                <th>本月次数</th>
                <th>轮值日期</th>
              </tr>
            </thead>
            <tbody>
              ${
                view.cxStats.length
                  ? view.cxStats.map(
                      (item) =>
                        html`<tr>
                          <td><strong>${item.staff.name}</strong></td>
                          <td>${item.cxPreflightDates.length}</td>
                          <td>${this.shortDates(item.cxPreflightDates)}</td>
                        </tr>`
                    )
                  : html`<tr>
                      <td colspan="3" class="text-secondary">
                        暂无符合条件的人员
                      </td>
                    </tr>`
              }
            </tbody>
          </table>
        </div>
        <div class="table-responsive duty-roster-table-wrap">
          <table class="table table-sm align-middle duty-roster-table">
            <thead>
              <tr>
                <th>工作日</th>
                <th>CX航前</th>
                <th class="action-col"></th>
              </tr>
            </thead>
            <tbody>
              ${view.monthly.map(
                (row) =>
                  html`<tr class=${row.date === this.date ? "is-current" : ""}>
                    <td>
                      <strong>${row.date.slice(5)}</strong
                      >${row.adjusted ? html`<span class="duty-adjusted-mark">已调整</span>` : null}
                    </td>
                    <td>
                      ${this.rosterSelect(
                        view.cxStaff,
                        row,
                        "cx-preflight",
                        row.cxPreflightStaffId,
                        "CX航前"
                      )}
                    </td>
                    <td>${this.resetButton(row)}</td>
                  </tr>`
              )}
            </tbody>
          </table>
        </div>
        ${!view.cxStaff.length ? this.warning("尚未配置CX航前资质人员") : view.unfilledCxCount ? this.warning(`值班优先后，本月 ${view.unfilledCxCount} 个工作日没有剩余CX航前资质人员，请增加CX资质人员或人工调整。`) : null}
      </div>
    </details>`;
  }

  private generalSection(view: DutyRosterPageModel, date: string) {
    return html`<details class="duty-roster-details">
      <summary>
        <span><i class="bi bi-people me-2"></i>值班与备勤轮换</span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="duty-roster-detail-body">
        <div class="duty-balance-summary">
          <span>值班席位 <strong>${view.monthly.length}</strong></span
          ><span>资质人员 <strong>${view.dutyStaff.length}</strong></span
          ><span
            >首轮覆盖
            <strong
              >${view.firstRoundCovered}/${view.dutyStaff.length}</strong
            ></span
          ><span>值班差值 <strong>${view.dutyRange.difference}</strong></span
          ><span>备勤差值 <strong>${view.standbyRange.difference}</strong></span
          ><span>备勤资质 <strong>${view.standbyStaff.length}</strong></span
          ><span>备勤保底 <strong>2 次</strong></span
          ><span
            >每次值班
            <strong>${this.model.settings.dutyFatiguePoints} 点</strong></span
          >
        </div>
        ${this.dutyBalanceNotice(view, date)} ${this.standbyNotice(view)}
        <div class="table-responsive">
          <table class="table table-sm align-middle duty-roster-fairness-table">
            <thead>
              <tr>
                <th>人员</th>
                <th>值班保障</th>
                <th>本月值班</th>
                <th>计划疲劳</th>
                <th>本月备勤</th>
                <th>轮值日期</th>
              </tr>
            </thead>
            <tbody>
              ${
                view.stats.length
                  ? view.stats.map((item) => this.generalStatsRow(item))
                  : html`<tr>
                      <td colspan="6" class="text-secondary">
                        暂无符合条件的人员
                      </td>
                    </tr>`
              }
            </tbody>
          </table>
        </div>
        <div class="table-responsive duty-roster-table-wrap">
          <table class="table table-sm align-middle duty-roster-table">
            <thead>
              <tr>
                <th>工作班日期</th>
                <th>值班人员</th>
                <th>次日备勤一</th>
                <th>次日备勤二</th>
                <th class="action-col"></th>
              </tr>
            </thead>
            <tbody>
              ${view.monthly.map((row) => {
                const standby = view.standbyStaff.filter(
                  (person) => person.id !== row.dutyStaffId
                );
                const duty = view.dutyStaff;
                return html`<tr
                  class=${row.date === this.date ? "is-current" : ""}
                >
                  <td>
                    <strong>${row.date.slice(5)}</strong
                    ><small class="d-block text-secondary"
                      >次日 ${addIsoDays(row.date, 1).slice(5)}</small
                    >${row.adjusted ? html`<span class="duty-adjusted-mark">已调整</span>` : null}
                  </td>
                  <td>
                    ${this.rosterSelect(duty, row, "duty", row.dutyStaffId, "值班人员")}
                  </td>
                  <td>
                    ${this.rosterSelect(standby, row, "standby-0", row.standbyStaffIds[0], "次日备勤一")}
                  </td>
                  <td>
                    ${this.rosterSelect(standby, row, "standby-1", row.standbyStaffIds[1], "次日备勤二")}
                  </td>
                  <td>${this.resetButton(row)}</td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>
        ${view.dutyStaff.length ? null : this.warning("尚未配置值班资质人员")}
      </div>
    </details>`;
  }

  private dutyBalanceNotice(view: DutyRosterPageModel, date: string) {
    if (
      (view.missingDuty.length && !view.dutySeatShortage) ||
      view.dutyRange.difference > 1
    )
      return html`<div class="duty-balance-alert is-attention">
        <i class="bi bi-exclamation-triangle-fill"></i>
        <div>
          <strong>值班均衡未完成</strong
          ><span
            >${view.stats
              .filter((item) => item.staff.dutyQualified)
              .map((item) => `${item.staff.name} ${item.dutyDates.length} 次`)
              .join("、")}。</span
          ><span
            >${view.hasMonthlyAdjustments ? "本月存在人工调整，自动均衡不会覆盖手工结果。" : "请恢复本月自动均衡，系统会先补齐 0 次人员并将次数差控制在 1 以内。"}</span
          >
        </div>
        ${view.hasMonthlyAdjustments ? html`<button class="btn btn-sm btn-outline-danger" type="button" @click=${() => dispatchUiCommand(this, { type: "rebalance-duty-roster-month", date })}><i class="bi bi-arrow-repeat me-1"></i>重新均衡本月</button>` : null}
      </div>`;
    return view.missingDuty.length && view.dutySeatShortage
      ? html`<div class="duty-balance-alert is-info">
          <i class="bi bi-info-circle-fill"></i>
          <div>
            <strong>本月值班席位不足</strong
            ><span
              >${view.missingDuty.map((item) => item.staff.name).join("、")}本月暂缺
              1 次值班，缺额会在后续月份轮换。</span
            >
          </div>
        </div>`
      : null;
  }

  private standbyNotice(view: DutyRosterPageModel) {
    if (view.unfilledStandbyCount)
      return html`<div class="duty-balance-alert is-attention">
        <i class="bi bi-exclamation-triangle-fill"></i>
        <div>
          <strong>备勤资质人员不足</strong
          ><span
            >本月 ${view.unfilledStandbyCount}
            个次日备勤未满两人，空缺席位保持未配置。请在人员信息中开启备勤资质，或人工选择其他具备资质的人员。</span
          >
        </div>
      </div>`;
    if (!view.standbyMissing.length) return null;
    return html`<div
      class="duty-balance-alert ${view.standbySeatShortage ? "is-info" : "is-attention"}"
    >
      <i
        class="bi bi-${view.standbySeatShortage ? "info-circle-fill" : "exclamation-triangle-fill"}"
      ></i>
      <div>
        <strong
          >${view.standbySeatShortage ? "本月备勤席位不足" : "备勤保底未完成"}</strong
        ><span
          >${view.standbyMissing.map((item) => `${item.staff.name} ${item.standbyDates.length} 次`).join("、")}。${view.standbySeatShortage ? "值班刚性要求优先，备勤缺额只作说明，不计入违约。" : "每名具备备勤资质的正常常规人员应至少安排 2 次备勤。"}</span
        >
      </div>
    </div>`;
  }

  private generalStatsRow(item: DutyRosterPersonStats) {
    const coverage = !item.staff.dutyQualified
      ? ["is-neutral", "不参与值班"]
      : !item.dutyDates.length
        ? ["is-missing", "首轮待安排"]
        : [
            "is-complete",
            item.dutyDates.length === 1
              ? "首轮已保障"
              : `已进入第 ${item.dutyDates.length} 轮`,
          ];
    const dates = [
      ...item.dutyDates.map((date) => `${date.slice(5)}值班`),
      ...item.standbyDates.map((date) => `${date.slice(5)}备勤`),
    ];
    return html`<tr>
      <td>
        <strong>${item.staff.name}</strong
        >${item.staff.dutyQualified ? null : html`<small class="duty-no-qualification">无值班资质</small>`}
        ${item.staff.standbyQualified ? null : html`<small class="duty-no-qualification">无备勤资质</small>`}
      </td>
      <td>
        <span class="duty-coverage-badge ${coverage[0]}">${coverage[1]}</span>
      </td>
      <td>${item.dutyDates.length}</td>
      <td>
        <strong class="duty-planned-fatigue"
          >${item.dutyDates.length * this.model.settings.dutyFatiguePoints}
          点</strong
        >
      </td>
      <td>${item.standbyDates.length}</td>
      <td>${dates.join("、") || "-"}</td>
    </tr>`;
  }

  private rosterSelect(
    staff: Staff[],
    row: DutyRosterAssignment,
    slot: DutyRosterSlot,
    selectedId: string | null,
    label: string
  ) {
    return html`<select
      ${dynamicSelectValue(selectedId ?? "")}
      class="form-select form-select-sm"
      aria-label="${row.date} ${label}"
      .value=${selectedId ?? ""}
      @change=${(event: Event) => dispatchUiCommand(this, { type: "update-duty-roster", date: row.date, slot, staffId: (event.currentTarget as HTMLSelectElement).value })}
    >
      <option value="">未配置</option>
      ${staff.map(
        (person) => html`<option .value=${person.id}>${person.name}</option>`
      )}
    </select>`;
  }

  private resetButton(row: DutyRosterAssignment) {
    return html`<button
      class="btn btn-sm btn-light icon-btn"
      type="button"
      title="恢复该日全部顺序轮值"
      aria-label="恢复该日全部顺序轮值"
      ?disabled=${!row.adjusted}
      @click=${() => dispatchUiCommand(this, { type: "reset-duty-roster", date: row.date })}
    >
      <i class="bi bi-arrow-counterclockwise"></i>
    </button>`;
  }

  private shortDates(dates: string[]): string {
    return dates.length ? dates.map((date) => date.slice(5)).join("、") : "-";
  }

  private dutyStandbyMonth(): string {
    return this.selectedDutyStandbyMonth || this.date.slice(0, 7);
  }

  private dutyStandbyReferenceDate(): string {
    const month = this.dutyStandbyMonth();
    const day = Number(this.date.slice(8, 10));
    const parityDay = day > 0 && day % 2 === 0 ? "02" : "01";
    return `${month}-${parityDay}`;
  }

  private selectDutyStandbyMonth(month: string): void {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    this.selectedDutyStandbyMonth = month;
    this.requestUpdate();
  }

  private warning(message: string) {
    return html`<div class="duty-roster-warning">
      <i class="bi bi-exclamation-triangle"></i><span>${message}</span>
    </div>`;
  }
}

customElements.define(
  "autoschedule-duty-roster-details",
  DutyRosterDetailsElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-duty-roster-details": DutyRosterDetailsElement;
  }
}
