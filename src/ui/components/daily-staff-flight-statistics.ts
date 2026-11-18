import { html, type PropertyValues } from "lit";

import { buildDailyStaffFlightStatistics } from "../../domain/statistics/daily-staff-flight-statistics";
import { buildOverlapStaffingCheck } from "../../domain/feedback/overlap-staffing-check";
import { renderOverlapStaffingCheck } from "./overlap-staffing-check";
import type { AppState } from "../../model";
import { LightDomElement } from "./light-dom-element";

type DailyStaffFlightSort = "desc" | "asc" | "original";

export class DailyStaffFlightStatisticsElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
    historyEdit: { type: Boolean },
  };
  model!: AppState;
  date = "";
  historyEdit = false;
  private queryDate = "";
  private sortMode: DailyStaffFlightSort = "desc";

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("date")) return;
    const previousDate = changedProperties.get("date");
    if (!this.queryDate || this.queryDate === previousDate)
      this.queryDate = this.date;
  }

  protected override render() {
    const statistics = buildDailyStaffFlightStatistics(
      this.model,
      this.queryDate || this.date
    );
    const known =
      statistics.source === "current" || statistics.source === "history";
    const availability = [
      { label: "全天无航班人员：", names: statistics.unassignedStaffNames },
      {
        label: "上午无航班人员：",
        names: statistics.morningUnassignedStaffNames,
      },
      {
        label: "中午以后无航班人员（半休）：",
        names: statistics.afternoonUnassignedStaffNames,
      },
    ];
    return html`<section
      class="workspace-section daily-staff-flight-statistics"
      aria-label="人员当日航班"
    >
      <div class="daily-staff-flight-head">
        <div>
          <h3>人员当日航班</h3>
          <span
            >全部常规人员（含病休），同一航班只统计一次；假别按当前人员状态显示</span
          >
        </div>
        <label>
          <span>查询工作日</span>
          <input
            class="form-control form-control-sm"
            type="date"
            aria-label="人员航班查询日期"
            .value=${statistics.date}
            @change=${this.changeDate}
          />
        </label>
      </div>
      ${
        statistics.source === "current" || statistics.source === "history"
          ? html`<div class="daily-staff-flight-summary">
              <span>统计日期 ${statistics.date}</span>
              <span>人员总数 ${statistics.staffCount}</span>
              <strong>${statistics.assignedStaffCount} 人有航班</strong>
              <span>${statistics.unassignedStaffCount} 人未安排</span>
              <span>总航班 ${statistics.totalFlightCount}</span>
            </div>`
          : null
      }
      <div
        class="daily-staff-flight-availability"
        aria-label="无航班人员自动识别"
      >
        ${availability.map(({ label, names }, index) => {
          const warning = known && names.length > 0 && index === 0;
          const complete = known && names.length === 0 && index === 0;
          return html`<div
            class="daily-staff-flight-availability-row ${warning ? "daily-staff-flight-unassigned" : complete ? "daily-staff-flight-complete" : ""}"
            role=${warning ? "alert" : "status"}
          >
            <strong>${label}</strong>
            <span
              >${known ? names.join("、") || "无" : "无法判断（无完整班表）"}</span
            >
          </div>`;
        })}
      </div>
      ${renderOverlapStaffingCheck(buildOverlapStaffingCheck(this.model, statistics.date, this.historyEdit))}
      ${
        statistics.source === "current" || statistics.source === "history"
          ? html`<label class="daily-staff-flight-sort">
              <span>人员排序</span>
              <select
                class="form-select form-select-sm"
                aria-label="人员航班排序"
                .value=${this.sortMode}
                @change=${this.changeSort}
              >
                <option value="desc">航班数从多到少</option>
                <option value="asc">航班数从少到多</option>
                <option value="original">人员原顺序</option>
              </select>
            </label>`
          : null
      }
      ${this.result(statistics)}
    </section>`;
  }

  private result(
    statistics: ReturnType<typeof buildDailyStaffFlightStatistics>
  ) {
    if (statistics.source === "partial-history") {
      return html`<div class="daily-staff-flight-message" role="status">
        <i class="bi bi-exclamation-triangle"></i>
        该工作日只有末班重点记录，无法还原全天人员航班。
      </div>`;
    }
    if (statistics.source === "none") {
      return html`<div class="daily-staff-flight-message" role="status">
        <i class="bi bi-calendar2-x"></i>该工作日没有完整排班记录。
      </div>`;
    }
    if (!statistics.allRows.length) {
      return html`<div class="daily-staff-flight-message" role="status">
        <i class="bi bi-calendar2-check"></i>该工作日没有常规人员航班。
      </div>`;
    }
    return html`<div class="daily-staff-flight-table-wrap">
      <table class="daily-staff-flight-table">
        <thead>
          <tr>
            <th scope="col" class="daily-staff-flight-number">序号</th>
            <th scope="col">人员</th>
            <th scope="col">航班数</th>
            <th scope="col">承担航班</th>
          </tr>
        </thead>
        <tbody>
          ${this.sortedRows(statistics).map(
            (row, index) =>
              html`<tr
                class="daily-staff-flight-row"
                data-staff-id=${row.staffId}
              >
                <td class="daily-staff-flight-number">${index + 1}</td>
                <th scope="row">
                  ${row.staffName}${row.leaveLabel ? `（${row.leaveLabel}）` : ""}
                </th>
                <td class="daily-staff-flight-count">${row.flightCount}</td>
                <td>
                  ${
                    row.flightNumbers.length
                      ? row.flightNumbers.join("、")
                      : "未安排"
                  }
                </td>
              </tr>`
          )}
        </tbody>
      </table>
    </div>`;
  }

  private changeDate(event: Event): void {
    this.queryDate = (event.currentTarget as HTMLInputElement).value;
    this.requestUpdate();
  }

  private changeSort(event: Event): void {
    this.sortMode = (event.currentTarget as HTMLSelectElement)
      .value as DailyStaffFlightSort;
    this.requestUpdate();
  }

  private sortedRows(
    statistics: ReturnType<typeof buildDailyStaffFlightStatistics>
  ) {
    if (this.sortMode === "original") return statistics.allRows;
    return statistics.allRows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const difference = right.row.flightCount - left.row.flightCount;
        return (
          (this.sortMode === "desc" ? difference : -difference) ||
          left.index - right.index
        );
      })
      .map(({ row }) => row);
  }
}

customElements.define(
  "autoschedule-daily-staff-flight-statistics",
  DailyStaffFlightStatisticsElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-daily-staff-flight-statistics": DailyStaffFlightStatisticsElement;
  }
}
