import type { FlightTemplate, GroupWorkspace } from "../../model";
import {
  configuredFlightNumbers,
  configuredSeasonTemplates,
} from "./configured-flight-positions";
import { normalizeWeeklyFlightNo as normalize } from "./weekly-flight-plan";
import { fnv64Fingerprint } from "../rules/schedule-rule-fingerprint";

export const hasFlightTime = (value: string) =>
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** One read-only plan for confirmation and commit; never guesses old/new mapping. */
type SeasonWorkspace = Pick<
  GroupWorkspace,
  "positionRules" | "flights" | "flightSeasonOverrides"
>;

type SeasonSyncState = SeasonWorkspace & {
  activeGroupId: "A" | "B";
  groups: Record<"A" | "B", SeasonWorkspace>;
  templates: FlightTemplate[];
};

export function flightSeasonSyncPreview(state: SeasonSyncState) {
  const workspace = (id: "A" | "B"): SeasonWorkspace =>
    state.activeGroupId === id ? state : state.groups[id];
  const source = workspace("A");
  const target = workspace("B");
  const sourceNos = configuredFlightNumbers(
    source.positionRules,
    source.flightSeasonOverrides
  );
  const targetNos = configuredFlightNumbers(
    target.positionRules,
    target.flightSeasonOverrides
  );
  // Shared templates define recurring times; A's temporary daily changes are not a season plan.
  const templates = configuredSeasonTemplates(
    state.templates,
    source.positionRules,
    [],
    source.flightSeasonOverrides
  );
  const additions = sourceNos.filter((no) => !targetNos.includes(no));
  const retirements = [
    ...new Set([
      ...targetNos,
      ...target.flights.map((f) => normalize(f.flightNo)),
    ]),
  ].filter((no) => !sourceNos.includes(no));
  const timeChanges = target.flights.flatMap((f) => {
    const t = templates.find(
      (t) => normalize(t.flightNo) === normalize(f.flightNo)
    );
    return t && (t.startTime !== f.startTime || t.endTime !== f.endTime)
      ? [
          {
            flightNo: t.flightNo,
            from: `${f.startTime}–${f.endTime}`,
            to: `${t.startTime}–${t.endTime}`,
          },
        ]
      : [];
  });
  const missingPositions = sourceNos.filter(
    (no) => !target.positionRules.some((r) => normalize(r.flightNo) === no)
  );
  const error = !sourceNos.length
    ? "A组尚无本季航班，不能用空名单覆盖B组"
    : templates.some(
          (t) => !hasFlightTime(t.startTime) || !hasFlightTime(t.endTime)
        )
      ? "请先补齐A组本季航班的共用模板时间"
      : "";
  return {
    sourceNos,
    targetNos,
    templates,
    additions,
    retirements,
    timeChanges,
    missingPositions,
    error,
    count: additions.length + retirements.length + timeChanges.length,
    fingerprint: fnv64Fingerprint(
      [
        state.activeGroupId,
        sourceNos,
        targetNos,
        target.flightSeasonOverrides ?? {},
        target.positionRules,
        target.flights,
        templates.map(({ id, flightNo, startTime, endTime }) => ({
          id,
          flightNo,
          startTime,
          endTime,
        })),
      ],
      "season-sync-v1"
    ),
  };
}
