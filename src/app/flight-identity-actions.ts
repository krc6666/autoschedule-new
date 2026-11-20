import type { AppState, FlightIdentity } from "../model";
import { createId } from "../utils";
import {
  flightIdentityChangeFingerprint,
  flightIdentityReferenceMapper,
  previewFlightIdentityChange,
} from "../domain/flights/flight-identity-change";
import { renameGroupFlightReferences } from "../domain/flights/group-flight-references";
import { normalizeWeeklyFlightNo } from "../domain/flights/weekly-flight-plan";

/** Both direct maintenance and workbook imports carry jobs from the same group. */
export function inheritFlightIdentityPositions(
  state: AppState,
  identities: readonly FlightIdentity[]
): void {
  for (const groupId of ["A", "B"] as const) {
    const workspace =
      groupId === state.activeGroupId ? state : state.groups[groupId];
    for (const identity of identities)
      for (const alias of identity.aliases) {
        if (
          !alias.positionSourceFlightNo ||
          workspace.positionRules.some(
            (r) =>
              normalizeWeeklyFlightNo(r.flightNo) ===
              normalizeWeeklyFlightNo(alias.flightNo)
          )
        )
          continue;
        const source = workspace.positionRules.filter(
          (r) =>
            normalizeWeeklyFlightNo(r.flightNo) ===
            normalizeWeeklyFlightNo(alias.positionSourceFlightNo!)
        );
        workspace.positionRules.push(
          ...source.map((rule) => ({
            ...JSON.parse(JSON.stringify(rule)),
            id: createId("position"),
            flightNo: normalizeWeeklyFlightNo(alias.flightNo),
          }))
        );
        if (
          source.length &&
          state.templates.some(
            (t) =>
              normalizeWeeklyFlightNo(t.flightNo) ===
              normalizeWeeklyFlightNo(alias.flightNo)
          )
        ) {
          workspace.flightSeasonOverrides ??= {};
          workspace.flightSeasonOverrides[
            normalizeWeeklyFlightNo(alias.flightNo)
          ] ??= true;
        }
      }
  }
}

export function applyFlightIdentityChange(
  state: AppState,
  identities: FlightIdentity[],
  fingerprint: string
): { ok: boolean; message: string } {
  if (fingerprint !== flightIdentityChangeFingerprint(state))
    return { ok: false, message: "资料已改变，请重新预览航班档案" };
  const preview = previewFlightIdentityChange(state, identities);
  if (preview.errors.length)
    return { ok: false, message: preview.errors.join("；") };
  const map = flightIdentityReferenceMapper(state, identities);
  inheritFlightIdentityPositions(state, identities);
  for (const groupId of ["A", "B"] as const) {
    const workspace =
      groupId === state.activeGroupId ? state : state.groups[groupId];
    renameGroupFlightReferences([], workspace.settings, map);
    if (workspace.assignments.length) workspace.schedulePolicyStale = true;
    workspace.scheduleRuleFingerprint = undefined;
  }
  state.shared.flightIdentities = structuredClone(identities);
  return {
    ok: true,
    message: "航班档案已保存，两组规则自动共用，已有班表请重新排班",
  };
}
