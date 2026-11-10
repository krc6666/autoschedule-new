import { currentEarlyDepartureLastAssignmentIds } from "../../domain/statistics/relaxed-shift-statistics";
import { buildScheduleFeedback } from "../../domain/feedback/schedule-feedback";
import {
  activeFlightRules,
  compareGuideSourceAssignments,
  guideSourceStaff,
  isFixedBottomPosition,
} from "../../domain/flights/schedule-position-rules";
import { availableStaffForManualAssignment } from "../../domain/candidates/assignment-eligibility";
import { timeConflictAssignmentIds } from "../../domain/assignments/assignment-time-conflicts";
import type { AppState, Assignment, Staff } from "../../model";

export interface SchedulePageOptions {
  zoom: number;
  halfRestStaffIds?: readonly string[];
}

export interface ScheduleFlightGroup {
  flight: AppState["flights"][number];
  guideListId: string;
  guideCandidates: Staff[];
  primary: Assignment[];
  bottom: Assignment[];
}

function orderedAssignments(assignments: Assignment[]): Assignment[] {
  return assignments
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        (left.item.layoutIndex ?? left.index) -
          (right.item.layoutIndex ?? right.index) || left.index - right.index
    )
    .map(({ item }) => item);
}

function isBottomAssignment(state: AppState, assignment: Assignment): boolean {
  const rule = assignment.positionRuleId
    ? state.positionRules.find((item) => item.id === assignment.positionRuleId)
    : undefined;
  return (
    rule?.category === "引导" || isFixedBottomPosition(assignment.position)
  );
}

export function buildSchedulePageModel(
  state: AppState,
  date: string,
  options: SchedulePageOptions
) {
  const zoom = Math.min(1.6, Math.max(0.7, options.zoom));
  const scaled = (value: number): string =>
    `${Number((value * zoom).toFixed(1))}px`;
  const flights = [...state.flights].sort((left, right) =>
    left.startTime.localeCompare(right.startTime)
  );
  const groups: ScheduleFlightGroup[] = flights.map((flight, groupIndex) => {
    const assignments = state.assignments.filter(
      (item) => item.flightId === flight.id
    );
    const displayIndex = new Map(
      activeFlightRules(state, flight).map((rule, index) => [rule.id, index])
    );
    const guideCandidates = assignments
      .map((assignment) => ({
        assignment,
        person: guideSourceStaff(state, assignment),
      }))
      .filter(
        (
          item
        ): item is typeof item & {
          person: Staff;
        } => Boolean(item.person)
      )
      .sort((left, right) =>
        compareGuideSourceAssignments(
          state,
          displayIndex,
          left.assignment,
          right.assignment
        )
      )
      .map((item) => item.person)
      .filter(
        (person, index, people) =>
          people.findIndex((candidate) => candidate.id === person.id) === index
      );
    return {
      flight,
      guideListId: `schedule-guide-staff-${groupIndex}`,
      guideCandidates,
      primary: orderedAssignments(
        assignments.filter(
          (item) =>
            item.layoutGroup === "primary" ||
            (item.layoutGroup !== "bottom" && !isBottomAssignment(state, item))
        )
      ),
      bottom: orderedAssignments(
        assignments.filter(
          (item) =>
            item.layoutGroup === "bottom" ||
            (item.layoutGroup !== "primary" && isBottomAssignment(state, item))
        )
      ),
    };
  });
  const candidateStaffByAssignmentId = new Map(
    state.assignments.map((assignment) => [
      assignment.id,
      availableStaffForManualAssignment(state, assignment.id),
    ])
  );
  const timeConflictAssignmentIds = timeConflictAssignmentIdsForDate(
    state,
    flights
  );
  return {
    groups,
    earlyDepartureLastAssignmentIds: currentEarlyDepartureLastAssignmentIds(
      state,
      date
    ),
    feedback: buildScheduleFeedback(state, date, {
      halfRestStaffIds: options.halfRestStaffIds,
    }),
    candidateStaffByAssignmentId,
    timeConflictAssignmentIds,
    primaryRowCount:
      Math.max(0, ...groups.map((group) => group.primary.length)) + 1,
    bottomRowCount:
      Math.max(0, ...groups.map((group) => group.bottom.length)) + 1,
    regularStaff: state.staff.filter(
      (person) => person.staffType !== "行政支援"
    ),
    administrativeStaff: state.staff.filter(
      (person) => person.staffType === "行政支援"
    ),
    zoom,
    zoomPercent: Math.round(zoom * 100),
    tableStyles: {
      "--flight-count": String(Math.max(1, flights.length)),
      "--schedule-column-width": scaled(64),
      "--schedule-person-column-width": scaled(56),
      "--schedule-flight-width": scaled(120),
      "--schedule-header-height": scaled(50),
      "--schedule-cell-height": scaled(36),
      "--schedule-flight-size": scaled(14),
      "--schedule-position-size": scaled(11),
      "--schedule-small-size": scaled(10),
      "--schedule-tiny-size": scaled(9),
      "--schedule-input-height": scaled(19),
      "--schedule-name-width": scaled(48),
      "--schedule-divider-height": scaled(20),
    },
  };
}

function timeConflictAssignmentIdsForDate(
  state: AppState,
  flights: AppState["flights"]
): Set<string> {
  const flightIds = new Set(flights.map((flight) => flight.id));
  const scopedState = {
    ...state,
    assignments: state.assignments.filter((assignment) =>
      flightIds.has(assignment.flightId)
    ),
  };
  return timeConflictAssignmentIds(scopedState, scopedState.assignments);
}

export type SchedulePageModel = ReturnType<typeof buildSchedulePageModel>;
