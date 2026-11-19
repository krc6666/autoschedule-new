import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudModel, publishableCloudModel } from "../helpers/cloud";

const admin = "00000000-0000-4000-8000-000000000001";
const first = "first-editor-123456";
const second = "second-editor-123456";
const third = "third-editor-123456";
const request = "login-request-123456";

describe("server-authoritative editor handoff", () => {
  let db: PGlite;
  let preserved = false;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      insert into auth.users values ('${admin}', 'admin@example.invalid');
    `);
    for (const path of [
      "202611150001_cloud_workspace.sql",
      "202611150002_operation_audit.sql",
      "202611170001_workspace_versions.sql",
      "202611170002_single_editor_session.sql",
    ])
      await db.exec(readFileSync(`supabase/migrations/${path}`, "utf8"));
    await db.query("insert into public.autoschedule_admin values(true, $1)", [
      admin,
    ]);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
    await acquire(first);
    await rpc("cloud_save_workspace_locked", [
      0,
      JSON.stringify(cloudModel()),
      first,
    ]);
    await rpc("cloud_save_workspace_locked", [
      1,
      JSON.stringify(cloudModel()),
      first,
    ]);
    const snapshot = async () =>
      db.query(`select jsonb_build_object(
      'workspace', (select jsonb_agg(w) from public.autoschedule_workspace w),
      'versions', (select jsonb_agg(v) from public.schedule_versions v),
      'audit', (select jsonb_agg(a) from public.autoschedule_audit_entries a),
      'lease', (select jsonb_agg(s) from public.autoschedule_editor_sessions s),
      'admin', (select jsonb_agg(a) from public.autoschedule_admin a)
    ) as snapshot`);
    const before = await snapshot();
    await db.exec(
      readFileSync(
        "supabase/migrations/202611180001_editor_session_approval.sql",
        "utf8"
      )
    );
    preserved =
      JSON.stringify(before.rows) === JSON.stringify((await snapshot()).rows);
  }, 30000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec(
      "reset role; truncate public.autoschedule_editor_requests, public.autoschedule_editor_sessions; truncate public.autoschedule_audit_entries cascade; truncate public.schedule_versions, public.autoschedule_workspace, public.autoschedule_publications;"
    );
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
    await db.exec("set role authenticated");
    await acquire(first);
  });
  const acquire = (id: string, takeover = false) =>
    db.query("select public.cloud_acquire_editor_session($1,$2)", [
      id,
      takeover,
    ]);
  async function rpc(name: string, args: unknown[]) {
    const result = await db.query<{ value: unknown }>(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`,
      args
    );
    return result.rows[0]!.value;
  }
  const ask = (id = second, token = request) =>
    rpc("cloud_request_editor_session", [id, token]);
  const poll = (id: string, token: string | null = null) =>
    rpc("cloud_poll_editor_request", [id, token]);
  const decide = (allow: boolean, id = first) =>
    rpc("cloud_decide_editor_request", [id, request, allow]);

  it("preserves existing workspace, history, audit, admin and live lease when installed", () => {
    expect(preserved).toBe(true);
  });

  it("blocks forced takeover even when an older client passes true", async () => {
    await expect(acquire(second, true)).rejects.toThrow("SESSION_ACTIVE");
    await rpc("cloud_touch_editor_session", [first]);
  });

  it("keeps the first editor active after rejection and reports rejection to the applicant", async () => {
    expect(await ask()).toMatchObject({ id: request, status: "pending" });
    expect(await poll(first)).toMatchObject({ id: request, status: "pending" });
    await decide(false);
    expect(await poll(second, request)).toMatchObject({ status: "rejected" });
    await rpc("cloud_touch_editor_session", [first]);
    await expect(acquire(second)).rejects.toThrow("SESSION_ACTIVE");
  });

  it("only lets the current holder approve and rejects old writes after handoff", async () => {
    await ask();
    await expect(decide(true, second)).rejects.toThrow("SESSION_EXPIRED");
    await expect(poll(third, request)).rejects.toThrow(
      "SESSION_REQUEST_INVALID"
    );
    await decide(true);
    expect(await poll(second, request)).toMatchObject({ status: "approved" });
    await rpc("cloud_touch_editor_session", [second]);
    await expect(rpc("cloud_touch_editor_session", [first])).rejects.toThrow(
      "SESSION_EXPIRED"
    );
    await expect(
      rpc("cloud_save_workspace_locked", [0, cloudModel(), first])
    ).rejects.toThrow("SESSION_EXPIRED");
    await expect(
      rpc("cloud_restore_workspace_version_locked", [0, 1, first])
    ).rejects.toThrow("SESSION_EXPIRED");
    await expect(
      rpc("cloud_publish_schedule_locked", [0, "A", first])
    ).rejects.toThrow("SESSION_EXPIRED");
    await expect(
      rpc("cloud_save_workspace", [0, cloudModel()])
    ).rejects.toThrow("SESSION_REQUIRED");
  });

  it("does not turn request expiry into permission and rejects a late approval", async () => {
    await ask();
    await db.exec(
      "reset role; update public.autoschedule_editor_requests set expires_at = now() - interval '1 second'; set role authenticated;"
    );
    expect(await poll(second, request)).toMatchObject({ status: "expired" });
    await expect(decide(true)).rejects.toThrow("SESSION_REQUEST_CLOSED");
    await expect(acquire(second, true)).rejects.toThrow("SESSION_ACTIVE");
    await rpc("cloud_touch_editor_session", [first]);
  });

  it("cancels an applicant request and makes a late decision harmless", async () => {
    await ask();
    await rpc("cloud_cancel_editor_request", [second, request]);
    expect(await poll(second, request)).toMatchObject({ status: "cancelled" });
    await expect(decide(true)).rejects.toThrow("SESSION_REQUEST_CLOSED");
    await rpc("cloud_touch_editor_session", [first]);
  });

  it("is idempotent and allows only one pending applicant", async () => {
    const original = await ask();
    expect(await ask()).toEqual(original);
    await expect(ask(third, "another-request-123456")).rejects.toThrow(
      "SESSION_REQUEST_BUSY"
    );
    await decide(false);
    expect(await ask(third, "another-request-123456")).toMatchObject({
      status: "pending",
    });
    expect(await poll(second, request)).toMatchObject({ status: "rejected" });
  });

  it("does not silently transfer an unanswered request when the holder lease expires", async () => {
    await ask();
    await db.exec(
      "reset role; update public.autoschedule_editor_sessions set expires_at = now() - interval '1 second'; set role authenticated;"
    );
    expect(await poll(second, request)).toMatchObject({ status: "expired" });
    await expect(decide(true)).rejects.toThrow("SESSION_EXPIRED");
    await acquire(third);
    await expect(acquire(second)).rejects.toThrow("SESSION_ACTIVE");
  });

  it("protects requests from direct access and anonymous calls", async () => {
    await ask();
    await expect(
      db.query("select * from public.autoschedule_editor_requests")
    ).rejects.toThrow();
    await db.exec("reset role; set role anon;");
    await expect(ask()).rejects.toThrow();
    await expect(poll(first)).rejects.toThrow();
    await expect(decide(true)).rejects.toThrow();
  });

  it("keeps CAS, publish, history restore and old release protection after approval", async () => {
    const model = JSON.stringify(publishableCloudModel());
    expect(await rpc("cloud_save_workspace_locked", [0, model, first])).toBe(1);
    expect(await rpc("cloud_save_workspace_locked", [1, model, first])).toBe(2);
    await ask();
    await decide(true);
    await rpc("cloud_release_editor_session", [first]);
    await rpc("cloud_touch_editor_session", [second]);
    await expect(
      rpc("cloud_save_workspace_locked", [1, model, second])
    ).rejects.toThrow("WORKSPACE_CONFLICT");
    expect(
      await rpc("cloud_publish_schedule_locked", [2, "A", second])
    ).toMatchObject({ token: expect.any(String) });
    // Read the actual version id through the same public list RPC as the page.
    const list = (await rpc("cloud_list_workspace_versions", [])) as Array<{
      id: string;
    }>;
    expect(list).toHaveLength(1);
    expect(
      await rpc("cloud_restore_workspace_version_locked", [
        2,
        list[0]!.id,
        second,
      ])
    ).toBe(3);
  });
});
