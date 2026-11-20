import type { Flight, PositionRule } from "../../model";
import {
  flightHasSpecialRule,
  type FlightIdentityFacts,
} from "./flight-identities";
import { timeToMinutes } from "../shared/time";

export interface AssignmentTask {
  key: string;
  flight: Flight;
  rule: PositionRule;
}

const PRE_NOON_CUTOFF_MINUTES = 12 * 60;

export function isPreNoonFlight(target: Pick<Flight, "startTime">): boolean {
  const start = timeToMinutes(target.startTime);
  return Number.isFinite(start) && start < PRE_NOON_CUTOFF_MINUTES;
}

export function meetsPassengerThreshold(
  flight: Pick<Flight, "bookedPassengers">,
  rule: Pick<PositionRule, "minPassengers">
): boolean {
  return (rule.minPassengers ?? 0) <= flight.bookedPassengers;
}

export function mustAutoFillPreNoon(
  flight: Flight,
  rule: PositionRule
): boolean {
  return (
    isPreNoonFlight(flight) &&
    rule.category === "常规" &&
    meetsPassengerThreshold(flight, rule)
  );
}

export function isKe166MobileSupervisor(
  flight: Flight,
  rule: PositionRule,
  context: FlightIdentityFacts = {}
): boolean {
  return (
    flightHasSpecialRule(context, flight.flightNo, "KE166") &&
    isMobileSupervisor(flight, rule)
  );
}

export function isMobileSupervisor(
  _flight: Flight,
  rule: PositionRule
): boolean {
  return rule.category === "机动督导";
}

export function isNumberedRegularPosition(rule: PositionRule): boolean {
  return rule.category === "常规" && /\d/.test(rule.name);
}

export function shouldAutoAssign(
  flight: Flight,
  rule: PositionRule,
  administrativeSupportEnabled = false,
  context: FlightIdentityFacts = {}
): boolean {
  if (isKe166MobileSupervisor(flight, rule, context)) return true;
  if (mustAutoFillPreNoon(flight, rule)) return true;
  if (rule.category === "行政支援") {
    return (
      administrativeSupportEnabled && meetsPassengerThreshold(flight, rule)
    );
  }
  return (
    rule.category !== "引导" &&
    !rule.manual &&
    meetsPassengerThreshold(flight, rule)
  );
}
