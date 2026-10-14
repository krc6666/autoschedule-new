import { createTeamLeaderGapFillChainScenario } from "./scheduling-scenario";

export const SUPERVISOR_GAP_FILL_DATE = "2026-10-13";

export function createSupervisorGapFillScenario(direct = false) {
  const scenario = createTeamLeaderGapFillChainScenario();
  const { state, leader, worker } = scenario;
  leader.name = "分队长甲";
  worker.name = "员工乙";
  const source = state.assignments[0]!;
  const vacancy = state.assignments[1]!;
  const sourceFlight = state.flights[0]!;
  const vacancyFlight = state.flights[1]!;
  const vacancyRule = state.positionRules[1]!;
  sourceFlight.startTime = source.startTime = "21:05";
  sourceFlight.endTime = source.endTime = "23:05";
  source.staffName = worker.name;
  vacancyFlight.flightNo = vacancy.flightNo = vacancyRule.flightNo = "TW616";
  vacancyFlight.startTime = vacancy.startTime = "22:10";
  vacancyFlight.endTime = vacancy.endTime = "00:10";
  vacancyRule.category = "机动督导";
  vacancyRule.name = vacancy.position = "督导/引导";
  vacancyRule.fatiguePoints = vacancy.fatiguePoints = 9;
  vacancyRule.qualifiedStaffIds = [direct ? leader.id : worker.id];
  vacancy.systemNotes = ["自动排班未找到安全督导安排"];
  state.activeScheduleDate = SUPERVISOR_GAP_FILL_DATE;
  state.settings.dailyPrimaryPositionUniqueEnabled = true;
  return { ...scenario, source, vacancy, vacancyRule, vacancyFlight };
}
