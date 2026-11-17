import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudModel } from "../helpers/cloud";

const admin = "00000000-0000-4000-8000-000000000001";

describe("single editor session lease", () => {
  let db: PGlite;
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
      "supabase/migrations/202611150001_cloud_workspace.sql",
      "supabase/migrations/202611150002_operation_audit.sql",
      "supabase/migrations/202611170001_workspace_versions.sql",
      "supabase/migrations/202611170002_single_editor_session.sql",
    ])
      await db.exec(readFileSync(path, "utf8"));
    await db.query("insert into public.autoschedule_admin values(true, $1)", [
      admin,
    ]);
  }, 30000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec(
      "reset role; truncate public.autoschedule_editor_sessions; truncate public.schedule_versions; truncate public.autoschedule_audit_entries cascade; truncate public.autoschedule_workspace, public.autoschedule_publications;"
    );
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
    await db.exec("set role authenticated");
  });

  const acquire = (id: string, takeover = false) =>
    db.query("select public.cloud_acquire_editor_session($1,$2)", [
      id,
      takeover,
    ]);
  const save = (version: number, id: string) =>
    db.query("select public.cloud_save_workspace_locked($1,$2::jsonb,$3)", [
      version,
      JSON.stringify(cloudModel()),
      id,
    ]);

  it("allows one active session, supports takeover, and rejects the old lease", async () => {
    await acquire("session-one-123456");
    await expect(acquire("session-two-123456")).rejects.toThrow(
      "SESSION_ACTIVE"
    );
    await acquire("session-two-123456", true);
    await expect(
      db.query("select public.cloud_touch_editor_session($1)", [
        "session-one-123456",
      ])
    ).rejects.toThrow("SESSION_EXPIRED");
    await expect(save(0, "session-one-123456")).rejects.toThrow(
      "SESSION_EXPIRED"
    );
    await save(0, "session-two-123456");
  });

  it("lets an expired lease be acquired and keeps CAS protection", async () => {
    await acquire("session-one-123456");
    await db.exec("reset role");
    await db.query(
      "update public.autoschedule_editor_sessions set expires_at = now() - interval '1 second'"
    );
    await db.exec("set role authenticated");
    await acquire("session-two-123456");
    await save(0, "session-two-123456");
    await expect(save(0, "session-two-123456")).rejects.toThrow(
      "WORKSPACE_CONFLICT"
    );
  });

  it("does not expose the lease table or allow old write signatures to bypass it", async () => {
    await acquire("session-one-123456");
    await expect(
      db.query("select * from public.autoschedule_editor_sessions")
    ).rejects.toThrow();
    await expect(
      db.query("select public.cloud_save_workspace(0, $1::jsonb)", [
        JSON.stringify(cloudModel()),
      ])
    ).rejects.toThrow("SESSION_REQUIRED");
  });
});
