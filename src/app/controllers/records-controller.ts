import type { UiCommand } from "../../ui/events/ui-command";
import type {
  ApplicationContext,
  UiCommandController,
} from "../application-context";
import {
  buildHistoricalScheduleDraft,
  currentScheduleHistory,
  replaceHistoryForDate,
} from "../history-actions";
import type { AppState } from "../../model";

export class RecordsController implements UiCommandController {
  private historicalEditSnapshot: {
    flights: AppState["flights"];
    assignments: AppState["assignments"];
    activeScheduleDate: AppState["activeScheduleDate"];
    schedulePolicyStale: AppState["schedulePolicyStale"];
  } | null = null;
  private historicalEditWarnings: string[] = [];

  constructor(private readonly context: ApplicationContext) {}

  async handle(command: UiCommand): Promise<boolean> {
    const records = this.context.store.getState().records;
    switch (command.type) {
      case "clear-history":
        if (
          this.context.model().history.length &&
          this.context.confirm("确认清空全部历史排班？")
        ) {
          records.clearHistory();
          this.context.commit("历史排班已清空");
        }
        return true;
      case "delete-history":
        records.deleteHistory(command.id);
        this.context.commit("历史记录已删除");
        return true;
      case "edit-history-date": {
        if (this.context.view().historyEditDate) {
          this.context.toast("请先保存或取消当前历史排班编辑", "warning");
          return true;
        }
        const draft = buildHistoricalScheduleDraft(
          this.context.model(),
          command.date
        );
        if (!draft.assignments.length) {
          this.context.toast(draft.warnings.join("；"), "warning");
          return true;
        }
        this.historicalEditSnapshot = {
          flights: structuredClone(this.context.model().flights),
          assignments: structuredClone(this.context.model().assignments),
          activeScheduleDate: this.context.model().activeScheduleDate,
          schedulePolicyStale: this.context.model().schedulePolicyStale,
        };
        this.historicalEditWarnings = draft.warnings;
        const nextState = structuredClone(this.context.model());
        nextState.flights = draft.flights;
        nextState.assignments = draft.assignments;
        nextState.activeScheduleDate = command.date;
        nextState.schedulePolicyStale = false;
        this.context.store.getState().replaceModel(nextState);
        this.context.updateView({
          section: "schedule",
          date: command.date,
          historyEditDate: command.date,
        });
        if (draft.warnings.length)
          this.context.toast(draft.warnings.join("；"), "warning");
        return true;
      }
      case "save-history-edit": {
        const date = this.context.view().historyEditDate;
        if (!date) return true;
        if (this.historicalEditWarnings.length) {
          this.context.toast(
            `当前历史排班存在无法匹配的记录，不能覆盖保存。请取消编辑并补齐配置后重试：${this.historicalEditWarnings.join("；")}`,
            "warning"
          );
          return true;
        }
        if (
          !this.context.confirm(`确认用当前编辑结果覆盖 ${date} 的历史排班？`)
        )
          return true;
        const replacement = currentScheduleHistory(this.context.model(), date, {
          includeUnavailableStaff: true,
        }).filter((item) => item.flightNo !== "轮值");
        replacement.push(
          ...this.context
            .model()
            .history.filter(
              (item) => item.date === date && item.flightNo === "轮值"
            )
        );
        const restored = structuredClone(this.context.model());
        restored.flights =
          this.historicalEditSnapshot?.flights ?? restored.flights;
        restored.assignments =
          this.historicalEditSnapshot?.assignments ?? restored.assignments;
        restored.activeScheduleDate =
          this.historicalEditSnapshot?.activeScheduleDate ??
          restored.activeScheduleDate;
        restored.schedulePolicyStale =
          this.historicalEditSnapshot?.schedulePolicyStale ??
          restored.schedulePolicyStale;
        replaceHistoryForDate(restored, date, replacement);
        this.context.store.getState().replaceModel(restored);
        this.historicalEditSnapshot = null;
        this.historicalEditWarnings = [];
        this.context.updateView({
          section: "history",
          date: restored.activeScheduleDate ?? date,
          historyEditDate: null,
        });
        this.context.commit("历史排班已更新");
        return true;
      }
      case "cancel-history-edit": {
        if (!this.historicalEditSnapshot) return true;
        const restored = structuredClone(this.context.model());
        restored.flights = this.historicalEditSnapshot.flights;
        restored.assignments = this.historicalEditSnapshot.assignments;
        restored.activeScheduleDate =
          this.historicalEditSnapshot.activeScheduleDate;
        restored.schedulePolicyStale =
          this.historicalEditSnapshot.schedulePolicyStale;
        this.context.store.getState().replaceModel(restored);
        const restoredDate =
          restored.activeScheduleDate ?? this.context.view().date;
        this.historicalEditSnapshot = null;
        this.historicalEditWarnings = [];
        this.context.updateView({
          section: restored.activeScheduleDate ? "schedule" : "history",
          date: restoredDate,
          historyEditDate: null,
        });
        this.context.commit("已取消历史排班编辑");
        return true;
      }
      case "update-duty-roster": {
        if (!command.staffId) this.context.toast("轮值人员不能为空", "danger");
        else {
          const error = records.updateDutyRoster(
            command.date,
            command.slot,
            command.staffId
          );
          if (error) this.context.toast(error, "danger");
          else this.context.commit(`${command.date} 轮值已调整`);
        }
        return true;
      }
      case "reset-duty-roster":
        records.clearDutyRosterDay(command.date);
        this.context.commit(`${command.date} 已恢复顺序轮值`);
        return true;
      case "rebalance-duty-roster-month":
        if (
          this.context.confirm(
            `清除 ${command.date.slice(0, 7)} 的人工轮值调整，并按值班优先规则重新均衡？`
          )
        ) {
          records.clearDutyRosterMonth(command.date);
          this.context.commit(`${command.date.slice(0, 7)} 已重新均衡轮值`);
        }
        return true;
      case "download-duty-roster-template": {
        const [{ buildDutyRosterTemplateWorkbook }, { writeWorkbook }] =
          await Promise.all([
            import("../../infrastructure/duty-roster-excel"),
            import("../../infrastructure/excel"),
          ]);
        writeWorkbook(
          buildDutyRosterTemplateWorkbook(
            this.context.model(),
            command.date || this.context.view().date
          ),
          `值班备勤表_${(command.date || this.context.view().date).slice(0, 7)}.xlsx`
        );
        return true;
      }
      case "apply-duty-roster-import": {
        const dialog = this.context.view().dialog;
        if (dialog?.kind !== "duty-roster-import" || !dialog.preview.canApply)
          this.context.toast("当前值班备勤表存在阻止导入的问题", "danger");
        else {
          const result = records.applyDutyRosterImport(dialog.preview);
          if (!result.importedDays)
            this.context.toast(
              "值班备勤安排已发生变化，请重新选择文件并核对预览",
              "danger"
            );
          else {
            this.context.updateView({ dialog: null });
            this.context.commit(
              `已导入 ${dialog.preview.month} 值班备勤表：${result.importedDays} 个工作班、${result.importedAssignments} 项安排；CX航前保持不变`
            );
          }
        }
        return true;
      }
      case "adjust-late-priority-frequency":
        if (
          records.adjustLatePriorityFrequency(
            command.month,
            command.staffId,
            command.flightNo,
            command.kind,
            command.delta
          )
        )
          this.context.commit();
        return true;
      case "adjust-ordinary-priority-frequency":
        if (
          records.adjustOrdinaryPriorityFrequency(
            command.month,
            command.staffId,
            command.airlineCode,
            command.position,
            command.delta
          )
        )
          this.context.commit();
        return true;
      case "reset-monthly-late-priority-frequency-counts":
        if (
          this.context.confirm(
            `确认将 ${command.month} 当前统计月份的末班重点岗位次数清零？只影响该月份，历史排班不会删除。`
          ) &&
          records.resetMonthlyLatePriorityFrequencyCounts(command.date)
        )
          this.context.commit(`${command.month} 末班重点岗位次数已清零`);
        return true;
      case "apply-late-priority-counts-import": {
        const dialog = this.context.view().dialog;
        if (
          dialog?.kind !== "late-priority-counts-import" ||
          !dialog.preview.canApply
        ) {
          this.context.toast("当前次数文件存在阻止导入的问题", "danger");
          return true;
        }
        if (!records.applyLatePriorityCountsImport(dialog.preview)) {
          this.context.toast("导入内容与当前次数相同，没有变化", "warning");
          return true;
        }
        this.context.updateView({ dialog: null });
        this.context.commit(
          `已导入 ${dialog.preview.month} 末班重点岗位次数：${dialog.preview.targets.length} 项`
        );
        return true;
      }
      default:
        return false;
    }
  }
}
