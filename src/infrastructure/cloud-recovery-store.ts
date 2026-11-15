import type { AppState } from "../model";
import type { ApplicationPreferences } from "../app/application-preferences";
import { createBrowserPreferences } from "./browser-preferences";
import { STORAGE_KEY } from "./storage";
import { createDefaultState } from "../defaults";
import {
  clearLastRestorationReport,
  getLastRestorationReport,
  restorePersistedState,
} from "./state-restoration";
import { restoreCloudModel } from "./supabase-backend";

export interface RecoveryCopy {
  baseVersion: number;
  unsaved: boolean;
  model: AppState;
}

export interface CloudRecoveryStore {
  read(): RecoveryCopy | null;
  write(copy: RecoveryCopy): void;
  raw(): string | null;
  remove(): void;
}

export interface BrowserCloudPersistence {
  recovery: CloudRecoveryStore;
  preferences: ApplicationPreferences;
  loadLocalModel(): AppState | null;
}

export async function readCloudRecoveryFile(
  file: Pick<File, "text">
): Promise<AppState> {
  const value: unknown = JSON.parse(await file.text());
  if (typeof value !== "object" || value === null || !("model" in value)) {
    throw new Error("这不是完整云端恢复副本；Excel请使用工作台原有导入入口。");
  }
  return restoreCloudModel(value.model);
}

export function createBrowserCloudPersistence(
  scope: string,
  userId: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage
): BrowserCloudPersistence {
  const prefix = `autoschedule.cloud.v1:${scope}:${userId}`;
  const key = `${prefix}:recovery`;
  return {
    recovery: {
      read() {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (
          !Number.isSafeInteger(value.baseVersion) ||
          value.baseVersion < 0 ||
          typeof value.unsaved !== "boolean"
        )
          throw new Error("恢复副本版本无效");
        return {
          baseVersion: value.baseVersion,
          unsaved: value.unsaved,
          model: restoreCloudModel(value.model),
        };
      },
      write: (copy) => storage.setItem(key, JSON.stringify(copy)),
      raw: () => storage.getItem(key),
      remove: () => storage.removeItem(key),
    },
    preferences: createBrowserPreferences({
      getItem: (name) => storage.getItem(`${prefix}:${name}`),
      setItem: (name, value) => storage.setItem(`${prefix}:${name}`, value),
    }),
    loadLocalModel() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      clearLastRestorationReport();
      const model = restorePersistedState(
        JSON.parse(raw),
        createDefaultState()
      );
      if (!model || getLastRestorationReport().issues.length)
        throw new Error("原本地数据未能完整恢复，未迁移，请先检查Excel备份。");
      return model;
    },
  };
}
