import type { UiCommand } from "../ui/events/ui-command";
import { ConfigurationController } from "./controllers/configuration-controller";
import { PolicyController } from "./controllers/policy-controller";
import { RecordsController } from "./controllers/records-controller";
import { ScheduleController } from "./controllers/schedule-controller";
import { TransferController } from "./controllers/transfer-controller";
import type {
  ApplicationContext,
  UiCommandController,
} from "./application-context";
import type { ApplicationViewState } from "./application-view-state";
import type {
  ScheduleRunnerCallbacks,
  ScheduleRunner,
} from "./schedule-run-controller";
import type { AutoscheduleStore } from "./store/autoschedule-store";
import { plannedScheduleProgress } from "../domain/kernel/schedule-pipeline";
import { todayIso } from "../utils";
import {
  latestScheduleDate,
  scheduleDisplaySource,
} from "../domain/records/schedule-dates";
import type { AppState } from "../model";
import type { ApplicationPreferences } from "./application-preferences";
import { isStorageQuotaExceeded } from "../infrastructure/storage";
import { halfRestSelectionForDate } from "../domain/records/half-rest-selections";
import { PolicyEditingSession } from "./policy-editing-session";
import { FlightIdentityEditingSession } from "./flight-identity-editing-session";
import {
  capturePreflightDraft,
  isPreflightDialog,
  restorePreflightDraft,
  type PreflightDraft,
  type PreflightDialog,
} from "./preflight-drafts";

export interface ApplicationCoordinatorOptions {
  preferences: ApplicationPreferences;
  confirm?: (message: string) => boolean;
  onViewChange?: (view: ApplicationViewState) => void;
  restoredScheduleNotice?: boolean;
}

export interface ApplicationCoordinatorDependencies {
  createScheduleRunner(callbacks: ScheduleRunnerCallbacks): ScheduleRunner;
}

const COMMANDS_ALLOWED_DURING_SCHEDULE_RUN = new Set<UiCommand["type"]>([
  "navigate",
  "close-dialog",
  "dismiss-toast",
  "set-schedule-zoom",
  "set-schedule-cell-size",
  "stop-schedule-without-result",
  "stop-schedule-with-current-result",
]);

const COMMANDS_THAT_MAY_RUN_SCHEDULE = new Set<UiCommand["type"]>([
  "generate-schedule",
  "confirm-schedule-preflight",
  "confirm-reschedule-flight-picker",
  "toggle-administrative-mode",
  "archive-next-duty-day",
  "confirm-next-workday-flight-picker",
]);

const COMMANDS_ALLOWED_DURING_HISTORY_EDIT = new Set<UiCommand["type"]>([
  "close-dialog",
  "dismiss-toast",
  "set-schedule-zoom",
  "set-schedule-cell-size",
  "assign-staff",
  "update-assignment",
  "create-temporary-assignment",
  "delete-temporary-assignment",
  "clear-schedule",
  "export-schedule",
  "export-share-html",
  "export-share-png",
  "save-history-edit",
  "cancel-history-edit",
]);

function mayRunSchedule(command: UiCommand): boolean {
  return (
    COMMANDS_THAT_MAY_RUN_SCHEDULE.has(command.type) ||
    (command.type === "update-configuration" &&
      command.entity === "staff" &&
      command.field === "status")
  );
}

const COMMANDS_USING_CURRENT_SCHEDULE = new Set<UiCommand["type"]>([
  "assign-staff",
  "update-assignment",
  "create-temporary-assignment",
  "delete-temporary-assignment",
  "clear-schedule",
  "archive-schedule",
  "archive-next-duty-day",
  "export-schedule",
  "export-share-html",
  "export-share-png",
  "open-team-leader-gap-fill",
  "preview-team-leader-gap-fill",
  "confirm-team-leader-gap-fill",
  "open-swap-analysis",
  "select-swap-target",
  "apply-swap-analysis",
  "toggle-administrative-mode",
]);

function initialView(
  preferences: ApplicationPreferences,
  model: AppState,
  restoredScheduleNotice = false
): ApplicationViewState {
  const storedZoom = preferences.loadScheduleZoom();
  const storedCellSize = preferences.loadScheduleCellSize?.();
  return {
    section: "overview",
    date: latestScheduleDate(model) ?? todayIso(),
    zoom: Math.min(1.6, Math.max(0.7, storedZoom || 1)),
    cellSize: Math.min(1.3, Math.max(0.8, storedCellSize || 1)),
    halfRestStaffIds: [],
    halfRestModes: {},
    historyEditDate: null,
    dialog: null,
    toast: null,
    restoredScheduleNotice,
    progress: {
      outcome: "idle",
      visible: false,
      stage: "prepare",
      percent: 0,
      steps: [],
      canAdoptCurrentResult: false,
    },
  };
}

export class ApplicationCoordinator implements ApplicationContext {
  readonly policyEditing = new PolicyEditingSession();
  readonly flightIdentityEditing = new FlightIdentityEditingSession();
  readonly scheduleRunner: ScheduleRunner;
  readonly preferences: ApplicationPreferences;
  private currentView: ApplicationViewState;
  private readonly controllers: UiCommandController[];
  private toastId = 0;
  private progressHideTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleCommandPending = false;
  private preflightDrafts: PreflightDraft[];

  constructor(
    readonly store: AutoscheduleStore,
    private readonly options: ApplicationCoordinatorOptions,
    dependencies: ApplicationCoordinatorDependencies
  ) {
    this.preferences = options.preferences;
    this.preflightDrafts = this.preferences.loadPreflightDrafts?.() ?? [];
    this.currentView = initialView(
      this.preferences,
      this.model(),
      options.restoredScheduleNotice
    );
    this.scheduleRunner = dependencies.createScheduleRunner({
      start: () => {
        if (this.progressHideTimer) clearTimeout(this.progressHideTimer);
        this.updateView({
          restoredScheduleNotice: false,
          progress: {
            outcome: "running",
            visible: true,
            stage: "prepare",
            percent: 0,
            steps: plannedScheduleProgress(
              this.model().settings,
              this.model().flights,
              this.model().positionRules
            ),
            canAdoptCurrentResult: false,
          },
        });
      },
      progress: (stage, percent) =>
        this.updateView({
          progress: {
            ...this.currentView.progress,
            outcome: "running",
            visible: true,
            stage,
            percent,
          },
        }),
      safeResultAvailable: () =>
        this.updateView({
          progress: {
            ...this.currentView.progress,
            canAdoptCurrentResult: true,
          },
        }),
      finish: (outcome) => {
        this.updateView({
          progress: { ...this.currentView.progress, outcome },
        });
        this.progressHideTimer = setTimeout(
          () =>
            this.updateView({
              progress: { ...this.currentView.progress, visible: false },
            }),
          outcome === "completed" ? 1600 : 5000
        );
      },
    });
    this.controllers = [
      new ConfigurationController(this),
      new PolicyController(this),
      new ScheduleController(this),
      new RecordsController(this),
      new TransferController(this),
    ];
  }

  start(): void {
    this.options.onViewChange?.(this.view());
  }

  view(): ApplicationViewState {
    return {
      ...this.currentView,
      policyEditing: this.policyEditing.view(this.model()),
      flightIdentityEditing: this.flightIdentityEditing.view(this.model()),
      ...halfRestSelectionForDate(this.model(), this.currentView.date),
    };
  }

  model() {
    return this.store.getState().model;
  }

  canTransferWorkspace(): boolean {
    return (
      !this.scheduleCommandPending &&
      !this.scheduleRunner.isRunning() &&
      !this.currentView.historyEditDate
    );
  }

  hasUnsavedRules(): boolean {
    return (
      this.policyEditing.view(this.model()).dirty ||
      this.flightIdentityEditing.view(this.model()).dirty
    );
  }

  confirmLeaveRules(
    confirm = (message: string) => this.confirm(message)
  ): boolean {
    if (!this.hasUnsavedRules()) return true;
    if (
      !confirm(
        "规则或航班档案有未保存的修改。点“取消”返回继续编辑并点击“保存规则”或“确认并保存航班档案”；点“确定”将放弃这些修改并离开。"
      )
    )
      return false;
    this.policyEditing.discard();
    this.flightIdentityEditing.discard();
    this.updateView({});
    return true;
  }

  updateView(patch: Partial<ApplicationViewState>): void {
    if (isPreflightDialog(patch.dialog)) {
      const draft = capturePreflightDraft(patch.dialog);
      this.preflightDrafts = [
        ...this.preflightDrafts.filter(
          (item) => item.groupId !== draft.groupId || item.date !== draft.date
        ),
        draft,
      ];
    }
    this.currentView = { ...this.currentView, ...patch };
    if (isPreflightDialog(patch.dialog)) this.savePreflightDrafts();
    this.options.onViewChange?.(this.view());
  }

  openPreflightDialog(dialog: PreflightDialog): void {
    const saved = this.preflightDrafts.find(
      (draft) => draft.groupId === dialog.groupId && draft.date === dialog.date
    );
    this.updateView({
      dialog: saved
        ? restorePreflightDraft(dialog, saved, this.model())
        : dialog,
    });
  }

  private savePreflightDrafts(): void {
    try {
      this.preferences.savePreflightDrafts?.(this.preflightDrafts);
    } catch {
      this.toast(
        "准备选项暂时只保留在当前页面，未能保存到浏览器；刷新或关闭页面后可能丢失，请恢复浏览器存储后重试。",
        "warning"
      );
    }
  }

  commit(message?: string): void {
    if (
      this.currentView.historyEditDate &&
      !message?.includes("历史排班已更新")
    ) {
      if (message) this.toast(message);
      return;
    }
    try {
      const result = this.store.getState().persist();
      if (result.nearCapacity) {
        this.toast(
          `${message ? `${message}。` : ""}本地数据已接近浏览器存储上限，请尽快导出配置和历史排班备份。系统不会自动删除历史记录。`,
          "warning"
        );
        return;
      }
      if (message) this.toast(message);
    } catch (error) {
      this.toast(
        isStorageQuotaExceeded(error)
          ? "本次修改暂时只保留在当前页面中，未保存到浏览器：存储空间不足。请尽快导出配置和历史排班备份，再清理不再需要的历史记录。"
          : "本次修改暂时只保留在当前页面中，未能保存到浏览器。请尽快导出配置和历史排班备份后重试。",
        "danger"
      );
    }
  }

  toast(
    message: string,
    tone: "success" | "danger" | "warning" = "success"
  ): void {
    this.updateView({ toast: { id: ++this.toastId, message, tone } });
  }

  confirm(message: string): boolean {
    return (this.options.confirm ?? globalThis.confirm)(message);
  }

  async handle(command: UiCommand): Promise<void> {
    if (
      this.currentView.historyEditDate &&
      !COMMANDS_ALLOWED_DURING_HISTORY_EDIT.has(command.type)
    ) {
      this.toast("历史排班正在编辑，请先保存或取消编辑", "warning");
      return;
    }
    if (
      (this.scheduleCommandPending || this.scheduleRunner.isRunning()) &&
      !COMMANDS_ALLOWED_DURING_SCHEDULE_RUN.has(command.type)
    ) {
      this.toast("排班正在计算，请等待当前任务完成", "warning");
      return;
    }
    if (
      !this.currentView.historyEditDate &&
      this.currentView.section === "schedule" &&
      scheduleDisplaySource(this.model(), this.currentView.date) !==
        "current" &&
      (this.model().assignments.length > 0 ||
        scheduleDisplaySource(this.model(), this.currentView.date) ===
          "history") &&
      COMMANDS_USING_CURRENT_SCHEDULE.has(command.type)
    ) {
      this.toast(
        scheduleDisplaySource(this.model(), this.currentView.date) === "history"
          ? "当前显示已保存历史，请先点击“编辑该日排班”，再调整或导出。"
          : "当前日期没有班表，请先生成排班或选择已有班表的日期。",
        "warning"
      );
      return;
    }
    if (
      ((command.type === "navigate" &&
        command.section !== this.currentView.section) ||
        command.type === "apply-workbook-import") &&
      !this.confirmLeaveRules()
    )
      return;
    if (command.type === "export-config" && this.hasUnsavedRules()) {
      this.toast(
        "规则或航班档案尚未保存，请先点击“保存规则”或“确认并保存航班档案”，再导出配置。",
        "warning"
      );
      return;
    }
    const reservesSchedule = mayRunSchedule(command);
    if (reservesSchedule) this.scheduleCommandPending = true;
    try {
      if (this.handleViewCommand(command)) return;
      for (const controller of this.controllers) {
        if (await controller.handle(command)) return;
      }
      throw new Error(`未处理的界面命令：${command.type}`);
    } finally {
      if (reservesSchedule) this.scheduleCommandPending = false;
    }
  }

  private handleViewCommand(command: UiCommand): boolean {
    switch (command.type) {
      case "edit-flight-identities":
        this.flightIdentityEditing.edit(this.model(), command.identities);
        this.updateView({});
        return true;
      case "discard-flight-identities":
        this.flightIdentityEditing.discard();
        this.updateView({});
        return true;
      case "save-flight-identities":
        try {
          const result = this.store
            .getState()
            .saveFlightIdentities(command.identities, command.fingerprint);
          this.flightIdentityEditing.discard();
          this.toast(
            result.nearCapacity
              ? "航班档案已保存，但浏览器存储接近上限，请及时备份。"
              : "航班档案已保存，两组规则自动共用；已有班表请重新排班。云端版请再点击顶部“保存到云端”。",
            result.nearCapacity ? "warning" : "success"
          );
        } catch (error) {
          this.toast(
            `航班档案未保存，原数据和草稿均保留：${error instanceof Error ? error.message : "请重试"}`,
            "danger"
          );
        }
        return true;
      case "save-policy":
        if (!this.policyEditing.view(this.model()).dirty) return true;
        try {
          const settings = this.policyEditing.prepareSave(this.model());
          const result = this.store.getState().savePolicySettings(settings);
          this.policyEditing.discard();
          this.toast(
            result.nearCapacity
              ? "规则已保存，但浏览器存储接近上限，请及时备份。"
              : "全部规则已保存；当前班表需重新排班后执行。云端版请再点击顶部“保存到云端”。",
            result.nearCapacity ? "warning" : "success"
          );
        } catch (error) {
          this.toast(
            `规则未保存，原规则和草稿均保留：${error instanceof Error ? error.message : "请重试。"}`,
            "danger"
          );
        }
        return true;
      case "discard-policy":
        this.confirmLeaveRules();
        return true;
      case "navigate":
        this.updateView({ section: command.section });
        return true;
      case "change-date":
        if (this.currentView.historyEditDate) {
          this.toast("请先保存或取消当前历史排班编辑", "warning");
          return true;
        }
        this.preferences.saveScheduleDate(command.date);
        this.updateView({
          date: command.date,
          historyEditDate: null,
        });
        return true;
      case "switch-group":
        if (this.store.getState().isDirty()) {
          if (!this.confirm("当前组有未保存的班表或配置，是否先保存再切换？")) {
            this.toast("已取消切换，当前组数据未改变", "warning");
            return true;
          }
          this.commit("当前组已保存");
        }
        if (
          command.groupId !== this.model().activeGroupId &&
          !this.confirmLeaveRules()
        )
          return true;
        this.store.getState().switchGroup(command.groupId);
        this.commit(`已切换到${command.groupId}组`);
        this.updateView({
          date: latestScheduleDate(this.model()) ?? todayIso(),
          historyEditDate: null,
          restoredScheduleNotice: false,
        });
        return true;
      case "close-dialog":
        this.updateView({ dialog: null });
        return true;
      case "dismiss-toast":
        this.updateView({ toast: null });
        return true;
      case "reset-all":
        if (this.confirm("确认恢复初始数据？当前本地数据将被替换。")) {
          if (!this.confirmLeaveRules()) return true;
          this.store.getState().reset();
          this.preflightDrafts = [];
          this.savePreflightDrafts();
          this.updateView({ dialog: null });
          this.commit("已恢复初始数据");
        }
        return true;
      case "open-import":
        return false;
      default:
        return false;
    }
  }
}
