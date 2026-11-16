import { produce } from "immer";
import type { AppState, ScheduleSettings } from "../model";
import type { MobileSupervisorFillRule } from "../domain/rules/structured-policy-contract";
import {
  applyScheduleSettingsPatch,
  STATISTICS_TIME_WINDOWS,
} from "../domain/rules/schedule-settings";
import { normalizeAirlineMixCodes } from "../domain/rules/airline-mix-policy";
import {
  fillPositionMatches,
  isSameFlightSupervisorFillRule,
} from "../domain/coverage/supervisor-fill-configuration";
import { createPolicyCommands } from "./store/policy-commands";
import type { PolicyValue, SchedulePolicyInput } from "./policy-actions";

export interface PolicyEditingView {
  model: AppState;
  dirty: boolean;
  fieldInputs: Readonly<Record<string, PolicyValue>>;
  supervisorEditor: MobileSupervisorFillRule | null;
}

export const policyFieldInputKey = (
  entity: string,
  id: string,
  field: string
) => JSON.stringify([entity, id, field]);

/** Owns only the rules-page draft. Formal state and scheduling never read it. */
export class PolicyEditingSession {
  private baseline?: {
    groupId: AppState["activeGroupId"];
    settings: ScheduleSettings;
  };
  private settings?: ScheduleSettings;
  private fieldInputs: Record<string, PolicyValue> = {};
  private invalidInputs = new Set<string>();
  private editor: MobileSupervisorFillRule | null = null;
  private editorBaseline: string | null = null;

  view(model: AppState): PolicyEditingView {
    this.reconcile(model);
    return {
      model: this.settings ? { ...model, settings: this.settings } : model,
      dirty: this.isDirty(),
      fieldInputs: this.fieldInputs,
      supervisorEditor: this.editor,
    };
  }

  isDirty(): boolean {
    return Boolean(
      (this.settings &&
        JSON.stringify(this.settings) !==
          JSON.stringify(this.baseline?.settings)) ||
      this.invalidInputs.size ||
      this.hasSupervisorChanges()
    );
  }

  hasSupervisorChanges(): boolean {
    return Boolean(
      this.editor && JSON.stringify(this.editor) !== this.editorBaseline
    );
  }

  private reconcile(model: AppState): void {
    // Clean sessions follow external imports/restores. Dirty sessions require an explicit decision.
    if (
      this.baseline &&
      !this.isDirty() &&
      (model.activeGroupId !== this.baseline.groupId ||
        model.settings !== this.baseline.settings)
    )
      this.discard();
  }

  private begin(model: AppState): void {
    this.reconcile(model);
    this.baseline ??= {
      groupId: model.activeGroupId,
      settings: model.settings,
    };
    this.settings ??= model.settings;
  }

  commands(model: AppState) {
    return createPolicyCommands(<T>(operation: (state: AppState) => T): T => {
      this.begin(model);
      let result!: T;
      const next = produce({ ...model, settings: this.settings! }, (state) => {
        result = operation(state);
      });
      this.settings = next.settings;
      return result;
    });
  }

  patch(model: AppState, input: Partial<SchedulePolicyInput>): void {
    this.begin(model);
    this.settings = { ...this.settings!, ...input };
  }

  updateField(
    model: AppState,
    entity: string,
    id: string,
    field: string,
    value: PolicyValue
  ): void {
    this.begin(model);
    const key = policyFieldInputKey(entity, id, field);
    this.fieldInputs = { ...this.fieldInputs, [key]: value };
    if (
      entity === "airline-mix" &&
      field === "airlineCodes" &&
      normalizeAirlineMixCodes(value) === null
    ) {
      this.invalidInputs.add(key);
      return;
    }
    this.invalidInputs.delete(key);
    this.commands(model).updateEntity(entity, id, field, value);
  }

  forgetItemInputs(id: string): void {
    if (this.editor?.id === id) this.cancelSupervisor();
    this.fieldInputs = Object.fromEntries(
      Object.entries(this.fieldInputs).filter(([key]) => {
        const matches = JSON.parse(key)[1] === id;
        if (matches) this.invalidInputs.delete(key);
        return !matches;
      })
    );
  }

  updateOrdinaryPosition(
    model: AppState,
    index: number,
    field: "airlineCode" | "position",
    value: string
  ): void {
    this.begin(model);
    // Keep incomplete text while typing; the existing settings normalizer runs at Save.
    this.settings = produce(this.settings!, (settings) => {
      const item = settings.ordinaryPriorityPositions[index];
      if (item) item[field] = value;
    });
  }

  editSupervisor(model: AppState, rule?: MobileSupervisorFillRule): void {
    this.begin(model);
    const draft: MobileSupervisorFillRule = rule
      ? { ...rule }
      : {
          id: "",
          enabled: true,
          sourceFlightNo: "",
          sourcePositionKeyword: "",
          targetFlightNo: "",
          targetPositionKeyword: "",
          allowAutomatic: true,
          allowManual: true,
        };
    if (rule) {
      for (const side of ["source", "target"] as const) {
        const matches = model.positionRules.filter(
          (position) =>
            fillPositionMatches(
              position,
              rule[`${side}FlightNo`],
              rule[`${side}PositionKeyword`]
            ) && position.category === (side === "source" ? "机动督导" : "常规")
        );
        draft[`${side}PositionKeyword`] =
          matches.length === 1 ? matches[0]!.name : "";
      }
      if (!isSameFlightSupervisorFillRule(rule)) {
        draft.sourceFlightNo = draft.targetFlightNo = "";
        draft.sourcePositionKeyword = draft.targetPositionKeyword = "";
      }
    }
    this.editor = draft;
    this.editorBaseline = rule ? JSON.stringify(draft) : null;
  }

  updateSupervisor(patch: Partial<MobileSupervisorFillRule>): void {
    if (this.editor) this.editor = { ...this.editor, ...patch };
  }

  cancelSupervisor(): void {
    this.editor = null;
    this.editorBaseline = null;
  }

  prepareSave(model: AppState): ScheduleSettings {
    this.begin(model);
    if (
      model.activeGroupId !== this.baseline!.groupId ||
      JSON.stringify(model.settings) !== JSON.stringify(this.baseline!.settings)
    )
      throw new Error(
        "正式规则已被其他操作改变，未覆盖现有配置。请先核对或放弃规则草稿后重新编辑。"
      );
    if (this.invalidInputs.size)
      throw new Error(
        "航司搭配请填写航司代码，例如 FD, AK，不填完整航班号；规则草稿仍保留。"
      );
    for (const { label, start, end } of STATISTICS_TIME_WINDOWS)
      if (this.settings![start] === this.settings![end])
        throw new Error(`${label}统计开始和结束不能相同，请调整后保存规则。`);
    let candidate = this.settings!;
    if (this.editor && JSON.stringify(this.editor) !== this.editorBaseline) {
      let error: string | undefined;
      const next = produce({ ...model, settings: candidate }, (state) => {
        const commands = createPolicyCommands((operation) => operation(state));
        const result = commands.saveSupervisorFill(this.editor!);
        if (!result.ok) error = result.error;
      });
      if (error) throw new Error(error);
      candidate = next.settings;
    }
    const normalized = applyScheduleSettingsPatch(candidate, {});
    // Incomplete newly edited collections must not disappear on normalization/reload.
    for (const key of Object.keys(candidate) as (keyof ScheduleSettings)[]) {
      const before = candidate[key],
        after = normalized[key];
      if (
        Array.isArray(before) &&
        Array.isArray(after) &&
        before.length !== after.length
      )
        throw new Error(
          "有规则项填写不完整或重复，请补全或删除该项后保存；所有草稿仍保留。"
        );
    }
    return normalized;
  }

  discard(): void {
    this.baseline = undefined;
    this.settings = undefined;
    this.fieldInputs = {};
    this.invalidInputs.clear();
    this.cancelSupervisor();
  }
}
