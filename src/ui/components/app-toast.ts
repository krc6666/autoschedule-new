import Toast from "bootstrap/js/dist/toast";
import { html, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";

import type { ApplicationToast } from "../../app/application-view-state";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";
import { warningSummary } from "../../domain/reviews/warning-presentation";

export class AppToastElement extends LightDomElement {
  static override properties = { toast: { attribute: false } };
  toast: ApplicationToast | null = null;
  private readonly toastRef: Ref<HTMLDivElement> = createRef();

  protected override render() {
    const tone = this.toast?.tone ?? "success";
    return html`<div class="toast-container position-fixed bottom-0 end-0 p-3">
      <div
        ${ref(this.toastRef)}
        class="toast align-items-center border-0 text-bg-${tone}"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        @hidden.bs.toast=${this.dismiss}
      >
        <div class="d-flex">
          <div class="toast-body">
            ${
              this.toast?.tone === "warning" &&
              !this.toast.details &&
              warningSummary(this.toast.message) !== this.toast.message
                ? keyed(
                    this.toast.id,
                    html`${warningSummary(this.toast.message)}
                      <details>
                        <summary>查看具体原因</summary>
                        <div style="white-space: pre-line">
                          ${this.toast.message}
                        </div>
                      </details>`
                  )
                : (this.toast?.message ?? "")
            }
            ${
              this.toast?.details?.code === "local-vacancies"
                ? keyed(
                    this.toast.id,
                    html`<ul
                      class="mt-2 mb-0 ps-3"
                      style="max-height: 50vh; overflow-y: auto;"
                    >
                      ${this.toast.details.vacancies?.map(
                        (vacancy) =>
                          html`<li
                            data-vacancy-assignment-id=${vacancy.assignmentId}
                          >
                            ${vacancy.label}
                            <details class="toast-vacancy-details">
                              <summary>原因</summary>
                              <div class="toast-vacancy-reasons">
                                ${
                                  vacancy.reasons.length
                                    ? vacancy.reasons.map(
                                        (reason) => html`<p>${reason}</p>`
                                      )
                                    : html`<p>这次没有记录到具体原因。</p>`
                                }
                              </div>
                            </details>
                          </li>`
                      )}
                    </ul>`
                  )
                : this.toast?.details
                  ? html`<details .open=${false} data-schedule-failure-details>
                      <summary>查看原因和解决办法</summary>
                      <div
                        class="mt-2"
                        style="max-height: 50vh; overflow-y: auto;"
                      >
                        <p>
                          ${this.toast.details.date}：${this.toast.details.reason}
                        </p>
                        ${this.toast.details.facts.map((fact) => html`<p>${fact}</p>`)}
                        <ol>
                          ${this.toast.details.steps.map((step) => html`<li class="mb-2">${step}</li>`)}
                        </ol>
                        <button
                          type="button"
                          class="btn btn-sm btn-light"
                          @click=${() => dispatchUiCommand(this, { type: "export-schedule-failure-details" })}
                        >
                          导出诊断记录
                        </button>
                      </div>
                    </details>`
                  : null
            }
          </div>
          <button
            type="button"
            class="btn-close btn-close-white me-2 m-auto"
            data-bs-dismiss="toast"
            aria-label="关闭"
          ></button>
        </div>
      </div>
    </div>`;
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("toast") || !this.toast || !this.toastRef.value) return;
    Toast.getInstance(this.toastRef.value)?.dispose();
    Toast.getOrCreateInstance(this.toastRef.value, {
      animation: false,
      autohide:
        this.toast.tone !== "danger" &&
        !this.toast.details &&
        !(
          this.toast.tone === "warning" &&
          warningSummary(this.toast.message) !== this.toast.message
        ),
      delay: 3600,
    }).show();
  }

  private dismiss(): void {
    if (this.toast) dispatchUiCommand(this, { type: "dismiss-toast" });
  }
}

customElements.define("autoschedule-app-toast", AppToastElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-app-toast": AppToastElement;
  }
}
