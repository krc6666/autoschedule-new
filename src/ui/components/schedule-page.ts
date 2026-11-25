import { html } from "lit";

import type { AppState } from "../../model";
import type { HalfRestMode } from "../../domain/shared/schedule-run-preferences";
import { buildSchedulePageModel } from "../projections/schedule-page-model";
import {
  buildArchivedScheduleDays,
  buildPreviousArchivedScheduleView,
} from "../projections/archived-schedule-view";
import type { ScheduleDisplaySource } from "../../domain/records/schedule-dates";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import "./duty-roster-summary";
import "./daily-staff-flight-statistics";
import "./schedule-feedback";
import "./schedule-grid";
import "./previous-schedule-comparison";
import "./schedule-relaxed-shift-summary";
import "./schedule-toolbar";
import "./staff-palette";
import "./half-rest-selector";
import "./archived-schedule-board";

interface PointerDragSource {
  staffId: string;
  assignmentId?: string;
}

export class SchedulePageElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    date: { type: String },
    zoom: { type: Number },
    cellSize: { type: Number },
    halfRestStaffIds: { attribute: false },
    halfRestModes: { attribute: false },
    historyEditDate: { attribute: false },
    restoredScheduleNotice: { type: Boolean },
    source: { type: String },
  };
  model!: AppState;
  date = "";
  zoom = 1;
  cellSize = 1;
  halfRestStaffIds: string[] = [];
  halfRestModes: Record<string, HalfRestMode> = {};
  historyEditDate: string | null = null;
  restoredScheduleNotice = false;
  source: ScheduleDisplaySource = "current";
  private pointerSourceValue: PointerDragSource | null = null;
  private pointerTargetId = "";
  private previousScheduleVisible = false;

  protected override render() {
    if (this.source === "history") {
      const archived = buildArchivedScheduleDays(this.model).find(
        (day) => day.date === this.date
      );
      if (!archived) return null;
      return html`<section
        class="workspace-section"
        aria-label="所选日期已保存班表"
      >
        <div class="section-heading">
          <div>
            <h3>${this.date} 已保存班表</h3>
            <p>
              人员和时段来自该日历史记录。需要调整或导出时，请先编辑该日排班。
            </p>
          </div>
          <button
            type="button"
            class="btn btn-outline-primary"
            @click=${() => dispatchUiCommand(this, { type: "edit-history-date", date: this.date })}
          >
            编辑该日排班
          </button>
          <button
            type="button"
            class="btn btn-outline-secondary"
            @click=${() => dispatchUiCommand(this, { type: "generate-schedule" })}
          >
            重新排班
          </button>
        </div>
        <autoschedule-archived-schedule-board
          .view=${archived}
        ></autoschedule-archived-schedule-board>
      </section>`;
    }
    if (this.source === "empty" || !this.model.assignments.length) {
      return html`<section class="workspace-section empty-workspace">
        <i class="bi bi-calendar2-plus"></i>
        <h3>
          ${this.source === "empty" ? `${this.date} 没有班表` : "尚未生成排班"}
        </h3>
        <autoschedule-half-rest-selector
          .model=${this.model}
          .selectedStaffIds=${this.halfRestStaffIds}
          .selectedModes=${this.halfRestModes}
        ></autoschedule-half-rest-selector>
        <button
          class="btn btn-primary"
          type="button"
          @click=${() => dispatchUiCommand(this, { type: "generate-schedule" })}
        >
          <i class="bi bi-stars me-2"></i>生成排班
        </button>
      </section>`;
    }
    const view = buildSchedulePageModel(this.model, this.date, {
      zoom: this.zoom,
      cellSize: this.cellSize,
      halfRestStaffIds: this.halfRestStaffIds,
    });
    const previousSchedule = buildPreviousArchivedScheduleView(
      this.model,
      this.date
    );
    return html`
      <autoschedule-schedule-toolbar
        .model=${this.model}
        .date=${this.date}
        .zoom=${view.zoom}
        .cellSize=${view.cellSize}
        .previousScheduleDate=${previousSchedule?.date ?? ""}
        .previousScheduleVisible=${this.previousScheduleVisible}
        .halfRestStaffIds=${this.halfRestStaffIds}
        .halfRestModes=${this.halfRestModes}
        .historyEditDate=${this.historyEditDate}
        @autoschedule-toggle-previous-schedule=${this.togglePreviousSchedule}
      ></autoschedule-schedule-toolbar>
      ${this.model.schedulePolicyStale ? html`<div class="alert alert-warning py-2" role="status"><i class="bi bi-exclamation-triangle me-2"></i>排班规则已更新，当前排班尚未按新规则重新生成。</div>` : null}
      ${this.restoredScheduleNotice ? html`<div class="alert alert-warning py-2" role="status"><i class="bi bi-arrow-repeat me-2"></i>这是旧班表，请重新排班后再使用。</div>` : null}
      ${
        this.previousScheduleVisible && previousSchedule
          ? html`<autoschedule-previous-schedule-comparison
              .view=${previousSchedule}
            ></autoschedule-previous-schedule-comparison>`
          : null
      }
      <section
        class="schedule-workspace"
        @autoschedule-pointer-drag-start=${this.startPointerDrag}
        @autoschedule-pointer-drag-target=${this.setPointerTarget}
        @pointerup=${this.finishPointerDrag}
        @pointercancel=${this.cancelPointerDrag}
      >
        <autoschedule-staff-palette
          .model=${this.model}
        ></autoschedule-staff-palette>
        <autoschedule-schedule-grid
          .model=${this.model}
          .view=${view}
        ></autoschedule-schedule-grid>
        <div class="schedule-side-panel">
          <autoschedule-duty-roster-summary
            .model=${this.model}
            .date=${this.date}
          ></autoschedule-duty-roster-summary>
          <autoschedule-schedule-relaxed-shift-summary
            .model=${this.model}
            .date=${this.date}
          ></autoschedule-schedule-relaxed-shift-summary>
        </div>
      </section>
      <autoschedule-daily-staff-flight-statistics
        .model=${this.model}
        .date=${this.date}
        .historyEdit=${Boolean(this.historyEditDate)}
      ></autoschedule-daily-staff-flight-statistics>
      <autoschedule-schedule-feedback
        .model=${this.model}
        .view=${view}
        .date=${this.date}
      ></autoschedule-schedule-feedback>
    `;
  }

  private startPointerDrag(event: CustomEvent<PointerDragSource>): void {
    this.pointerSourceValue = event.detail;
    this.pointerTargetId = "";
  }

  private setPointerTarget(event: CustomEvent<{ assignmentId: string }>): void {
    if (this.pointerSourceValue)
      this.pointerTargetId = event.detail.assignmentId;
  }

  private finishPointerDrag(): void {
    const source = this.pointerSourceValue;
    const assignmentId = this.pointerTargetId;
    this.cancelPointerDrag();
    if (!source || !assignmentId || assignmentId === source.assignmentId)
      return;
    dispatchUiCommand(this, {
      type: "assign-staff",
      assignmentId,
      staffId: source.staffId,
      sourceAssignmentId: source.assignmentId,
    });
  }

  private cancelPointerDrag(): void {
    this.pointerSourceValue = null;
    this.pointerTargetId = "";
  }

  private togglePreviousSchedule(event: Event): void {
    event.stopPropagation();
    if (!buildPreviousArchivedScheduleView(this.model, this.date)) return;
    this.previousScheduleVisible = !this.previousScheduleVisible;
    this.requestUpdate();
  }
}

customElements.define("autoschedule-schedule-page", SchedulePageElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-schedule-page": SchedulePageElement;
  }
}
