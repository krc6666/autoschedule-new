import type {
  FlightPlanConfirmation,
  FlightTemplate,
  GroupWorkspace,
  ScheduleGroupId,
} from "../../model";
import {
  configuredFlightNumbers,
  configuredSeasonTemplates,
} from "./configured-flight-positions";
import { normalizeWeeklyFlightNo as normalize } from "./weekly-flight-plan";

type FlightPlanReviewWorkspace = Pick<
  GroupWorkspace,
  | "positionRules"
  | "settings"
  | "flights"
  | "flightPlanConfirmations"
  | "flightSeasonOverrides"
>;

interface FlightPlanReviewInput extends FlightPlanReviewWorkspace {
  activeGroupId: ScheduleGroupId;
  templates: readonly FlightTemplate[];
  groups: Record<ScheduleGroupId, FlightPlanReviewWorkspace>;
}

const time = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function normalizeFlightPlanConfirmations(
  value: unknown
): FlightPlanConfirmation[] {
  if (!Array.isArray(value)) return [];
  const result: FlightPlanConfirmation[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !["new-flight", "keep-current-time"].includes(entry.kind) ||
      typeof entry.flightNo !== "string" ||
      !normalize(entry.flightNo) ||
      !time(entry.templateStartTime) ||
      !time(entry.templateEndTime) ||
      (entry.kind === "keep-current-time" &&
        (!time(entry.currentStartTime) || !time(entry.currentEndTime)))
    )
      continue;
    const row: FlightPlanConfirmation = {
      kind: entry.kind,
      flightNo: normalize(entry.flightNo),
      templateStartTime: entry.templateStartTime,
      templateEndTime: entry.templateEndTime,
      currentStartTime:
        entry.kind === "keep-current-time" ? entry.currentStartTime : "",
      currentEndTime:
        entry.kind === "keep-current-time" ? entry.currentEndTime : "",
    };
    if (!result.some((r) => r.kind === row.kind && r.flightNo === row.flightNo))
      result.push(row);
  }
  return result;
}

function groupFlightWorkspace(
  state: FlightPlanReviewInput,
  groupId: ScheduleGroupId
): FlightPlanReviewWorkspace {
  return groupId === state.activeGroupId ? state : state.groups[groupId];
}

export function flightPlanReview(
  state: FlightPlanReviewInput,
  groupId: ScheduleGroupId = state.activeGroupId
) {
  const group = groupFlightWorkspace(state, groupId);
  const sourceGroupId = "A";
  const source = groupFlightWorkspace(state, sourceGroupId);
  const sourceFlightNos = configuredFlightNumbers(
    source.positionRules,
    source.flightSeasonOverrides
  );
  const configuredFlightNos = configuredFlightNumbers(
    group.positionRules,
    group.flightSeasonOverrides
  );
  const references = new Set([
    ...configuredFlightNos,
    ...group.flights
      .map((f) => normalize(f.flightNo))
      .filter(
        (no) => Boolean(no) && group.flightSeasonOverrides?.[no] !== false
      ),
  ]);
  const unmatchedFlightNos = [...references].filter(
    (no) => !sourceFlightNos.includes(no)
  );
  const confirmations = normalizeFlightPlanConfirmations(
    group.flightPlanConfirmations
  );
  const confirmed = (
    template: FlightTemplate,
    kind: FlightPlanConfirmation["kind"],
    start = "",
    end = ""
  ) =>
    confirmations.some(
      (r) =>
        r.kind === kind &&
        r.flightNo === normalize(template.flightNo) &&
        r.templateStartTime === template.startTime &&
        r.templateEndTime === template.endTime &&
        r.currentStartTime === start &&
        r.currentEndTime === end
    );
  const sourceTemplates = configuredSeasonTemplates(
    state.templates,
    source.positionRules,
    source.flights,
    source.flightSeasonOverrides
  );
  const missingPositions = sourceTemplates
    .filter(
      (t) =>
        !group.positionRules.some(
          (r) => normalize(r.flightNo) === normalize(t.flightNo)
        )
    )
    .map((template) => ({
      template,
      confirmedNew: confirmed(template, "new-flight"),
    }));
  const timeDifferences = group.flights.flatMap((flight) => {
    if (groupId === "A") return [];
    const template = state.templates.find(
      (t) => normalize(t.flightNo) === normalize(flight.flightNo)
    );
    if (
      !template ||
      (flight.startTime === template.startTime &&
        flight.endTime === template.endTime) ||
      confirmed(template, "keep-current-time", flight.startTime, flight.endTime)
    )
      return [];
    return [{ flight, template }];
  });
  return {
    groupId,
    sourceGroupId,
    sourceFlightNos,
    configuredFlightNos,
    unmatchedFlightNos,
    missingPositions,
    timeDifferences,
    count:
      unmatchedFlightNos.length +
      missingPositions.length +
      timeDifferences.length,
  };
}

export interface FlightPlanTemplateReviewChoice {
  expectedSourceFlightNos: string[];
  action: "new-flight" | "rename" | "use-template-time" | "keep-current-time";
  templateId: string;
  expectedFlightNo: string;
  expectedStartTime: string;
  expectedEndTime: string;
  previousFlightNo?: string;
  flightId?: string;
  expectedCurrentStartTime?: string;
  expectedCurrentEndTime?: string;
}

export type FlightPlanReviewChoice =
  | FlightPlanTemplateReviewChoice
  | {
      action: "retire-flight";
      previousFlightNo: string;
      expectedSourceFlightNos: string[];
    };

export function flightPlanReviewSummaries(state: FlightPlanReviewInput) {
  return (["A", "B"] as const)
    .map((id) => {
      const review = flightPlanReview(state, id);
      return {
        groupId: id,
        sourceGroupId: review.sourceGroupId,
        count: review.count,
        unmatchedFlightNos: review.unmatchedFlightNos,
        missingPositionFlightNos: review.missingPositions.map(
          (r) => r.template.flightNo
        ),
        timeDifferenceFlightNos: review.timeDifferences.map(
          (r) => r.flight.flightNo
        ),
      };
    })
    .filter((r) => r.count > 0);
}

export type FlightPlanReviewSummary = ReturnType<
  typeof flightPlanReviewSummaries
>[number];
