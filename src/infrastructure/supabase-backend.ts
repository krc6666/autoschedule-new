import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createDefaultState } from "../defaults";
import type { AppState } from "../model";
import {
  CloudError,
  type CloudBackend,
  type CloudPublication,
  type PublicSchedule,
} from "../app/cloud-contract";
import {
  clearLastRestorationReport,
  getLastRestorationReport,
  restorePersistedState,
} from "./state-restoration";
import type { CloudConfiguration } from "./supabase-config";
import { parseAuditDetails, parseAuditPage } from "./operation-audit-response";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredShape(
  value: Record<string, unknown>,
  example: object
): boolean {
  return Object.entries(example).every(([key, field]) =>
    Array.isArray(field)
      ? Array.isArray(value[key])
      : record(field)
        ? record(value[key])
        : field === null
          ? value[key] === null || typeof value[key] === "string"
          : typeof value[key] === typeof field
  );
}

export function restoreCloudModel(value: unknown): AppState {
  const fallback = createDefaultState();
  if (
    !record(value) ||
    value.version !== 12 ||
    !record(value.shared) ||
    !record(value.groups) ||
    !record(value.groups.A) ||
    !record(value.groups.B) ||
    !["A", "B"].includes(String(value.activeGroupId))
  ) {
    throw new CloudError(
      "invalid",
      "云端数据结构不完整或版本不支持，未载入默认数据，请先备份并检查。"
    );
  }
  // The existing restorer consumes root fields for the active A workspace.
  // Validate before it can substitute defaults for a missing projection.
  if (!hasRequiredShape(value, fallback)) {
    throw new CloudError(
      "invalid",
      "云端顶层资料不完整，未使用初始配置补盖，请先检查备份。"
    );
  }
  for (const [name, group] of Object.entries(value.groups)) {
    if (name !== "A" && name !== "B") continue;
    if (!record(group) || !hasRequiredShape(group, fallback.groups[name])) {
      throw new CloudError(
        "invalid",
        "云端组内资料不完整，未使用初始配置补盖，请先检查备份。"
      );
    }
  }
  if (
    !Array.isArray(value.shared.templates) ||
    !Array.isArray(value.shared.weeklyFlightPlans)
  ) {
    throw new CloudError("invalid", "云端共用航班资料不完整，未载入数据。");
  }
  clearLastRestorationReport();
  const model = restorePersistedState(value, fallback);
  if (!model || getLastRestorationReport().issues.length) {
    throw new CloudError(
      "invalid",
      "云端数据有无法完整恢复的内容，未覆盖本机数据，请先检查备份。"
    );
  }
  for (const id of ["A", "B"] as const) {
    const original = value.groups[id];
    if (!record(original))
      throw new CloudError("invalid", "云端组内资料缺失。");
    const restored = model.groups[id];
    for (const key of [
      "staff",
      "flights",
      "positionRules",
      "history",
      "assignments",
    ] as const) {
      if (
        !Array.isArray(original[key]) ||
        original[key].length !== restored[key].length
      ) {
        throw new CloudError(
          "invalid",
          "云端有无法完整恢复的人员、岗位或班表记录，未丢弃记录后继续使用。"
        );
      }
    }
  }
  return model;
}

export function parsePublicSchedule(value: unknown): PublicSchedule {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    (value.groupId !== "A" && value.groupId !== "B") ||
    typeof value.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    typeof value.publishedAt !== "string" ||
    !Array.isArray(value.rows) ||
    !value.rows.every(
      (row) =>
        record(row) &&
        [
          "flightNo",
          "position",
          "staffName",
          "startTime",
          "endTime",
          "remark",
          "status",
        ].every((key) => typeof row[key] === "string")
    )
  ) {
    throw new CloudError("invalid", "发布班表格式不正确，未显示不完整内容。");
  }
  // Strip unknown fields again at the read boundary.
  return {
    schemaVersion: 1,
    groupId: value.groupId,
    date: value.date,
    publishedAt: value.publishedAt,
    rows: value.rows.map((row) => ({
      flightNo: row.flightNo,
      position: row.position,
      staffName: row.staffName,
      startTime: row.startTime,
      endTime: row.endTime,
      remark: row.remark,
      status: row.status,
    })),
  };
}

function fail(error: { message: string; code?: string }): never {
  if (error.message.includes("WORKSPACE_CONFLICT")) {
    throw new CloudError(
      "conflict",
      "云端已有更新，已阻止旧数据覆盖。本次修改尚未保存到云端，请核对后重新登录读取最新数据。"
    );
  }
  if (error.code === "42501" || error.message.includes("ADMIN_REQUIRED")) {
    throw new CloudError(
      "unauthorized",
      "当前账号没有管理员权限，请检查项目中的管理员设置。"
    );
  }
  if (error.message.includes("SCHEDULE_NOT_PUBLISHABLE")) {
    throw new CloudError(
      "invalid",
      "没有可发布的有效班表，请先重新排班并保存到云端。"
    );
  }
  throw new CloudError(
    "unavailable",
    "云端操作未成功，请检查网络、登录状态和项目配置后重试；当前修改与上次发布保留。"
  );
}

export function createSupabaseBackend(
  config: CloudConfiguration,
  client: SupabaseClient = createClient(config.url, config.publicKey, {
    auth: { detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            AbortSignal.timeout(20_000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    },
  })
): CloudBackend {
  const rpc = async (name: string, args = {}) => {
    const { data, error } = await client.rpc(name, args);
    if (error) fail(error);
    return data as unknown;
  };
  return {
    async currentUser() {
      const { data: session, error: sessionError } =
        await client.auth.getSession();
      if (sessionError) fail(sessionError);
      if (!session.session) return null;
      const { data, error } = await client.auth.getUser();
      if (error) fail(error);
      return data.user?.id ?? null;
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error)
        throw new CloudError(
          "unauthorized",
          "登录未成功，请检查账号、密码和网络。"
        );
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) fail(error);
    },
    onSignedOut(callback) {
      const { data } = client.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") callback();
      });
      return () => data.subscription.unsubscribe();
    },
    async load() {
      const data = await rpc("cloud_load_workspace");
      if (
        !record(data) ||
        !Number.isSafeInteger(data.version) ||
        Number(data.version) < 0 ||
        (data.version === 0) !== (data.model === null)
      ) {
        throw new CloudError(
          "invalid",
          "云端版本信息不完整，未加载或覆盖数据。"
        );
      }
      return {
        version: Number(data.version),
        model: data.model === null ? null : restoreCloudModel(data.model),
      };
    },
    async save(expectedVersion, model) {
      const version = await rpc("cloud_save_workspace", {
        p_expected_version: expectedVersion,
        p_model: model,
      });
      if (
        !Number.isSafeInteger(version) ||
        Number(version) !== expectedVersion + 1
      ) {
        throw new CloudError(
          "invalid",
          "云端保存回执不正确，请重新读取版本后核对。"
        );
      }
      return Number(version);
    },
    async listAudit(beforeId = null) {
      return parseAuditPage(
        await rpc("cloud_list_audit", { p_before_id: beforeId })
      );
    },
    async auditDetails(entryId, afterIndex = 0) {
      return parseAuditDetails(
        await rpc("cloud_audit_details", {
          p_entry_id: entryId,
          p_after_index: afterIndex,
        })
      );
    },
    async publish(expectedVersion, groupId) {
      const data = await rpc("cloud_publish_schedule", {
        p_expected_version: expectedVersion,
        p_group_id: groupId,
      });
      if (!record(data) || typeof data.token !== "string")
        throw new CloudError("invalid", "发布回执不完整。");
      return {
        token: data.token,
        snapshot: parsePublicSchedule(data.snapshot),
      } satisfies CloudPublication;
    },
    async readPublication(token) {
      const data = await rpc("cloud_read_publication", { p_token: token });
      return data === null ? null : parsePublicSchedule(data);
    },
  };
}
