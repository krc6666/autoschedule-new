import { html } from "lit";

import { buildStaffLoads } from "../../domain/statistics/fatigue";
import { activeFlightPositions } from "../../domain/flights/schedule-position-rules";
import { countedWorkloadAssignments } from "../../domain/shared/workload-accounting";
import type { AppState } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

export class OverviewPageElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
  };

  model!: AppState;
  date = "";

  protected override render() {
    const available = this.model.staff.filter(
      (person) => person.status === "正常"
    ).length;
    const assigned = this.model.assignments.filter(
      (item) => item.status === "assigned"
    ).length;
    const unfilled = this.model.assignments.filter(
      (item) => item.status === "unfilled"
    ).length;
    const loads = buildStaffLoads(
      this.model.staff.filter((person) => person.staffType === "常规"),
      countedWorkloadAssignments(this.model),
      this.model.history,
      this.date,
      this.model.settings
    )
      .filter((item) => item.workHours > 0 || item.historyFatigue > 0)
      .sort((left, right) => right.totalFatigue - left.totalFatigue)
      .slice(0, 8);
    const missingRules = this.model.flights
      .flatMap((flight) =>
        activeFlightPositions(this.model, flight).map((position) => ({
          flight,
          position,
        }))
      )
      .filter(
        ({ flight, position }) =>
          !this.model.positionRules.some(
            (rule) =>
              rule.flightNo === flight.flightNo && rule.name === position
          )
      );

    return html`
      <section class="metric-grid" aria-label="排班概况">
        ${this.metric("airplane", "text-primary", this.model.flights.length, "今日航班")}
        ${this.metric("people", "text-success", available, "可用人员")}
        ${this.metric("person-check", "text-info", assigned, "已排岗位")}
        ${this.metric("exclamation-diamond", "text-danger", unfilled, "待补岗位", unfilled > 0)}
      </section>
      <section class="workspace-section">
        <div class="section-heading">
          <div>
            <h3>航班运行面板</h3>
            <span>${this.date}</span>
          </div>
          <button
            class="btn btn-primary"
            type="button"
            @click=${() => dispatchUiCommand(this, { type: "generate-schedule" })}
          >
            <i class="bi bi-stars me-2"></i>生成排班
          </button>
        </div>
        <div class="flight-strip">
          ${
            this.model.flights.length
              ? [...this.model.flights]
                  .sort((left, right) =>
                    left.startTime.localeCompare(right.startTime)
                  )
                  .map((flight) => {
                    const own = this.model.assignments.filter(
                      (item) => item.flightId === flight.id
                    );
                    const done = own.filter(
                      (item) => item.status === "assigned"
                    ).length;
                    return html`
                      <button
                        class="flight-stop"
                        type="button"
                        @click=${() =>
                          dispatchUiCommand(this, {
                            type: "navigate",
                            section: "schedule",
                          })}
                      >
                        <span class="flight-time">${flight.startTime}</span>
                        <span
                          class="flight-dot ${
                            own.length && done === own.length
                              ? "done"
                              : own.length
                                ? "warning"
                                : ""
                          }"
                        ></span>
                        <strong>${flight.flightNo}</strong>
                        <small
                          >${done}/${activeFlightPositions(this.model, flight).length}
                          岗</small
                        >
                      </button>
                    `;
                  })
              : html`<div class="empty-state">
                  <i class="bi bi-airplane"></i><span>尚无航班</span>
                </div>`
          }
        </div>
      </section>
      <section class="workspace-section split-section">
        <div>
          <div class="section-heading">
            <h3>疲劳负荷</h3>
            <button
              class="btn btn-sm btn-outline-secondary"
              type="button"
              @click=${() =>
                dispatchUiCommand(this, {
                  type: "navigate",
                  section: "statistics",
                })}
            >
              查看全部
            </button>
          </div>
          <div class="table-responsive">
            <table class="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>人员</th>
                  <th>当日工时</th>
                  <th>历史</th>
                  <th>总疲劳</th>
                </tr>
              </thead>
              <tbody>
                ${
                  loads.length
                    ? loads.map(
                        (load) =>
                          html`<tr>
                            <td>${load.staff.name}</td>
                            <td>${load.workHours.toFixed(1)}h</td>
                            <td>${load.historyFatigue.toFixed(1)}</td>
                            <td>
                              <span
                                class="badge ${
                                  load.totalFatigue >= 20
                                    ? "text-bg-danger"
                                    : load.totalFatigue >= 10
                                      ? "text-bg-warning"
                                      : "text-bg-success"
                                }"
                                >${load.totalFatigue.toFixed(1)}</span
                              >
                            </td>
                          </tr>`
                      )
                    : html`<tr>
                        <td colspan="4" class="empty-cell">暂无负荷数据</td>
                      </tr>`
                }
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="section-heading">
            <h3>配置健康</h3>
            <button
              class="btn btn-sm btn-outline-secondary"
              type="button"
              @click=${() =>
                dispatchUiCommand(this, {
                  type: "navigate",
                  section: "config",
                })}
            >
              检查配置
            </button>
          </div>
          <div class="health-list">
            ${this.health("岗位规则", missingRules.length ? `${missingRules.length} 项缺失` : "完整", missingRules.length ? "danger" : "success")}
            ${this.health("人员信息", `${this.model.staff.length} 人`, this.model.staff.some((item) => !item.name) ? "danger" : "success")}
            ${this.health("岗位资质", `${this.model.positionRules.length} 条`, this.model.positionRules.some((item) => !item.manual && item.qualifiedStaffIds.length === 0) ? "warning" : "success")}
            ${this.health("本地存储", "已启用", "success")}
          </div>
        </div>
      </section>
    `;
  }

  private metric(
    icon: string,
    tone: string,
    value: number,
    label: string,
    alert = false
  ) {
    return html`<article class="metric ${alert ? "metric-alert" : ""}">
      <span class="metric-icon ${tone}"><i class="bi bi-${icon}"></i></span>
      <div><strong>${value}</strong><span>${label}</span></div>
    </article>`;
  }

  private health(
    label: string,
    value: string,
    tone: "success" | "warning" | "danger"
  ) {
    const icon =
      tone === "success"
        ? "check-circle-fill"
        : tone === "warning"
          ? "exclamation-circle-fill"
          : "x-circle-fill";
    return html`<div>
      <i class="bi bi-${icon} text-${tone}"></i><span>${label}</span
      ><strong>${value}</strong>
    </div>`;
  }
}

customElements.define("autoschedule-overview-page", OverviewPageElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-overview-page": OverviewPageElement;
  }
}
