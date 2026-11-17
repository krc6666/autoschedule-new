import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudModel } from "../helpers/cloud";

describe("Supabase database authorization and transactions", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      insert into auth.users values ('00000000-0000-4000-8000-000000000001', 'admin@example.invalid');
    `);
    await db.exec(
      readFileSync(
        "supabase/migrations/202611150001_cloud_workspace.sql",
        "utf8"
      )
    );
    await db.exec(
      readFileSync(
        "supabase/migrations/202611150002_operation_audit.sql",
        "utf8"
      )
    );
    await db.exec(
      readFileSync(
        "supabase/migrations/202611170001_workspace_versions.sql",
        "utf8"
      )
    );
    await db.exec(
      `insert into public.autoschedule_admin values (true, '00000000-0000-4000-8000-000000000001');`
    );
  }, 30000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec(
      "reset role; truncate public.schedule_versions; truncate public.autoschedule_audit_entries cascade; truncate public.autoschedule_workspace, public.autoschedule_publications;"
    );
  });

  async function asUser<T>(
    user: "admin" | "other" | "anon",
    action: () => Promise<T>
  ): Promise<T> {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      user === "anon"
        ? ""
        : user === "admin"
          ? "00000000-0000-4000-8000-000000000001"
          : "00000000-0000-4000-8000-000000000002",
    ]);
    await db.exec(`set role ${user === "anon" ? "anon" : "authenticated"}`);
    try {
      return await action();
    } finally {
      await db.exec("reset role");
    }
  }
  async function save(version: number, model = cloudModel()) {
    return db.query<{ version: number }>(
      "select public.cloud_save_workspace($1, $2::jsonb) as version",
      [version, JSON.stringify(model)]
    );
  }

  it("denies anonymous access to workspace and admin membership", async () => {
    await db.exec("set role anon");
    try {
      await expect(
        db.query("select * from public.autoschedule_workspace")
      ).rejects.toThrow();
      await expect(
        db.query("select * from public.autoschedule_admin")
      ).rejects.toThrow();
      await expect(
        db.query("select public.cloud_load_workspace()")
      ).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });

  it("rejects authenticated non-admin users and privilege escalation", async () => {
    await asUser("other", async () => {
      await expect(
        db.query("select public.cloud_load_workspace()")
      ).rejects.toThrow("ADMIN_REQUIRED");
      await expect(save(0)).rejects.toThrow("ADMIN_REQUIRED");
      await expect(
        db.query("select public.cloud_publish_schedule(1, 'A')")
      ).rejects.toThrow("ADMIN_REQUIRED");
      await expect(
        db.query("update public.autoschedule_admin set user_id = auth.uid()")
      ).rejects.toThrow();
    });
    await expect(
      db.query(
        "insert into public.autoschedule_admin values (false, '00000000-0000-4000-8000-000000000001')"
      )
    ).rejects.toThrow();
  });

  it("preserves two groups and shared data; rejects stale first saves and later saves atomically", async () => {
    await asUser("admin", async () => {
      const empty = await db.query<{
        data: { version: number; model: unknown };
      }>("select public.cloud_load_workspace() as data");
      expect(empty.rows[0]!.data).toEqual({ version: 0, model: null });
      const model = cloudModel();
      model.groups.B.staff = [
        { ...model.staff[0]!, id: "B-only", name: "B test" },
      ];
      expect((await save(0, model)).rows[0]!.version).toBe(1);
      await expect(save(0)).rejects.toThrow("WORKSPACE_CONFLICT");
      expect((await save(1, model)).rows[0]!.version).toBe(2);
      await expect(save(1)).rejects.toThrow("WORKSPACE_CONFLICT");
      await expect(
        db.query("select public.cloud_save_workspace(2, '{}'::jsonb)")
      ).rejects.toThrow("INVALID_WORKSPACE");
      const current = await db.query<{
        data: { version: number; model: typeof model };
      }>("select public.cloud_load_workspace() as data");
      expect(current.rows[0]!.data).toEqual({ version: 2, model });
      await expect(
        db.query("update public.autoschedule_workspace set version = 99")
      ).rejects.toThrow();
    });
  });

  it("publishes ONLY saved whitelisted facts; anonymous token cannot enumerate or modify anything", async () => {
    const model = cloudModel();
    model.groups.A.activeScheduleDate = "2026-11-15";
    model.groups.A.assignments = [
      {
        id: "private-id",
        flightId: "flight-private",
        flightNo: "TEST100",
        positionRuleId: null,
        position: "柜台",
        staffId: "private-staff-id",
        staffName: "示例人员",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 4,
        remark: "公开岗位说明",
        manualRemark: "内部备注不公开",
        systemNotes: ["private diagnostic"],
        status: "assigned",
      },
    ];
    const first = await asUser("admin", async () => {
      await save(0, model);
      return db.query<{
        data: { token: string; snapshot: Record<string, unknown> };
      }>("select public.cloud_publish_schedule(1, 'A') as data");
    });
    const publication = first.rows[0]!.data;
    expect(Object.keys(publication.snapshot).sort()).toEqual([
      "date",
      "groupId",
      "publishedAt",
      "rows",
      "schemaVersion",
    ]);
    expect(JSON.stringify(publication.snapshot)).not.toMatch(
      /private|内部|settings|qualifiedStaffIds|history/
    );
    const second = await asUser("admin", async () => {
      await expect(
        db.query("select public.cloud_publish_schedule(0, 'A')")
      ).rejects.toThrow("WORKSPACE_CONFLICT");
      model.groups.A.schedulePolicyStale = true;
      await save(1, model);
      await expect(
        db.query("select public.cloud_publish_schedule(2, 'A')")
      ).rejects.toThrow("SCHEDULE_NOT_PUBLISHABLE");
      const old = await db.query<{ snapshot: unknown }>(
        "select public.cloud_read_publication($1::uuid) as snapshot",
        [publication.token]
      );
      expect(old.rows[0]!.snapshot).toEqual(publication.snapshot);
      model.groups.A.schedulePolicyStale = false;
      model.groups.A.assignments[0]!.staffName = "新的示例人员";
      await save(2, model);
      return db.query<{ data: { token: string; snapshot: unknown } }>(
        "select public.cloud_publish_schedule(3, 'A') as data"
      );
    });
    expect(second.rows[0]!.data.token).toBe(publication.token);
    await asUser("anon", async () => {
      const latest = await db.query<{ snapshot: unknown }>(
        "select public.cloud_read_publication($1::uuid) as snapshot",
        [publication.token]
      );
      expect(latest.rows[0]!.snapshot).toEqual(second.rows[0]!.data.snapshot);
      const missing = await db.query<{ snapshot: unknown }>(
        "select public.cloud_read_publication('00000000-0000-4000-8000-000000000099') as snapshot"
      );
      expect(missing.rows[0]!.snapshot).toBeNull();
      await expect(
        db.query("select * from public.autoschedule_publications")
      ).rejects.toThrow();
      await expect(save(3)).rejects.toThrow();
      await expect(
        db.query("select public.cloud_publish_schedule(3, 'A')")
      ).rejects.toThrow();
    });
  });

  it("keeps RLS denying rows if a table SELECT grant is added accidentally", async () => {
    await asUser("admin", () => save(0));
    await db.exec(
      "grant select on public.autoschedule_workspace to anon, authenticated"
    );
    try {
      for (const user of ["anon", "other", "admin"] as const)
        await asUser(user, async () => {
          expect(
            (await db.query("select * from public.autoschedule_workspace")).rows
          ).toEqual([]);
        });
    } finally {
      await db.exec(
        "revoke select on public.autoschedule_workspace from anon, authenticated"
      );
    }
  });

  it("sets the same administrator idempotently and refuses to replace it with another account", async () => {
    const setup = readFileSync("supabase/set-admin.sql", "utf8");
    const existing = setup.replaceAll(
      "REPLACE_WITH_ADMIN_EMAIL",
      "admin@example.invalid"
    );
    await db.exec(existing);
    await db.exec(existing);
    await db.exec(
      "insert into auth.users values ('00000000-0000-4000-8000-000000000002', 'other@example.invalid')"
    );
    await expect(
      db.exec(
        setup.replaceAll("REPLACE_WITH_ADMIN_EMAIL", "other@example.invalid")
      )
    ).rejects.toThrow("different administrator");
    const members = await db.query<{ user_id: string }>(
      "select user_id from public.autoschedule_admin"
    );
    expect(members.rows).toEqual([
      { user_id: "00000000-0000-4000-8000-000000000001" },
    ]);
  });
});
