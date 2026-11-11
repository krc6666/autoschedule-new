import { html } from "lit";
import { createRef, ref, type Ref } from "lit/directives/ref.js";

import type { ApplicationViewState } from "../../app/application-view-state";
import type { AppSection, AppState } from "../../model";
import {
  UI_COMMAND_EVENT,
  dispatchUiCommand,
  type UiCommand,
  type UiCommandEvent,
} from "../events/ui-command";
import { APPLICATION_NAVIGATION } from "../projections/application-navigation";
import { LightDomElement } from "./light-dom-element";
import "./app-dialog";
import "./flight-season-review";
import "./app-toast";
import "./config-page";
import "./flights-page";
import "./history-page";
import "./overview-page";
import "./policy-page";
import "./schedule-page";
import "./schedule-progress-panel";
import "./statistics-page";

export interface UiCommandHandler {
  handle(command: UiCommand): Promise<void>;
}

interface PendingImport {
  mode: Extract<UiCommand, { type: "open-import" }>["mode"];
  date?: string;
}

export class AutoscheduleAppElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    view: { attribute: false },
    commandHandler: { attribute: false },
  };
  model!: AppState;
  view!: ApplicationViewState;
  commandHandler!: UiCommandHandler;
  private readonly workbookInput: Ref<HTMLInputElement> = createRef();
  private pendingImport: PendingImport = { mode: "all" };

  constructor() {
    super();
    this.addEventListener(
      UI_COMMAND_EVENT,
      this.handleCommand as EventListener
    );
  }

  protected override render() {
    if (!this.model || !this.view) return null;
    const assigned = this.model.assignments.filter(
      (item) => item.status === "assigned"
    ).length;
    const unfilled = this.model.assignments.filter(
      (item) => item.status === "unfilled"
    ).length;
    const active = APPLICATION_NAVIGATION.find(
      (item) => item.id === this.view.section
    );
    return html`
      <div class="group-switcher" role="group" aria-label="排班组">
        <label class="small text-secondary" for="active-group">当前组</label>
        <select
          id="active-group"
          class="form-select form-select-sm"
          @change=${this.switchGroup}
        >
          <option value="A" ?selected=${this.model.activeGroupId === "A"}>
            A 组
          </option>
          <option value="B" ?selected=${this.model.activeGroupId === "B"}>
            B 组
          </option>
        </select>
      </div>
      <header class="app-header border-bottom bg-white sticky-top">
        <div
          class="container-fluid app-container d-flex align-items-center gap-3 py-2"
        >
          <div class="brand-mark" aria-hidden="true">
            <i class="bi bi-calendar2-week"></i>
          </div>
          <div class="me-auto min-w-0">
            <h1 class="h5 mb-0 text-truncate">自动排班</h1>
            <div class="small text-secondary">机场地勤 · 本地工作台</div>
          </div>
          <label class="date-control d-flex align-items-center gap-2">
            <i class="bi bi-calendar3 text-secondary"></i>
            <input
              class="form-control form-control-sm"
              type="date"
              .value=${this.view.date}
              aria-label="排班日期"
              @change=${this.changeDate}
            />
          </label>
          <span class="save-state small text-secondary d-none d-md-inline"
            ><i class="bi bi-check-circle me-1"></i>已保存</span
          >
        </div>
      </header>
      <div class="container-fluid app-container app-layout">
        <nav class="app-nav" aria-label="主要导航">
          ${APPLICATION_NAVIGATION.map(
            (item) =>
              html`<button
                class="nav-item ${this.view.section === item.id ? "active" : ""}"
                type="button"
                title=${item.label}
                @click=${() => this.command({ type: "navigate", section: item.id })}
              >
                <i class="bi bi-${item.icon}"></i><span>${item.label}</span>
              </button>`
          )}
          <div class="nav-spacer"></div>
          <button
            class="nav-item nav-data-action"
            type="button"
            title="导入配置、航班计划或历史排班结果"
            @click=${() => this.openImport({ mode: "all" })}
          >
            <i class="bi bi-file-earmark-arrow-up"></i><span>导入数据</span>
          </button>
          <button
            class="nav-item nav-data-action"
            type="button"
            title="导出配置"
            @click=${() => this.command({ type: "export-config" })}
          >
            <i class="bi bi-file-earmark-arrow-down"></i><span>导出配置</span>
          </button>
        </nav>
        <main class="app-main">
          <div
            class="content-head d-flex align-items-center justify-content-between gap-3"
          >
            <div>
              <h2 class="h4 mb-1">${active?.label ?? "工作台"}</h2>
              <div class="small text-secondary">
                ${this.model.flights.length} 个航班 ·
                ${this.model.staff.filter((person) => person.status === "正常").length}
                人可用 · ${assigned}
                个岗位已排${unfilled ? html` · <span class="text-danger">${unfilled} 个待补位</span>` : ""}
              </div>
            </div>
          </div>
          <autoschedule-flight-season-review
            .model=${this.model}
          ></autoschedule-flight-season-review>
          <div class="view-root">${this.page(this.view.section)}</div>
        </main>
      </div>
      <input
        ${ref(this.workbookInput)}
        class="visually-hidden"
        type="file"
        accept=".xlsx,.xls"
        @change=${this.importFile}
      />
      <autoschedule-progress-panel
        .progress=${this.view.progress}
      ></autoschedule-progress-panel>
      <autoschedule-app-toast
        .toast=${this.view.toast}
      ></autoschedule-app-toast>
      <autoschedule-app-dialog
        .model=${this.model}
        .dialog=${this.view.dialog}
      ></autoschedule-app-dialog>
    `;
  }

  private switchGroup(event: Event): void {
    const groupId = (event.currentTarget as HTMLSelectElement).value as
      "A" | "B";
    dispatchUiCommand(this, { type: "switch-group", groupId });
  }

  private page(section: AppSection) {
    if (section === "overview")
      return html`<autoschedule-overview-page
        .model=${this.model}
        .date=${this.view.date}
      ></autoschedule-overview-page>`;
    if (section === "config")
      return html`<autoschedule-config-page
        .model=${this.model}
      ></autoschedule-config-page>`;
    if (section === "flights")
      return html`<autoschedule-flights-page
        .model=${this.model}
      ></autoschedule-flights-page>`;
    if (section === "schedule")
      return html`<autoschedule-schedule-page
        .model=${this.model}
        .date=${this.view.date}
        .zoom=${this.view.zoom}
        .halfRestStaffIds=${this.view.halfRestStaffIds}
        .halfRestModes=${this.view.halfRestModes}
        .historyEditDate=${this.view.historyEditDate}
        .restoredScheduleNotice=${this.view.restoredScheduleNotice ?? false}
      ></autoschedule-schedule-page>`;
    if (section === "policy")
      return html`<autoschedule-policy-page
        .model=${this.model}
        .query=${this.view.policyQuery ?? ""}
      ></autoschedule-policy-page>`;
    if (section === "statistics")
      return html`<autoschedule-statistics-page
        .model=${this.model}
        .date=${this.view.date}
      ></autoschedule-statistics-page>`;
    return html`<autoschedule-history-page
      .model=${this.model}
    ></autoschedule-history-page>`;
  }

  private readonly handleCommand = (event: UiCommandEvent): void => {
    event.stopPropagation();
    if (event.detail.type === "open-import") {
      this.openImport({ mode: event.detail.mode, date: event.detail.date });
      return;
    }
    void this.commandHandler.handle(event.detail);
  };

  private command(command: UiCommand): void {
    void this.commandHandler.handle(command);
  }

  private changeDate(event: Event): void {
    this.command({
      type: "change-date",
      date: (event.currentTarget as HTMLInputElement).value,
    });
  }

  private openImport(request: PendingImport): void {
    this.pendingImport = request;
    const input = this.workbookInput.value;
    if (!input) return;
    input.value = "";
    input.click();
  }

  private importFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.command({ type: "import-file", file, ...this.pendingImport });
    input.value = "";
  }
}

customElements.define("autoschedule-app", AutoscheduleAppElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-app": AutoscheduleAppElement;
  }
}
