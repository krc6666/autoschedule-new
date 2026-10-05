import { buildFlightPlanReconciliation } from "../../domain/flights/flight-plan-reconciliation";
import { queryInternationalFlights } from "../../infrastructure/flight-query";
import { exportShareHtml, exportSharePng } from "../../infrastructure/share";
import type { UiCommand } from "../../ui/events/ui-command";
import { prepareWorkbookImport } from "../workbook-import-controller";
import { applyLegacyScheduleImport } from "../workbook-actions";
import type {
  ApplicationContext,
  UiCommandController,
} from "../application-context";

export class TransferController implements UiCommandController {
  constructor(private readonly context: ApplicationContext) {}

  async handle(command: UiCommand): Promise<boolean> {
    switch (command.type) {
      case "import-file":
        if (command.mode === "late-priority-counts") {
          await this.importLatePriorityCounts(
            command.file,
            command.date ?? this.context.view().date
          );
          return true;
        }
        await this.importWorkbook(
          command.file,
          command.mode ?? "all",
          command.date ?? this.context.view().date
        );
        return true;
      case "apply-workbook-import":
        return this.applyWorkbookImport();
      case "apply-legacy-schedule-import":
        return this.applyLegacyScheduleImport();
      case "update-legacy-schedule-import-date":
        return this.updateLegacyScheduleImportDate(command.date);
      case "export-config": {
        const { buildConfigWorkbook, writeWorkbook } =
          await import("../../infrastructure/excel");
        writeWorkbook(
          buildConfigWorkbook(this.context.model()),
          "排班工具配置.xlsx"
        );
        this.context.store.getState().markExported();
        return true;
      }
      case "export-late-priority-counts": {
        const [{ buildLatePriorityCountsWorkbook }, { writeWorkbook }] =
          await Promise.all([
            import("../../infrastructure/late-priority-counts-excel"),
            import("../../infrastructure/excel"),
          ]);
        const month = command.date.slice(0, 7);
        writeWorkbook(
          buildLatePriorityCountsWorkbook(this.context.model(), command.date),
          `末班重点岗位次数_${month}.xlsx`
        );
        return true;
      }
      case "export-schedule": {
        const { buildScheduleWorkbook, writeWorkbook } =
          await import("../../infrastructure/excel");
        writeWorkbook(
          buildScheduleWorkbook(this.context.model(), this.context.view().date),
          `保障明细_${this.context.view().date}.xlsx`
        );
        return true;
      }
      case "export-share-html":
        exportShareHtml(this.context.model(), this.context.view().date);
        return true;
      case "export-share-png":
        try {
          await exportSharePng(this.context.model(), this.context.view().date);
        } catch (error) {
          this.context.toast(
            `图片导出失败：${error instanceof Error ? error.message : String(error)}`,
            "danger"
          );
        }
        return true;
      case "open-flight-query":
        this.context.updateView({
          dialog: {
            kind: "flight-query",
            date: this.context.view().date,
            loading: false,
            reconciliation: null,
            fetchedAt: "",
            error: "",
          },
        });
        return true;
      case "run-flight-query":
        await this.queryFlights(command.date);
        return true;
      case "apply-flight-query":
        return this.applyFlightQuery(command.templateIds, command.flightIds);
      default:
        return false;
    }
  }

  private async importWorkbook(
    file: File,
    mode: "all" | "config" | "history" | "duty-roster",
    date: string
  ): Promise<void> {
    try {
      const importedState = structuredClone(this.context.model());
      const prepared = await prepareWorkbookImport(
        importedState,
        file,
        mode,
        date
      );
      if (prepared.kind === "duty-roster") {
        this.context.updateView({
          dialog: { kind: "duty-roster-import", preview: prepared.preview },
        });
        return;
      }
      if (prepared.kind === "legacy-schedule") {
        this.context.updateView({
          dialog: {
            kind: "legacy-schedule-import",
            date,
            preview: prepared.preview,
          },
        });
        return;
      }
      this.context.updateView({
        dialog: {
          kind: "workbook-import",
          mode: mode === "duty-roster" ? "all" : mode,
          importedState,
          recognized: prepared.recognized,
          changedConfig: prepared.changedConfig,
          historySummary: prepared.historySummary,
          warnings: prepared.warnings,
        },
      });
    } catch (error) {
      this.context.toast(
        `导入失败：${error instanceof Error ? error.message : String(error)}`,
        "danger"
      );
    }
  }

  private async importLatePriorityCounts(
    file: File,
    date: string
  ): Promise<void> {
    try {
      const { importLatePriorityCountsWorkbook } =
        await import("../../infrastructure/late-priority-counts-excel");
      const preview = await importLatePriorityCountsWorkbook(
        file,
        this.context.model(),
        date
      );
      this.context.updateView({
        dialog: { kind: "late-priority-counts-import", preview },
      });
    } catch (error) {
      this.context.toast(
        `次数导入失败：${error instanceof Error ? error.message : String(error)}`,
        "danger"
      );
    }
  }

  private applyWorkbookImport(): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "workbook-import") return false;
    if (!dialog.recognized) {
      this.context.toast(
        dialog.warnings[0] ?? "文件中没有有效数据，未导入任何内容",
        "warning"
      );
      return true;
    }
    this.context.store.getState().replaceModel(dialog.importedState);
    this.context.updateView({ dialog: null });
    this.context.commit(
      `已导入 ${dialog.recognized}；${
        dialog.changedConfig === false ? "历史已归档" : "请重新排班"
      }`
    );
    if (dialog.warnings.length)
      this.context.toast(dialog.warnings.join("；"), "warning");
    return true;
  }

  private applyLegacyScheduleImport(): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "legacy-schedule-import") return false;
    const result = applyLegacyScheduleImport(
      this.context.store.getState().model,
      dialog.preview,
      dialog.date
    );
    this.context.updateView({ dialog: null });
    this.context.commit(
      `旧版排班已导入 ${result.imported} 条历史记录，${dialog.preview.reviewRecords} 条待确认记录未写入`
    );
    return true;
  }

  private updateLegacyScheduleImportDate(date: string): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "legacy-schedule-import") return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
    this.context.updateView({
      dialog: {
        ...dialog,
        date,
        preview: {
          ...dialog.preview,
          records: dialog.preview.records.map((record) => ({
            ...record,
            date,
          })),
        },
      },
    });
    return true;
  }

  private async queryFlights(date: string): Promise<void> {
    this.context.updateView({
      dialog: {
        kind: "flight-query",
        date,
        loading: true,
        reconciliation: null,
        fetchedAt: "",
        error: "",
      },
    });
    try {
      const result = await queryInternationalFlights(date);
      const reconciliation = buildFlightPlanReconciliation(
        this.context.model(),
        this.context.view().date,
        result
      );
      this.context.updateView({
        dialog: {
          kind: "flight-query",
          date,
          loading: false,
          reconciliation,
          fetchedAt: result.fetchedAt,
          error: "",
        },
      });
    } catch (error) {
      this.context.updateView({
        dialog: {
          kind: "flight-query",
          date,
          loading: false,
          reconciliation: null,
          fetchedAt: "",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private applyFlightQuery(
    templateIds: string[],
    flightIds: string[]
  ): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "flight-query" || !dialog.reconciliation) return true;
    if (!templateIds.length && !flightIds.length) {
      this.context.toast("当前没有勾选需要新增或删减的航班", "warning");
      return true;
    }
    if (flightIds.length && !dialog.reconciliation.removalAllowed) {
      this.context.toast(dialog.reconciliation.removalBlockedReason, "warning");
      return true;
    }
    if (flightIds.length) {
      const flightNumbers = dialog.reconciliation.removals
        .filter((flight) => flightIds.includes(flight.id))
        .map((flight) => flight.flightNo)
        .join("、");
      if (
        !this.context.confirm(
          `确认从当前航班计划删除 ${flightIds.length} 个航班（${flightNumbers}）？删除后已有排班结果将失效，需重新排班。`
        )
      )
        return true;
    }
    const result = this.context.store
      .getState()
      .configuration.applyFlightPlan(
        dialog.reconciliation,
        templateIds,
        flightIds
      );
    if (!result.added && !result.removed) {
      this.context.toast(
        "所选内容已失效，当前计划没有变化，请重新查询",
        "warning"
      );
      return true;
    }
    this.context.preferences.saveScheduleDate(dialog.date);
    this.context.updateView({ dialog: null });
    this.context.updateView({ date: dialog.date });
    this.context.commit(
      `航班计划已更新：新增 ${result.added} 个，删除 ${result.removed} 个`
    );
    return true;
  }
}
