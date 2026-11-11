import { html } from "lit";

import type { ApplicationDialog } from "../../app/application-view-state";
import type { AppState } from "../../model";
import { weekdayLabel } from "../../domain/flights/weekly-flight-plan";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

type WorkbookImportDialog = Extract<
  ApplicationDialog,
  { kind: "workbook-import" }
>;

export class WorkbookImportDialogElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    dialog: { attribute: false },
  };

  model!: AppState;
  dialog!: WorkbookImportDialog;

  protected override render() {
    const imported = this.dialog.imported;
    const importModeLabel = {
      all: "导入数据",
      config: "导入配置",
      history: "导入历史",
    }[this.dialog.mode];
    const settings = { ...this.model.settings, ...imported.settings };
    const restoreFlightConfiguration =
      this.dialog.restoreFlightConfiguration === true;
    const replaceSharedTemplates =
      restoreFlightConfiguration || this.dialog.replaceSharedTemplates;
    const importsPositionRules =
      this.dialog.mode !== "history" && imported.positionRules !== undefined;
    const importsWeeklyPlan =
      this.dialog.mode !== "history" &&
      imported.weeklyFlightPlans !== undefined;
    const weeklyPlanMessage =
      imported.weeklyFlightPlanStatus === "invalid"
        ? "每周航班计划工作表有问题，现有计划保留。"
        : importsWeeklyPlan
          ? "文件中的每周计划会导入，并同步到 A、B 两组。"
          : "文件未包含每周计划，现有计划保留。";
    const changesConfig =
      this.dialog.changedConfig ||
      (replaceSharedTemplates && this.dialog.sharedTemplatesAvailable);
    const hasHistory = (this.dialog.historySummary?.total ?? 0) > 0;
    const canImport =
      !this.dialog.restoreErrors?.length &&
      (this.dialog.changedConfig ||
        hasHistory ||
        (replaceSharedTemplates && this.dialog.sharedTemplatesAvailable));
    const confirmLabel = changesConfig
      ? hasHistory
        ? "确认导入配置与历史"
        : "确认导入配置"
      : "确认导入历史";
    return html`<div class="modal-body">
        <div class="alert alert-warning py-2">
          <i class="bi bi-exclamation-triangle me-2"></i>
          ${
            changesConfig
              ? `组内岗位和规则只写入当前${this.model.activeGroupId}组；${importsPositionRules && !restoreFlightConfiguration ? "岗位配置中的新航班会自动补入 A、B 共用模板。" : ""}${weeklyPlanMessage}${replaceSharedTemplates ? "下方选项会整体替换共用模板。" : ""}确认后当前组未归档的排班结果会清空。`
              : "确认导入后会立即合并到历史统计；当前尚未归档的排班结果保持不变。"
          }
          ${
            restoreFlightConfiguration
              ? html`<div class="mt-2">
                  将按文件完整恢复当前${this.model.activeGroupId}组人员、岗位资质、规则、轮值、半休和次数修正，以及
                  A、B
                  共用航班模板、每周计划和当前组当天航班，文件中没有的旧航班会移除。另一组已有人员与规则不覆盖。历史仍按原方式合并。
                </div>`
              : ""
          }
        </div>
        <div class="small text-secondary mb-3">
          配置目标：${this.model.activeGroupId} 组
        </div>
        ${
          this.dialog.weeklyPlanPreview
            ? html`<div class="border rounded p-3 mb-3">
                <strong>导入后的每周航班计划（A、B 共用）</strong>
                <table class="table table-sm mb-0 mt-2">
                  <tbody>
                    ${this.dialog.weeklyPlanPreview.plans.map(
                      (entry) =>
                        html`<tr>
                          <th scope="row" class="fw-normal text-nowrap">
                            ${weekdayLabel(entry.weekday)}
                          </th>
                          <td class="text-break">
                            ${
                              entry.flightNos.length
                                ? entry.flightNos.join("、")
                                : "未选择"
                            }
                          </td>
                        </tr>`
                    )}
                  </tbody>
                </table>
                ${
                  this.dialog.weeklyPlanPreview.unavailableFlightNos.length
                    ? html`<div class="small text-warning-emphasis mt-2">
                        因模板不存在而不会导入：${this.dialog.weeklyPlanPreview.unavailableFlightNos.join(
                          "、"
                        )}
                      </div>`
                    : ""
                }
              </div>`
            : ""
        }
        ${
          this.dialog.sharedTemplatesAvailable
            ? html`<label class="form-check mb-3">
                <input
                  class="form-check-input"
                  type="checkbox"
                  .checked=${replaceSharedTemplates}
                  .disabled=${restoreFlightConfiguration}
                  @change=${(event: Event) =>
                    dispatchUiCommand(this, {
                      type: "set-workbook-import-shared-templates",
                      enabled: (event.currentTarget as HTMLInputElement)
                        .checked,
                    })}
                />
                <span class="form-check-label">
                  整体替换共用航班模板（A、B 两组都会更新）
                </span>
              </label>`
            : ""
        }
        ${
          this.dialog.sharedTemplatesAvailable
            ? html`<label class="form-check mb-3">
                <input
                  class="form-check-input"
                  type="checkbox"
                  data-flight-restore
                  .checked=${restoreFlightConfiguration}
                  @change=${(event: Event) =>
                    dispatchUiCommand(this, {
                      type: "set-workbook-import-flight-restore",
                      enabled: (event.currentTarget as HTMLInputElement)
                        .checked,
                    })}
                />
                <span class="form-check-label"
                  >换设备完整恢复配置（当前组及共用航班）</span
                >
                <small class="d-block text-secondary"
                  >完整配置文件默认选中；按文件恢复配置，移除原设备旧值。文件未记录的新增项目按统一初始值恢复并列在下方；内容错误时先说明，原数据保留。历史仍按原方式合并，行政支援模式沿用本机当前选择。</small
                >
              </label>`
            : ""
        }
        ${
          this.dialog.restoreErrors?.length
            ? html`<div class="alert alert-danger" role="alert">
                <strong>完整恢复未通过检查，原数据未改变。</strong>
                <ul class="mb-0">
                  ${this.dialog.restoreErrors.map((error) => html`<li>${error}</li>`)}
                </ul>
              </div>`
            : ""
        }
        ${
          this.dialog.restoreFlightConfiguration &&
          this.dialog.restoreDefaults?.length
            ? html`<div class="alert alert-info" role="status">
                <strong>文件未记录以下新增项目，将按统一初始设置恢复：</strong>
                <ul class="mb-0">
                  ${this.dialog.restoreDefaults.map((item) => html`<li>${item}</li>`)}
                </ul>
                航班和规则仍按文件恢复，不使用本机原来的这些设置。新版导出配置会包含这些项目。
              </div>`
            : ""
        }
        ${
          this.dialog.flightPlanReview?.length
            ? html`<div class="alert alert-warning" data-import-flight-review>
                <strong>导入后仍需核对各组航班</strong
                >：本季航班以岗位配置为准，备用模板继续保留。确认导入后，选择以本次调好的组为准，核对另一组，分别确认新增、旧号换号或旧航班退出本季。
                ${this.dialog.flightPlanReview.map((review) => html`<div class="mt-1">以 ${review.sourceGroupId} 组为准核对 ${review.groupId} 组：${review.unmatchedFlightNos.length ? `本组多出 ${review.unmatchedFlightNos.join("、")}；` : ""}${review.missingPositionFlightNos.length ? `待配岗位 ${review.missingPositionFlightNos.join("、")}；` : ""}${review.timeDifferenceFlightNos.length ? `当天时段不同 ${review.timeDifferenceFlightNos.join("、")}` : ""}</div>`)}
              </div>`
            : ""
        }
        <div class="row g-2 mb-3">
          ${this.summary("导入入口", importModeLabel)}
          ${this.summary("识别内容", this.dialog.recognized || "无有效数据")}
          ${this.summary(
            "人员",
            imported.staff ? `${imported.staff.length} 人` : "未包含"
          )}
          ${this.summary(
            "岗位规则",
            imported.positionRules
              ? `${imported.positionRules.length} 条`
              : "未包含"
          )}
          ${this.summary(
            "结构化规则",
            `${
              settings.positionTransitionPolicies.length +
              settings.dutyPositionPriorities.length +
              settings.nextWorkdayRecoveryTargets.length +
              settings.lateShiftRecoveryPositionRules.length +
              settings.mobileSupervisorCoverageRules.length +
              settings.crossWorkdayQualificationReservations.length +
              settings.crossFlightPriorityPolicies.length
            } 条`
          )}
        </div>
        ${
          this.dialog.historySummary
            ? html`<div class="border rounded p-3 mb-3">
                <strong>历史统计记录</strong>
                <div class="small text-secondary mt-1">
                  共 ${this.dialog.historySummary.total} 条；新增
                  ${this.dialog.historySummary.added} 条；覆盖
                  ${this.dialog.historySummary.replaced} 条；无法匹配当前人员
                  ${this.dialog.historySummary.unmatchedStaff} 条
                </div>
              </div>`
            : ""
        }
        <div class="border rounded p-3 mb-3">
          <strong>末班重点航班范围</strong>
          <div class="small text-secondary mt-1">
            ${
              settings.latePriorityFlightNumbers.length
                ? settings.latePriorityFlightNumbers.join("、")
                : "当前为空，导入后停用这组范围保护"
            }
          </div>
        </div>
        ${(this.dialog.restoreErrors?.length ? [] : this.dialog.warnings).map(
          (message) =>
            html`<div class="alert alert-warning py-2 mb-2">
              <i class="bi bi-exclamation-triangle me-2"></i>${message}
            </div>`
        )}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-bs-dismiss="modal">
          取消
        </button>
        <button
          class="btn btn-primary"
          type="button"
          ?disabled=${!canImport}
          @click=${() =>
            dispatchUiCommand(this, { type: "apply-workbook-import" })}
        >
          <i class="bi bi-check2 me-1"></i>${confirmLabel}
        </button>
      </div>`;
  }

  private summary(label: string, value: string) {
    return html`<div class="col-md-4">
      <div class="small text-secondary">${label}</div>
      <div class="fw-semibold text-break">${value}</div>
    </div>`;
  }
}

customElements.define(
  "autoschedule-workbook-import-dialog",
  WorkbookImportDialogElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-workbook-import-dialog": WorkbookImportDialogElement;
  }
}
