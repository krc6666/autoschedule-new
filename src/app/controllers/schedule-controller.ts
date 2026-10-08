import { currentScheduleHistory } from "../history-actions";
import { installArchivedNextWorkdaySchedule } from "../schedule-actions";
import { addIsoDays } from "../../domain/shared/time";
import type { UiCommand } from "../../ui/events/ui-command";
import type {
  ApplicationContext,
  UiCommandController,
} from "../application-context";
import { analyzeManualSwap } from "../../domain/reviews/manual-swap-analysis";
import {
  buildCurrentScheduleFlightCandidates,
  buildNextWorkdayFlightCandidates,
  materializeCurrentScheduleFlights,
  materializeNextWorkdayFlights,
  updateFlightSelectionBookedPassengers,
} from "../../domain/flights/next-workday-flight-plan";
import { installGeneratedSchedule } from "../../domain/kernel/schedule-lifecycle";
import {
  flightNumbersForDate,
  isoWeekdayForDate,
} from "../../domain/flights/weekly-flight-plan";
import { isHalfRestWarning } from "../../domain/rules/half-rest";
import { planTeamLeaderGapFill } from "../../domain/coverage/team-leader-gap-fill";
import { applyStaffStatusChange } from "../../domain/kernel/schedule-state";
import {
  getDutyRosterForDate,
  dutyRosterStatusIssues,
  updateDutyRosterSlot,
  type DutyRosterAssignment,
  type DutyRosterSlot,
} from "../../domain/duty-roster/roster";
import type { AppState, ScheduleResult, StaffStatus } from "../../model";

export class ScheduleController implements UiCommandController {
  constructor(private readonly context: ApplicationContext) {}

  async handle(command: UiCommand): Promise<boolean> {
    const schedule = this.context.store.getState().schedule;
    switch (command.type) {
      case "generate-schedule":
        this.openSchedulePreflight();
        return true;
      case "update-schedule-preflight-selection":
        this.updateSchedulePreflightSelection(command.selectedIds);
        return true;
      case "update-schedule-preflight-passengers":
        this.updateSchedulePreflightPassengers(
          command.candidateId,
          command.bookedPassengers
        );
        return true;
      case "update-schedule-preflight-staff-status":
        this.updateSchedulePreflightStaffStatus(
          command.staffId,
          command.status
        );
        return true;
      case "update-schedule-preflight-duty-roster":
        this.updatePreflightDutyRoster(command.slot, command.staffId);
        return true;
      case "confirm-schedule-preflight":
        await this.confirmSchedulePreflight(command.selectedIds);
        return true;
      case "open-reschedule-flight-picker":
        this.openRescheduleFlightPicker();
        return true;
      case "update-reschedule-flight-picker-selection":
        this.updateRescheduleFlightSelection(command.selectedIds);
        return true;
      case "update-reschedule-flight-picker-passengers":
        this.updateRescheduleFlightPassengers(
          command.candidateId,
          command.bookedPassengers
        );
        return true;
      case "update-reschedule-flight-picker-staff-status":
        this.updateRescheduleStaffStatus(command.staffId, command.status);
        return true;
      case "update-reschedule-flight-picker-duty-roster":
        this.updatePreflightDutyRoster(command.slot, command.staffId);
        return true;
      case "confirm-reschedule-flight-picker":
        await this.confirmRescheduleFlightPicker(command.selectedIds);
        return true;
      case "set-half-rest-staff": {
        const allowedIds = new Set(
          this.context
            .model()
            .staff.filter(
              (person) =>
                person.status === "正常" && person.staffType === "常规"
            )
            .map((person) => person.id)
        );
        this.context.updateView({
          halfRestStaffIds: [
            ...new Set(
              command.staffIds.filter((staffId) => allowedIds.has(staffId))
            ),
          ],
          halfRestModes: Object.fromEntries(
            Object.entries(command.modes ?? {}).filter(([staffId]) =>
              allowedIds.has(staffId)
            )
          ),
        });
        return true;
      }
      case "stop-schedule-without-result":
        if (!this.context.scheduleRunner.stopWithoutResult())
          this.context.toast("当前没有正在运行的排班", "warning");
        return true;
      case "stop-schedule-with-current-result":
        if (!this.context.scheduleRunner.stopWithCurrentResult())
          this.context.toast("完整安全方案尚未准备好，请稍后再试", "warning");
        return true;
      case "open-swap-analysis":
        this.context.updateView({
          dialog: {
            kind: "swap-analysis",
            sourceAssignmentId: command.assignmentId,
            targetAssignmentId: null,
            analysis: null,
          },
        });
        return true;
      case "select-swap-target":
        return this.selectSwapTarget(command.assignmentId);
      case "apply-swap-analysis":
        return this.applySwapAnalysis();
      case "open-team-leader-gap-fill":
        this.openTeamLeaderGapFill();
        return true;
      case "update-team-leader-gap-fill-leader":
        this.updateTeamLeaderGapFill({
          selectedTeamLeaderId: command.staffId,
        });
        return true;
      case "update-team-leader-gap-fill-vacancies":
        this.updateTeamLeaderGapFill({
          selectedVacancyAssignmentIds: command.assignmentIds,
        });
        return true;
      case "preview-team-leader-gap-fill":
        await this.previewTeamLeaderGapFill();
        return true;
      case "confirm-team-leader-gap-fill":
        return this.confirmTeamLeaderGapFill();
      case "toggle-administrative-mode":
        schedule.setAdministrativeMode(command.enabled);
        this.context.commit();
        await this.generate(this.context.view().date);
        return true;
      case "assign-staff":
        return this.assign(
          command.assignmentId,
          command.staffId,
          command.sourceAssignmentId
        );
      case "update-assignment": {
        const result = schedule.updateAssignment(
          command.id,
          command.field,
          command.value
        );
        if (result.error) this.context.toast(result.error, "danger");
        else if (result.changed) {
          this.context.commit(result.message);
          if (result.warning) this.context.toast(result.warning, "warning");
        }
        return true;
      }
      case "create-temporary-assignment":
        {
          const result = schedule.createTemporary(
            command.flightId,
            command.position,
            command.staffName,
            command.layoutGroup,
            command.layoutIndex
          );
          if (result.error) this.context.toast(result.error, "danger");
          else if (result.changed) {
            this.context.commit(result.message ?? "已增加临时岗位");
            if (result.warning) this.context.toast(result.warning, "warning");
          }
        }
        return true;
      case "delete-temporary-assignment":
        if (schedule.deleteTemporary(command.id))
          this.context.commit("临时岗位已移除");
        return true;
      case "clear-schedule":
        if (
          this.context.model().assignments.length &&
          this.context.confirm("确认清空当前排班？")
        ) {
          schedule.clear();
          this.context.commit("当前排班已清空");
        }
        return true;
      case "archive-schedule":
        this.archive();
        return true;
      case "archive-next-duty-day":
        this.openNextWorkdayFlightPicker();
        return true;
      case "update-next-workday-flight-picker-selection":
        this.updateNextWorkdayFlightSelection(command.selectedIds);
        return true;
      case "update-next-workday-flight-picker-passengers":
        this.updateNextWorkdayFlightPassengers(
          command.candidateId,
          command.bookedPassengers
        );
        return true;
      case "update-next-workday-flight-picker-staff-status":
        this.updateNextWorkdayStaffStatus(command.staffId, command.status);
        return true;
      case "update-next-workday-flight-picker-duty-roster":
        this.updatePreflightDutyRoster(command.slot, command.staffId);
        return true;
      case "confirm-next-workday-flight-picker":
        await this.confirmNextWorkdayFlightPicker(command.selectedIds);
        return true;
      case "set-schedule-zoom": {
        const zoom = Math.min(1.6, Math.max(0.7, command.value));
        this.context.preferences.saveScheduleZoom(zoom);
        this.context.updateView({ zoom });
        return true;
      }
      case "set-load-sort":
        this.context.updateView({
          loadSortField: command.field,
          loadSortDirection: command.direction,
        });
        return true;
      default:
        return false;
    }
  }

  async generate(date: string): Promise<void> {
    const dutyIssues = dutyRosterStatusIssues(this.context.model(), date);
    if (dutyIssues.length) {
      this.context.toast(`不能生成排班：${dutyIssues.join("；")}`, "danger");
      return;
    }
    try {
      const outcome = await this.context.scheduleRunner.calculate(
        this.context.model(),
        date,
        {
          halfRestStaffIds: this.context.view().halfRestStaffIds,
          halfRestModes: this.context.view().halfRestModes,
        }
      );
      if (outcome.kind === "stopped-without-result") {
        this.context.toast("排班已停止，原班表保持不变", "warning");
        return;
      }
      const result = outcome.result;
      this.context.store.getState().schedule.install(date, result);
      this.context.updateView({ section: "schedule" });
      this.context.commit(
        outcome.kind === "stopped-with-result"
          ? "排班已停止，并采用最近一份完整安全方案"
          : result.unfilledCount
            ? `排班已生成，${result.unfilledCount} 个常规岗位待补位`
            : "排班已生成"
      );
      this.reportHalfRestWarnings(result);
    } catch (error) {
      this.context.toast(
        `排班生成失败：${error instanceof Error ? error.message : String(error)}`,
        "danger"
      );
    }
  }

  private reportHalfRestWarnings(result: ScheduleResult): void {
    const halfRestWarnings = result.warnings.filter(isHalfRestWarning);
    const halfRestVacancyCount = result.assignments.filter(
      (assignment) =>
        assignment.status === "unfilled" &&
        assignment.systemNotes?.some(isHalfRestWarning)
    ).length;
    if (halfRestWarnings.length || halfRestVacancyCount) {
      this.context.toast(
        [
          ...(halfRestVacancyCount
            ? [`半休人员较多，${halfRestVacancyCount} 个后续岗位待补位并已标红`]
            : []),
          ...halfRestWarnings.filter(
            (message) => !message.includes("岗位保持空缺")
          ),
        ].join("；"),
        "warning"
      );
    }
  }

  private currentStaffStatuses(): Record<string, StaffStatus> {
    return Object.fromEntries(
      this.context.model().staff.map((person) => [person.id, person.status])
    );
  }

  private normalStaffStatuses(): Record<string, StaffStatus> {
    return Object.fromEntries(
      this.context.model().staff.map((person) => [person.id, "正常"])
    );
  }

  private dutyRosterForDialog(
    date: string,
    staffStatuses: Record<string, StaffStatus>
  ): DutyRosterAssignment {
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, staffStatuses);
    return getDutyRosterForDate(temporaryState, date);
  }

  private updatePreflightDutyRoster(
    slot: DutyRosterSlot,
    staffId: string
  ): void {
    const dialog = this.context.view().dialog;
    if (
      !dialog ||
      (dialog.kind !== "schedule-preflight" &&
        dialog.kind !== "reschedule-flight-picker" &&
        dialog.kind !== "next-workday-flight-picker")
    )
      return;
    const statuses = dialog.staffStatuses ?? this.currentStaffStatuses();
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, statuses);
    const current =
      dialog.dutyRoster ?? this.dutyRosterForDialog(dialog.date, statuses);
    if (!staffId) {
      const next: DutyRosterAssignment = {
        ...current,
        standbyStaffIds: [...current.standbyStaffIds],
      };
      if (slot === "cx-preflight") next.cxPreflightStaffId = null;
      else if (slot === "duty") next.dutyStaffId = null;
      else next.standbyStaffIds[slot === "standby-0" ? 0 : 1] = null;
      this.context.updateView({ dialog: { ...dialog, dutyRoster: next } });
      return;
    }
    temporaryState.dutyRosterOverrides = [
      ...temporaryState.dutyRosterOverrides.filter(
        (item) => item.date !== dialog.date
      ),
      {
        date: dialog.date,
        cxPreflightStaffId: current.cxPreflightStaffId,
        dutyStaffId: current.dutyStaffId,
        standbyStaffIds: [...current.standbyStaffIds],
      },
    ];
    const error = updateDutyRosterSlot(
      temporaryState,
      dialog.date,
      slot,
      staffId
    );
    if (error) {
      this.context.toast(error, "warning");
      return;
    }
    this.context.updateView({
      dialog: {
        ...dialog,
        dutyRoster: getDutyRosterForDate(temporaryState, dialog.date),
      },
    });
  }

  private applyPreflightStaffStatuses(
    state: AppState,
    statuses: Record<string, StaffStatus>
  ): void {
    state.staff.forEach((person) => {
      const status = statuses[person.id];
      if (status) applyStaffStatusChange(state, person.id, status);
    });
  }

  private preflightDutyRosterIssues(
    date: string,
    statuses: Record<string, StaffStatus>,
    roster: DutyRosterAssignment | undefined
  ): string[] {
    if (!roster) return [];
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, statuses);
    temporaryState.dutyRosterOverrides = [
      ...temporaryState.dutyRosterOverrides.filter(
        (item) => item.date !== date
      ),
      {
        date,
        cxPreflightStaffId: roster.cxPreflightStaffId,
        dutyStaffId: roster.dutyStaffId,
        standbyStaffIds: [...roster.standbyStaffIds],
      },
    ];
    return dutyRosterStatusIssues(temporaryState, date);
  }

  private checkPreflightContext(
    groupId: AppState["activeGroupId"],
    date: string
  ): boolean {
    if (
      groupId === this.context.model().activeGroupId &&
      date === this.context.view().date
    )
      return true;
    this.context.updateView({ dialog: null });
    this.context.toast("排班组或日期已变化，请重新打开确认窗口", "warning");
    return false;
  }

  private assign(
    assignmentId: string,
    staffId: string,
    sourceAssignmentId?: string
  ): boolean {
    const result = this.context.store
      .getState()
      .schedule.assignStaff(assignmentId, staffId, sourceAssignmentId);
    if (result.error) this.context.toast(result.error, "danger");
    else if (result.changed) {
      this.context.commit(result.message);
      if (result.warning) this.context.toast(result.warning, "warning");
    }
    return true;
  }

  private selectSwapTarget(targetAssignmentId: string): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "swap-analysis") return true;
    const analysis = analyzeManualSwap(
      this.context.model(),
      this.context.view().date,
      dialog.sourceAssignmentId,
      targetAssignmentId
    );
    this.context.updateView({
      dialog: { ...dialog, targetAssignmentId, analysis },
    });
    return true;
  }

  private applySwapAnalysis(): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "swap-analysis" || !dialog.targetAssignmentId)
      return true;
    const analysis = analyzeManualSwap(
      this.context.model(),
      this.context.view().date,
      dialog.sourceAssignmentId,
      dialog.targetAssignmentId
    );
    if (analysis.outcome === "blocked") {
      this.context.updateView({ dialog: { ...dialog, analysis } });
      this.context.toast(`不能交换：${analysis.blockers.join("；")}`, "danger");
      return true;
    }
    const source = this.context
      .model()
      .assignments.find(
        (assignment) => assignment.id === dialog.sourceAssignmentId
      );
    const target = this.context
      .model()
      .assignments.find(
        (assignment) => assignment.id === dialog.targetAssignmentId
      );
    if (!source || !target?.staffId) {
      this.context.toast("岗位已经变化，请重新打开分析", "danger");
      return true;
    }
    const result = this.context.store
      .getState()
      .schedule.assignStaff(source.id, target.staffId, target.id);
    if (result.error) {
      this.context.toast(result.error, "danger");
      return true;
    }
    if (result.changed) {
      this.context.updateView({ dialog: null });
      this.context.commit("人员岗位已按分析结果交换");
      if (result.warning) this.context.toast(result.warning, "warning");
    }
    return true;
  }

  private openTeamLeaderGapFill(): void {
    const teamLeader = this.context
      .model()
      .staff.find(
        (person) =>
          person.teamLeader &&
          person.status === "正常" &&
          person.staffType === "常规"
      );
    if (!teamLeader) {
      this.context.toast("没有状态正常的分队长可用于补差", "warning");
      return;
    }
    if (
      !this.context
        .model()
        .assignments.some((assignment) => assignment.status === "unfilled")
    ) {
      this.context.toast("当前班表没有空缺", "warning");
      return;
    }
    this.context.updateView({
      dialog: {
        kind: "team-leader-gap-fill",
        selectedTeamLeaderId: teamLeader.id,
        selectedVacancyAssignmentIds: [],
        planning: false,
        preview: null,
        reasons: [],
      },
    });
  }

  private updateTeamLeaderGapFill(
    patch: Partial<{
      selectedTeamLeaderId: string;
      selectedVacancyAssignmentIds: string[];
    }>
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "team-leader-gap-fill" || dialog.planning) return;
    this.context.updateView({
      dialog: {
        ...dialog,
        ...patch,
        preview: null,
        reasons: [],
      },
    });
  }

  private async previewTeamLeaderGapFill(): Promise<void> {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "team-leader-gap-fill" || dialog.planning) return;
    this.context.updateView({
      dialog: { ...dialog, planning: true, preview: null, reasons: [] },
    });
    try {
      const snapshot = structuredClone(this.context.model());
      const { defaultHighsSolver } =
        await import("../../infrastructure/solver/highs-solver");
      const result = await planTeamLeaderGapFill({
        solver: defaultHighsSolver,
        state: snapshot,
        date: this.context.view().date,
        teamLeaderId: dialog.selectedTeamLeaderId,
        vacancyAssignmentIds: dialog.selectedVacancyAssignmentIds,
      });
      const current = this.context.view().dialog;
      if (current?.kind !== "team-leader-gap-fill") return;
      this.context.updateView({
        dialog: {
          ...current,
          planning: false,
          preview: result.kind === "ready" ? result.preview : null,
          reasons: result.kind === "unavailable" ? result.reasons : [],
        },
      });
    } catch (error) {
      const current = this.context.view().dialog;
      if (current?.kind !== "team-leader-gap-fill") return;
      this.context.updateView({
        dialog: {
          ...current,
          planning: false,
          preview: null,
          reasons: [
            `补差方案计算失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
        },
      });
    }
  }

  private confirmTeamLeaderGapFill(): boolean {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "team-leader-gap-fill" || !dialog.preview) return true;
    const result = this.context.store
      .getState()
      .schedule.applyTeamLeaderGapFill(dialog.preview);
    if (result.kind === "rejected") {
      this.context.updateView({
        dialog: {
          ...dialog,
          preview: null,
          reasons: result.reasons,
        },
      });
      this.context.toast(result.reasons.join("；"), "danger");
      return true;
    }
    this.context.updateView({ dialog: null });
    this.context.commit("分队长补差已应用");
    return true;
  }

  private archive(): void {
    const records = currentScheduleHistory(
      this.context.model(),
      this.context.view().date
    );
    if (!records.length)
      return this.context.toast("没有可归档的已排岗位", "warning");
    if (!this.confirmStale("归档当前排班")) return;
    if (
      !this.context.confirm(
        `将 ${records.length} 条已排岗位归档到 ${this.context.view().date}？同日旧记录会被替换。`
      )
    )
      return;
    this.context.store
      .getState()
      .records.replaceHistory(this.context.view().date, records);
    this.context.commit("排班已归档到历史");
  }

  private openSchedulePreflight(): void {
    const model = this.context.model();
    const candidates = buildCurrentScheduleFlightCandidates(
      model.templates,
      model.flights
    );
    if (!candidates.length)
      return this.context.toast("没有可选择的本地航班", "warning");
    this.context.updateView({
      dialog: {
        kind: "schedule-preflight",
        date: this.context.view().date,
        groupId: model.activeGroupId,
        candidates,
        selectedIds: candidates
          .filter((candidate) => candidate.selectedByDefault)
          .map((candidate) => candidate.id),
        staffStatuses: this.currentStaffStatuses(),
        dutyRoster: getDutyRosterForDate(model, this.context.view().date),
      },
    });
  }

  private updateSchedulePreflightSelection(selectedIds: string[]): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "schedule-preflight") return;
    const candidateIds = new Set(
      dialog.candidates.map((candidate) => candidate.id)
    );
    this.context.updateView({
      dialog: {
        ...dialog,
        selectedIds: [...new Set(selectedIds)].filter((id) =>
          candidateIds.has(id)
        ),
      },
    });
  }

  private updateSchedulePreflightPassengers(
    candidateId: string,
    bookedPassengers: number
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "schedule-preflight") return;
    this.context.updateView({
      dialog: {
        ...dialog,
        candidates: updateFlightSelectionBookedPassengers(
          dialog.candidates,
          candidateId,
          bookedPassengers
        ),
      },
    });
  }

  private updateSchedulePreflightStaffStatus(
    staffId: string,
    status: StaffStatus
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "schedule-preflight") return;
    if (!this.context.model().staff.some((person) => person.id === staffId))
      return;
    const statuses = { ...dialog.staffStatuses, [staffId]: status };
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, statuses);
    this.context.updateView({
      dialog: {
        ...dialog,
        staffStatuses: statuses,
        dutyRoster: getDutyRosterForDate(temporaryState, dialog.date),
      },
    });
  }

  private updateRescheduleStaffStatus(
    staffId: string,
    status: StaffStatus
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker") return;
    if (!this.context.model().staff.some((person) => person.id === staffId))
      return;
    const statuses = {
      ...(dialog.staffStatuses ?? this.currentStaffStatuses()),
      [staffId]: status,
    };
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, statuses);
    this.context.updateView({
      dialog: {
        ...dialog,
        staffStatuses: statuses,
        dutyRoster: getDutyRosterForDate(temporaryState, dialog.date),
      },
    });
  }

  private async confirmSchedulePreflight(selectedIds: string[]): Promise<void> {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "schedule-preflight") return;
    if (!this.checkPreflightContext(dialog.groupId, dialog.date)) return;
    const flights = materializeCurrentScheduleFlights(
      dialog.candidates,
      selectedIds
    );
    if (!flights.length) {
      this.context.toast("请至少选择一个航班", "warning");
      return;
    }
    const dutyIssues = this.preflightDutyRosterIssues(
      dialog.date,
      dialog.staffStatuses,
      dialog.dutyRoster
    );
    if (dutyIssues.length) {
      this.context.toast(`不能生成排班：${dutyIssues.join("；")}`, "danger");
      return;
    }
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, dialog.staffStatuses);
    if (dialog.dutyRoster) {
      temporaryState.dutyRosterOverrides = [
        ...temporaryState.dutyRosterOverrides.filter(
          (item) => item.date !== dialog.date
        ),
        {
          date: dialog.date,
          cxPreflightStaffId: dialog.dutyRoster.cxPreflightStaffId,
          dutyStaffId: dialog.dutyRoster.dutyStaffId,
          standbyStaffIds: [...dialog.dutyRoster.standbyStaffIds],
        },
      ];
    }
    temporaryState.flights = flights;
    temporaryState.assignments = [];
    temporaryState.activeScheduleDate = null;
    temporaryState.schedulePolicyStale = false;
    this.context.updateView({ dialog: null });
    try {
      const outcome = await this.context.scheduleRunner.calculate(
        temporaryState,
        dialog.date,
        {
          halfRestStaffIds: this.context.view().halfRestStaffIds,
          halfRestModes: this.context.view().halfRestModes,
        }
      );
      if (outcome.kind !== "completed") {
        this.context.toast("排班已停止，原班表保持不变", "warning");
        return;
      }
      installGeneratedSchedule(temporaryState, dialog.date, outcome.result);
      this.context.store.getState().replaceModel(temporaryState);
      this.context.updateView({ section: "schedule" });
      this.context.commit(
        outcome.result.unfilledCount
          ? `排班已生成，${outcome.result.unfilledCount} 个常规岗位待补位`
          : "排班已生成"
      );
      this.reportHalfRestWarnings(outcome.result);
    } catch (error) {
      this.context.toast(
        `排班生成失败，原航班、人员状态和班表保持不变：${error instanceof Error ? error.message : String(error)}`,
        "danger"
      );
    }
  }

  private openRescheduleFlightPicker(): void {
    const model = this.context.model();
    const candidates = buildCurrentScheduleFlightCandidates(
      model.templates,
      model.flights
    );
    if (!candidates.length)
      return this.context.toast("没有可选择的本地航班", "warning");
    this.context.updateView({
      dialog: {
        kind: "reschedule-flight-picker",
        date: this.context.view().date,
        groupId: model.activeGroupId,
        candidates,
        selectedIds: candidates
          .filter((candidate) => candidate.selectedByDefault)
          .map((candidate) => candidate.id),
        staffStatuses: this.currentStaffStatuses(),
        dutyRoster: getDutyRosterForDate(model, this.context.view().date),
      },
    });
  }

  private updateRescheduleFlightSelection(selectedIds: string[]): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker") return;
    const candidateIds = new Set(
      dialog.candidates.map((candidate) => candidate.id)
    );
    this.context.updateView({
      dialog: {
        ...dialog,
        selectedIds: [...new Set(selectedIds)].filter((id) =>
          candidateIds.has(id)
        ),
      },
    });
  }

  private updateRescheduleFlightPassengers(
    candidateId: string,
    bookedPassengers: number
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker") return;
    this.context.updateView({
      dialog: {
        ...dialog,
        candidates: updateFlightSelectionBookedPassengers(
          dialog.candidates,
          candidateId,
          bookedPassengers
        ),
      },
    });
  }

  private async confirmRescheduleFlightPicker(
    selectedIds: string[]
  ): Promise<void> {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "reschedule-flight-picker") return;
    if (!this.checkPreflightContext(dialog.groupId, dialog.date)) return;
    const flights = materializeCurrentScheduleFlights(
      dialog.candidates,
      selectedIds
    );
    if (!flights.length) {
      this.context.toast("请至少选择一个航班", "warning");
      return;
    }
    const date = dialog.date;
    const dutyIssues = this.preflightDutyRosterIssues(
      date,
      dialog.staffStatuses ?? this.currentStaffStatuses(),
      dialog.dutyRoster
    );
    if (dutyIssues.length) {
      this.context.toast(`不能重新排班：${dutyIssues.join("；")}`, "danger");
      return;
    }
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(
      temporaryState,
      dialog.staffStatuses ?? this.currentStaffStatuses()
    );
    if (dialog.dutyRoster) {
      temporaryState.dutyRosterOverrides = [
        ...temporaryState.dutyRosterOverrides.filter(
          (item) => item.date !== date
        ),
        {
          date,
          cxPreflightStaffId: dialog.dutyRoster.cxPreflightStaffId,
          dutyStaffId: dialog.dutyRoster.dutyStaffId,
          standbyStaffIds: [...dialog.dutyRoster.standbyStaffIds],
        },
      ];
    }
    temporaryState.flights = flights;
    temporaryState.assignments = [];
    temporaryState.activeScheduleDate = null;
    temporaryState.schedulePolicyStale = false;
    this.context.updateView({ dialog: null });
    try {
      const outcome = await this.context.scheduleRunner.calculate(
        temporaryState,
        date,
        {
          halfRestStaffIds: this.context.view().halfRestStaffIds,
          halfRestModes: this.context.view().halfRestModes,
        }
      );
      if (outcome.kind === "stopped-without-result") {
        this.context.toast("排班已停止，原航班和班表保持不变", "warning");
        return;
      }
      installGeneratedSchedule(temporaryState, date, outcome.result);
      this.context.store.getState().replaceModel(temporaryState);
      this.context.updateView({ section: "schedule" });
      this.context.commit(
        outcome.kind === "stopped-with-result"
          ? "已采用最近一份完整安全方案，航班与班表已更新"
          : outcome.result.unfilledCount
            ? `重新排班完成，${outcome.result.unfilledCount} 个常规岗位待补位`
            : "重新排班完成"
      );
    } catch (error) {
      this.context.toast(
        `重新排班失败，原航班和班表保持不变：${error instanceof Error ? error.message : String(error)}`,
        "danger"
      );
    }
  }

  private openNextWorkdayFlightPicker(): void {
    const currentDate = this.context.view().date;
    const records = currentScheduleHistory(this.context.model(), currentDate);
    if (!records.length)
      return this.context.toast("没有可归档的已排岗位", "warning");
    const nextDate = addIsoDays(currentDate, 2);
    const model = this.context.model();
    const candidates = buildNextWorkdayFlightCandidates(
      model.templates,
      flightNumbersForDate(model.weeklyFlightPlans, nextDate)
    );
    if (!candidates.length)
      return this.context.toast("没有可选择的本地航班", "warning");
    this.context.updateView({
      dialog: {
        kind: "next-workday-flight-picker",
        date: nextDate,
        sourceDate: currentDate,
        groupId: model.activeGroupId,
        weekday: isoWeekdayForDate(nextDate),
        candidates,
        selectedIds: candidates
          .filter((candidate) => candidate.selectedByDefault)
          .map((candidate) => candidate.id),
        staffStatuses: this.normalStaffStatuses(),
        dutyRoster: this.dutyRosterForDialog(
          nextDate,
          this.normalStaffStatuses()
        ),
      },
    });
  }

  private updateNextWorkdayFlightSelection(selectedIds: string[]): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker") return;
    const candidateIds = new Set(
      dialog.candidates.map((candidate) => candidate.id)
    );
    this.context.updateView({
      dialog: {
        ...dialog,
        selectedIds: [...new Set(selectedIds)].filter((id) =>
          candidateIds.has(id)
        ),
      },
    });
  }

  private updateNextWorkdayFlightPassengers(
    candidateId: string,
    bookedPassengers: number
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker") return;
    this.context.updateView({
      dialog: {
        ...dialog,
        candidates: updateFlightSelectionBookedPassengers(
          dialog.candidates,
          candidateId,
          bookedPassengers
        ),
      },
    });
  }

  private updateNextWorkdayStaffStatus(
    staffId: string,
    status: StaffStatus
  ): void {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker") return;
    if (!this.context.model().staff.some((person) => person.id === staffId))
      return;
    const statuses = { ...dialog.staffStatuses, [staffId]: status };
    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, statuses);
    this.context.updateView({
      dialog: {
        ...dialog,
        staffStatuses: statuses,
        dutyRoster: getDutyRosterForDate(temporaryState, dialog.date),
      },
    });
  }

  private async confirmNextWorkdayFlightPicker(
    selectedIds: string[]
  ): Promise<void> {
    const dialog = this.context.view().dialog;
    if (dialog?.kind !== "next-workday-flight-picker") return;
    if (!this.checkPreflightContext(dialog.groupId, dialog.sourceDate)) return;
    const currentDate = this.context.view().date;
    const records = currentScheduleHistory(this.context.model(), currentDate);
    if (!records.length) {
      this.context.toast("没有可归档的已排岗位", "warning");
      return;
    }
    if (!this.confirmStale("归档当前排班并生成后天排班")) return;
    const selected = new Set(selectedIds);
    const flights = materializeNextWorkdayFlights(
      dialog.candidates,
      dialog.candidates
        .filter((candidate) => selected.has(candidate.id))
        .map((candidate) => candidate.id)
    );
    if (!flights.length) {
      this.context.toast("请至少选择一个航班", "warning");
      return;
    }
    const nextDate = dialog.date;
    const dutyIssues = this.preflightDutyRosterIssues(
      nextDate,
      dialog.staffStatuses,
      dialog.dutyRoster
    );
    if (dutyIssues.length) {
      this.context.toast(
        `不能生成后天排班：${dutyIssues.join("；")}`,
        "danger"
      );
      return;
    }
    if (
      !this.context.confirm(
        `归档 ${currentDate}，并根据已选择的 ${flights.length} 个航班生成后天 ${nextDate} 排班？`
      )
    )
      return;

    const temporaryState = structuredClone(this.context.model());
    this.applyPreflightStaffStatuses(temporaryState, dialog.staffStatuses);
    if (dialog.dutyRoster) {
      temporaryState.dutyRosterOverrides = [
        ...temporaryState.dutyRosterOverrides.filter(
          (item) => item.date !== nextDate
        ),
        {
          date: nextDate,
          cxPreflightStaffId: dialog.dutyRoster.cxPreflightStaffId,
          dutyStaffId: dialog.dutyRoster.dutyStaffId,
          standbyStaffIds: [...dialog.dutyRoster.standbyStaffIds],
        },
      ];
    }
    temporaryState.history = [
      ...temporaryState.history.filter((item) => item.date !== currentDate),
      ...records,
    ];
    temporaryState.flights = flights;
    temporaryState.assignments = [];
    temporaryState.activeScheduleDate = null;
    temporaryState.schedulePolicyStale = false;

    this.context.updateView({ dialog: null });
    try {
      const outcome = await this.context.scheduleRunner.calculate(
        temporaryState,
        nextDate
      );
      if (outcome.kind !== "completed") {
        this.context.toast("排班已停止，原班表保持不变", "warning");
        return;
      }
      installArchivedNextWorkdaySchedule(
        temporaryState,
        currentDate,
        records,
        nextDate,
        flights,
        outcome.result
      );
      this.context.store.getState().replaceModel(temporaryState);
      this.context.preferences.saveScheduleDate(nextDate);
      this.context.updateView({
        date: nextDate,
        section: "schedule",
        halfRestStaffIds: [],
        halfRestModes: {},
      });
      this.context.commit(
        outcome.result.unfilledCount
          ? `后天排班已生成，${outcome.result.unfilledCount} 个常规岗位待补位`
          : "后天排班已生成"
      );
    } catch (error) {
      this.context.toast(
        `后天排班生成失败：${error instanceof Error ? error.message : String(error)}`,
        "danger"
      );
    }
  }

  private confirmStale(action: string): boolean {
    return (
      !this.context.model().schedulePolicyStale ||
      this.context.confirm(
        `排班规则已更新，但当前班表尚未重新生成。仍要${action}吗？`
      )
    );
  }
}
