import { html } from "lit";

import type { AppState, Staff } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

export class StaffPaletteElement extends LightDomElement {
  static override properties = { model: { attribute: false } };
  model!: AppState;

  protected override render() {
    const regular = this.model.staff.filter(
      (person) => person.staffType !== "行政支援"
    );
    const administrative = this.model.staff.filter(
      (person) => person.staffType === "行政支援"
    );
    return html`<aside class="staff-palette">
      <div class="staff-palette-section">
        <div class="staff-palette-head">
          <strong>常规人员</strong
          ><span
            >${regular.filter((person) => person.status === "正常").length}
            人可用</span
          >
        </div>
        <div class="staff-palette-list">
          ${regular.map((person) => this.person(person, false))}
        </div>
      </div>
      ${
        this.model.settings.adminSupportEnabled
          ? html`<div class="staff-palette-section admin-support-palette">
              <div class="staff-palette-head">
                <strong>行政支援人员</strong>
                <button
                  class="btn btn-sm icon-btn"
                  type="button"
                  title="新增行政支援人员"
                  aria-label="新增行政支援人员"
                  @click=${() => dispatchUiCommand(this, { type: "add-staff", administrative: true })}
                >
                  <i class="bi bi-plus-lg"></i>
                </button>
              </div>
              <div class="staff-palette-list">
                ${administrative.length ? administrative.map((person) => this.person(person, true)) : html`<div class="staff-palette-empty">暂无人员</div>`}
              </div>
            </div>`
          : null
      }
    </aside>`;
  }

  private person(person: Staff, administrative: boolean) {
    const disabled = person.status !== "正常";
    return html`<div
      class="staff-palette-item ${administrative ? "is-admin-support" : ""} ${disabled ? "is-disabled" : ""}"
      draggable=${String(!disabled)}
      title="#${person.id} ${person.status}"
      @dragstart=${(event: DragEvent) => this.startDrag(event, person.id)}
      @pointerdown=${() => this.startPointerDrag(person.id)}
    >
      <i class="bi bi-grip-vertical"></i>
      ${
        administrative
          ? html`<input
                class="staff-palette-name"
                .value=${person.name}
                aria-label="行政支援人员姓名"
                @change=${(event: Event) => dispatchUiCommand(this, { type: "update-configuration", entity: "staff", id: person.id, field: "name", value: (event.currentTarget as HTMLInputElement).value })}
              />
              <button
                class="btn btn-sm icon-btn"
                type="button"
                title="删除行政支援人员"
                aria-label="删除行政支援人员"
                @click=${() => dispatchUiCommand(this, { type: "delete-staff", id: person.id })}
              >
                <i class="bi bi-x"></i>
              </button>`
          : html`<span>${person.name}</span>`
      }
    </div>`;
  }

  private startDrag(event: DragEvent, staffId: string): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-autoschedule",
      JSON.stringify({ staffId })
    );
  }

  private startPointerDrag(staffId: string): void {
    this.dispatchEvent(
      new CustomEvent("autoschedule-pointer-drag-start", {
        detail: { staffId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

customElements.define("autoschedule-staff-palette", StaffPaletteElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-staff-palette": StaffPaletteElement;
  }
}
