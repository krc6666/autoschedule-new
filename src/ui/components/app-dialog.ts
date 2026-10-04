import Modal from "bootstrap/js/dist/modal";
import { html, nothing, type PropertyValues } from "lit";
import { createRef, ref, type Ref } from "lit/directives/ref.js";

import type { ApplicationDialog } from "../../app/application-view-state";
import type { AppState } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import "./duty-roster-import-dialog";
import "./flight-query-dialog";
import "./qualification-dialog";
import "./template-picker-dialog";
import "./next-workday-flight-picker-dialog";
import "./workbook-import-dialog";
import "./legacy-schedule-import-dialog";
import "./late-priority-counts-import-dialog";
import "./swap-analysis-dialog";
import "./team-leader-gap-fill-dialog";
import { weekdayLabel } from "../../domain/flights/weekly-flight-plan";

export class AppDialogElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    dialog: { attribute: false },
  };
  model!: AppState;
  dialog: ApplicationDialog | null = null;
  private readonly modalRef: Ref<HTMLDivElement> = createRef();

  protected override render() {
    return html`<div
      ${ref(this.modalRef)}
      class="modal fade"
      tabindex="-1"
      aria-hidden="true"
      @hidden.bs.modal=${this.closed}
    >
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title fs-5">${this.titleText()}</h2>
            <button
              type="button"
              class="btn-close"
              data-bs-dismiss="modal"
              aria-label="关闭"
            ></button>
          </div>
          ${this.content()}
        </div>
      </div>
    </div>`;
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("dialog") || !this.modalRef.value) return;
    const instance = Modal.getOrCreateInstance(this.modalRef.value);
    if (this.dialog) instance.show();
    else instance.hide();
  }

  private titleText(): string {
    const dialog = this.dialog;
    if (dialog?.kind === "schedule-preflight")
      return "确认 " + dialog.date + " 航班与人员状态";
    if (dialog?.kind === "templates") return "从模板添加航班";
    if (dialog?.kind === "reschedule-flight-picker")
      return `确认 ${dialog.date} 航班与人数`;
    if (dialog?.kind === "next-workday-flight-picker")
      return `确认 ${dialog.date}（${weekdayLabel(dialog.weekday)}）航班`;
    if (dialog?.kind === "qualification") {
      const rule = this.model.positionRules.find(
        (item) => item.id === dialog.positionRuleId
      );
      return rule ? `${rule.flightNo} / ${rule.name} 资质` : "岗位资质";
    }
    if (dialog?.kind === "flight-query") return "在线查询航班";
    if (dialog?.kind === "duty-roster-import") return "值班备勤表导入预览";
    if (dialog?.kind === "late-priority-counts-import")
      return "末班重点岗位次数导入预览";
    if (dialog?.kind === "workbook-import")
      return dialog.changedConfig ? "配置导入预览" : "历史导入预览";
    if (dialog?.kind === "legacy-schedule-import")
      return "旧版手工排班导入预览";
    if (dialog?.kind === "swap-analysis") return "调整原因分析";
    if (dialog?.kind === "team-leader-gap-fill") return "分队长补差";
    return "";
  }

  private content() {
    const dialog = this.dialog;
    if (dialog?.kind === "templates")
      return html`<autoschedule-template-picker
        class="modal-content-stack"
        .model=${this.model}
      ></autoschedule-template-picker>`;
    if (
      dialog?.kind === "next-workday-flight-picker" ||
      dialog?.kind === "schedule-preflight" ||
      dialog?.kind === "reschedule-flight-picker"
    )
      return html`<autoschedule-next-workday-flight-picker
        class="modal-content-stack"
        .model=${this.model}
        .dialog=${dialog}
      ></autoschedule-next-workday-flight-picker>`;
    if (dialog?.kind === "qualification")
      return html`<autoschedule-qualification-dialog
        class="modal-content-stack"
        .model=${this.model}
        .positionRuleId=${dialog.positionRuleId}
      ></autoschedule-qualification-dialog>`;
    if (dialog?.kind === "flight-query")
      return html`<autoschedule-flight-query-dialog
        class="modal-content-stack"
        .dialog=${dialog}
      ></autoschedule-flight-query-dialog>`;
    if (dialog?.kind === "duty-roster-import")
      return html`<autoschedule-duty-roster-import-dialog
        class="modal-content-stack"
        .model=${this.model}
        .preview=${dialog.preview}
      ></autoschedule-duty-roster-import-dialog>`;
    if (dialog?.kind === "late-priority-counts-import")
      return html`<autoschedule-late-priority-counts-import-dialog
        class="modal-content-stack"
        .dialog=${dialog}
      ></autoschedule-late-priority-counts-import-dialog>`;
    if (dialog?.kind === "workbook-import")
      return html`<autoschedule-workbook-import-dialog
        class="modal-content-stack"
        .model=${this.model}
        .dialog=${dialog}
      ></autoschedule-workbook-import-dialog>`;
    if (dialog?.kind === "legacy-schedule-import")
      return html`<autoschedule-legacy-schedule-import-dialog
        class="modal-content-stack"
        .date=${dialog.date}
        .preview=${dialog.preview}
      ></autoschedule-legacy-schedule-import-dialog>`;
    if (dialog?.kind === "swap-analysis")
      return html`<autoschedule-swap-analysis-dialog
        class="modal-content-stack"
        .model=${this.model}
        .dialog=${dialog}
      ></autoschedule-swap-analysis-dialog>`;
    if (dialog?.kind === "team-leader-gap-fill")
      return html`<autoschedule-team-leader-gap-fill-dialog
        class="modal-content-stack"
        .model=${this.model}
        .dialog=${dialog}
      ></autoschedule-team-leader-gap-fill-dialog>`;
    return nothing;
  }

  private closed(): void {
    if (this.dialog) dispatchUiCommand(this, { type: "close-dialog" });
  }
}

customElements.define("autoschedule-app-dialog", AppDialogElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-app-dialog": AppDialogElement;
  }
}
