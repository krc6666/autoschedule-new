import type {
  ApplicationContext,
  UiCommandController,
} from "../application-context";
import type { UiCommand } from "../../ui/events/ui-command";
import { normalizeWeeklyFlightNo } from "../../domain/flights/weekly-flight-plan";
import { scheduleRunStopMessage } from "../schedule-run-controller";
import { flightSeasonSyncPreview } from "../../domain/flights/flight-season-sync";

export class ConfigurationController implements UiCommandController {
  constructor(private readonly context: ApplicationContext) {}

  async handle(command: UiCommand): Promise<boolean> {
    const commands = this.context.store.getState().configuration;
    switch (command.type) {
      case "sync-b-flight-season": {
        const plan = flightSeasonSyncPreview(this.context.model());
        if (
          this.context.model().activeGroupId !== "B" ||
          plan.fingerprint !== command.fingerprint ||
          plan.error
        ) {
          this.context.toast(plan.error || "资料已改变，请重新核对", "warning");
          return true;
        }
        if (
          !this.context.confirm(
            `B组本季航班按A组更新？新增/重新启用：${plan.additions.join("、") || "无"}；暂不使用：${plan.retirements.join("、") || "无"}；时间更新：${plan.timeChanges.map((r) => `${r.flightNo} ${r.from} → ${r.to}`).join("、") || "无"}。B组全部岗位性质、资质、人员、规则和历史保留；停用只移出当天航班，旧班表需要重排。待配B组岗位：${plan.missingPositions.join("、") || "无"}。取消不修改。`
          )
        )
          return true;
        const result = commands.syncFlightSeason(command.fingerprint);
        if (result.ok) this.context.commit(result.message);
        else this.context.toast(result.message, "warning");
        return true;
      }
      case "set-flight-season-enabled": {
        if (
          !this.context.confirm(
            `${command.flightNo} ${command.enabled ? "恢复为本季启用" : "标为暂不使用"}？保留全部岗位配置、资质及历史，本组旧班表需要重排。`
          )
        )
          return true;
        const result = commands.setFlightSeasonEnabled(
          command.flightNo,
          command.enabled
        );
        if (result.ok) this.context.commit(result.message);
        else this.context.toast(result.message, "warning");
        return true;
      }
      case "confirm-flight-plan-review": {
        if (command.groupId !== "B") {
          this.context.toast("本季航班以A组为准，请切到B组核对", "warning");
          return true;
        }
        if (command.groupId !== this.context.model().activeGroupId) {
          this.context.toast("当前组已改变，请重新核对", "warning");
          return true;
        }
        const choice = command.choice;
        const sourceGroup = "A";
        const effect =
          choice.action === "retire-flight"
            ? `确认 ${choice.previousFlightNo} 是已停用的旧航班？将删除当前组这个航班、岗位和相关规则，并清空本组未归档班表，需要重新排班。过去历史、次数记录和另一组保留。取消不修改。`
            : choice.action === "rename"
              ? `将本组 ${choice.previousFlightNo} 换号为 ${choice.expectedFlightNo}，保留岗位和资质，时段改为 ${choice.expectedStartTime}–${choice.expectedEndTime}，清除本组未归档班表。历史及另一组不变。`
              : choice.action === "new-flight"
                ? `确认 ${choice.expectedFlightNo} 是新增航班？不会沿用旧航班岗位，请另配本组岗位和资质。`
                : choice.action === "use-template-time"
                  ? `按模板更新本组 ${choice.expectedFlightNo} 时段为 ${choice.expectedStartTime}–${choice.expectedEndTime}，清除本组未归档班表，需重新排班。`
                  : `确认本组 ${choice.expectedFlightNo} 保留当天时段 ${choice.expectedCurrentStartTime}–${choice.expectedCurrentEndTime}？`;
        if (
          !this.context.confirm(
            `以 ${sourceGroup} 组本季名单为准，核对当前 ${command.groupId} 组。${effect}`
          )
        )
          return true;
        const result = commands.reviewFlightPlan(choice);
        if (result.ok) this.context.commit(result.message);
        else this.context.toast(result.message, "warning");
        return true;
      }
      case "add-leave-type":
      case "update-leave-type":
      case "delete-leave-type": {
        if (
          command.type === "delete-leave-type" &&
          !this.context.confirm("删除这个未使用的休假类别？")
        )
          return true;
        const result =
          command.type === "add-leave-type"
            ? commands.addLeaveType(command.name)
            : command.type === "update-leave-type"
              ? commands.updateLeaveType(command.id, command.patch)
              : commands.deleteLeaveType(command.id);
        if (!result.ok) this.context.toast(result.error, "warning");
        else this.context.commit("休假类别已更新");
        return true;
      }
      case "update-configuration": {
        if (command.entity === "staff" && command.field === "status") {
          const status = String(command.value);
          const changed = this.context.store
            .getState()
            .schedule.applyStaffStatus(command.id, status);
          if (!changed) {
            this.context.toast(
              "人员状态未更新，请选择可用的状态或休假类别",
              "warning"
            );
            return true;
          }
          const activeDate = this.context.model().activeScheduleDate;
          if (!activeDate) {
            this.context.commit("人员状态已更新");
            return true;
          }
          this.context.commit();
          try {
            const outcome = await this.context.scheduleRunner.calculate(
              this.context.model(),
              activeDate
            );
            if (outcome.kind === "stopped-without-result") {
              this.context.commit(
                scheduleRunStopMessage(
                  outcome,
                  "人员状态已更新，排班重算已停止"
                )
              );
              return true;
            }
            const result = outcome.result;
            this.context.store.getState().schedule.install(activeDate, result);
            this.context.commit(
              scheduleRunStopMessage(
                outcome,
                outcome.kind === "stopped-with-result"
                  ? "人员状态已更新，已采用最近一份完整安全方案"
                  : result.unfilledCount
                    ? `人员状态已更新，当前排班已重新计算，${result.unfilledCount} 个岗位待补位`
                    : "人员状态已更新，当前排班已重新计算"
              )
            );
          } catch (error) {
            this.context.toast(
              `人员状态已更新，但排班重新计算失败：${error instanceof Error ? error.message : String(error)}`,
              "danger"
            );
          }
          return true;
        }
        const result = commands.updateField(
          command.entity,
          command.id,
          command.field,
          command.value
        );
        if (result === "duplicate")
          this.context.toast(
            command.entity === "staff"
              ? "人员编号不能重复"
              : "航班号不能重复或为空；请检查模板和两组当前航班是否已有新名称，未修改任何配置",
            "danger"
          );
        else if (result !== "missing") this.context.commit();
        return true;
      }
      case "add-flight":
        commands.addFlight();
        this.context.commit("已新增航班");
        return true;
      case "delete-flight": {
        const flight = this.context
          .model()
          .flights.find((item) => item.id === command.id);
        if (
          flight &&
          this.context.confirm(`确认删除航班 ${flight.flightNo}？`) &&
          commands.deleteFlight(command.id)
        )
          this.context.commit("航班已删除");
        return true;
      }
      case "open-flight-templates":
        this.context.updateView({ dialog: { kind: "templates" } });
        return true;
      case "add-template-flight":
        if (commands.addTemplateFlight(command.id))
          this.context.commit("已从模板添加航班");
        this.context.updateView({ dialog: null });
        return true;
      case "add-template":
        commands.addTemplate();
        this.context.commit("已新增航班模板");
        return true;
      case "rename-current-flight-to-template": {
        const model = this.context.model();
        const flight = model.flights.find(
          (item) => item.id === command.flightId
        );
        const template = model.templates.find(
          (item) => item.id === command.templateId
        );
        if (!flight || !template) {
          this.context.toast("航班或模板已变更，请重新选择", "warning");
          return true;
        }
        if (
          !this.context.confirm(
            `确认修正航班名称 ${flight.flightNo} → ${template.flightNo}？两组同旧名称的当前航班将同步改名，保留时段、人数、岗位和备注，清除受影响班表；历史不变。`
          )
        )
          return true;
        const result = commands.renameCurrentFlightToTemplate(
          command.flightId,
          command.templateId
        );
        if (result === "updated")
          this.context.commit("航班名称已修正，请重新生成排班");
        else
          this.context.toast(
            result === "duplicate"
              ? "两组当前航班中已存在目标名称，本次修正未执行；请先核对重复航班，不能自动合并"
              : "当前航班或模板已变更；有对应模板的航班请直接修改模板名称",
            "warning"
          );
        return true;
      }
      case "delete-template":
        commands.deleteTemplate(command.id);
        this.context.commit("模板已删除");
        return true;
      case "cleanup-orphaned-flight-rules": {
        const flightNo = normalizeWeeklyFlightNo(command.flightNo);
        const hasTemplate = this.context
          .model()
          .templates.some(
            (template) =>
              normalizeWeeklyFlightNo(template.flightNo) === flightNo
          );
        if (
          hasTemplate ||
          !this.context.confirm(
            `确认清理无模板航班 ${flightNo} 的 A、B 两组岗位规则？当前航班和历史不删除，受影响未归档班表会清空并需重新排班。`
          )
        )
          return true;
        const removed = commands.cleanupOrphanedFlightRules(flightNo);
        if (removed)
          this.context.commit(`已清理 ${flightNo} 的 ${removed} 条岗位规则`);
        else
          this.context.toast("无模板岗位规则已变更，请刷新后重试", "warning");
        return true;
      }
      case "set-weekly-flight-template":
        if (
          commands.setWeeklyFlightPlanFlight(
            command.weekday,
            command.flightNo,
            command.selected
          )
        )
          this.context.commit("每周航班计划已更新");
        return true;
      case "add-staff":
        command.administrative
          ? commands.addAdministrativeStaff()
          : commands.addStaff();
        this.context.commit(
          command.administrative ? "已新增行政支援人员" : "已新增人员"
        );
        return true;
      case "delete-staff": {
        const person = this.context
          .model()
          .staff.find((item) => item.id === command.id);
        if (
          person &&
          this.context.confirm(
            `确认删除 ${person.name}？相关岗位资质也会同步移除。`
          ) &&
          commands.deleteStaff(command.id)
        )
          this.context.commit("人员已删除");
        return true;
      }
      case "add-positions": {
        if (!command.flightNo) this.context.toast("请先配置航班", "warning");
        else
          this.context.commit(
            `已为 ${command.flightNo} 新增 ${commands.addPositions(command.flightNo, command.count)} 条岗位规则`
          );
        return true;
      }
      case "copy-position-rules": {
        const targetHasRules = this.context
          .model()
          .positionRules.some(
            (rule) =>
              normalizeWeeklyFlightNo(rule.flightNo) ===
              normalizeWeeklyFlightNo(command.targetFlightNo)
          );
        if (
          targetHasRules &&
          !this.context.confirm(
            `目标航班 ${command.targetFlightNo} 已有岗位规则，确认覆盖？`
          )
        )
          return true;
        if (
          commands.copyPositionRules(
            command.sourceFlightNo,
            command.targetFlightNo,
            targetHasRules
          )
        )
          this.context.commit(
            `已将 ${command.sourceFlightNo} 的岗位配置复制到 ${command.targetFlightNo}`
          );
        return true;
      }
      case "delete-position": {
        const rule = this.context
          .model()
          .positionRules.find((item) => item.id === command.id);
        if (
          rule &&
          this.context.confirm(`确认删除 ${rule.flightNo} / ${rule.name}？`) &&
          commands.deletePosition(command.id)
        )
          this.context.commit("岗位规则已删除");
        return true;
      }
      case "move-position":
        if (commands.movePosition(command.id, command.direction))
          this.context.commit("岗位顺序已调整");
        return true;
      case "sort-counters":
        commands.sortCountersDescending(command.flightNo);
        this.context.commit(`${command.flightNo} 柜台已按编号从大到小排列`);
        return true;
      case "open-qualification":
        this.context.updateView({
          dialog: { kind: "qualification", positionRuleId: command.id },
        });
        return true;
      case "save-qualification":
        if (
          commands.saveQualified(command.id, command.manual, command.staffIds)
        )
          this.context.commit("岗位资质已保存");
        this.context.updateView({ dialog: null });
        return true;
      default:
        return false;
    }
  }
}
