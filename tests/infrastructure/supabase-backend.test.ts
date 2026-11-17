import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseBackend,
  parsePublicSchedule,
  restoreCloudModel,
} from "../../src/infrastructure/supabase-backend";
import { cloudModel } from "../helpers/cloud";

const config = {
  url: "https://example.supabase.co",
  publicKey: "sb_publishable_test_only",
};

describe("official Supabase SDK adapter", () => {
  function adapter(responses: Array<{ data: unknown; status?: number }>) {
    const fetcher = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected network call");
      return new Response(JSON.stringify(response.data), {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createClient(config.url, config.publicKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetcher },
    });
    return { backend: createSupabaseBackend(config, client), fetcher };
  }

  it("uses server session leases and exposes an active-session error", async () => {
    const { backend, fetcher } = adapter([
      { data: { expiresAt: "2026-11-17T00:01:30Z" } },
      { data: null },
      { data: null },
      { data: { code: "P0001", message: "SESSION_ACTIVE" }, status: 400 },
    ]);
    await backend.acquireSession("session-one");
    await backend.touchSession("session-one");
    await backend.releaseSession("session-one");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_session_id: "session-one",
      p_takeover: false,
    });
    await expect(backend.acquireSession("session-two")).rejects.toMatchObject({
      kind: "session",
    });
    expect(String(fetcher.mock.calls[3]![0])).toContain(
      "/rpc/cloud_acquire_editor_session"
    );
  });

  it("passes the lease id to locked workspace writes", async () => {
    const { backend, fetcher } = adapter([{ data: 2 }]);
    expect(await backend.save(1, cloudModel(), "session-one")).toBe(2);
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "/rpc/cloud_save_workspace_locked"
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({
      p_expected_version: 1,
      p_session_id: "session-one",
    });
  });

  it("sends RPC arguments through the real SDK and preserves explicit empty workspace", async () => {
    const { backend, fetcher } = adapter([
      { data: { version: 0, model: null } },
      { data: 1 },
    ]);
    expect(await backend.currentUser()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await backend.load()).toEqual({ version: 0, model: null });
    const model = cloudModel();
    expect(await backend.save(0, model)).toBe(1);
    const call = fetcher.mock.calls[1]!;
    expect(String(call[0])).toContain("/rest/v1/rpc/cloud_save_workspace");
    const init = call[1]!;
    expect(JSON.parse(String(init.body))).toEqual({
      p_expected_version: 0,
      p_model: model,
    });
    expect(new Headers(init.headers).get("apikey")).toBe(config.publicKey);
  });

  it("loads audit pages/details through authenticated RPC without sending actor or changing workspace", async () => {
    const entry = {
      id: "21",
      actor: "audit@example.invalid",
      occurredAt: "2026-11-15T10:00:00Z",
      version: 2,
      changeCount: 1,
    };
    const page = { entries: [entry], nextCursor: null };
    const details = {
      changes: [
        {
          index: 1,
          scope: "A",
          area: "settings",
          key: "maxDailyHours",
          operation: "update",
          before: 12,
          after: 9,
        },
      ],
      staffLabels: {},
      nextCursor: null,
    };
    const { backend, fetcher } = adapter([
      { data: page },
      { data: details },
      { data: { entries: [{}], nextCursor: null } },
    ]);
    expect(await backend.listAudit("22")).toEqual(page);
    expect(await backend.auditDetails("21", 0)).toEqual(details);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_before_id: "22",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      p_entry_id: "21",
      p_after_index: 0,
    });
    await expect(backend.listAudit()).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("reads uploader snapshots and validates selected content before invoking atomic restore without actor/model input", async () => {
    const entry = {
      id: "1",
      version: 1,
      createdAt: "2026-11-17T01:00:00Z",
      actor: "original@example.invalid",
    };
    const model = cloudModel();
    const { backend, fetcher } = adapter([
      { data: [entry] },
      { data: model },
      { data: 3 },
    ]);
    expect(await backend.listVersions()).toEqual([entry]);
    expect(await backend.restoreVersion(2, "1")).toEqual({ version: 3, model });
    expect(String(fetcher.mock.calls[1]![0])).toContain(
      "/rpc/cloud_read_workspace_version"
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      p_version_id: "1",
    });
    expect(String(fetcher.mock.calls[2]![0])).toContain(
      "/rpc/cloud_restore_workspace_version"
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body))).toEqual({
      p_expected_version: 2,
      p_version_id: "1",
    });
  });

  it("rejects malformed history and corrupt content before any restore write", async () => {
    const { backend, fetcher } = adapter([
      { data: [{ id: "1", version: 1, createdAt: "bad", actor: "x" }] },
      { data: {} },
    ]);
    await expect(backend.listVersions()).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(backend.restoreVersion(2, "1")).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(backend.restoreVersion(2, "not-an-id")).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports expired versions, stale restore CAS and invalid receipts as failures", async () => {
    const model = cloudModel();
    const { backend } = adapter([
      { data: { code: "P0001", message: "VERSION_NOT_FOUND" }, status: 400 },
      { data: model },
      { data: { code: "P0001", message: "WORKSPACE_CONFLICT" }, status: 400 },
      { data: model },
      { data: 2 },
    ]);
    await expect(backend.restoreVersion(2, "1")).rejects.toThrow("自动清理");
    await expect(backend.restoreVersion(2, "1")).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(backend.restoreVersion(2, "1")).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("maps permission and version failures and does not invent a successful save", async () => {
    const { backend } = adapter([
      { data: { code: "P0001", message: "WORKSPACE_CONFLICT" }, status: 400 },
      { data: { code: "42501", message: "ADMIN_REQUIRED" }, status: 403 },
      { data: { version: 2 }, status: 200 },
    ]);
    await expect(backend.save(1, cloudModel())).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(backend.load()).rejects.toMatchObject({
      kind: "unauthorized",
    });
    await expect(backend.load()).rejects.toMatchObject({ kind: "invalid" });
  });

  it("rejects corrupted workspace without silently falling back to default people or dropping records", () => {
    expect(() => restoreCloudModel({ version: 12 })).toThrow();
    const model = cloudModel();
    expect(restoreCloudModel(model).groups.B.staff).toEqual([]);
    const missingRoot = JSON.parse(JSON.stringify(model));
    delete missingRoot.staff;
    expect(() => restoreCloudModel(missingRoot)).toThrow();
    const broken = JSON.parse(JSON.stringify(model));
    delete broken.groups.A.staff;
    expect(() => restoreCloudModel(broken)).toThrow("组内资料");
    broken.groups.A.staff = [{ invalid: true }];
    expect(() => restoreCloudModel(broken)).toThrow();
  });

  it.each(["staff", "templates", "settings"])(
    "rejects missing or malformed root %s before applying defaults",
    (key) => {
      const model = JSON.parse(JSON.stringify(cloudModel()));
      delete model[key];
      expect(() => restoreCloudModel(model)).toThrow("顶层资料");
      model[key] = null;
      expect(() => restoreCloudModel(model)).toThrow("顶层资料");
    }
  );

  it("strips unknown private fields from public responses and rejects incomplete rows", () => {
    const publicData = {
      schemaVersion: 1,
      groupId: "B",
      date: "2026-11-15",
      publishedAt: "2026-11-15T00:00:00Z",
      privateConfig: { secret: true },
      rows: [
        {
          flightNo: "TEST100",
          position: "柜台",
          staffName: "示例",
          startTime: "08:00",
          endTime: "10:00",
          remark: "",
          status: "assigned",
          privateId: "hidden",
        },
      ],
    };
    const result = parsePublicSchedule(publicData);
    expect(result).not.toHaveProperty("privateConfig");
    expect(result.rows[0]).not.toHaveProperty("privateId");
    expect(() => parsePublicSchedule({ ...publicData, rows: [{}] })).toThrow();
  });

  it("uses password login, verifies restored user over Auth, and explicitly signs out only this device", async () => {
    const user = {
      id: "00000000-0000-4000-8000-000000000001",
      aud: "authenticated",
      role: "authenticated",
      email: "admin@example.invalid",
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: "2026-11-15T00:00:00Z",
    };
    const token = [
      btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      btoa(
        JSON.stringify({
          sub: user.id,
          exp: Math.floor(Date.now() / 1000) + 3600,
          role: "authenticated",
        })
      ),
      btoa("test-signature"),
    ].join(".");
    const { backend, fetcher } = adapter([
      {
        data: {
          access_token: token,
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "test-refresh",
          user,
        },
      },
      { data: user },
      { data: {} },
    ]);
    const signedOut = vi.fn();
    const unsubscribe = backend.onSignedOut(signedOut);
    await backend.signIn(user.email, "test-password");
    expect(await backend.currentUser()).toBe(user.id);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("/auth/v1/user"))
    ).toBe(true);
    await backend.signOut();
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("/logout?scope=local")
      )
    ).toBe(true);
    expect(signedOut).toHaveBeenCalledOnce();
    expect(await backend.currentUser()).toBeNull();
    unsubscribe();
  });
});
