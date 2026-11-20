import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import { previewFlightIdentityChange } from "../../src/domain/flights/flight-identity-change";
import { flightRuleMatches } from "../../src/domain/flights/flight-identities";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { restorePersistedState } from "../../src/infrastructure/state-restoration";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { restoreCloudModel } from "../../src/infrastructure/supabase-backend";
import { createTestAutoscheduleStore } from "../helpers/application";

const identities = [
  {
    id: "service",
    displayName: "统一航班",
    aliases: [
      { flightNo: "CX937早" },
      { flightNo: "CX937晚" },
      { flightNo: "AB999", positionSourceFlightNo: "CX937晚" },
    ],
  },
];

describe("航班档案事务与跨设备", () => {
  it("a directory-only import inherits each group's own position source without overwriting existing jobs", () => {
    const state = createDefaultState();
    const source = {
      ...state.positionRules[0]!,
      id: "source-a",
      flightNo: "CX937晚",
      qualifiedStaffIds: [state.staff[0]!.id],
    };
    state.positionRules = [source];
    const otherSource = { ...source, id: "source-b", qualifiedStaffIds: [] };
    state.groups.B.positionRules = [otherSource];
    expect(
      applyWorkbookImport(
        state,
        { flightIdentities: identities, warnings: [] },
        "config"
      ).errors
    ).toBeUndefined();
    expect(
      state.positionRules.find((r) => r.flightNo === "AB999")
    ).toMatchObject({ qualifiedStaffIds: source.qualifiedStaffIds });
    expect(
      state.groups.B.positionRules.find((r) => r.flightNo === "AB999")
    ).toMatchObject({ qualifiedStaffIds: [] });
    const next = state.positionRules.find((r) => r.flightNo === "AB999")!;
    expect(next.id).not.toBe(source.id);
    next.remark = "independent";
    applyWorkbookImport(
      state,
      { flightIdentities: identities, warnings: [] },
      "config"
    );
    expect(
      state.positionRules.filter((r) => r.flightNo === "AB999")
    ).toHaveLength(1);
    expect(
      state.positionRules.find((r) => r.flightNo === "AB999")!.remark
    ).toBe("independent");
  });
  it("恢复拒绝另一组和次数中悬空的档案引用；旧无目录云资料保持独立名称", () => {
    const state = createDefaultState();
    state.shared.flightIdentities = identities;
    state.groups.B.settings.latePriorityFlightNumbers = ["@MISSING"];
    expect(
      restorePersistedState(
        JSON.parse(JSON.stringify(state)),
        createDefaultState()
      )
    ).toBeNull();
    state.groups.B.settings.latePriorityFlightNumbers = [];
    state.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId: state.staff[0]!.id,
        flightNo: "@MISSING",
        kind: "number-one",
        delta: 1,
      },
    ];
    expect(
      restorePersistedState(
        JSON.parse(JSON.stringify(state)),
        createDefaultState()
      )
    ).toBeNull();
    const old = createDefaultState();
    delete old.shared.flightIdentities;
    delete old.shared.flightIdentitySchemaVersion;
    expect(restoreCloudModel(JSON.parse(JSON.stringify(old))).settings).toEqual(
      old.settings
    );
  });
  it("预览后原子保存，两组共用身份而组内规则独立，切组与重启保留", () => {
    const source = createDefaultState();
    source.settings.latePriorityFlightNumbers = ["CX937早"];
    source.groups.B.settings.latePriorityFlightNumbers = ["CX937晚"];
    source.groups.B.staff = [];
    const store = createTestAutoscheduleStore(source);
    const preview = previewFlightIdentityChange(
      store.getState().model,
      identities
    );
    expect(preview.errors).toEqual([]);
    expect(
      store
        .getState()
        .configuration.saveFlightIdentities(identities, preview.fingerprint).ok
    ).toBe(true);
    expect(store.getState().model.settings.latePriorityFlightNumbers).toEqual([
      "@SERVICE",
    ]);
    store.getState().switchGroup("B");
    expect(store.getState().model.settings.latePriorityFlightNumbers).toEqual([
      "@SERVICE",
    ]);
    expect(store.getState().model.staff).toEqual([]);
    store.getState().persist();
    const restored = restorePersistedState(
      JSON.parse(JSON.stringify(store.getState().model)),
      createDefaultState()
    )!;
    expect(restored.shared.flightIdentities).toEqual(identities);
    expect(flightRuleMatches(restored, "@SERVICE", "AB999")).toBe(true);
    expect(restoreCloudModel(restored).shared.flightIdentities).toEqual(
      identities
    );
  });
  it("冲突、过期预览、坏目录均不写入", () => {
    const state = createDefaultState();
    state.settings.teamLeaderGapFillPositionPolicies = [
      { flightNo: "CX937早", position: "H02", movable: true },
      { flightNo: "CX937晚", position: "H02", movable: false },
    ];
    const store = createTestAutoscheduleStore(state);
    const before = JSON.stringify(store.getState().model);
    const preview = previewFlightIdentityChange(
      store.getState().model,
      identities
    );
    expect(preview.errors.join()).toContain("同时设置");
    expect(
      store
        .getState()
        .configuration.saveFlightIdentities(identities, preview.fingerprint).ok
    ).toBe(false);
    expect(JSON.stringify(store.getState().model)).toBe(before);
    expect(
      store.getState().configuration.saveFlightIdentities(identities, "old").ok
    ).toBe(false);
    expect(JSON.stringify(store.getState().model)).toBe(before);
    expect(
      restorePersistedState(
        {
          ...state,
          shared: { ...state.shared, flightIdentities: [{ id: "bad" }] },
        },
        createDefaultState()
      )
    ).toBeNull();
  });
  it("a partial settings import cannot add a dangling identity when the directory sheet is absent", () => {
    const state = createDefaultState();
    const before = JSON.stringify(state);
    const result = applyWorkbookImport(
      state,
      { settings: { latePriorityFlightNumbers: ["@MISSING"] }, warnings: [] },
      "config"
    );
    expect(result.errors?.join()).toContain("档案");
    expect(JSON.stringify(state)).toBe(before);
  });
  it("真实XLSX字节往返后空状态导入、重启，身份效果及另一组保留", () => {
    const source = createDefaultState();
    source.shared.flightIdentities = identities;
    source.settings.latePriorityFlightNumbers = ["@SERVICE"];
    const book = XLSX.read(
      XLSX.write(buildConfigWorkbook(source), {
        type: "array",
        bookType: "xlsx",
      }),
      { type: "array" }
    );
    const imported = parseWorkbook(book, []);
    expect(imported.flightIdentities).toEqual(identities);
    const target = createDefaultState();
    target.shared.flightIdentities = [
      {
        id: "different",
        displayName: "旧目标",
        aliases: [{ flightNo: "ZZ100" }],
      },
    ];
    const other = structuredClone(target.groups.B);
    const result = applyWorkbookImport(target, imported, "config", {
      restoreFlightConfiguration: true,
    });
    expect(result.errors).toBeUndefined();
    expect(target.shared.flightIdentities).toEqual(identities);
    expect(target.groups.B.staff).toEqual(other.staff);
    const restored = restorePersistedState(
      JSON.parse(JSON.stringify(target)),
      createDefaultState()
    )!;
    expect(
      flightRuleMatches(
        restored,
        restored.settings.latePriorityFlightNumbers[0]!,
        "AB999"
      )
    ).toBe(true);
  });
  it("旧文件缺表：普通导入保留，完整恢复采用独立名称；坏表拒绝整个事务", () => {
    const source = createDefaultState(),
      target = createDefaultState();
    const book = buildConfigWorkbook(source);
    delete book.Sheets["航班长期档案"];
    book.SheetNames = book.SheetNames.filter((n) => n !== "航班长期档案");
    const old = parseWorkbook(book, []);
    target.shared.flightIdentities = identities;
    expect(applyWorkbookImport(target, old, "config").errors).toBeUndefined();
    expect(target.shared.flightIdentities).toEqual(identities);
    expect(
      applyWorkbookImport(target, old, "config", {
        restoreFlightConfiguration: true,
      }).errors
    ).toBeUndefined();
    expect(target.shared.flightIdentities).toEqual([]);
    const before = JSON.stringify(target);
    expect(
      applyWorkbookImport(
        target,
        { flightIdentityErrors: ["损坏"], staff: [], warnings: [] },
        "config"
      ).errors
    ).toEqual(["损坏"]);
    expect(JSON.stringify(target)).toBe(before);
  });
});
