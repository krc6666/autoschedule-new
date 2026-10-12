import type { UiCommand } from "../../ui/events/ui-command";
import type {
  ApplicationContext,
  UiCommandController,
} from "../application-context";
import { diagnoseSupervisorFillRuleConfiguration } from "../../domain/coverage/supervisor-fill-facts";

export class PolicyController implements UiCommandController {
  constructor(private readonly context: ApplicationContext) {}

  async handle(command: UiCommand): Promise<boolean> {
    const policy = this.context.store.getState().policy;
    switch (command.type) {
      case "apply-policy":
        policy.apply(command.input);
        this.context.commit(
          "排班规则已保存；当前班表需重新排班后才会执行新规则"
        );
        return true;
      case "update-policy":
        {
          const result = policy.updateEntity(
            command.entity,
            command.id,
            command.field,
            command.value
          );
          if (result !== "missing") {
            this.context.commit();
            if (command.entity === "supervisor-fill") {
              const rule = this.context
                .model()
                .settings.mobileSupervisorFillRules.find(
                  (item) => item.id === command.id
                );
              const issue = rule
                ? diagnoseSupervisorFillRuleConfiguration(
                    this.context.model(),
                    rule
                  )
                : null;
              if (issue?.severity === "warning")
                this.context.toast(issue.message, "warning");
            }
          }
        }
        return true;
      case "add-ordinary-priority-position":
        policy.addOrdinaryPriorityPosition();
        this.context.commit("普通重点岗位已新增");
        return true;
      case "delete-ordinary-priority-position":
        if (
          policy.deleteOrdinaryPriorityPosition(
            command.airlineCode,
            command.position
          )
        )
          this.context.commit("普通重点岗位已删除");
        return true;
      case "update-ordinary-priority-position":
        if (
          policy.updateOrdinaryPriorityPosition(
            command.index,
            command.field,
            command.value
          )
        )
          this.context.commit("普通重点岗位已更新");
        return true;
      case "set-team-leader-gap-fill-positions-movable":
        if (
          policy.setTeamLeaderGapFillPositionsMovable(
            command.positionRuleIds,
            command.movable
          )
        )
          this.context.commit(
            command.movable
              ? "已允许所选岗位参与分队长补差换人"
              : "所选岗位已设为分队长补差保护"
          );
        return true;
      case "add-policy-item":
        if (command.collection === "same-flight-staff-exclusion")
          policy.addSameFlightStaffExclusion();
        else if (command.collection === "duty") policy.addDutyPriority();
        else if (command.collection === "recovery-target")
          policy.addRecoveryTarget();
        else if (command.collection === "cross-workday-reservation")
          policy.addCrossWorkdayReservation();
        else if (command.collection === "cross-flight-priority")
          policy.addCrossFlightPriority();
        else if (command.collection === "late-position")
          policy.addLateShiftPosition();
        else if (command.collection === "supervisor")
          policy.addSupervisorCoverage();
        else if (command.collection === "supervisor-fill")
          policy.addSupervisorFill();
        else policy.addTransition();
        this.context.commit("已新增规则项");
        return true;
      case "delete-policy-item":
        return this.deleteItem(command.collection, command.id);
      case "move-duty-priority":
        if (policy.moveDutyPriority(command.id, command.direction))
          this.context.commit("值班岗位优先顺序已调整");
        return true;
      case "move-cross-workday-reservation":
        if (policy.moveCrossWorkdayReservation(command.id, command.direction))
          this.context.commit("跨工作日资质预留顺序已调整");
        return true;
      case "move-cross-flight-priority":
        if (policy.moveCrossFlightPriority(command.id, command.direction))
          this.context.commit("跨航班重点人员优先顺序已调整");
        return true;
      default:
        return false;
    }
  }

  private deleteItem(
    collection: Extract<
      UiCommand,
      { type: "delete-policy-item" }
    >["collection"],
    id: string
  ): boolean {
    if (!this.context.confirm("确认删除这条规则配置？")) return true;
    const policy = this.context.store.getState().policy;
    const deleted =
      collection === "same-flight-staff-exclusion"
        ? policy.deleteSameFlightStaffExclusion(id)
        : collection === "duty"
          ? policy.deleteDutyPriority(id)
          : collection === "recovery-target"
            ? policy.deleteRecoveryTarget(id)
            : collection === "cross-workday-reservation"
              ? policy.deleteCrossWorkdayReservation(id)
              : collection === "cross-flight-priority"
                ? policy.deleteCrossFlightPriority(id)
                : collection === "late-position"
                  ? policy.deleteLateShiftPosition(id)
                  : collection === "supervisor"
                    ? policy.deleteSupervisorCoverage(id)
                    : collection === "supervisor-fill"
                      ? policy.deleteSupervisorFill(id)
                      : policy.deleteTransition(id);
    if (deleted) this.context.commit("规则配置已删除");
    return true;
  }
}
