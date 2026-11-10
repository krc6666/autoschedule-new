import { html } from "lit";
import type { AppState } from "../../model";
import { buildMonthlyStaffFatigue } from "../../domain/statistics/monthly-staff-fatigue";
import { todayIso } from "../../utils";
import { staffStatusLabel } from "../../domain/staff-status";
import { LightDomElement } from "./light-dom-element";

export class StaffLoadTableElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
  };
  model!: AppState;
  date = "";
  private selectedMonth = "";
  private field: "todayFatigue" | "monthFatigue" = "monthFatigue";
  private direction: "asc" | "desc" = "desc";

  protected override render() {
    const month = this.selectedMonth || todayIso().slice(0, 7);
    const statistics = buildMonthlyStaffFatigue(this.model, month, this.date);
    const rows = [...statistics.rows].sort(
      (left, right) =>
        (this.direction === "asc" ? 1 : -1) *
          (left[this.field] - right[this.field]) ||
        left.staff.name.localeCompare(right.staff.name, "zh-CN")
    );
    return html`<section class="workspace-section staff-fatigue-statistics">
      <div class="section-heading">
        <div>
          <h3>人员岗位疲劳</h3>
          <span
            >当日：${this.date} ·
            ${month}累计${statistics.latestDate ? `截至 ${statistics.latestDate}` : "暂无班表"}</span
          >
        </div>
        <div class="load-sort-controls">
          <label class="d-inline-flex align-items-center gap-2 mb-0">
            <span class="small text-body-secondary">统计月份</span>
            <input
              class="form-control form-control-sm"
              type="month"
              aria-label="人员疲劳统计月份"
              .value=${month}
              @change=${(event: Event) => {
                const value = (event.currentTarget as HTMLInputElement).value;
                if (value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
                this.selectedMonth = value;
                this.requestUpdate();
              }}
            />
          </label>
          <select
            class="form-select form-select-sm"
            aria-label="疲劳排序字段"
            .value=${this.field}
            @change=${(event: Event) => {
              this.field = (event.currentTarget as HTMLSelectElement)
                .value as typeof this.field;
              this.requestUpdate();
            }}
          >
            <option value="todayFatigue">当日岗位疲劳</option>
            <option value="monthFatigue">月份累计岗位疲劳</option>
          </select>
          <select
            class="form-select form-select-sm"
            aria-label="疲劳排序方向"
            .value=${this.direction}
            @change=${(event: Event) => {
              this.direction = (event.currentTarget as HTMLSelectElement)
                .value as typeof this.direction;
              this.requestUpdate();
            }}
          >
            <option value="desc">从高到低</option>
            <option value="asc">从低到高</option>
          </select>
        </div>
      </div>
      <p class="small text-body-secondary mb-2">
        按班表记录的疲劳点数逐日累加，包含值班额外疲劳；各月分别计算，同日不重复，不加连续工作惩罚。
      </p>
      <div class="table-responsive">
        <table
          class="table table-sm align-middle data-table staff-fatigue-table"
        >
          <thead>
            <tr>
              <th>人员</th>
              <th>状态</th>
              <th>当日岗位疲劳</th>
              <th>月份累计岗位疲劳</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td>${row.staff.name}</td>
                  <td>${staffStatusLabel(row.staff, this.model.leaveTypes)}</td>
                  <td>${row.todayFatigue.toFixed(1)}</td>
                  <td>${row.monthFatigue.toFixed(1)}</td>
                </tr>`
            )}
          </tbody>
        </table>
      </div>
    </section>`;
  }
}
customElements.define("autoschedule-staff-load-table", StaffLoadTableElement);
declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-staff-load-table": StaffLoadTableElement;
  }
}
