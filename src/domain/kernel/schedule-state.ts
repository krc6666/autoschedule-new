import type { Assignment, Staff, StaffStatus } from "../../model";
import type { StaffAssignmentFacts } from "../shared/scheduling-facts";
import { clearSupervisorFillLink } from "../coverage/supervisor-fill-facts";

function linkedStaff(
  state: StaffAssignmentFacts,
  assignment: Assignment
): Staff | undefined {
  return assignment.staffId
    ? state.staff.find((person) => person.id === assignment.staffId)
    : assignment.staffName
      ? state.staff.find((person) => person.name === assignment.staffName)
      : undefined;
}

export function assignmentUsesUnavailableStaff(
  state: StaffAssignmentFacts,
  assignment: Assignment
): boolean {
  const person = linkedStaff(state, assignment);
  return Boolean(person && person.status !== "正常");
}

export function removeUnavailableStaffAssignments(
  state: StaffAssignmentFacts
): void {
  state.assignments.forEach((assignment) => {
    if (!assignmentUsesUnavailableStaff(state, assignment)) return;
    const rule = assignment.positionRuleId
      ? state.positionRules.find(
          (item) => item.id === assignment.positionRuleId
        )
      : undefined;
    assignment.staffId = null;
    assignment.staffName = "";
    assignment.status =
      !assignment.positionRuleId ||
      rule?.manual ||
      rule?.category === "行政支援"
        ? "manual"
        : "unfilled";
    clearSupervisorFillLink(assignment);
    delete assignment.systemNotes;
    delete assignment.vacancyEvidence;
  });
}

export function applyStaffStatusChange(
  state: StaffAssignmentFacts,
  staffId: string,
  status: StaffStatus
): boolean {
  const person = state.staff.find((item) => item.id === staffId);
  if (!person) return false;
  person.status = status;
  removeUnavailableStaffAssignments(state);
  return true;
}
