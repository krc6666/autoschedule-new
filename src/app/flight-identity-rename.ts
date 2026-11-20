import type { AppState, FlightIdentity } from "../model";
import { createId } from "../utils";
import {
  flightIdentityKey,
  validateFlightIdentities,
} from "../domain/flights/flight-identities";
import { normalizeWeeklyFlightNo as normalize } from "../domain/flights/weekly-flight-plan";

/** Explicit rename is evidence of continuity, unlike a similar-looking number. */
export function flightRenameIdentityPlan(
  state: AppState,
  previous: string,
  next: string
): { identities: FlightIdentity[]; error: string } {
  const identities = JSON.parse(
    JSON.stringify(state.shared.flightIdentities ?? [])
  ) as FlightIdentity[];
  if (normalize(previous) === normalize(next)) return { identities, error: "" };
  const oldKey = flightIdentityKey(state, previous),
    nextKey = flightIdentityKey(state, next);
  if (nextKey.startsWith("@") && nextKey !== oldKey)
    return {
      identities,
      error: "新名称已属于另一航班档案，请先在航班长期档案中核对",
    };
  if (
    oldKey === normalize(previous) &&
    identities.some((i) =>
      i.aliases.some((a) => normalize(a.flightNo) === normalize(previous))
    )
  )
    return {
      identities,
      error: "旧名称有跨期归属，请在航班长期档案中明确换季关系",
    };
  let identity = identities.find((i) => `@${i.id.toUpperCase()}` === oldKey);
  if (!identity) {
    identity = {
      id: createId("flight"),
      displayName: next,
      aliases: [{ flightNo: previous, positionSourceFlightNo: next }],
    };
    identities.push(identity);
  }
  for (const alias of identity.aliases) {
    if (
      alias.positionSourceFlightNo &&
      normalize(alias.positionSourceFlightNo) === normalize(previous)
    )
      alias.positionSourceFlightNo = next;
    if (normalize(alias.flightNo) === normalize(previous))
      alias.positionSourceFlightNo = next;
  }
  if (!identity.aliases.some((a) => normalize(a.flightNo) === normalize(next)))
    identity.aliases.push({ flightNo: next });
  return { identities, error: validateFlightIdentities(identities).join("；") };
}
