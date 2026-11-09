import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { restorePersistedState } from "../../src/infrastructure/state-restoration";

describe("双组工作区状态迁移", () => {
  it("默认状态创建组内规则副本，并只共享航班模板和每周计划", () => {
    const state = createDefaultState();

    expect(state.activeGroupId).toBe("A");
    expect(Object.keys(state.groups).sort()).toEqual(["A", "B"]);
    expect(state.groups.A.staff).toEqual(state.staff);
    expect(state.groups.A.flights).toEqual(state.flights);
    expect(state.groups.B.staff).toEqual([]);
    expect(state.groups.B.flights).toEqual([]);
    expect(state.shared.templates).toEqual(state.templates);
    expect(state.shared.weeklyFlightPlans).toEqual(state.weeklyFlightPlans);
    expect(state.groups.A.positionRules).toEqual(state.positionRules);
    expect(state.groups.B.positionRules).toEqual(state.positionRules);
    expect(state.groups.A.settings).toEqual(state.settings);
    expect(state.groups.B.settings).toEqual(state.settings);
    expect(state.groups.A.positionRules).not.toBe(state.groups.B.positionRules);
    expect(state.groups.A.settings).not.toBe(state.groups.B.settings);
    expect(state.shared).not.toHaveProperty("positionRules");
    expect(state.shared).not.toHaveProperty("settings");
  });

  it("把旧单组状态迁移到 A，并将旧规则复制为两组的独立起点", () => {
    const legacy = JSON.parse(JSON.stringify(createDefaultState())) as Record<
      string,
      unknown
    >;
    legacy.version = 5;
    (legacy.positionRules as Array<{ category: string }>)[0]!.category = "分流";
    (legacy.settings as { maxDailyHours: number }).maxDailyHours = 9.5;
    legacy.staff = [
      {
        id: "legacy-a-1",
        name: "A组人员",
        staffType: "常规",
        teamLeader: false,
        cxPreflightQualified: false,
        dutyQualified: false,
        standbyQualified: false,
        nightShift: true,
        status: "正常",
        remark: "",
      },
    ];
    legacy.history = [
      {
        id: "legacy-history-a",
        date: "2026-09-18",
        flightNo: "CX931",
        position: "控制",
        staffId: "legacy-a-1",
        staffName: "A组人员",
        startTime: "17:50",
        endTime: "19:50",
        workHours: 2,
        fatiguePoints: 1,
        remark: "",
      },
    ];

    const migrated = restorePersistedState(legacy, createDefaultState());

    expect(migrated).not.toBeNull();
    expect(migrated!.version).toBe(12);
    expect(migrated!.activeGroupId).toBe("A");
    expect(migrated!.groups.A.staff.map((item) => item.id)).toEqual([
      "legacy-a-1",
    ]);
    expect(migrated!.groups.A.history.map((item) => item.id)).toEqual([
      "legacy-history-a",
    ]);
    expect(migrated!.groups.B.staff).toEqual([]);
    expect(migrated!.groups.B.history).toEqual([]);
    expect(migrated!.groups.A.staff).not.toBe(migrated!.groups.B.staff);
    expect(migrated!.groups.A.positionRules[0]!.category).toBe("分流");
    expect(migrated!.groups.B.positionRules[0]!.category).toBe("分流");
    expect(migrated!.groups.A.settings.maxDailyHours).toBe(9.5);
    expect(migrated!.groups.B.settings.maxDailyHours).toBe(9.5);
    expect(migrated!.groups.A.positionRules).not.toBe(
      migrated!.groups.B.positionRules
    );
    expect(migrated!.groups.A.settings).not.toBe(migrated!.groups.B.settings);
  });

  it("恢复新版 B 组状态时保留两组各自配置", () => {
    const current = createDefaultState();
    current.groups.A.staffStatusOptions.push("陪产假");
    current.groups.B.staffStatusOptions.push("育儿假");
    current.groups.B.staff = [
      {
        id: "b-1",
        name: "B组人员",
        staffType: "常规",
        teamLeader: false,
        cxPreflightQualified: false,
        dutyQualified: false,
        standbyQualified: false,
        nightShift: true,
        status: "正常",
        remark: "",
      },
    ];
    current.groups.A.positionRules[0]!.category = "分流";
    current.groups.A.settings.maxDailyHours = 9.5;
    current.groups.B.positionRules[0]!.category = "常规";
    current.groups.B.settings.maxDailyHours = 8.5;
    current.activeGroupId = "B";
    current.positionRules = current.groups.B.positionRules;
    current.settings = current.groups.B.settings;
    const restored = restorePersistedState(
      JSON.parse(JSON.stringify(current)),
      createDefaultState()
    );

    expect(restored!.activeGroupId).toBe("B");
    expect(restored!.groups.B.staff.map((item) => item.id)).toEqual(["b-1"]);
    expect(restored!.groups.A.staff.length).toBeGreaterThan(0);
    expect(restored!.positionRules[0]!.category).toBe("常规");
    expect(restored!.settings.maxDailyHours).toBe(8.5);
    expect(restored!.groups.A.positionRules[0]!.category).toBe("分流");
    expect(restored!.groups.A.settings.maxDailyHours).toBe(9.5);
    expect(restored!.staffStatusOptions).toEqual([
      "正常",
      "病假",
      "休假",
      "育儿假",
    ]);
    expect(restored!.groups.A.staffStatusOptions).toContain("陪产假");
    expect(restored!.groups.B.staffStatusOptions).toContain("育儿假");
  });

  it("migrates v11 groups to built-in status options without losing staff status", () => {
    const current = createDefaultState();
    current.staff[0]!.status = "陪产假";
    const legacy = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    legacy.version = 11;
    delete legacy.staffStatusOptions;
    const groups = legacy.groups as Record<string, Record<string, unknown>>;
    delete groups.A!.staffStatusOptions;
    delete groups.B!.staffStatusOptions;

    const restored = restorePersistedState(
      JSON.parse(JSON.stringify(legacy)),
      createDefaultState()
    );

    expect(restored!.version).toBe(12);
    expect(restored!.staff[0]!.status).toBe("陪产假");
    expect(restored!.staffStatusOptions).toEqual([
      "正常",
      "病假",
      "休假",
      "陪产假",
    ]);
    expect(restored!.groups.A.staffStatusOptions).toEqual([
      "正常",
      "病假",
      "休假",
      "陪产假",
    ]);
    expect(restored!.groups.B.staffStatusOptions).toEqual([
      "正常",
      "病假",
      "休假",
    ]);
  });

  it("v9 迁移时补齐模板岗位一次并保留之后的组内删除", () => {
    const current = createDefaultState();
    const template = { ...current.templates[0]!, positions: ["H1", "H2"] };
    const ruleA = {
      ...current.positionRules[0]!,
      id: "a-h1",
      flightNo: template.flightNo,
      name: "H1",
      category: "分流" as const,
      qualifiedStaffIds: [current.groups.A.staff[0]!.id],
    };
    const ruleB = {
      ...current.groups.B.positionRules[0]!,
      id: "b-h1",
      flightNo: template.flightNo,
      name: "H1",
      category: "常规" as const,
      qualifiedStaffIds: ["B-1"],
    };
    current.groups.B.staff = [
      { ...current.groups.A.staff[0]!, id: "B-1", name: "B组人员" },
    ];
    current.templates = [template];
    current.shared.templates = [template];
    current.groups.A.positionRules = [ruleA];
    current.groups.B.positionRules = [ruleB];
    current.positionRules = current.groups.A.positionRules;
    current.activeScheduleDate = "2026-08-17";
    current.groups.A.activeScheduleDate = "2026-08-17";
    current.groups.B.activeScheduleDate = "2026-08-17";

    const legacy = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    legacy.version = 9;
    const migrated = restorePersistedState(
      JSON.parse(JSON.stringify(legacy)),
      createDefaultState()
    );

    expect(migrated!.version).toBe(12);
    expect(migrated!.groups.A.positionRules.map((rule) => rule.name)).toEqual([
      "H1",
      "H2",
    ]);
    expect(migrated!.groups.B.positionRules.map((rule) => rule.name)).toEqual([
      "H1",
      "H2",
    ]);
    expect(migrated!.groups.A.positionRules[0]).toMatchObject({
      category: "分流",
      qualifiedStaffIds: [current.groups.A.staff[0]!.id],
    });
    expect(migrated!.groups.B.positionRules[0]).toMatchObject({
      category: "常规",
      qualifiedStaffIds: ["B-1"],
    });
    expect(migrated!.groups.A.activeScheduleDate).toBeNull();
    expect(migrated!.groups.B.activeScheduleDate).toBeNull();

    const edited = structuredClone(migrated!);
    edited.groups.A.positionRules = edited.groups.A.positionRules.filter(
      (rule) => rule.name !== "H2"
    );
    edited.positionRules = edited.groups.A.positionRules;
    const reopened = restorePersistedState(
      JSON.parse(JSON.stringify(edited)),
      createDefaultState()
    );
    expect(reopened!.groups.A.positionRules.map((rule) => rule.name)).toEqual([
      "H1",
    ]);
    expect(reopened!.groups.B.positionRules.map((rule) => rule.name)).toEqual([
      "H1",
      "H2",
    ]);
  });

  it("v10 迁移时将两组岗位航班补入共享模板一次", () => {
    const current = createDefaultState();
    const baseRule = current.positionRules[0]!;
    current.groups.A.positionRules = [
      {
        ...baseRule,
        id: "a-ke-g20",
        flightNo: "KE166",
        name: "G20",
        category: "分流",
      },
    ];
    current.groups.B.positionRules = [
      {
        ...baseRule,
        id: "b-ke-g20",
        flightNo: "KE166",
        name: "G20",
        category: "常规",
      },
      {
        ...baseRule,
        id: "b-tw-h02",
        flightNo: "TW616",
        name: "H02",
        category: "引导",
      },
    ];
    current.groups.B.flights.push({
      ...current.flights[0]!,
      id: "b-ke166",
      flightNo: "KE166",
      startTime: "13:20",
      endTime: "15:20",
      remark: "B组航班时间",
    });
    current.activeScheduleDate = "2026-08-12";
    current.groups.B.activeScheduleDate = "2026-08-12";
    current.positionRules = current.groups.A.positionRules;
    const legacy = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    legacy.version = 10;

    const migrated = restorePersistedState(
      JSON.parse(JSON.stringify(legacy)),
      createDefaultState()
    );

    expect(migrated!.version).toBe(12);
    expect(migrated!.templates.map((template) => template.flightNo)).toEqual([
      "CX937",
      "FD573",
      "CX931",
      "TR121",
      "KE166",
      "TW616",
    ]);
    expect(migrated!.templates.at(-2)).toMatchObject({
      flightNo: "KE166",
      startTime: "13:20",
      endTime: "15:20",
      positions: ["G20"],
      remark: "B组航班时间",
    });
    expect(migrated!.templates.at(-1)).toMatchObject({
      flightNo: "TW616",
      startTime: "",
      endTime: "",
      positions: ["H02"],
    });
    expect(migrated!.groups.A.positionRules[0]!.category).toBe("分流");
    expect(migrated!.groups.B.positionRules[0]!.category).toBe("常规");
    expect(migrated!.groups.A.activeScheduleDate).toBeNull();
    expect(migrated!.groups.B.activeScheduleDate).toBe("2026-08-12");

    migrated!.templates = migrated!.templates.filter(
      (template) => template.flightNo !== "KE166"
    );
    migrated!.shared.templates = migrated!.templates;
    const reopened = restorePersistedState(
      JSON.parse(JSON.stringify(migrated)),
      createDefaultState()
    );
    expect(
      reopened!.templates.map((template) => template.flightNo)
    ).not.toContain("KE166");
  });
});
