import type { AppState } from "../model";
import {
  configuredFlightNumbers,
  normalizeFlightSeasonOverrides,
} from "../domain/flights/configured-flight-positions";
import {
  flightSeasonSyncPreview,
  hasFlightTime,
} from "../domain/flights/flight-season-sync";
import { normalizeWeeklyFlightNo as normalize } from "../domain/flights/weekly-flight-plan";
import { clearActiveSchedule } from "../domain/kernel/schedule-lifecycle";

export function applyFlightSeasonSync(state: AppState, fingerprint: string) {
  const plan = flightSeasonSyncPreview(state);
  if (
    state.activeGroupId !== "B" ||
    fingerprint !== plan.fingerprint ||
    plan.error
  )
    return {
      ok: false,
      message: plan.error || "两组资料已改变，请重新核对；未修改任何数据",
    };
  if (!plan.count)
    return { ok: true, message: "B组本季航班已与A组一致；岗位配置保留" };
  const all = new Set([
    ...configuredFlightNumbers(state.positionRules),
    ...Object.keys(state.flightSeasonOverrides ?? {}),
    ...state.flights.map((f) => normalize(f.flightNo)),
    ...plan.sourceNos,
  ]);
  state.flightSeasonOverrides = Object.fromEntries(
    [...all].map((no) => [no, plan.sourceNos.includes(no)])
  );
  state.flights = state.flights.filter((f) =>
    plan.sourceNos.includes(normalize(f.flightNo))
  );
  for (const flight of state.flights) {
    const template = plan.templates.find(
      (t) => normalize(t.flightNo) === normalize(flight.flightNo)
    )!;
    flight.startTime = template.startTime;
    flight.endTime = template.endTime;
  }
  clearActiveSchedule(state);
  return {
    ok: true,
    message: `B组本季航班已按A组更新，岗位性质、资质及历史全部保留，请重新排班。${plan.missingPositions.length ? `待配置B组岗位及资质：${plan.missingPositions.join("、")}` : ""}`,
  };
}

export function setFlightSeasonEnabled(
  state: AppState,
  flightNo: string,
  enabled: boolean
) {
  const no = normalize(flightNo);
  if (
    !no ||
    (!state.templates.some((t) => normalize(t.flightNo) === no) &&
      !state.positionRules.some((r) => normalize(r.flightNo) === no))
  )
    return { ok: false, message: "航班已改变，请重新核对" };
  const template = state.templates.find((t) => normalize(t.flightNo) === no);
  if (
    enabled &&
    (!template ||
      !hasFlightTime(template.startTime) ||
      !hasFlightTime(template.endTime))
  )
    return { ok: false, message: "请先补齐航班模板的开始和结束时间，再启用" };
  state.flightSeasonOverrides = {
    ...normalizeFlightSeasonOverrides(state.flightSeasonOverrides),
    [no]: enabled,
  };
  if (!enabled)
    state.flights = state.flights.filter((f) => normalize(f.flightNo) !== no);
  clearActiveSchedule(state);
  return {
    ok: true,
    message: `${no} 已${enabled ? "启用" : "标为暂不使用"}，岗位配置保留，请重新排班`,
  };
}
