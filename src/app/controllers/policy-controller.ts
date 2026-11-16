import type { UiCommand } from "../../ui/events/ui-command";
import type {
  ApplicationContext,
  UiCommandController,
} from "../application-context";

export class PolicyController implements UiCommandController {
  constructor(private readonly context: ApplicationContext) {}

  async handle(command: UiCommand): Promise<boolean> {
    const policy = this.context.policyEditing.commands(this.context.model());
    switch (command.type) {
      case "open-supervisor-fill-settings":
        this.context.updateView({
          section: "policy",
          policyQuery: "督导补位关系",
        });
        return true;
      case "save-supervisor-fill": {
        const result = policy.saveSupervisorFill(command.rule);
        if (result.ok) {
          this.context.policyEditing.cancelSupervisor();
          this.context.updateView({});
        } else this.context.toast(result.error, "warning");
        return true;
      }
      case "edit-supervisor-fill":
        if (
          this.context.policyEditing.hasSupervisorChanges() &&
          !this.context.confirm(
            "当前补位关系有未完成的修改，确定放弃本条编辑并打开另一条？其他规则草稿会保留。"
          )
        )
          return true;
        this.context.policyEditing.editSupervisor(
          this.context.model(),
          command.rule
        );
        this.context.updateView({});
        return true;
      case "update-supervisor-fill-editor":
        this.context.policyEditing.updateSupervisor(command.patch);
        this.context.updateView({});
        return true;
      case "cancel-supervisor-fill-editor":
        this.context.policyEditing.cancelSupervisor();
        this.context.updateView({});
        return true;
      case "edit-policy-input":
        this.context.policyEditing.patch(this.context.model(), command.input);
        this.context.updateView({});
        return true;
      case "update-policy":
        this.context.policyEditing.updateField(
          this.context.model(),
          command.entity,
          command.id,
          command.field,
          command.value
        );
        this.context.updateView({});
        return true;
      case "add-ordinary-priority-position":
        policy.addOrdinaryPriorityPosition();
        this.context.updateView({});
        return true;
      case "delete-ordinary-priority-position":
        if (
          policy.deleteOrdinaryPriorityPosition(
            command.airlineCode,
            command.position
          )
        )
          this.context.updateView({});
        return true;
      case "update-ordinary-priority-position":
        this.context.policyEditing.updateOrdinaryPosition(
          this.context.model(),
          command.index,
          command.field,
          command.value
        );
        this.context.updateView({});
        return true;
      case "set-team-leader-gap-fill-positions-movable":
        if (
          policy.setTeamLeaderGapFillPositionsMovable(
            command.positionRuleIds,
            command.movable
          )
        )
          this.context.updateView({});
        return true;
      case "add-policy-item":
        if (command.collection === "airline-mix") policy.addAirlineMix();
        else if (command.collection === "same-flight-staff-exclusion")
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
        this.context.updateView({});
        return true;
      case "delete-policy-item":
        return this.deleteItem(command.collection, command.id);
      case "move-duty-priority":
        if (policy.moveDutyPriority(command.id, command.direction))
          this.context.updateView({});
        return true;
      case "move-cross-workday-reservation":
        if (policy.moveCrossWorkdayReservation(command.id, command.direction))
          this.context.updateView({});
        return true;
      case "move-cross-flight-priority":
        if (policy.moveCrossFlightPriority(command.id, command.direction))
          this.context.updateView({});
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
    const policy = this.context.policyEditing.commands(this.context.model());
    const deleted =
      collection === "airline-mix"
        ? policy.deleteAirlineMix(id)
        : collection === "same-flight-staff-exclusion"
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
    if (deleted) {
      this.context.policyEditing.forgetItemInputs(id);
      this.context.updateView({});
    }
    return true;
  }
}
