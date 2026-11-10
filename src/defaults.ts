import type {
  AppState,
  Flight,
  GroupWorkspace,
  PositionRule,
  SharedScheduleData,
  Staff,
} from "./model";
import { createDefaultScheduleSettings } from "./domain/rules/schedule-settings";
import { latePriorityFlightScopeCandidates } from "./domain/statistics/late-priority-flight-scope";
import { createEmptyWeeklyFlightPlans } from "./domain/flights/weekly-flight-plan";
import { orderPositionRules } from "./utils";
import { isPriorityRotationPosition } from "./domain/reviews/position-rotation-policy";
import { airlineCode } from "./domain/rules/airline-rotation";

const allRegular = Array.from({ length: 17 }, (_, index) => String(index + 2));

export const defaultStaff: Staff[] = [
  ["1", "刘红", true, "正常", ""],
  ["2", "华嘉慧", true, "正常", ""],
  ["3", "张奇", true, "正常", ""],
  ["4", "秦雁", true, "正常", ""],
  ["5", "肖萍", true, "正常", ""],
  ["6", "陈睿康", true, "正常", ""],
  ["7", "刘翔", true, "正常", ""],
  ["8", "郭萌", true, "正常", ""],
  ["9", "叶琳", true, "正常", ""],
  ["10", "董玲", true, "正常", ""],
  ["11", "严晓珂", true, "正常", ""],
  ["12", "黄海盈", true, "正常", ""],
  ["13", "曾子卓", true, "正常", ""],
  ["14", "杨洁涵", true, "正常", ""],
  ["15", "刘燕琼", true, "正常", ""],
  ["16", "罗敏", false, "正常", "年休假"],
  ["17", "任霞", true, "病假", "病假"],
  ["18", "肖潇", true, "休假", "产假"],
].map(([id, name, nightShift, status, remark]) => ({
  id: String(id),
  name: String(name),
  staffType: "常规",
  teamLeader: String(name) === "刘红",
  cxPreflightQualified: false,
  dutyQualified: true,
  standbyQualified: true,
  nightShift: Boolean(nightShift),
  status: status as Staff["status"],
  remark: String(remark),
}));

export const defaultFlights: Flight[] = [
  {
    id: "flight-cx937",
    flightNo: "CX937",
    startTime: "08:30",
    endTime: "10:30",
    bookedPassengers: 0,
    positions: [
      "督导",
      "G20",
      "G19",
      "G18",
      "G17",
      "G16",
      "G15",
      "G14",
      "G13",
      "G12",
    ],
    remark: "到岗08:05",
  },
  {
    id: "flight-fd573",
    flightNo: "FD573",
    startTime: "15:25",
    endTime: "17:25",
    bookedPassengers: 0,
    positions: ["督导/引导", "G10", "G09", "G08", "G07"],
    remark: "到岗15:05",
  },
  {
    id: "flight-cx931",
    flightNo: "CX931",
    startTime: "17:50",
    endTime: "19:50",
    bookedPassengers: 0,
    positions: [
      "督导",
      "G20",
      "G19",
      "G18",
      "G17",
      "G16",
      "G15",
      "G14",
      "G13",
      "G12",
    ],
    remark: "到岗17:25",
  },
  {
    id: "flight-tr121",
    flightNo: "TR121",
    startTime: "21:55",
    endTime: "23:55",
    bookedPassengers: 0,
    positions: [
      "督导",
      "收费/引导",
      "H02",
      "H03",
      "H04",
      "H05",
      "H06",
      "H07",
      "H08",
      "H09",
    ],
    remark: "到岗21:35",
  },
];

const cxRules = [
  ["G12", "", allRegular, 2],
  ["G13", "", allRegular, 2],
  ["G14", "", allRegular, 2],
  ["G15", "", allRegular, 2],
  ["G16", "排查", allRegular, 2.5],
  ["G17", "申报", allRegular, 3],
  ["G18", "控制", ["2", "7", "12", "13", "14"], 5],
  ["G19", "", ["2", "4", "5", "7", "9", "11", "12", "13", "14", "17"], 2],
  ["G20", "一号", ["2", "4", "5", "7", "9", "12", "13", "14", "16"], 4],
  ["督导", "", ["1", "4", "11", "12"], 4],
] as const;

function positionRule(
  flightNo: string,
  name: string,
  remark: string,
  qualifiedStaffIds: readonly string[],
  fatiguePoints: number,
  options: Partial<Pick<PositionRule, "category" | "manual">> = {}
): PositionRule {
  const normalizedName = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return {
    id: `position-${flightNo.toLowerCase()}-${normalizedName || encodeURIComponent(name)}`,
    flightNo,
    name,
    category: options.category ?? "常规",
    remark,
    qualifiedStaffIds: [...qualifiedStaffIds],
    manual: options.manual ?? false,
    fatiguePoints,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  };
}

export const defaultPositionRules: PositionRule[] = [
  ...cxRules.map(([name, remark, ids, points]) =>
    positionRule("CX937", name, remark, ids, points)
  ),
  positionRule("CX937", "柜台引导1", "", [], 2.5, { category: "引导" }),
  positionRule("CX937", "柜台引导2", "", [], 2.5, { category: "引导" }),
  positionRule("CX937", "超规柜台", "", [], 2.5, { manual: true }),
  positionRule("CX937", "超规行李引导", "", [], 2.5, { category: "引导" }),
  positionRule("FD573", "G07", "一号", allRegular, 4),
  positionRule("FD573", "G08", "申报", allRegular, 3),
  positionRule("FD573", "G09", "排查", allRegular, 2.5),
  positionRule("FD573", "G10", "", allRegular, 1),
  positionRule("FD573", "督导/引导", "", ["1", "4", "11", "12"], 3.5),
  ...cxRules.map(([name, remark, ids, points]) =>
    positionRule(
      "CX931",
      name,
      remark,
      ids,
      name === "G18" ? 6 : name === "督导" ? 5 : points
    )
  ),
  positionRule("TR121", "H02", "一号", allRegular, 10),
  positionRule("TR121", "H03", "", allRegular, 6),
  positionRule("TR121", "H04", "申报", allRegular, 7),
  positionRule("TR121", "H05", "送资料", allRegular, 7),
  positionRule("TR121", "H06", "", allRegular, 2),
  positionRule("TR121", "H07", "", allRegular, 2),
  positionRule("TR121", "H08", "", allRegular, 2),
  positionRule("TR121", "H09", "", allRegular, 2),
  positionRule("TR121", "督导", "", ["1", "3", "4", "10", "11", "12"], 9.5),
  positionRule("TR121", "收费/引导", "", ["5", "15"], 5),
];

export function createDefaultState(): AppState {
  const positionRules = orderPositionRules(
    structuredClone(defaultPositionRules)
  );
  const settings = createDefaultScheduleSettings();
  settings.ordinaryPriorityPositions = [
    ...new Map(
      positionRules.filter(isPriorityRotationPosition).map((rule) => [
        `${airlineCode(rule.flightNo)}\u0000${rule.name.trim()}`,
        {
          airlineCode: airlineCode(rule.flightNo),
          position: rule.name.trim(),
        },
      ])
    ).values(),
  ];
  settings.latePriorityFlightNumbers =
    latePriorityFlightScopeCandidates(positionRules);
  const staff = structuredClone(defaultStaff);
  const flights = structuredClone(defaultFlights);
  const templates = defaultFlights.map(
    ({ id, bookedPassengers: _bookedPassengers, ...flight }) => ({
      ...structuredClone(flight),
      id: `template-${id}`,
    })
  );
  const weeklyFlightPlans = createEmptyWeeklyFlightPlans();
  const shared: SharedScheduleData = {
    templates: structuredClone(templates),
    weeklyFlightPlans: structuredClone(weeklyFlightPlans),
  };
  const groupA: GroupWorkspace = {
    halfRestSelections: [],
    leaveTypes: [],
    flights: structuredClone(flights),
    staff: structuredClone(staff),
    positionRules: structuredClone(positionRules),
    settings: structuredClone(settings),
    history: [],
    dutyRosterOverrides: [],
    latePriorityFrequencyAdjustments: [],
    ordinaryPriorityFrequencyAdjustments: [],
    assignments: [],
    activeScheduleDate: null,
    schedulePolicyStale: false,
  };
  const groupB: GroupWorkspace = {
    halfRestSelections: [],
    leaveTypes: [],
    flights: [],
    staff: [],
    positionRules: structuredClone(positionRules),
    settings: structuredClone(settings),
    history: [],
    dutyRosterOverrides: [],
    latePriorityFrequencyAdjustments: [],
    ordinaryPriorityFrequencyAdjustments: [],
    assignments: [],
    activeScheduleDate: null,
    schedulePolicyStale: false,
  };
  return {
    version: 12,
    shared,
    groups: { A: groupA, B: groupB },
    activeGroupId: "A",
    halfRestSelections: groupA.halfRestSelections,
    leaveTypes: groupA.leaveTypes,
    staff,
    flights,
    templates: shared.templates,
    weeklyFlightPlans: shared.weeklyFlightPlans,
    positionRules: groupA.positionRules,
    history: groupA.history,
    dutyRosterOverrides: groupA.dutyRosterOverrides,
    latePriorityFrequencyAdjustments: groupA.latePriorityFrequencyAdjustments,
    ordinaryPriorityFrequencyAdjustments:
      groupA.ordinaryPriorityFrequencyAdjustments,
    assignments: groupA.assignments,
    activeScheduleDate: groupA.activeScheduleDate,
    schedulePolicyStale: groupA.schedulePolicyStale,
    settings: groupA.settings,
    updatedAt: new Date().toISOString(),
  };
}
