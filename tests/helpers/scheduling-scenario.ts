import { createDefaultState } from "../../src/defaults";
import {
  createScheduleGenerationFacts,
  type ScheduleGenerationFacts,
} from "../../src/domain/shared/scheduling-facts";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import type {
  AppState,
  Assignment,
  Flight,
  HistoryRecord,
  PositionRule,
  Staff,
} from "../../src/model";

export function createOrdinarySchedulingState(): AppState {
  const state = createDefaultState();
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  state.staff.forEach((person) => {
    person.teamLeader = false;
  });
  return state;
}

export function createSchedulingScenario(
  overrides: Partial<ScheduleGenerationFacts> = {}
): ScheduleGenerationFacts {
  const defaults = createScheduleGenerationFacts(createDefaultState());
  defaults.settings.dailyPrimaryPositionUniqueEnabled = false;
  return {
    ...defaults,
    ...overrides,
  };
}

export interface TeamLeaderGapFillChainScenario {
  state: AppState;
  leader: Staff;
  worker: Staff;
}

export interface TeamLeaderGapFillChainScenarioOptions {
  prioritySource?: boolean;
}

export function createTeamLeaderGapFillChainScenario(
  options: TeamLeaderGapFillChainScenarioOptions = {}
): TeamLeaderGapFillChainScenario {
  const leader: Staff = {
    id: "leader",
    name: "刘红",
    staffType: "常规",
    teamLeader: true,
    cxPreflightQualified: false,
    dutyQualified: false,
    standbyQualified: true,
    nightShift: true,
    status: "正常",
    remark: "",
  };
  const worker: Staff = {
    ...leader,
    id: "worker",
    name: "员工worker",
    teamLeader: false,
  };
  const sourceFlight: Flight = {
    id: "ak151",
    flightNo: "AK151",
    startTime: "10:00",
    endTime: "12:00",
    bookedPassengers: 100,
    positions: [],
    remark: "",
  };
  const vacancyFlight: Flight = {
    ...sourceFlight,
    id: "tr",
    flightNo: "TR100",
  };
  const sourceRule: PositionRule = {
    id: "source",
    flightNo: sourceFlight.flightNo,
    name: "G01",
    category: "常规",
    remark: "",
    qualifiedStaffIds: [leader.id, worker.id],
    manual: false,
    fatiguePoints: 1,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  };
  const vacancyRule: PositionRule = {
    ...sourceRule,
    id: "vacancy",
    flightNo: vacancyFlight.flightNo,
    name: "G02",
    qualifiedStaffIds: [worker.id],
  };
  const sourceAssignment: Assignment = {
    id: "assignment-source",
    flightId: sourceFlight.id,
    flightNo: sourceFlight.flightNo,
    positionRuleId: sourceRule.id,
    position: sourceRule.name,
    staffId: worker.id,
    staffName: worker.name,
    startTime: sourceFlight.startTime,
    endTime: sourceFlight.endTime,
    workHours: 2,
    fatiguePoints: sourceRule.fatiguePoints,
    remark: sourceRule.remark,
    manualRemark: "",
    status: "assigned",
  };
  const vacancyAssignment: Assignment = {
    ...sourceAssignment,
    id: "assignment-vacancy",
    flightId: vacancyFlight.id,
    flightNo: vacancyFlight.flightNo,
    positionRuleId: vacancyRule.id,
    position: vacancyRule.name,
    staffId: null,
    staffName: "",
    startTime: vacancyFlight.startTime,
    endTime: vacancyFlight.endTime,
    remark: vacancyRule.remark,
    status: "unfilled",
  };
  const state = createDefaultState();
  state.staff = [leader, worker];
  state.flights = [sourceFlight, vacancyFlight];
  state.positionRules = [sourceRule, vacancyRule];
  state.assignments = [sourceAssignment, vacancyAssignment];
  state.activeScheduleDate = "2026-09-22";
  state.settings.positionRotationEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.ordinaryPriorityPositions = options.prioritySource
    ? [{ airlineCode: "AK", position: "G01" }]
    : [];
  return { state, leader, worker };
}

export function createTeamLeaderGapFillGuideChainScenario(): TeamLeaderGapFillChainScenario {
  const scenario = createTeamLeaderGapFillChainScenario();
  const sourceRule = scenario.state.positionRules.find(
    (item) => item.id === "source"
  )!;
  sourceRule.category = "引导";
  sourceRule.qualifiedStaffIds = [];
  const sourceAssignment = scenario.state.assignments.find(
    (item) => item.id === "assignment-source"
  )!;
  sourceAssignment.workHours = 0;
  sourceAssignment.fatiguePoints = 0;
  return scenario;
}

function createGapFillStaff(id: string, teamLeader = false): Staff {
  return {
    id,
    name: teamLeader ? "刘红" : `员工${id}`,
    staffType: "常规",
    teamLeader,
    cxPreflightQualified: false,
    dutyQualified: false,
    standbyQualified: true,
    nightShift: true,
    status: "正常",
    remark: "",
  };
}

function createGapFillFlight(id: string, flightNo: string): Flight {
  return {
    id,
    flightNo,
    startTime: "10:00",
    endTime: "12:00",
    bookedPassengers: 100,
    positions: [],
    remark: "",
  };
}

function createGapFillRule(
  id: string,
  flightNo: string,
  name: string,
  qualifiedStaffIds: string[],
  category: PositionRule["category"] = "常规"
): PositionRule {
  return {
    id,
    flightNo,
    name,
    category,
    remark: "",
    qualifiedStaffIds,
    manual: false,
    fatiguePoints: 1,
    minPassengers: 0,
    earlyReleaseMinutes: category === "分流" ? 15 : 0,
  };
}

function createGapFillAssignment(
  rule: PositionRule,
  flight: Flight,
  staff: Staff | null
): Assignment {
  return {
    id: `assignment-${rule.id}`,
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: staff?.id ?? null,
    staffName: staff?.name ?? "",
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints: rule.fatiguePoints,
    remark: rule.remark,
    manualRemark: "",
    status: staff ? "assigned" : "unfilled",
  };
}

export function createTeamLeaderGapFillBatchScenario() {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  const workerOne = createGapFillStaff("worker-one");
  const workerTwo = createGapFillStaff("worker-two");
  const workerThree = createGapFillStaff("worker-three");
  const sourceFlightOne = createGapFillFlight("ak151", "AK151");
  const vacancyFlightOne = createGapFillFlight("tr100", "TR100");
  const sourceFlightTwo = createGapFillFlight("ak152", "AK152");
  const vacancyFlightTwo = createGapFillFlight("tr200", "TR200");
  const sourceFlightThree = createGapFillFlight("ak153", "AK153");
  const vacancyFlightThree = createGapFillFlight("tr300", "TR300");
  sourceFlightTwo.startTime = vacancyFlightTwo.startTime = "13:00";
  sourceFlightTwo.endTime = vacancyFlightTwo.endTime = "15:00";
  sourceFlightThree.startTime = vacancyFlightThree.startTime = "16:00";
  sourceFlightThree.endTime = vacancyFlightThree.endTime = "18:00";
  const sourceRuleOne = createGapFillRule("source-one", "AK151", "G01", [
    leader.id,
    workerOne.id,
  ]);
  const vacancyRuleOne = createGapFillRule("vacancy-one", "TR100", "G02", [
    workerOne.id,
  ]);
  const sourceRuleTwo = createGapFillRule("source-two", "AK152", "G01", [
    leader.id,
    workerTwo.id,
  ]);
  const vacancyRuleTwo = createGapFillRule("vacancy-two", "TR200", "G02", [
    workerTwo.id,
  ]);
  const sourceRuleThree = createGapFillRule("source-three", "AK153", "G01", [
    leader.id,
    workerThree.id,
  ]);
  const vacancyRuleThree = createGapFillRule("vacancy-three", "TR300", "G02", [
    workerThree.id,
  ]);
  state.staff = [leader, workerOne, workerTwo, workerThree];
  state.flights = [
    sourceFlightOne,
    vacancyFlightOne,
    sourceFlightTwo,
    vacancyFlightTwo,
    sourceFlightThree,
    vacancyFlightThree,
  ];
  state.positionRules = [
    sourceRuleOne,
    vacancyRuleOne,
    sourceRuleTwo,
    vacancyRuleTwo,
    sourceRuleThree,
    vacancyRuleThree,
  ];
  state.assignments = [
    createGapFillAssignment(sourceRuleOne, sourceFlightOne, workerOne),
    createGapFillAssignment(vacancyRuleOne, vacancyFlightOne, null),
    createGapFillAssignment(sourceRuleTwo, sourceFlightTwo, workerTwo),
    createGapFillAssignment(vacancyRuleTwo, vacancyFlightTwo, null),
    createGapFillAssignment(sourceRuleThree, sourceFlightThree, workerThree),
    createGapFillAssignment(vacancyRuleThree, vacancyFlightThree, null),
  ];
  state.activeScheduleDate = "2026-09-22";
  state.settings.positionRotationEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.minimumRegularTransitionMinutes = 0;
  return { state, leader, workerOne, workerTwo, workerThree };
}

export interface TeamLeaderGapFillAssignmentLimitScenarioOptions {
  chainedVacancyCount: number;
  includeDirectVacancy: boolean;
  includeExtraMovable?: boolean;
}

export function createTeamLeaderGapFillAssignmentLimitScenario({
  chainedVacancyCount,
  includeDirectVacancy,
  includeExtraMovable = false,
}: TeamLeaderGapFillAssignmentLimitScenarioOptions) {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  const workers = Array.from({ length: chainedVacancyCount }, (_, index) =>
    createGapFillStaff(`worker-${index + 1}`)
  );
  const flights: Flight[] = [];
  const rules: PositionRule[] = [];
  const assignments: Assignment[] = [];
  const vacancyAssignmentIds: string[] = [];

  workers.forEach((worker, index) => {
    const startHour = 6 + index * 2;
    const sourceFlight = createGapFillFlight(
      `source-flight-${index}`,
      `AK${index + 1}`
    );
    const vacancyFlight = createGapFillFlight(
      `vacancy-flight-${index}`,
      `TR${index + 1}`
    );
    sourceFlight.startTime = vacancyFlight.startTime = `${String(
      startHour
    ).padStart(2, "0")}:00`;
    sourceFlight.endTime = vacancyFlight.endTime = `${String(
      startHour + 2
    ).padStart(2, "0")}:00`;
    const sourceRule = createGapFillRule(
      `source-${index}`,
      sourceFlight.flightNo,
      "G01",
      [leader.id, worker.id]
    );
    const vacancyRule = createGapFillRule(
      `vacancy-${index}`,
      vacancyFlight.flightNo,
      "G02",
      [worker.id]
    );
    flights.push(sourceFlight, vacancyFlight);
    rules.push(sourceRule, vacancyRule);
    assignments.push(
      createGapFillAssignment(sourceRule, sourceFlight, worker),
      createGapFillAssignment(vacancyRule, vacancyFlight, null)
    );
    vacancyAssignmentIds.push(`assignment-${vacancyRule.id}`);
  });

  let extraMovable: Assignment | null = null;
  if (includeDirectVacancy) {
    const directFlight = createGapFillFlight("direct-flight", "DIRECT");
    directFlight.startTime = "22:00";
    directFlight.endTime = "23:00";
    const directRule = createGapFillRule("direct-vacancy", "DIRECT", "G03", [
      leader.id,
    ]);
    flights.push(directFlight);
    rules.push(directRule);
    assignments.push(createGapFillAssignment(directRule, directFlight, null));
    vacancyAssignmentIds.push("assignment-direct-vacancy");

    if (includeExtraMovable) {
      const extraWorker = createGapFillStaff("extra-worker");
      state.staff = [leader, ...workers, extraWorker];
      const extraRule = createGapFillRule("extra-movable", "DIRECT", "G04", [
        extraWorker.id,
        workers[0]!.id,
      ]);
      rules.push(extraRule);
      extraMovable = createGapFillAssignment(
        extraRule,
        directFlight,
        extraWorker
      );
      assignments.push(extraMovable);
    }
  }

  if (!state.staff.some((staff) => staff.id === leader.id))
    state.staff = [leader, ...workers];
  state.flights = flights;
  state.positionRules = rules;
  state.assignments = assignments;
  state.activeScheduleDate = "2026-09-22";
  state.settings.maxDailyHours = 24;
  state.settings.positionRotationEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.ordinaryPriorityPositions = [];
  return { state, leader, workers, vacancyAssignmentIds, extraMovable };
}

export function createTeamLeaderGapFillReservationScenario() {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  const reserveWorker = createGapFillStaff("reserve-worker");
  reserveWorker.name = "刘燕琼";
  const guideWorker = createGapFillStaff("guide-worker");
  guideWorker.name = "叶琳";
  const sourceFlight = createGapFillFlight("ak151", "AK151");
  sourceFlight.startTime = "21:05";
  sourceFlight.endTime = "23:05";
  const vacancyFlight = createGapFillFlight("tr121", "TR121");
  vacancyFlight.startTime = "21:55";
  vacancyFlight.endTime = "23:55";
  const sourceRule = createGapFillRule("source", "AK151", "G09", [
    reserveWorker.id,
    guideWorker.id,
  ]);
  sourceRule.category = "分流";
  sourceRule.earlyReleaseMinutes = 60;
  const guideRule = createGapFillRule("guide", "AK151", "引导", []);
  guideRule.category = "分流";
  const vacancyRule = createGapFillRule("vacancy", "TR121", "收费/引导", [
    reserveWorker.id,
  ]);
  const sourceAssignment = createGapFillAssignment(
    sourceRule,
    sourceFlight,
    reserveWorker
  );
  sourceAssignment.endTime = "22:05";
  sourceAssignment.workHours = 1;
  const guideAssignment = createGapFillAssignment(
    guideRule,
    sourceFlight,
    guideWorker
  );
  guideAssignment.workHours = 0;
  guideAssignment.fatiguePoints = 0;
  state.staff = [leader, reserveWorker, guideWorker];
  state.flights = [sourceFlight, vacancyFlight];
  state.positionRules = [sourceRule, guideRule, vacancyRule];
  state.assignments = [
    sourceAssignment,
    guideAssignment,
    createGapFillAssignment(vacancyRule, vacancyFlight, null),
  ];
  state.activeScheduleDate = "2026-09-27";
  state.settings.positionRotationEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.minimumRegularTransitionMinutes = 0;
  state.settings.ordinaryPriorityPositions = [];
  state.settings.teamLeaderGapFillPositionPolicies = [
    { flightNo: "AK151", position: "G09", movable: true },
  ];
  state.settings.crossWorkdayQualificationReservations = [
    {
      id: "reserve-tr121-guide",
      enabled: true,
      flightNo: "TR121",
      matchField: "position",
      keyword: "收费/引导",
      minimumStaffCount: 1,
    },
  ];
  state.settings.lateShiftEndTime = "23:00";
  return { state, leader, reserveWorker, guideWorker };
}

export function createTeamLeaderGapFillFatiguePreferenceScenario() {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  const tired = createGapFillStaff("tired");
  const rested = createGapFillStaff("rested");
  const sourceFlight = createGapFillFlight("source", "AK151");
  sourceFlight.startTime = "21:05";
  sourceFlight.endTime = "23:55";
  const lighterFlight = createGapFillFlight("lighter", "TR100");
  lighterFlight.startTime = "21:55";
  lighterFlight.endTime = "23:15";
  const sourceRule = createGapFillRule("source", "AK151", "G08", [
    leader.id,
    tired.id,
  ]);
  sourceRule.fatiguePoints = 8;
  const otherRule = createGapFillRule("other", "AK151", "G09", [
    leader.id,
    rested.id,
  ]);
  otherRule.fatiguePoints = 3;
  const vacancyRule = createGapFillRule("vacancy", "TR100", "H08", [
    tired.id,
    rested.id,
  ]);
  vacancyRule.fatiguePoints = 1;
  state.staff = [leader, tired, rested];
  state.flights = [sourceFlight, lighterFlight];
  state.positionRules = [sourceRule, otherRule, vacancyRule];
  state.assignments = [
    createGapFillAssignment(sourceRule, sourceFlight, tired),
    createGapFillAssignment(otherRule, sourceFlight, rested),
    createGapFillAssignment(vacancyRule, lighterFlight, null),
  ];
  state.history = [
    {
      id: "history-tired",
      date: "2026-09-21",
      flightNo: "TR121",
      position: "H02",
      staffId: tired.id,
      staffName: tired.name,
      startTime: "21:55",
      endTime: "23:55",
      workHours: 2,
      fatiguePoints: 10,
      remark: "一号",
    },
    {
      id: "history-rested",
      date: "2026-09-21",
      flightNo: "CX937",
      position: "G12",
      staffId: rested.id,
      staffName: rested.name,
      startTime: "09:00",
      endTime: "10:00",
      workHours: 1,
      fatiguePoints: 1,
      remark: "",
    },
  ];
  state.activeScheduleDate = "2026-09-22";
  state.settings.positionRotationEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.minimumRegularTransitionMinutes = 0;
  return { state, leader, tired, rested };
}

function createConcurrentAssignment(
  rule: PositionRule,
  flight: Flight,
  staff: Staff | null,
  endTime = flight.endTime
): Assignment {
  return {
    ...createGapFillAssignment(rule, flight, staff),
    endTime,
    workHours: staff ? 2 : 0,
    remark: "",
  };
}

export function createTeamLeaderConcurrentDutyScenario() {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  leader.name = "员工leader";
  const supervisorWorker = createGapFillStaff("supervisor-worker");
  const dutyWorker = createGapFillStaff("duty-worker");
  dutyWorker.dutyQualified = true;
  state.staff = [leader, supervisorWorker, dutyWorker];
  state.dutyRosterOverrides = [
    {
      date: "2026-07-29",
      cxPreflightStaffId: null,
      dutyStaffId: dutyWorker.id,
      standbyStaffIds: [null, null],
    },
  ];
  state.flights = [
    createGapFillFlight("morning", "CX937"),
    createGapFillFlight("first", "MF8683"),
    createGapFillFlight("second", "FD573"),
    createGapFillFlight("late", "TR121"),
  ];
  const [morning, first, second, late] = state.flights;
  morning!.startTime = "08:30";
  morning!.endTime = "10:30";
  first!.startTime = "13:40";
  first!.endTime = "15:40";
  second!.startTime = "15:25";
  second!.endTime = "17:25";
  late!.startTime = "21:55";
  late!.endTime = "23:55";
  const positionRules = [
    createGapFillRule("morning-position", "CX937", "G17", [dutyWorker.id]),
    createGapFillRule("first-supervisor", "MF8683", "督导", [
      leader.id,
      supervisorWorker.id,
    ]),
    createGapFillRule("second-supervisor", "FD573", "督导", [
      leader.id,
      supervisorWorker.id,
    ]),
    createGapFillRule("second-vacancy", "FD573", "G10", [dutyWorker.id]),
    createGapFillRule("late-position", "TR121", "H02", [dutyWorker.id]),
  ];
  positionRules[positionRules.length - 1]!.remark = "一号";
  state.positionRules = positionRules;
  const byId = new Map(positionRules.map((item) => [item.id, item]));
  const morningDuty = createConcurrentAssignment(
    byId.get("morning-position")!,
    morning!,
    dutyWorker
  );
  const lateDuty = createConcurrentAssignment(
    byId.get("late-position")!,
    late!,
    dutyWorker
  );
  state.assignments = [
    morningDuty,
    createConcurrentAssignment(
      byId.get("first-supervisor")!,
      first!,
      supervisorWorker
    ),
    createConcurrentAssignment(byId.get("second-supervisor")!, second!, leader),
    createConcurrentAssignment(byId.get("second-vacancy")!, second!, null),
    lateDuty,
  ];
  return {
    state,
    dutyWorker,
    morningDuty,
    lateDuty,
    lockedAssignmentIds: new Set([morningDuty.id, lateDuty.id]),
  };
}

export function createTeamLeaderConcurrentCycleScenario() {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  leader.name = "员工leader";
  const workers = Array.from({ length: 14 }, (_, index) =>
    createGapFillStaff(`worker-${index + 1}`)
  );
  state.staff = [leader, ...workers];
  state.flights = [
    createGapFillFlight("mf", "MF8683"),
    createGapFillFlight("ae", "AE218"),
    createGapFillFlight("fd", "FD573"),
  ];
  const [mf, ae, fd] = state.flights;
  mf!.startTime = "13:40";
  mf!.endTime = "15:40";
  ae!.startTime = "14:25";
  ae!.endTime = "16:25";
  fd!.startTime = "15:25";
  fd!.endTime = "17:25";
  const regularIds = workers.map((person) => person.id);
  const supervisorIds = [leader.id, workers[0]!.id, workers[1]!.id];
  state.positionRules = [
    createGapFillRule("mf-supervisor", "MF8683", "督导", supervisorIds, "分流"),
    ...Array.from({ length: 4 }, (_, index) =>
      createGapFillRule(`mf-${index}`, "MF8683", `G${20 - index}`, regularIds)
    ),
    createGapFillRule("ae-supervisor", "AE218", "督导", supervisorIds),
    ...Array.from({ length: 6 }, (_, index) =>
      createGapFillRule(`ae-${index}`, "AE218", `H0${index + 2}`, regularIds)
    ),
    createGapFillRule("fd-supervisor", "FD573", "督导/引导", supervisorIds),
    ...Array.from({ length: 4 }, (_, index) =>
      createGapFillRule(
        `fd-${index}`,
        "FD573",
        `G${String(7 + index).padStart(2, "0")}`,
        regularIds
      )
    ),
  ];
  const byId = new Map(state.positionRules.map((item) => [item.id, item]));
  state.assignments = [
    createConcurrentAssignment(
      byId.get("mf-supervisor")!,
      mf!,
      workers[0]!,
      "15:25"
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      createConcurrentAssignment(
        byId.get(`mf-${index}`)!,
        mf!,
        workers[index + 2]!
      )
    ),
    createConcurrentAssignment(byId.get("ae-supervisor")!, ae!, leader),
    ...Array.from({ length: 6 }, (_, index) =>
      createConcurrentAssignment(
        byId.get(`ae-${index}`)!,
        ae!,
        workers[index + 6]!
      )
    ),
    createConcurrentAssignment(byId.get("fd-supervisor")!, fd!, workers[1]!),
    createConcurrentAssignment(byId.get("fd-0")!, fd!, workers[12]!),
    createConcurrentAssignment(byId.get("fd-1")!, fd!, workers[13]!),
    createConcurrentAssignment(byId.get("fd-2")!, fd!, workers[0]!),
    createConcurrentAssignment(byId.get("fd-3")!, fd!, null),
  ];
  return { state };
}

export function createTeamLeaderConcurrentLongChainScenario() {
  const state = createDefaultState();
  const leader = createGapFillStaff("leader", true);
  leader.name = "员工leader";
  const releasedSupervisor = createGapFillStaff("released-supervisor");
  const workers = Array.from({ length: 4 }, (_, index) =>
    createGapFillStaff(`worker-${index + 1}`)
  );
  state.staff = [leader, releasedSupervisor, ...workers];
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.positionTransitionPolicies = [];
  state.flights = [
    createGapFillFlight("first", "FIRST1"),
    createGapFillFlight("second", "SECOND1"),
  ];
  const [first, second] = state.flights;
  first!.startTime = "13:40";
  first!.endTime = "15:40";
  second!.startTime = "15:25";
  second!.endTime = "17:25";
  state.positionRules = [
    createGapFillRule("first-supervisor", first!.flightNo, "督导", [
      leader.id,
      releasedSupervisor.id,
    ]),
    createGapFillRule("second-supervisor", second!.flightNo, "督导", [
      leader.id,
      releasedSupervisor.id,
    ]),
    createGapFillRule("vacancy", second!.flightNo, "G10", [workers[0]!.id]),
    createGapFillRule("relay-1", second!.flightNo, "G11", [
      workers[0]!.id,
      workers[1]!.id,
    ]),
    createGapFillRule("relay-2", second!.flightNo, "G12", [
      workers[1]!.id,
      workers[2]!.id,
    ]),
    createGapFillRule("relay-3", second!.flightNo, "G13", [
      workers[2]!.id,
      workers[3]!.id,
    ]),
    createGapFillRule("relay-4", second!.flightNo, "G14", [
      workers[3]!.id,
      releasedSupervisor.id,
    ]),
  ];
  const byId = new Map(state.positionRules.map((item) => [item.id, item]));
  state.assignments = [
    createConcurrentAssignment(
      byId.get("first-supervisor")!,
      first!,
      releasedSupervisor
    ),
    createConcurrentAssignment(byId.get("second-supervisor")!, second!, leader),
    createConcurrentAssignment(byId.get("vacancy")!, second!, null),
    ...workers.map((person, index) =>
      createConcurrentAssignment(
        byId.get(`relay-${index + 1}`)!,
        second!,
        person
      )
    ),
  ];
  return { state, leader, releasedSupervisor, workers };
}

export function createRotationReviewRetainWorkScenario() {
  const state = createDefaultState();
  const worker = {
    ...state.staff[0]!,
    id: "required-worker",
    name: "必上班人员",
    status: "正常" as const,
    staffType: "常规" as const,
    teamLeader: false,
  };
  const assignment: Assignment = {
    id: "target",
    flightId: "flight",
    flightNo: "F100",
    positionRuleId: "rule",
    position: "G20",
    staffId: worker.id,
    staffName: worker.name,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
    manualRemark: "",
    status: "assigned",
  };
  state.staff = [worker];
  return { state, worker, assignment };
}

export function createRotationReviewMinimumWorkScenario() {
  const state = createDefaultState();
  const person = state.staff.find((item) => !item.teamLeader)!;
  const assignment: Assignment = {
    id: "target",
    flightId: "flight",
    flightNo: "F100",
    positionRuleId: "rule",
    position: "G20",
    staffId: person.id,
    staffName: person.name,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
    manualRemark: "",
    status: "assigned",
  };
  return { person, assignment };
}

export function createRotationReviewHalfRestScenario() {
  const state = createDefaultState();
  const [halfRestWorker, recoveringWorker, availableWorker] = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 3);
  state.staff = [halfRestWorker!, recoveringWorker!, availableWorker!];
  state.flights = [
    {
      id: "late-flight",
      flightNo: "PM200",
      startTime: "15:00",
      endTime: "17:00",
      bookedPassengers: 100,
      positions: ["B1"],
      remark: "",
    },
  ];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "late-control",
      flightNo: "PM200",
      name: "B1",
      category: "常规",
      remark: "控制",
      qualifiedStaffIds: state.staff.map((person) => person.id),
    },
  ];
  state.settings.lateShiftRecoveryEnabled = true;
  state.settings.nextWorkdayRecoveryMode = "forbid";
  state.settings.nextWorkdayRecoveryTargets = [
    {
      id: "strict-control",
      enabled: true,
      flightNo: "PM200",
      positionKeyword: "控制",
    },
  ];
  state.settings.lateShiftRecoveryPositionRules = [
    {
      id: "previous-number-one",
      enabled: true,
      flightNo: "OLD900",
      matchField: "remark",
      keyword: "一号",
      nextWorkdayCutoffTime: "",
    },
  ];
  state.history = [
    {
      id: "previous-late",
      date: "2026-07-28",
      flightNo: "OLD900",
      position: "H02",
      staffId: recoveringWorker!.id,
      staffName: recoveringWorker!.name,
      startTime: "21:00",
      endTime: "23:30",
      workHours: 2.5,
      fatiguePoints: 5,
      remark: "一号",
    },
  ];
  const target: Assignment = {
    id: "target",
    flightId: "late-flight",
    flightNo: "PM200",
    positionRuleId: "late-control",
    position: "B1",
    staffId: availableWorker!.id,
    staffName: availableWorker!.name,
    startTime: "15:00",
    endTime: "17:00",
    workHours: 2,
    fatiguePoints: 2,
    remark: "控制",
    manualRemark: "",
    status: "assigned",
  };
  const facts = createScheduleRunFacts(state, "2026-07-30", {
    halfRestStaffIds: [halfRestWorker!.id],
  });
  return { state, target, facts, recoveringWorker: recoveringWorker! };
}

export function createTr121H02CooldownHistoryRecord(
  id: string,
  date: string,
  person: Staff,
  position: string,
  remark: string,
  flightNo = "TR121"
): HistoryRecord {
  return {
    id,
    date,
    flightNo,
    position,
    staffId: person.id,
    staffName: person.name,
    startTime: "21:30",
    endTime: "23:30",
    workHours: 2,
    fatiguePoints: position === "H02" ? 10 : 1,
    remark,
    historyCoverage: "complete",
  };
}

export function createTr121H02CooldownScenario() {
  const state = createDefaultState();
  const [recent, rested] = state.staff
    .filter((person) => person.status === "正常")
    .slice(0, 2);
  state.staff = [recent!, rested!];
  state.staff.forEach((person) => {
    person.dutyQualified = false;
    person.nightShift = true;
    person.teamLeader = false;
  });
  state.flights = [
    {
      id: "tr121",
      flightNo: "TR121",
      startTime: "21:30",
      endTime: "23:30",
      bookedPassengers: 100,
      positions: ["H02"],
      remark: "",
    },
  ];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "tr121-h02",
      flightNo: "TR121",
      name: "H02",
      remark: "一号",
      category: "常规",
      qualifiedStaffIds: [recent!.id, rested!.id],
      fatiguePoints: 10,
      minPassengers: 0,
    },
  ];
  state.dutyRosterOverrides = [
    {
      date: "2026-09-15",
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.settings.historyWindowDays = 1;
  state.settings.workloadBalanceEnabled = false;
  state.history = [
    createTr121H02CooldownHistoryRecord(
      "recent-h02",
      "2026-09-11",
      recent!,
      "H02",
      "一号"
    ),
    createTr121H02CooldownHistoryRecord(
      "rested-h02",
      "2026-09-07",
      rested!,
      "H02",
      "一号"
    ),
    createTr121H02CooldownHistoryRecord(
      "fill-13-a",
      "2026-09-13",
      recent!,
      "G01",
      "",
      "FILL"
    ),
    createTr121H02CooldownHistoryRecord(
      "fill-13-b",
      "2026-09-13",
      rested!,
      "G02",
      "",
      "FILL"
    ),
    createTr121H02CooldownHistoryRecord(
      "fill-09-a",
      "2026-09-09",
      recent!,
      "G01",
      "",
      "FILL"
    ),
    createTr121H02CooldownHistoryRecord(
      "fill-09-b",
      "2026-09-09",
      rested!,
      "G02",
      "",
      "FILL"
    ),
  ];
  return { state, recent: recent!, rested: rested! };
}

export interface CrossWorkdayReservationScenarioOptions {
  staffCount: number;
  latePositionCount: number;
}

export function createCrossWorkdayReservationScenario({
  staffCount,
  latePositionCount,
}: CrossWorkdayReservationScenarioOptions) {
  const state = createOrdinarySchedulingState();
  const baseStaff = state.staff[0]!;
  state.staff = Array.from({ length: staffCount }, (_, index): Staff => ({
    ...baseStaff,
    id: `worker-${index + 1}`,
    name: `人员${index + 1}`,
    staffType: "常规",
    status: "正常",
    nightShift: true,
    dutyQualified: false,
    cxPreflightQualified: false,
  }));
  const lateFlight: Flight = {
    id: "late-flight",
    flightNo: "LATE100",
    startTime: "21:00",
    endTime: "23:30",
    bookedPassengers: 100,
    positions: Array.from(
      { length: latePositionCount },
      (_, index) => `G0${index + 1}`
    ),
    remark: "",
  };
  const nextFlight: Flight = {
    id: "next-flight",
    flightNo: "NEXT200",
    startTime: "08:00",
    endTime: "10:00",
    bookedPassengers: 100,
    positions: ["控制"],
    remark: "",
  };
  const baseRule = state.positionRules[0]!;
  const lateRules = lateFlight.positions.map((name, index): PositionRule => ({
    ...baseRule,
    id: `late-rule-${index + 1}`,
    flightNo: lateFlight.flightNo,
    name,
    category: "常规",
    remark: "",
    qualifiedStaffIds: state.staff.map((person) => person.id),
    manual: false,
    fatiguePoints: 1,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  }));
  const nextRule: PositionRule = {
    ...lateRules[0]!,
    id: "next-control",
    flightNo: nextFlight.flightNo,
    name: "控制",
    qualifiedStaffIds: [state.staff[0]!.id],
  };
  state.flights = [lateFlight];
  state.templates = [
    {
      id: "next-template",
      flightNo: nextFlight.flightNo,
      startTime: nextFlight.startTime,
      endTime: nextFlight.endTime,
      positions: nextFlight.positions,
      remark: "",
    },
  ];
  state.positionRules = [...lateRules, nextRule];
  state.history = [];
  state.dutyRosterOverrides = [];
  state.settings.positionTransitionPolicies = [];
  state.settings.positionRotationEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  state.settings.crossWorkdayQualificationReservations = [
    {
      id: "reserve-control",
      enabled: true,
      flightNo: nextFlight.flightNo,
      matchField: "position",
      keyword: "控制",
      minimumStaffCount: 1,
    },
  ];
  return state;
}

export interface ReassignmentScenario {
  state: ScheduleGenerationFacts;
  assignedWorker: Staff;
  replacementWorker: Staff;
  flight: Flight;
  rule: PositionRule;
  primary: Assignment;
}

export interface ReassignmentScenarioOptions {
  position?: {
    name: string;
    remark: string;
    fatiguePoints: number;
  };
}

export function createReassignmentScenario(
  options: ReassignmentScenarioOptions = {}
): ReassignmentScenario {
  const position = options.position ?? {
    name: "H01",
    remark: "",
    fatiguePoints: 1,
  };
  const assignedWorker: Staff = {
    id: "assigned-worker",
    name: "原岗位人员",
    staffType: "常规",
    teamLeader: false,
    cxPreflightQualified: false,
    dutyQualified: false,
    standbyQualified: false,
    nightShift: true,
    status: "正常",
    remark: "",
  };
  const replacementWorker: Staff = {
    ...assignedWorker,
    id: "replacement-worker",
    name: "替换人员",
  };
  const flight: Flight = {
    id: "reassignment-flight",
    flightNo: "F100",
    startTime: "08:00",
    endTime: "10:00",
    bookedPassengers: 100,
    positions: [position.name],
    remark: "",
  };
  const rule: PositionRule = {
    id: "reassignment-rule",
    flightNo: flight.flightNo,
    name: position.name,
    category: "常规",
    remark: position.remark,
    qualifiedStaffIds: [assignedWorker.id, replacementWorker.id],
    manual: false,
    fatiguePoints: position.fatiguePoints,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  };
  const primary: Assignment = {
    id: "primary-assignment",
    flightId: flight.id,
    flightNo: flight.flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: assignedWorker.id,
    staffName: assignedWorker.name,
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints: rule.fatiguePoints,
    remark: position.remark,
    manualRemark: "",
    status: "assigned",
  };
  const state = createSchedulingScenario({
    staff: [assignedWorker, replacementWorker],
    flights: [flight],
    positionRules: [rule],
    history: [],
    assignments: [primary],
  });
  state.settings.highLoadProtectionEnabled = false;
  state.settings.rollingLoadProtectionEnabled = false;
  state.settings.workloadBalanceEnabled = false;
  return {
    state,
    assignedWorker,
    replacementWorker,
    flight,
    rule,
    primary,
  };
}

export function createRotationReviewFrequencyScenario() {
  const {
    state,
    assignedWorker: originalWorker,
    replacementWorker,
    primary: target,
  } = createReassignmentScenario({
    position: { name: "G20", remark: "一号", fatiguePoints: 2 },
  });
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: "F1", position: "G20" },
  ];
  return { state, originalWorker, replacementWorker, target };
}
