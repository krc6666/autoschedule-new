import type { Assignment } from "../../model";
import type { WorkloadAccountingFacts } from "./scheduling-facts";
import { isReusableAssignment } from "../flights/schedule-position-rules";

export function isCountedWorkloadAssignment(
  state: WorkloadAccountingFacts,
  assignment: Assignment
): boolean {
  const person = assignment.staffId
    ? state.staff.find((item) => item.id === assignment.staffId)
    : undefined;
  if (person?.staffType === "行政支援") return false;
  return !isReusableAssignment(state, assignment);
}

export function countedWorkloadAssignments(
  state: WorkloadAccountingFacts,
  assignments = state.assignments
): Assignment[] {
  return assignments.filter((assignment) =>
    isCountedWorkloadAssignment(state, assignment)
  );
}
