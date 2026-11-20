import type { AppState } from "../../model";
import {
  flightIdentities,
  flightIdentityKey,
  flightIdentityLabel,
} from "../../domain/flights/flight-identities";

/** Values stay stable references; all page labels use the shared directory. */
export function flightIdentityOptions(
  state: AppState,
  extra: readonly string[] = []
): Array<readonly [string, string]> {
  return [
    ...new Set(
      [
        ...flightIdentities(state).map((i) => `@${i.id.toUpperCase()}`),
        ...state.templates.map((f) => f.flightNo),
        ...state.flights.map((f) => f.flightNo),
        ...state.positionRules.map((r) => r.flightNo),
        ...extra,
      ]
        .filter(Boolean)
        .map((no) => flightIdentityKey(state, no))
    ),
  ].map((key) => [key, flightIdentityLabel(state, key)] as const);
}
