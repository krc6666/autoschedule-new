import { html } from "lit";

import type { ApplicationDialog } from "../../app/application-view-state";
import type { AppState, StaffStatus } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import { weekdayLabel } from "../../domain/flights/weekly-flight-plan";

type PickerDialog = Extract<
  ApplicationDialog,
  {
    kind:
      | "schedule-preflight"
      | "next-workday-flight-picker"
      | "reschedule-flight-picker";
  }
>;

export class NextWorkdayFlightPickerDialogElement extends LightDomElement {
  static override properties = {
    dialog: { attribute: false },
    model: { attribute: false },
  };
  dialog!: PickerDialog;
  model!: AppState;

  protected override render() {
    const selected = new Set(this.dialog.selectedIds);
    const selectedCount = this.dialog.selectedIds.length;
    const reschedule = this.dialog.kind === "reschedule-flight-picker";
    const schedulePreflight = this.dialog.kind === "schedule-preflight";
    const hasStaffStatusDraft = this.dialog.kind !== "reschedule-flight-picker";
    return html`<div class="modal-body next-workday-flight-picker">
        ${hasStaffStatusDraft ? html`<h3 class="h6">选择航班</h3>` : null}
        <div class="d-flex flex-wrap gap-2 mb-3">
          ${this.quickAction(
            this.dialog.kind === "reschedule-flight-picker"
              ? "恢复当前航班"
              : this.dialog.kind === "schedule-preflight"
                ? "恢复当前航班"
                : `恢复${weekdayLabel(this.dialog.weekday)}预设`,
            this.restorePreset
          )}
          ${this.quickAction("全选", this.selectAll)}
          ${this.quickAction("清空", this.clearAll)}
        </div>
        ${
          this.dialog.candidates.length
            ? html`<div class="list-group next-workday-flight-list">
                ${this.dialog.candidates.map(
                  (candidate) =>
                    html`<div class="list-group-item next-workday-flight-row">
                      <label class="next-workday-flight-choice">
                        <input
                          class="form-check-input flex-shrink-0"
                          type="checkbox"
                          .checked=${selected.has(candidate.id)}
                          @change=${(event: Event) =>
                            this.toggle(
                              candidate.id,
                              (event.currentTarget as HTMLInputElement).checked
                            )}
                        />
                        <span class="min-w-0">
                          <strong>${candidate.flightNo}</strong>
                          <small class="text-secondary ms-2"
                            >${candidate.startTime}-${candidate.endTime}</small
                          >
                        </span>
                      </label>
                      <span class="next-workday-passenger-field">
                        <input
                          class="form-control form-control-sm"
                          type="number"
                          min="0"
                          step="1"
                          inputmode="numeric"
                          data-next-workday-passengers
                          aria-label="${candidate.flightNo} 预定人数"
                          title="预定人数"
                          .value=${String(candidate.bookedPassengers)}
                          @change=${(event: Event) =>
                            this.updatePassengers(
                              candidate.id,
                              (event.currentTarget as HTMLInputElement).value
                            )}
                        />
                        <span aria-hidden="true">人</span>
                      </span>
                      <span class="badge text-bg-light flex-shrink-0"
                        >${candidate.positions.length} 岗</span
                      >
                    </div>`
                )}
              </div>`
            : html`<div class="empty-state">尚无可选择的本地航班</div>`
        }
        <div class="small text-secondary mt-3">
          已选择 ${selectedCount} 个航班
        </div>
        ${hasStaffStatusDraft ? this.staffStatusSection() : null}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-bs-dismiss="modal">
          取消
        </button>
        <button
          class="btn ${reschedule ? "btn-primary" : "btn-success"}"
          type="button"
          ?disabled=${selectedCount === 0}
          @click=${this.confirm}
        >
          <i
            class="bi bi-${reschedule ? "arrow-repeat" : "calendar2-check"} me-1"
          ></i
          >${reschedule ? "确认并重新排班" : schedulePreflight ? "确认并生成排班" : "归档并生成后天排班"}
        </button>
      </div>`;
  }

  private quickAction(label: string, action: () => void) {
    return html`<button
      class="btn btn-sm btn-outline-secondary"
      type="button"
      @click=${action}
    >
      ${label}
    </button>`;
  }

  private toggle(id: string, checked: boolean): void {
    const selected = new Set(this.dialog.selectedIds);
    checked ? selected.add(id) : selected.delete(id);
    this.dispatchSelection([...selected]);
  }

  private updatePassengers(id: string, value: string): void {
    dispatchUiCommand(this, {
      type:
        this.dialog.kind === "reschedule-flight-picker"
          ? "update-reschedule-flight-picker-passengers"
          : this.dialog.kind === "schedule-preflight"
            ? "update-schedule-preflight-passengers"
            : "update-next-workday-flight-picker-passengers",
      candidateId: id,
      bookedPassengers: value === "" ? 0 : Number(value),
    });
  }

  private restorePreset = (): void => {
    this.dispatchSelection(
      this.dialog.candidates
        .filter((candidate) => candidate.selectedByDefault)
        .map((candidate) => candidate.id)
    );
  };

  private selectAll = (): void => {
    this.dispatchSelection(
      this.dialog.candidates.map((candidate) => candidate.id)
    );
  };

  private clearAll = (): void => this.dispatchSelection([]);

  private dispatchSelection(selectedIds: string[]): void {
    dispatchUiCommand(this, {
      type:
        this.dialog.kind === "reschedule-flight-picker"
          ? "update-reschedule-flight-picker-selection"
          : this.dialog.kind === "schedule-preflight"
            ? "update-schedule-preflight-selection"
            : "update-next-workday-flight-picker-selection",
      selectedIds,
    });
  }

  private confirm = (): void => {
    if (!this.dialog.selectedIds.length) return;
    dispatchUiCommand(this, {
      type:
        this.dialog.kind === "reschedule-flight-picker"
          ? "confirm-reschedule-flight-picker"
          : this.dialog.kind === "schedule-preflight"
            ? "confirm-schedule-preflight"
            : "confirm-next-workday-flight-picker",
      selectedIds: this.dialog.selectedIds,
    });
  };

  private staffStatusSection() {
    if (this.dialog.kind === "reschedule-flight-picker") return null;
    const statuses = this.dialog.staffStatuses;
    return html`<section class="mt-4" aria-label="人员状态确认">
      <h3 class="h6 mb-2">确认休假人员</h3>
      <p class="small text-secondary">
        请核对以下人员状态，点击确认后开始排班。
      </p>
      <div class="list-group">
        ${this.model.staff.map(
          (person) =>
            html`<label
              class="list-group-item d-flex align-items-center justify-content-between gap-3"
            >
              <span>${person.name}</span>
              <select
                class="form-select form-select-sm w-auto"
                aria-label="${person.name} 状态"
                .value=${statuses[person.id] ?? person.status}
                @change=${(event: Event) =>
                  this.updateStaffStatus(
                    person.id,
                    (event.currentTarget as HTMLSelectElement)
                      .value as StaffStatus
                  )}
              >
                <option value="正常">正常</option>
                <option value="病假">病假</option>
                <option value="休假">休假</option>
              </select>
            </label>`
        )}
      </div>
    </section>`;
  }

  private updateStaffStatus(staffId: string, status: StaffStatus): void {
    dispatchUiCommand(this, {
      type:
        this.dialog.kind === "schedule-preflight"
          ? "update-schedule-preflight-staff-status"
          : "update-next-workday-flight-picker-staff-status",
      staffId,
      status,
    });
  }
}

customElements.define(
  "autoschedule-next-workday-flight-picker",
  NextWorkdayFlightPickerDialogElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-next-workday-flight-picker": NextWorkdayFlightPickerDialogElement;
  }
}
