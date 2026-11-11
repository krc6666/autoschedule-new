import type { AppState } from "../model";
import {
  flightPlanReview,
  type FlightPlanReviewChoice,
} from "../domain/flights/flight-plan-review";
import {
  removeFlightScopedReferences,
  renameGroupFlightReferences,
} from "../domain/flights/group-flight-references";
import { normalizeWeeklyFlightNo as normalize } from "../domain/flights/weekly-flight-plan";
import { clearActiveSchedule } from "../domain/kernel/schedule-lifecycle";

export function applyFlightPlanReview(
  state: AppState,
  choice: FlightPlanReviewChoice
): { ok: boolean; message: string } {
  const fail = (message: string) => ({ ok: false, message });
  const review = flightPlanReview(state);
  if (
    JSON.stringify(choice.expectedSourceFlightNos) !==
    JSON.stringify(review.sourceFlightNos)
  )
    return fail("作为依据的另一组本季名单已改变，请重新核对，未修改任何数据");
  if (choice.action === "retire-flight") {
    const previous = normalize(choice.previousFlightNo);
    if (!previous || !review.unmatchedFlightNos.includes(previous))
      return fail(
        "旧航班已改变、已删除或已在依据组本季名单中，请重新核对，未修改任何数据"
      );
    state.flights = state.flights.filter(
      (f) => normalize(f.flightNo) !== previous
    );
    state.positionRules = state.positionRules.filter(
      (r) => normalize(r.flightNo) !== previous
    );
    removeFlightScopedReferences(state.settings, previous);
    state.flightPlanConfirmations = (
      state.flightPlanConfirmations ?? []
    ).filter((r) => normalize(r.flightNo) !== previous);
    clearActiveSchedule(state);
    return {
      ok: true,
      message: `已删除本组停用旧航班 ${previous}、岗位和相关规则；历史、次数记录及另一组保留，请重新排班`,
    };
  }
  const template = state.templates.find((t) => t.id === choice.templateId);
  if (
    !template ||
    template.flightNo !== choice.expectedFlightNo ||
    template.startTime !== choice.expectedStartTime ||
    template.endTime !== choice.expectedEndTime
  )
    return fail("航班模板已改变，请重新核对，未修改任何数据");
  const no = normalize(template.flightNo);
  if (
    ![template.startTime, template.endTime].every((value) =>
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    )
  )
    return fail("请先补齐航班模板的开始和结束时间，再确认航班来源");
  if (choice.action === "rename") {
    const previous = normalize(choice.previousFlightNo ?? "");
    if (!review.unmatchedFlightNos.includes(previous))
      return fail("旧航班已改变或仍在依据组本季名单中，未执行换号");
    if (!review.sourceFlightNos.includes(no))
      return fail("新航班已不在依据组本季名单中，请重新核对");
    if (
      (state.positionRules.some((r) => normalize(r.flightNo) === previous) &&
        state.positionRules.some((r) => normalize(r.flightNo) === no)) ||
      (state.flights.some((f) => normalize(f.flightNo) === previous) &&
        state.flights.some((f) => normalize(f.flightNo) === no))
    )
      return fail("新旧航班都有岗位配置或当天航班，不能自动合并，请先核对");
    const rename = (value: string) =>
      normalize(value) === previous ? template.flightNo : value;
    renameGroupFlightReferences(state.positionRules, state.settings, rename);
    for (const row of state.latePriorityFrequencyAdjustments)
      row.flightNo = rename(row.flightNo);
    for (const flight of state.flights) {
      if (normalize(flight.flightNo) !== previous) continue;
      flight.flightNo = template.flightNo;
      flight.startTime = template.startTime;
      flight.endTime = template.endTime;
    }
    state.flightPlanConfirmations = (
      state.flightPlanConfirmations ?? []
    ).filter(
      (r) => normalize(r.flightNo) !== previous && normalize(r.flightNo) !== no
    );
    clearActiveSchedule(state);
    return {
      ok: true,
      message: `${previous} 已换号为 ${template.flightNo}，保留本组岗位与资质，时段已按模板更新，请重新排班`,
    };
  }
  const flight = state.flights.find(
    (f) => f.id === choice.flightId && normalize(f.flightNo) === no
  );
  if (
    choice.action !== "new-flight" &&
    (!flight ||
      flight.startTime !== choice.expectedCurrentStartTime ||
      flight.endTime !== choice.expectedCurrentEndTime)
  )
    return fail("当天航班或时段已改变，请重新核对，未修改任何数据");
  if (
    choice.action === "new-flight" &&
    !review.missingPositions.some((r) => r.template.id === template.id)
  )
    return fail("这个航班已经有本组岗位，请重新核对");
  if (choice.action === "use-template-time") {
    flight!.startTime = template.startTime;
    flight!.endTime = template.endTime;
    clearActiveSchedule(state);
    return { ok: true, message: "当前组航班时段已更新，请重新排班" };
  }
  if (choice.action !== "new-flight" && choice.action !== "keep-current-time")
    return fail("请选择有效的处理方式");
  state.flightPlanConfirmations = [
    ...(state.flightPlanConfirmations ?? []).filter(
      (r) => !(r.flightNo === no && r.kind === choice.action)
    ),
    {
      kind: choice.action,
      flightNo: no,
      templateStartTime: template.startTime,
      templateEndTime: template.endTime,
      currentStartTime:
        choice.action === "keep-current-time" ? flight!.startTime : "",
      currentEndTime:
        choice.action === "keep-current-time" ? flight!.endTime : "",
    },
  ];
  return {
    ok: true,
    message:
      choice.action === "new-flight"
        ? "已确认为新增航班，请在当前组岗位配置中设置岗位和资质；旧航班未改动"
        : "已确认保留本组当天时段，模板或当天时段再次变化时会重新提醒",
  };
}
