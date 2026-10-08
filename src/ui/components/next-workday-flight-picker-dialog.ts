import { html } from "lit";

import type { ApplicationDialog } from "../../app/application-view-state";
import type { AppState, StaffStatus } from "../../model";
import type { DutyRosterSlot } from "../../domain/duty-roster/roster";
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
    const hasStaffStatusDraft = true;
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
        ${this.dutyRosterSection()}
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
    const statuses =
      this.dialog.staffStatuses ??
      Object.fromEntries(
        this.model.staff.map((person) => [person.id, person.status])
      );
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
          : this.dialog.kind === "reschedule-flight-picker"
            ? "update-reschedule-flight-picker-staff-status"
            : "update-next-workday-flight-picker-staff-status",
      staffId,
      status,
    });
  }

  private dutyRosterSection() {
    const roster = this.dialog.dutyRoster;
    if (!roster) return null;
    const slots: Array<[DutyRosterSlot, string, string | null]> = [
      ["cx-preflight", "CX 航前", roster.cxPreflightStaffId],
      ["duty", "主值班", roster.dutyStaffId],
      ["standby-0", "次日备勤一", roster.standbyStaffIds[0]],
      ["standby-1", "次日备勤二", roster.standbyStaffIds[1]],
    ];
    return html`<section class="mt-4" aria-label="值班人员确认">
      <h3 class="h6 mb-2">值班人员确认</h3>
      <div class="list-group">
        ${slots.map(
          ([slot, label, selected]) =>
            html`<label
              class="list-group-item d-flex align-items-center justify-content-between gap-3"
            >
              <span>${label}</span>
              <select
                class="form-select form-select-sm w-auto"
                aria-label="${label}"
                .value=${selected ?? ""}
                @change=${(event: Event) =>
                this.updateDutyRoster(
                  slot,
                  (event.currentTarget as HTMLSelectElement).value
                )}
              >
                <option value="">未安排</option>
                ${this.model.staff
                .filter((person) =>
                  this.dutyRosterOptionAllowed(person, slot, selected)
                )
                .map(
                  (person) =>
                    html`<option value=${person.id}>${person.name}</option>`
                )}
              </select>
            </label>`
        )}
      </div>
    </section>`;
  }

  private dutyRosterOptionAllowed(
    person: AppState["staff"][number],
    slot: DutyRosterSlot,
    selected: string | null
  ): boolean {
    if (person.id === selected) return true;
    if (person.staffType !== "常规") return false;
    if (slot === "cx-preflight") return person.cxPreflightQualified;
    if (slot === "duty") return person.dutyQualified;
    return person.standbyQualified;
  }

  private updateDutyRoster(slot: DutyRosterSlot, staffId: string): void {
    dispatchUiCommand(this, {
      type:
        this.dialog.kind === "schedule-preflight"
          ? "update-schedule-preflight-duty-roster"
          : this.dialog.kind === "reschedule-flight-picker"
            ? "update-reschedule-flight-picker-duty-roster"
            : "update-next-workday-flight-picker-duty-roster",
      slot,
      staffId,
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
