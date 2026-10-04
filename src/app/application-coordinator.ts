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
import type { ApplicationPreferences } from "./application-preferences";
import { isStorageQuotaExceeded } from "../infrastructure/storage";

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
  "set-load-sort",
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
  "set-load-sort",
  "assign-staff",
  "update-assignment",
  "create-temporary-assignment",
  "delete-temporary-assignment",
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

function initialView(
  preferences: ApplicationPreferences,
  restoredScheduleNotice = false
): ApplicationViewState {
  const storedZoom = preferences.loadScheduleZoom();
  return {
    section: "overview",
    date: preferences.loadScheduleDate() || todayIso(),
    zoom: Math.min(1.6, Math.max(0.7, storedZoom || 1)),
    loadSortField: "totalFatigue",
    loadSortDirection: "desc",
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
  readonly scheduleRunner: ScheduleRunner;
  readonly preferences: ApplicationPreferences;
  private currentView: ApplicationViewState;
  private readonly controllers: UiCommandController[];
  private toastId = 0;
  private progressHideTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleCommandPending = false;

  constructor(
    readonly store: AutoscheduleStore,
    private readonly options: ApplicationCoordinatorOptions,
    dependencies: ApplicationCoordinatorDependencies
  ) {
    this.preferences = options.preferences;
    this.currentView = initialView(
      this.preferences,
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
    this.options.onViewChange?.(this.currentView);
  }

  view(): ApplicationViewState {
    return this.currentView;
  }

  model() {
    return this.store.getState().model;
  }

  updateView(patch: Partial<ApplicationViewState>): void {
    this.currentView = { ...this.currentView, ...patch };
    this.options.onViewChange?.(this.currentView);
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
          halfRestStaffIds: [],
          halfRestModes: {},
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
        this.store.getState().switchGroup(command.groupId);
        this.commit(`已切换到${command.groupId}组`);
        this.updateView({
          halfRestStaffIds: [],
          halfRestModes: {},
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
          this.store.getState().reset();
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
