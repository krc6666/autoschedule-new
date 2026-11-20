import { html } from "lit";
import {
  flightIdentityKey,
  flightIdentityLabel,
} from "../../domain/flights/flight-identities";

import {
  buildMonthlyLatePriorityStatistics,
  canAdjustLatePriorityCategory,
  LATE_PRIORITY_STATISTICS_CATEGORIES,
  type LatePriorityStatisticsCategory,
  type MonthlyLatePriorityFlightStatistics,
  type MonthlyLatePriorityStatisticsRow,
} from "../../domain/statistics/monthly-late-priority-statistics";
import { buildMonthlyRelaxedShiftStatistics } from "../../domain/statistics/relaxed-shift-statistics";
import { relaxedShiftFlightScope } from "../../domain/statistics/relaxed-shift-flight-scope";
import type { AppState } from "../../model";
import { LightDomElement } from "./light-dom-element";
import "./duty-roster-details";
import "./staff-load-table";
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
  private selectedRelaxedShiftMonth = "";
  private readonly expandedRelaxedCells = new Set<string>();

  protected override render() {
    return html`
      <autoschedule-staff-load-table
        .model=${this.model}
        .date=${this.date}
      ></autoschedule-staff-load-table>
      <autoschedule-duty-roster-details
        .model=${this.model}
        .date=${this.date}
      ></autoschedule-duty-roster-details>
      ${this.relaxedShiftStatistics()} ${this.ordinaryPriorityStatistics()}
      ${this.latePriorityStatistics()}
    `;
  }

  private relaxedShiftStatistics() {
    const month = this.selectedRelaxedShiftMonth || this.date.slice(0, 7);
    const referenceDate = this.model.activeScheduleDate?.startsWith(month)
      ? this.model.activeScheduleDate
      : this.date.startsWith(month)
        ? this.date
        : `${month}-01`;
    const statistics = buildMonthlyRelaxedShiftStatistics(
      this.model,
      referenceDate
    );
    const rows = statistics.rows;
    const todayStatistics =
      referenceDate === this.date
        ? statistics
        : buildMonthlyRelaxedShiftStatistics(this.model, this.date);
    const scope = relaxedShiftFlightScope(this.model);
    const setFlights = (flightNumbers: string[]) =>
      dispatchUiCommand(this, {
        type: "set-relaxed-shift-flights",
        flightNumbers,
      });
    return html`<section class="workspace-section relaxed-shift-statistics">
      <div class="section-heading">
        <div>
          <h3>月度轻松班次统计</h3>
          <span
            >${statistics.month} ·
            航班列沿用提前下班口径，每人每天最多一次；点击次数查看日期</span
          >
        </div>
        <div class="late-priority-toolbar">
          <label class="d-inline-flex align-items-center gap-2 mb-0">
            <span class="small text-body-secondary">统计月份</span>
            <input
              class="form-control form-control-sm"
              type="month"
              aria-label="轻松班次统计月份"
              .value=${month}
              @change=${(event: Event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
                this.selectedRelaxedShiftMonth = value;
                this.expandedRelaxedCells.clear();
                this.requestUpdate();
              }}
            />
          </label>
        </div>
      </div>
      <details class="relaxed-shift-flight-scope">
        <summary>调整统计航班（已选 ${scope.selected.length} 个）</summary>
        <div
          class="d-flex flex-wrap gap-2 p-3"
          role="group"
          aria-label="轻松班次统计航班"
        >
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click=${() => setFlights(scope.candidates)}
          >
            全选
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click=${() => setFlights([])}
          >
            清空
          </button>
          ${scope.candidates.map(
            (flightNo) =>
              html`<label class="d-inline-flex align-items-center gap-1">
                <input
                  type="checkbox"
                  class="form-check-input m-0"
                  aria-label=${`轻松班次统计航班：${flightNo}`}
                  .checked=${scope.selected.includes(flightNo)}
                  @change=${(event: Event) =>
                    setFlights(
                      (event.currentTarget as HTMLInputElement).checked
                        ? [...scope.selected, flightNo]
                        : scope.selected.filter((no) => no !== flightNo)
                    )}
                />${flightIdentityLabel(this.model, flightNo)}
              </label>`
          )}
        </div>
      </details>
      <p class="small text-body-secondary px-3 mb-2">
        下午空：${this.model.settings.afternoonRestStartTime}—${this.model.settings.afternoonRestEndTime}
        无岗位重叠，之后仍有航班；下午休：没有开始时间晚于 12:00
        的航班。仅统计当天实际参加排班的常规人员。
      </p>
      ${
        month === this.date.slice(0, 7)
          ? html`<div class="relaxed-shift-today">
              <div>
                <strong>今日提前下班</strong
                ><small
                  >任一航班截载晚于 23:00 不计；否则最后航班截载严格早于
                  ${this.model.settings.earlyDepartureCutoffTime}，排除当日值班</small
                >
                <div>
                  ${todayStatistics.currentEarlyDepartures.length ? todayStatistics.currentEarlyDepartures.map((item) => html`<span><strong>${item.staffName}</strong> ${item.flightNo} / ${item.cutoffTime} <em>本月 ${item.monthlyCount} 次</em></span>`) : html`<span class="is-empty">今日没有符合节点的提前下班人员</span>`}
                </div>
              </div>
              <div>
                <strong>今日下午无航班</strong
                ><small
                  >${this.model.settings.afternoonRestStartTime}-${this.model.settings.afternoonRestEndTime}
                  当天该时段有航班，个人无已排岗位重叠才计次；值班和备勤照常计入</small
                >
                <div>
                  ${todayStatistics.currentAfternoonRest.length ? todayStatistics.currentAfternoonRest.map((item) => html`<span><strong>${item.staffName}</strong> <em>本月 ${item.monthlyCount} 次</em></span>`) : html`<span class="is-empty">今日没有下午无航班人员</span>`}
                </div>
              </div>
            </div>`
          : ""
      }
      <div class="table-responsive">
        <table
          class="table table-sm align-middle data-table relaxed-shift-table"
        >
          <thead>
            <tr>
              <th>人员</th>
              ${scope.selected.map((flightNo) => html`<th>${flightIdentityLabel(this.model, flightNo)}</th>`)}
              <th>下午空</th>
              <th>下午休</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td data-label="人员"><strong>${row.staff.name}</strong></td>
                  ${scope.selected.map((flightNo) => html`<td data-label=${flightIdentityLabel(this.model, flightNo)}>${this.relaxedShiftDateCell(row.staff.id, month, flightNo, row.earlyDepartureDatesByFlight[flightNo] ?? [], flightNo.startsWith("@") ? row.earlyDepartures.filter((event) => flightIdentityKey(this.model, event.flightNo, event.date) === flightNo) : [])}</td>`)}
                  <td data-label="下午空">
                    ${this.relaxedShiftDateCell(row.staff.id, month, "下午空", row.afternoonFreeDates)}
                  </td>
                  <td data-label="下午休">
                    ${this.relaxedShiftDateCell(row.staff.id, month, "下午休", row.afternoonOffDates)}
                  </td>
                </tr>`
            )}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  private relaxedShiftDateCell(
    staffId: string,
    month: string,
    column: string,
    dates: readonly string[],
    originalEvents: readonly { date: string; flightNo: string }[] = []
  ) {
    const key = `${month}\u0000${staffId}\u0000${column}`;
    return html`<details
      class="late-priority-count-detail relaxed-shift-count-detail"
      .open=${this.expandedRelaxedCells.has(key)}
      @toggle=${(event: Event) => {
        if ((event.currentTarget as HTMLDetailsElement).open)
          this.expandedRelaxedCells.add(key);
        else this.expandedRelaxedCells.delete(key);
      }}
    >
      <summary
        title=${`展开${flightIdentityLabel(this.model, column)}日期`}
        aria-label=${`${flightIdentityLabel(this.model, column)}：${dates.length}次，展开日期`}
      >
        ${dates.length}
      </summary>
      <div>
        <small class="late-priority-detail-list"
          >${originalEvents.length ? originalEvents.map((event) => `${event.date.slice(5)} ${event.flightNo}`).join("、") : dates.length ? dates.map((date) => date.slice(5)).join("、") : "暂无日期"}</small
        >
      </div>
    </details>`;
  }

  private latePriorityStatistics() {
    const statistics = buildMonthlyLatePriorityStatistics(
      this.model,
      this.latePriorityStatisticsDate()
    );
    const flightNumbers = statistics.flightNumbers;
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
            当前统计航班：${flightNumbers.map((no) => flightIdentityLabel(this.model, no)).join("、") || "尚未选择"}
            · 实际结束晚于 ${this.model.settings.lateShiftEndTime}</span
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
      ${statistics.warnings?.length ? html`<div class="alert alert-warning" role="alert">${statistics.warnings.join("；")}</div>` : ""}
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
                        <th
                          class=${this.selectedLatePriorityCategory !== "全部" ? "statistics-position-selected" : ""}
                        >
                          ${this.latePriorityCategoryColumnLabel()}
                        </th>
                        ${flightNumbers.map((flightNo) => html`<th>${flightIdentityLabel(this.model, flightNo)}</th>`)}
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
                              class=${this.selectedLatePriorityCategory !== "全部" ? "statistics-position-selected" : ""}
                            >
                              <strong>${this.latePriorityRowCount(row)}</strong>
                            </td>
                            ${flightNumbers.map(
                              (flightNo) =>
                                html`<td
                                  data-label=${flightIdentityLabel(this.model, flightNo)}
                                >
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
                        html`<th
                          class=${selectedKey === column.key ? "statistics-position-selected" : ""}
                        >
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
                          return html`<td
                            data-label=${label}
                            class=${selectedKey === column.key ? "statistics-position-selected" : ""}
                          >
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
          ${
            row.dates.length
              ? html`<small class="late-priority-detail-list"
                  >${row.dates.map((date) => date.slice(5)).join("、")}</small
                >`
              : ""
          }
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
            class=${this.selectedLatePriorityCategory === category ? "statistics-position-selected" : ""}
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
            class=${`late-priority-adjustment-row${this.selectedLatePriorityCategory === category ? " statistics-position-selected" : ""}`}
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
                        (detail) =>
                          `${detail.date.slice(5)} ${flight.flightNo.startsWith("@") ? `${detail.flightNo} ` : ""}${detail.position}`
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
