import { html } from "lit";

import {
  buildMonthlyLatePriorityStatistics,
  canAdjustLatePriorityCategory,
  LATE_PRIORITY_STATISTICS_CATEGORIES,
  latePriorityStatisticsFlightNumbers,
  type LatePriorityStatisticsCategory,
  type MonthlyLatePriorityFlightStatistics,
  type MonthlyLatePriorityStatisticsRow,
} from "../../domain/statistics/monthly-late-priority-statistics";
import { buildMonthlyRelaxedShiftStatistics } from "../../domain/statistics/relaxed-shift-statistics";
import type { AppState } from "../../model";
import { LightDomElement } from "./light-dom-element";
import "./duty-roster-details";
import { dispatchUiCommand } from "../events/ui-command";
import {
  buildOrdinaryPriorityStatistics,
  type OrdinaryPriorityStatisticsRow,
} from "../../domain/statistics/ordinary-priority-statistics";

export class StatisticsPageElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
  };
  model!: AppState;
  date = "";
  private readonly expandedLatePriorityCells = new Set<string>();
  private readonly expandedOrdinaryPriorityCells = new Set<string>();
  private selectedLatePriorityStatisticsMonth = "";
  private selectedLatePriorityCategory:
    "全部" | LatePriorityStatisticsCategory = "全部";
  private selectedOrdinaryPriorityStatisticsMonth = "";
  private selectedOrdinaryPriorityKey = "全部";

  protected override render() {
    return html`
      <autoschedule-duty-roster-details
        .model=${this.model}
        .date=${this.date}
      ></autoschedule-duty-roster-details>
      ${this.relaxedShiftStatistics()} ${this.ordinaryPriorityStatistics()}
      ${this.latePriorityStatistics()}
    `;
  }

  private relaxedShiftStatistics() {
    const statistics = buildMonthlyRelaxedShiftStatistics(
      this.model,
      this.date
    );
    const rows = [...statistics.rows].sort(
      (left, right) =>
        right.earlyDepartures.length - left.earlyDepartures.length ||
        right.afternoonRestDates.length - left.afternoonRestDates.length ||
        left.staff.name.localeCompare(right.staff.name, "zh-CN")
    );
    return html`<section class="workspace-section relaxed-shift-statistics">
      <div class="section-heading">
        <div>
          <h3>月度轻松班次统计</h3>
          <span>${statistics.month} · 仅统计实际参加排班的常规人员</span>
        </div>
      </div>
      <div class="relaxed-shift-today">
        <div>
          <strong>今日提前下班</strong
          ><small
            >任一航班截载晚于 23:00 不计；否则最后航班截载严格早于
            ${this.model.settings.earlyDepartureCutoffTime}，排除当日值班</small
          >
          <div>
            ${statistics.currentEarlyDepartures.length ? statistics.currentEarlyDepartures.map((item) => html`<span><strong>${item.staffName}</strong> ${item.flightNo} / ${item.cutoffTime} <em>本月 ${item.monthlyCount} 次</em></span>`) : html`<span class="is-empty">今日没有符合节点的提前下班人员</span>`}
          </div>
        </div>
        <div>
          <strong>今日下午无航班</strong
          ><small
            >${this.model.settings.afternoonRestStartTime}-${this.model.settings.afternoonRestEndTime}
            无航班重叠，值班和备勤照常计入</small
          >
          <div>
            ${statistics.currentAfternoonRest.length ? statistics.currentAfternoonRest.map((item) => html`<span><strong>${item.staffName}</strong> <em>本月 ${item.monthlyCount} 次</em></span>`) : html`<span class="is-empty">今日没有下午无航班人员</span>`}
          </div>
        </div>
      </div>
      <div class="table-responsive">
        <table
          class="table table-sm align-middle data-table relaxed-shift-table"
        >
          <thead>
            <tr>
              <th>常规人员</th>
              <th>提前下班次数</th>
              <th>提前下班日期 / 最后航班 / 截载</th>
              <th>下午无航班次数</th>
              <th>下午无航班日期</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td><strong>${row.staff.name}</strong></td>
                  <td>${row.earlyDepartures.length}</td>
                  <td>
                    ${row.earlyDepartures.map((event) => `${event.date.slice(5)} ${event.flightNo} ${event.cutoffTime}`).join("、") || "-"}
                  </td>
                  <td>${row.afternoonRestDates.length}</td>
                  <td>
                    ${row.afternoonRestDates.map((eventDate) => eventDate.slice(5)).join("、") || "-"}
                  </td>
                </tr>`
            )}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  private latePriorityStatistics() {
    const flightNumbers = latePriorityStatisticsFlightNumbers(this.model);
    const statistics = buildMonthlyLatePriorityStatistics(
      this.model,
      this.latePriorityStatisticsDate()
    );
    const displayRows = this.latePriorityDisplayRows(statistics.rows);
    return html`<section
      class="workspace-section late-priority-statistics"
      data-late-priority-flights=${flightNumbers.join(",")}
    >
      <div class="section-heading">
        <div>
          <h3>末班重点岗位统计</h3>
          <span
            >${statistics.month} ·
            当前统计航班：${flightNumbers.join("、") || "尚未选择"} ·
            实际结束晚于 ${this.model.settings.lateShiftEndTime}</span
          >
        </div>
        <div class="late-priority-toolbar">
          <label class="d-inline-flex align-items-center gap-2 mb-0">
            <span class="small text-body-secondary">统计月份</span>
            <input
              class="form-control form-control-sm"
              type="month"
              aria-label="末班重点岗位统计月份"
              .value=${this.latePriorityStatisticsMonth()}
              @change=${(event: Event) =>
                this.selectLatePriorityStatisticsMonth(
                  (event.currentTarget as HTMLInputElement).value
                )}
            />
          </label>
          <div
            class="late-priority-category-filter"
            role="group"
            aria-label="末班重点岗位统计类别"
          >
            ${(["全部", ...LATE_PRIORITY_STATISTICS_CATEGORIES] as const).map(
              (category) =>
                html`<button
                  class=${`btn btn-sm ${
                    this.selectedLatePriorityCategory === category
                      ? "btn-primary"
                      : "btn-outline-secondary"
                  }`}
                  type="button"
                  aria-label=${`末班重点岗位统计类别：${category}`}
                  aria-pressed=${this.selectedLatePriorityCategory === category}
                  @click=${() => this.selectLatePriorityCategory(category)}
                >
                  ${category}
                </button>`
            )}
          </div>
          ${
            flightNumbers.length && statistics.rows.length
              ? html`<button
                    class="btn btn-sm btn-outline-secondary"
                    type="button"
                    title="导入当前月份末班重点岗位次数"
                    @click=${() =>
                      dispatchUiCommand(this, {
                        type: "open-import",
                        mode: "late-priority-counts",
                        date: this.latePriorityStatisticsDate(),
                      })}
                  >
                    <i class="bi bi-file-earmark-arrow-up me-1"></i>导入次数
                  </button>
                  <button
                    class="btn btn-sm btn-outline-secondary"
                    type="button"
                    title="导出当前月份末班重点岗位次数"
                    @click=${() =>
                      dispatchUiCommand(this, {
                        type: "export-late-priority-counts",
                        date: this.latePriorityStatisticsDate(),
                      })}
                  >
                    <i class="bi bi-file-earmark-arrow-down me-1"></i>导出次数
                  </button>
                  <button
                    class="btn btn-sm btn-outline-secondary"
                    type="button"
                    title="清零当前统计月份的末班重点岗位次数；其他月份和历史记录保留"
                    @click=${() =>
                      dispatchUiCommand(this, {
                        type: "reset-monthly-late-priority-frequency-counts",
                        month: statistics.month,
                        date: this.latePriorityStatisticsDate(),
                      })}
                  >
                    <i class="bi bi-arrow-counterclockwise me-1"></i
                    >当月次数清零
                  </button>`
              : ""
          }
        </div>
      </div>
      ${
        flightNumbers.length
          ? displayRows.length
            ? html`${this.latePriorityRangeSummary(statistics.ranges)}
                <div class="table-responsive">
                  <table
                    class="table table-sm align-middle data-table late-priority-summary-table"
                  >
                    <thead>
                      <tr>
                        <th>人员</th>
                        <th>${this.latePriorityCategoryColumnLabel()}</th>
                        ${flightNumbers.map((flightNo) => html`<th>${flightNo}</th>`)}
                      </tr>
                    </thead>
                    <tbody>
                      ${displayRows.map(
                        (row) =>
                          html`<tr>
                            <td data-label="人员">
                              <strong>${row.staff.name}</strong>
                            </td>
                            <td
                              data-label=${this.latePriorityCategoryColumnLabel()}
                            >
                              <strong>${this.latePriorityRowCount(row)}</strong>
                            </td>
                            ${flightNumbers.map(
                              (flightNo) =>
                                html`<td data-label=${flightNo}>
                                  ${this.latePriorityFlightCell(
                                    row.staff.id,
                                    statistics.month,
                                    row.flights[flightNo]!
                                  )}
                                </td>`
                            )}
                          </tr>`
                      )}
                    </tbody>
                  </table>
                </div>`
            : html`<div class="empty-workspace compact-empty">
                <i class="bi bi-bar-chart"></i>
                <p>当前范围没有正常常规资质人员</p>
              </div>`
          : html`<div class="empty-workspace compact-empty">
              <i class="bi bi-bar-chart"></i>
              <p>尚未选择统计航班，请先到规则页勾选</p>
            </div>`
      }
    </section>`;
  }

  private ordinaryPriorityStatistics() {
    const month = this.ordinaryPriorityStatisticsMonth();
    const rows = buildOrdinaryPriorityStatistics(
      this.model,
      this.ordinaryPriorityStatisticsDate()
    );
    const columns = this.ordinaryPriorityColumns(rows);
    const selectedKey = columns.some(
      (column) => column.key === this.selectedOrdinaryPriorityKey
    )
      ? this.selectedOrdinaryPriorityKey
      : "全部";
    const displayRows = this.ordinaryPriorityDisplayRows(rows, selectedKey);
    return html`<section class="workspace-section ordinary-priority-statistics">
      <div class="section-heading">
        <div>
          <h3>普通重点岗位</h3>
          <span>${month} · 只统计集合内岗位；次数进入一般同岗轮换</span>
        </div>
        <div class="ordinary-priority-toolbar">
          <label class="d-inline-flex align-items-center gap-2 mb-0">
            <span class="small text-body-secondary">统计月份</span>
            <input
              class="form-control form-control-sm"
              type="month"
              aria-label="普通重点岗位统计月份"
              .value=${month}
              @change=${(event: Event) =>
                this.selectOrdinaryPriorityStatisticsMonth(
                  (event.currentTarget as HTMLInputElement).value
                )}
            />
          </label>
          <div
            class="ordinary-priority-filter"
            role="group"
            aria-label="普通重点岗位筛选"
          >
            ${[
              { key: "全部", label: "全部" },
              ...columns.map((column) => ({
                key: column.key,
                label: `${column.airlineCode} / ${column.position}`,
              })),
            ].map(
              (option) =>
                html`<button
                  class=${`btn btn-sm ${
                    selectedKey === option.key
                      ? "btn-primary"
                      : "btn-outline-secondary"
                  }`}
                  type="button"
                  aria-label=${`普通重点岗位筛选：${option.label}`}
                  aria-pressed=${selectedKey === option.key}
                  @click=${() => this.selectOrdinaryPriority(option.key)}
                >
                  ${option.label}
                </button>`
            )}
          </div>
        </div>
      </div>
      ${
        rows.length
          ? html`<div class="table-responsive">
              <table
                class="table table-sm align-middle data-table ordinary-priority-summary-table"
              >
                <thead>
                  <tr>
                    <th>人员</th>
                    <th>合计</th>
                    ${columns.map(
                      (column) =>
                        html`<th>
                          ${column.airlineCode} / ${column.position}
                        </th>`
                    )}
                  </tr>
                </thead>
                <tbody>
                  ${displayRows.map(
                    (row) =>
                      html`<tr>
                        <td data-label="人员">
                          <strong>${row.staff.name}</strong>
                        </td>
                        <td data-label="合计">
                          <strong>${row.totalCount}</strong>
                        </td>
                        ${columns.map((column) => {
                          const cell = row.cells.get(column.key)!;
                          const label = `${column.airlineCode} / ${column.position}`;
                          return html`<td data-label=${label}>
                            ${
                              cell.qualified ||
                              cell.actualCount ||
                              cell.manualCorrection ||
                              cell.effectiveCount
                                ? this.ordinaryPriorityCountCell(cell, month)
                                : html`<span class="text-body-secondary"
                                    >-</span
                                  >`
                            }
                          </td>`;
                        })}
                      </tr>`
                  )}
                </tbody>
              </table>
            </div>`
          : html`<div class="empty-workspace compact-empty">
              <p>普通重点集合为空，请先在规则页维护</p>
            </div>`
      }
    </section>`;
  }

  private ordinaryPriorityColumns(
    rows: readonly OrdinaryPriorityStatisticsRow[]
  ) {
    const columns = new Map<
      string,
      { key: string; airlineCode: string; position: string }
    >();
    for (const row of rows) {
      const key = this.ordinaryPriorityCellKey(row.airlineCode, row.position);
      if (!columns.has(key)) {
        columns.set(key, {
          key,
          airlineCode: row.airlineCode,
          position: row.position,
        });
      }
    }
    return [...columns.values()];
  }

  private ordinaryPriorityDisplayRows(
    rows: readonly OrdinaryPriorityStatisticsRow[],
    selectedKey: string
  ) {
    const displayRows = new Map<
      string,
      {
        staff: OrdinaryPriorityStatisticsRow["staff"];
        totalCount: number;
        cells: Map<string, OrdinaryPriorityStatisticsRow>;
      }
    >();
    for (const row of rows) {
      const current = displayRows.get(row.staff.id) ?? {
        staff: row.staff,
        totalCount: 0,
        cells: new Map<string, OrdinaryPriorityStatisticsRow>(),
      };
      current.totalCount += row.effectiveCount;
      current.cells.set(
        this.ordinaryPriorityCellKey(row.airlineCode, row.position),
        row
      );
      displayRows.set(row.staff.id, current);
    }
    return [...displayRows.values()].filter((row) =>
      selectedKey === "全部"
        ? [...row.cells.values()].some(
            (cell) =>
              cell.qualified ||
              cell.actualCount ||
              cell.manualCorrection ||
              cell.effectiveCount
          )
        : Boolean(
            row.cells.get(selectedKey)?.qualified ||
            row.cells.get(selectedKey)?.actualCount ||
            row.cells.get(selectedKey)?.manualCorrection ||
            row.cells.get(selectedKey)?.effectiveCount
          )
    );
  }

  private ordinaryPriorityCountCell(
    row: OrdinaryPriorityStatisticsRow,
    month: string
  ) {
    const detailKey = `${row.staff.id}\u0000${this.ordinaryPriorityCellKey(
      row.airlineCode,
      row.position
    )}`;
    return html`<details
      class="ordinary-priority-count-detail"
      data-staff-id=${row.staff.id}
      data-airline-code=${row.airlineCode}
      data-position=${row.position}
      .open=${this.expandedOrdinaryPriorityCells.has(detailKey)}
      @toggle=${(event: Event) =>
        this.trackOrdinaryPriorityDetailToggle(
          detailKey,
          (event.currentTarget as HTMLDetailsElement).open
        )}
    >
      <summary title="展开普通重点岗位次数">${row.effectiveCount}</summary>
      <div>
        <div class="late-priority-adjustment-row">
          <strong>${row.airlineCode} / ${row.position}</strong>
          <span class="late-priority-adjustments">
            <button
              class="btn btn-sm btn-outline-secondary"
              type="button"
              aria-label=${`${row.airlineCode}/${row.position}减少一次`}
              ?disabled=${row.effectiveCount <= 0}
              @click=${() =>
                dispatchUiCommand(this, {
                  type: "adjust-ordinary-priority-frequency",
                  month,
                  staffId: row.staff.id,
                  airlineCode: row.airlineCode,
                  position: row.position,
                  delta: -1,
                })}
            >
              −</button
            ><output>${row.effectiveCount}</output
            ><button
              class="btn btn-sm btn-outline-secondary"
              type="button"
              aria-label=${`${row.airlineCode}/${row.position}增加一次`}
              @click=${() =>
                dispatchUiCommand(this, {
                  type: "adjust-ordinary-priority-frequency",
                  month,
                  staffId: row.staff.id,
                  airlineCode: row.airlineCode,
                  position: row.position,
                  delta: 1,
                })}
            >
              +
            </button>
          </span>
          <small
            >实际 ${row.actualCount} · 修正
            ${row.manualCorrection >= 0 ? "+" : ""}${row.manualCorrection}</small
          >
        </div>
      </div>
    </details>`;
  }

  private ordinaryPriorityCellKey(
    airlineCode: string,
    position: string
  ): string {
    return `${airlineCode}\u0000${position}`;
  }

  private latePriorityRangeSummary(
    ranges: Record<
      LatePriorityStatisticsCategory,
      {
        min: number;
        max: number;
        difference: number;
        allowedDifference: number;
      }
    >
  ) {
    return html`<div class="duty-balance-summary late-priority-range-summary">
      ${LATE_PRIORITY_STATISTICS_CATEGORIES.map(
        (category) =>
          html`<span
            >${category}最高 / 最低
            <strong>${ranges[category].max} / ${ranges[category].min}</strong>
            <small>允许差值 ${ranges[category].allowedDifference}</small></span
          >`
      )}
    </div>`;
  }

  private latePriorityFlightCell(
    staffId: string,
    month: string,
    flight: MonthlyLatePriorityFlightStatistics
  ) {
    const detailKey = `${staffId}\u0000${flight.flightNo}`;
    return html`<details
      class="late-priority-count-detail"
      data-staff-id=${staffId}
      data-flight-no=${flight.flightNo}
      .open=${this.expandedLatePriorityCells.has(detailKey)}
      @toggle=${(event: Event) => this.trackLatePriorityDetailToggle(detailKey, (event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary title="展开重点岗位次数">
        ${this.latePriorityFlightCount(flight)}
      </summary>
      <div class="late-priority-flight-breakdown">
        ${flight.applicableCategories.map((category) => {
          const own = flight.categories[category];
          return html`<div
            class="late-priority-adjustment-row"
            data-staff-id=${staffId}
            data-late-priority-category=${category}
          >
            <strong>${category}</strong>
            ${
              canAdjustLatePriorityCategory(own)
                ? html`${this.adjustmentButtons(
                      staffId,
                      month,
                      flight.flightNo,
                      category,
                      own.effectiveCount
                    )}<small
                      >实际 ${own.baseCount} · 修正
                      ${
                        own.manualCorrection >= 0 ? "+" : ""
                      }${own.manualCorrection}</small
                    >`
                : html`<span class="text-body-secondary">无资质</span>`
            }
            ${
              own.visibleDetails.length
                ? html`<small class="late-priority-detail-list"
                    >${own.visibleDetails
                      .map(
                        (detail) => `${detail.date.slice(5)} ${detail.position}`
                      )
                      .join("、")}</small
                  >`
                : ""
            }
          </div>`;
        })}
      </div>
    </details>`;
  }

  private latePriorityDisplayRows(
    rows: readonly MonthlyLatePriorityStatisticsRow[]
  ): MonthlyLatePriorityStatisticsRow[] {
    if (this.selectedLatePriorityCategory === "全部") return [...rows];
    const category = this.selectedLatePriorityCategory;
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) =>
        canAdjustLatePriorityCategory(row.categories[category])
      )
      .sort(
        (left, right) =>
          this.latePriorityRowCount(right.row) -
            this.latePriorityRowCount(left.row) || left.index - right.index
      )
      .map(({ row }) => row);
  }

  private latePriorityFlightCount(
    flight: MonthlyLatePriorityFlightStatistics
  ): number {
    if (this.selectedLatePriorityCategory === "全部") return flight.totalCount;
    return flight.categories[this.selectedLatePriorityCategory].effectiveCount;
  }

  private latePriorityStatisticsMonth(): string {
    return this.selectedLatePriorityStatisticsMonth || this.date.slice(0, 7);
  }

  private ordinaryPriorityStatisticsMonth(): string {
    return (
      this.selectedOrdinaryPriorityStatisticsMonth || this.date.slice(0, 7)
    );
  }

  private ordinaryPriorityStatisticsDate(): string {
    const month = this.ordinaryPriorityStatisticsMonth();
    if (this.model.activeScheduleDate?.startsWith(month))
      return this.model.activeScheduleDate;
    if (this.date.startsWith(month)) return this.date;
    return `${month}-01`;
  }

  private selectOrdinaryPriorityStatisticsMonth(month: string): void {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    this.selectedOrdinaryPriorityStatisticsMonth = month;
    this.requestUpdate();
  }

  private latePriorityStatisticsDate(): string {
    const month = this.latePriorityStatisticsMonth();
    if (this.model.activeScheduleDate?.startsWith(month))
      return this.model.activeScheduleDate;
    if (this.date.startsWith(month)) return this.date;
    return `${month}-01`;
  }

  private selectLatePriorityStatisticsMonth(month: string): void {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    this.selectedLatePriorityStatisticsMonth = month;
    this.requestUpdate();
  }

  private selectLatePriorityCategory(
    category: "全部" | LatePriorityStatisticsCategory
  ): void {
    this.selectedLatePriorityCategory = category;
    this.requestUpdate();
  }

  private latePriorityCategoryColumnLabel(): string {
    return this.selectedLatePriorityCategory === "全部"
      ? "四类合计"
      : this.selectedLatePriorityCategory;
  }

  private latePriorityRowCount(row: MonthlyLatePriorityStatisticsRow): number {
    if (this.selectedLatePriorityCategory === "全部") return row.totalCount;
    const category = this.selectedLatePriorityCategory;
    return Object.values(row.flights).reduce(
      (total, flight) => total + flight.categories[category].effectiveCount,
      0
    );
  }

  private adjustmentButtons(
    staffId: string,
    month: string,
    flightNo: string,
    category: LatePriorityStatisticsCategory,
    count: number
  ) {
    const kind = (
      {
        督导: "supervisor",
        一号: "number-one",
        申报: "declaration",
        送资料: "delivery",
      } as const
    )[category];
    return html`<span class="late-priority-adjustments">
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        aria-label="${flightNo}${category}减少一次"
        ?disabled=${count <= 0}
        @click=${() => dispatchUiCommand(this, { type: "adjust-late-priority-frequency", month, staffId, flightNo, kind, delta: -1 })}
      >
        −
      </button>
      <output aria-label="${flightNo}${category}最终次数">${count}</output>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        aria-label="${flightNo}${category}增加一次"
        @click=${() => dispatchUiCommand(this, { type: "adjust-late-priority-frequency", month, staffId, flightNo, kind, delta: 1 })}
      >
        +
      </button>
    </span>`;
  }

  private trackLatePriorityDetailToggle(key: string, open: boolean): void {
    if (open) {
      this.expandedLatePriorityCells.add(key);
    } else {
      this.expandedLatePriorityCells.delete(key);
    }
  }

  private trackOrdinaryPriorityDetailToggle(key: string, open: boolean): void {
    if (open) {
      this.expandedOrdinaryPriorityCells.add(key);
    } else {
      this.expandedOrdinaryPriorityCells.delete(key);
    }
  }

  private selectOrdinaryPriority(key: string): void {
    this.selectedOrdinaryPriorityKey = key;
    this.requestUpdate();
  }
}

customElements.define("autoschedule-statistics-page", StatisticsPageElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-statistics-page": StatisticsPageElement;
  }
}
