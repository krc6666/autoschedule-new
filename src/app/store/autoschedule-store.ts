import { createStore, type StoreApi } from "zustand/vanilla";
import { immer } from "zustand/middleware/immer";

import { createDefaultState } from "../../defaults";
import type { StateSaveResult } from "../../infrastructure/storage";
import type { AppState, ScheduleGroupId } from "../../model";
import {
  createConfigurationCommands,
  type ConfigurationCommands,
} from "./configuration-commands";
import { createPolicyCommands, type PolicyCommands } from "./policy-commands";
import {
  createRecordsCommands,
  type RecordsCommands,
} from "./records-commands";
import {
  createScheduleCommands,
  type ScheduleCommands,
} from "./schedule-commands";
import type { StateCommand } from "./store-command";

export interface AutoscheduleStoreState {
  model: AppState;
  configuration: ConfigurationCommands;
  policy: PolicyCommands;
  schedule: ScheduleCommands;
  records: RecordsCommands;
  replaceModel(state: AppState): void;
  switchGroup(groupId: ScheduleGroupId): boolean;
  isDirty(): boolean;
  hasUnexportedChanges(): boolean;
  markExported(): void;
  persist(): StateSaveResult;
  reset(): void;
}

export type AutoscheduleStore = StoreApi<AutoscheduleStoreState>;

export interface AutoscheduleStatePersistence {
  load(): AppState;
  save(state: AppState): StateSaveResult;
  clear(): void;
}

export interface CreateAutoscheduleStoreOptions {
  persistence: AutoscheduleStatePersistence;
  initialState?: AppState;
}

function syncSharedProjection(model: AppState): void {
  model.shared.templates = model.templates;
  model.shared.weeklyFlightPlans = model.weeklyFlightPlans;
  model.shared.positionRules = model.positionRules;
  model.shared.settings = model.settings;
}

function activateSharedProjection(model: AppState): void {
  model.templates = model.shared.templates;
  model.weeklyFlightPlans = model.shared.weeklyFlightPlans;
  model.positionRules = model.shared.positionRules;
  model.settings = model.shared.settings;
}

function reconcileInitialProjection(model: AppState): void {
  const active = model.groups[model.activeGroupId];
  if (!active) return;
  active.staff = model.staff;
  active.flights = model.flights;
  active.history = model.history;
  active.dutyRosterOverrides = model.dutyRosterOverrides;
  active.latePriorityFrequencyAdjustments =
    model.latePriorityFrequencyAdjustments;
  active.ordinaryPriorityFrequencyAdjustments =
    model.ordinaryPriorityFrequencyAdjustments;
  active.assignments = model.assignments;
  active.activeScheduleDate = model.activeScheduleDate;
  active.schedulePolicyStale = model.schedulePolicyStale;
  if (model.scheduleRuleFingerprint !== undefined)
    active.scheduleRuleFingerprint = model.scheduleRuleFingerprint;
  model.shared.templates = model.templates;
  model.shared.weeklyFlightPlans = model.weeklyFlightPlans;
  model.shared.positionRules = model.positionRules;
  model.shared.settings = model.settings;
}

function syncActiveGroupProjection(model: AppState): void {
  const group = model.groups[model.activeGroupId];
  if (!group) return;
  group.flights = model.flights;
  group.staff = model.staff;
  group.history = model.history;
  group.dutyRosterOverrides = model.dutyRosterOverrides;
  group.latePriorityFrequencyAdjustments =
    model.latePriorityFrequencyAdjustments;
  group.ordinaryPriorityFrequencyAdjustments =
    model.ordinaryPriorityFrequencyAdjustments;
  group.assignments = model.assignments;
  group.activeScheduleDate = model.activeScheduleDate;
  group.schedulePolicyStale = model.schedulePolicyStale;
  group.scheduleRuleFingerprint = model.scheduleRuleFingerprint;
  syncSharedProjection(model);
}

function activateGroupProjection(
  model: AppState,
  groupId: ScheduleGroupId
): void {
  const group = model.groups[groupId];
  if (!group) return;
  model.activeGroupId = groupId;
  model.flights = group.flights;
  model.staff = group.staff;
  model.history = group.history;
  model.dutyRosterOverrides = group.dutyRosterOverrides;
  model.latePriorityFrequencyAdjustments =
    group.latePriorityFrequencyAdjustments;
  model.ordinaryPriorityFrequencyAdjustments =
    group.ordinaryPriorityFrequencyAdjustments;
  model.assignments = group.assignments;
  model.activeScheduleDate = group.activeScheduleDate;
  model.schedulePolicyStale = group.schedulePolicyStale;
  model.scheduleRuleFingerprint = group.scheduleRuleFingerprint;
}

function exportFingerprint(model: AppState): string {
  const { updatedAt: _updatedAt, ...exportable } = model;
  return JSON.stringify(exportable);
}

export function createAutoscheduleStore(
  options: CreateAutoscheduleStoreOptions
): AutoscheduleStore {
  const initial = options.initialState ?? options.persistence.load();
  const initialModel = structuredClone(initial);
  reconcileInitialProjection(initialModel);
  activateSharedProjection(initialModel);
  activateGroupProjection(initialModel, initialModel.activeGroupId);
  return createStore<AutoscheduleStoreState>()(
    immer((set, get) => {
      let dirty = false;
      let exportedFingerprint = exportFingerprint(initialModel);
      const command: StateCommand = <T>(operation: (state: AppState) => T) => {
        let result!: T;
        set((store) => {
          result = operation(store.model);
          syncActiveGroupProjection(store.model);
        });
        dirty = true;
        return result;
      };
      return {
        model: initialModel,
        configuration: createConfigurationCommands(command),
        policy: createPolicyCommands(command),
        schedule: createScheduleCommands(command),
        records: createRecordsCommands(command),
        replaceModel: (state) => {
          const next = structuredClone(state);
          syncActiveGroupProjection(next);
          dirty = false;
          set({ model: next });
        },
        switchGroup: (groupId) => {
          if (groupId === get().model.activeGroupId) return true;
          let switched = false;
          set((store) => {
            syncActiveGroupProjection(store.model);
            activateGroupProjection(store.model, groupId);
            switched = true;
          });
          dirty = true;
          return switched;
        },
        isDirty: () => dirty,
        hasUnexportedChanges: () =>
          exportFingerprint(get().model) !== exportedFingerprint,
        markExported: () => {
          exportedFingerprint = exportFingerprint(get().model);
        },
        persist: () => {
          set((store) => syncActiveGroupProjection(store.model));
          const result = options.persistence.save(get().model);
          set({ model: result.state });
          dirty = false;
          return result;
        },
        reset: () => {
          options.persistence.clear();
          set({ model: createDefaultState() });
          dirty = false;
        },
      };
    })
  );
}
