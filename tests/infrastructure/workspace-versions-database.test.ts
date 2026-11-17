import { readFileSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudModel, publishableCloudModel } from "../helpers/cloud";

const migration = "supabase/migrations/202611170001_workspace_versions.sql";
const admin = "00000000-0000-4000-8000-000000000001";

describe("workspace time machine through actual PostgreSQL writes", () => {
  let db: PGlite;
  let existing: ReturnType<typeof cloudModel>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      insert into auth.users values ('${admin}', 'original@example.invalid');
    `);
    for (const path of [
      "supabase/migrations/202611150001_cloud_workspace.sql",
      "supabase/migrations/202611150002_operation_audit.sql",
    ])
      await db.exec(readFileSync(path, "utf8"));
    await db.query("insert into public.autoschedule_admin values(true, $1)", [
      admin,
    ]);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
    existing = cloudModel();
    await save(0, existing);
    await db.exec(readFileSync(migration, "utf8"));
    const current = await load();
    expect(current).toEqual({ version: 1, model: existing });
    expect(await list()).toEqual([]);
    // Preserve pre-migration data but never attribute it to the installing account.
    await save(1, existing);
    expect((await list())[0]).toMatchObject({ version: 1, actor: null });
  }, 30000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec(
      "reset role; truncate public.schedule_versions; truncate public.autoschedule_audit_entries cascade; truncate public.autoschedule_workspace, public.autoschedule_publications;"
    );
    await db.query(
      "update auth.users set email='original@example.invalid' where id=$1",
      [admin]
    );
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
    await db.exec("set role authenticated");
  });

  function save(version: number, model = cloudModel()) {
    return db.query<{ version: number }>(
      "select public.cloud_save_workspace($1,$2::jsonb) as version",
      [version, JSON.stringify(model)]
    );
  }
  async function load() {
    return (
      await db.query<{ data: { version: number; model: unknown } }>(
        "select public.cloud_load_workspace() as data"
      )
    ).rows[0]!.data;
  }
  async function list() {
    return (
      await db.query<{
        data: Array<{
          id: string;
          version: number;
          actor: string | null;
          createdAt: string;
        }>;
      }>("select public.cloud_list_workspace_versions() as data")
    ).rows[0]!.data;
  }
  async function read(id: string) {
    return (
      await db.query<{ data: unknown }>(
        "select public.cloud_read_workspace_version($1::bigint) as data",
        [id]
      )
    ).rows[0]!.data;
  }
  async function restore(version: number, id: string) {
    return (
      await db.query<{ version: number }>(
        "select public.cloud_restore_workspace_version($1,$2::bigint) as version",
        [version, id]
      )
    ).rows[0]!.version;
  }
  async function owner(sql: string) {
    await db.exec("reset role");
    try {
      return await db.exec(sql);
    } finally {
      await db.exec("set role authenticated");
    }
  }

  it("archives the complete previous JSON, its original server time and original uploader snapshot", async () => {
    const model = cloudModel();
    model.groups.B.staff = [
      { ...model.staff[0]!, id: "B-example", remark: "B previous" },
    ];
    model.shared.templates[0]!.remark = "shared previous";
    await save(0, model);
    expect(await list()).toEqual([]);
    await db.exec("reset role");
    const savedAt = (
      await db.query<{ time: string }>(
        "select updated_at::text time from public.autoschedule_workspace"
      )
    ).rows[0]!.time;
    await db.exec("set role authenticated");
    await owner("update auth.users set email='changed@example.invalid'");
    const next = structuredClone(model);
    next.staff[0]!.remark = next.groups.A.staff[0]!.remark = "A next";
    await save(1, next);
    const entry = (await list())[0]!;
    expect(entry).toMatchObject({
      version: 1,
      actor: "original@example.invalid",
    });
    expect(Number.isFinite(Date.parse(entry.createdAt))).toBe(true);
    expect(Date.parse(entry.createdAt)).toBe(Date.parse(savedAt));
    expect(await read(entry.id)).toEqual(model);
    await save(2, next);
    expect((await list())[0]!.actor).toBe("changed@example.invalid");
    expect((await list())[1]!.actor).toBe("original@example.invalid");
  });

  it("retains exactly the latest20 prior versions, including equal timestamps, and never prunes audit", async () => {
    const model = cloudModel();
    for (let version = 0; version <= 23; version++) {
      model.staff[0]!.remark =
        model.groups.A.staff[0]!.remark = `saved-${version + 1}`;
      await save(version, model);
    }
    const entries = await list();
    expect(entries.map((e) => e.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => 23 - i)
    );
    expect(await read(entries[0]!.id)).toMatchObject({
      groups: {
        A: {
          staff: [
            expect.objectContaining({ remark: "saved-23" }),
            ...model.groups.A.staff.slice(1),
          ],
        },
      },
    });
    await db.exec("reset role");
    const counts = (
      await db.query<{ versions: number; audit: number }>(
        "select (select count(*)::int from public.schedule_versions) versions, (select count(*)::int from public.autoschedule_audit_entries) audit"
      )
    ).rows[0]!;
    expect(counts).toEqual({ versions: 20, audit: 24 });
    await db.exec("set role authenticated");
    await owner(
      "update public.schedule_versions set created_at='2026-11-17T00:00:00Z'"
    );
    expect((await list()).map((e) => e.version)).toEqual(
      entries.map((e) => e.version)
    );
  });

  it("restores atomically using a new version, archives the displaced state, and permits undoing restoration", async () => {
    const original = cloudModel();
    await save(0, original);
    const edited = structuredClone(original);
    edited.staff[0]!.remark = edited.groups.A.staff[0]!.remark =
      "unwanted edit";
    edited.groups.B.staff = [
      { ...edited.staff[0]!, id: "B-example", remark: "B unwanted" },
    ];
    edited.shared.templates[0]!.remark = "shared unwanted";
    await save(1, edited);
    const old = (await list())[0]!;
    await owner("update auth.users set email='restorer@example.invalid'");
    expect(await restore(2, old.id)).toBe(3);
    expect(await load()).toEqual({ version: 3, model: original });
    const displaced = (await list())[0]!;
    expect(displaced.version).toBe(2);
    expect(await read(displaced.id)).toEqual(edited);
    expect(await restore(3, displaced.id)).toBe(4);
    expect(await load()).toEqual({ version: 4, model: edited });
    expect((await list()).find((e) => e.version === 3)!.actor).toBe(
      "restorer@example.invalid"
    );
    expect((await list()).find((e) => e.version === 1)!.actor).toBe(
      "original@example.invalid"
    );
  });

  it("does not replace a published snapshot or its public token when restoring workspace data", async () => {
    const model = publishableCloudModel();
    await save(0, model);
    const published = (
      await db.query<{ data: { token: string; snapshot: unknown } }>(
        "select public.cloud_publish_schedule(1,'A') data"
      )
    ).rows[0]!.data;
    const edited = structuredClone(model);
    edited.staff[0]!.remark = edited.groups.A.staff[0]!.remark = "new edit";
    await save(1, edited);
    await restore(2, (await list())[0]!.id);
    const visible = (
      await db.query<{ snapshot: unknown }>(
        "select public.cloud_read_publication($1::uuid) snapshot",
        [published.token]
      )
    ).rows[0]!.snapshot;
    expect(visible).toEqual(published.snapshot);
    expect((await load()).model).toEqual(model);
  });

  it("rejects stale saves/restores and missing or pruned versions without writing any history", async () => {
    await save(0);
    await save(1);
    const entries = await list();
    await expect(save(1)).rejects.toThrow("WORKSPACE_CONFLICT");
    await expect(restore(1, entries[0]!.id)).rejects.toThrow(
      "WORKSPACE_CONFLICT"
    );
    await expect(restore(2, "999999")).rejects.toThrow("VERSION_NOT_FOUND");
    expect(await list()).toEqual(entries);
    for (let version = 2; version < 23; version++) await save(version);
    const before = await load();
    const retained = await list();
    await expect(restore(23, entries[0]!.id)).rejects.toThrow(
      "VERSION_NOT_FOUND"
    );
    expect(await load()).toEqual(before);
    expect(await list()).toEqual(retained);
  });

  it("accepts only one simultaneous stale-device write and does not invent an extra archive", async () => {
    await save(0);
    const results = await Promise.allSettled([save(1), save(1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await load()).version).toBe(2);
    expect((await list()).map((e) => e.version)).toEqual([1]);
  });

  it.each(["archive", "cleanup", "audit"])(
    "rolls back model, version, archive and cleanup if %s fails",
    async (step) => {
      const model = cloudModel();
      for (let version = 0; version <= 20; version++)
        await save(version, model);
      const before = await list();
      const failure =
        step === "archive"
          ? "alter table public.schedule_versions add constraint probe_failure check(workspace_version<>21)"
          : step === "audit"
            ? "alter table public.autoschedule_audit_entries add constraint probe_failure check(workspace_version<>22)"
            : "create function public.probe_delete_failure() returns trigger language plpgsql as $$ begin raise exception 'cleanup failed'; end $$; create trigger probe_failure before delete on public.schedule_versions for each row execute function public.probe_delete_failure()";
      await owner(failure);
      try {
        model.staff[0]!.remark = model.groups.A.staff[0]!.remark =
          "must rollback";
        await expect(save(21, model)).rejects.toThrow();
        expect((await load()).version).toBe(21);
        expect((await load()).model).not.toEqual(model);
        expect(await list()).toEqual(before);
      } finally {
        await owner(
          step === "cleanup"
            ? "drop trigger probe_failure on public.schedule_versions; drop function public.probe_delete_failure()"
            : `alter table public.${step === "archive" ? "schedule_versions" : "autoschedule_audit_entries"} drop constraint probe_failure`
        );
      }
    }
  );

  it("denies anonymous/non-admin RPCs, direct reads/writes, forged uploader and direct cleanup", async () => {
    await save(0);
    await save(1);
    const id = (await list())[0]!.id;
    for (const sql of [
      "select * from public.schedule_versions",
      "delete from public.schedule_versions",
      "update public.schedule_versions set uploader_label='forged'",
      "update public.autoschedule_workspace set uploader_label='forged'",
      "select public.cloud_capture_workspace_version()",
    ])
      await expect(db.query(sql)).rejects.toThrow();
    for (const user of ["", "00000000-0000-4000-8000-000000000002"]) {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        user,
      ]);
      await db.exec(`set role ${user ? "authenticated" : "anon"}`);
      for (const sql of [
        "select public.cloud_list_workspace_versions()",
        `select public.cloud_read_workspace_version(${id})`,
        `select public.cloud_restore_workspace_version(2,${id})`,
      ])
        await expect(db.query(sql)).rejects.toThrow();
    }
  });

  it("produces an independently checked final database artifact", async () => {
    const model = cloudModel();
    for (let version = 0; version < 22; version++) {
      model.staff[0]!.remark =
        model.groups.A.staff[0]!.remark = `artifact-${version + 1}`;
      await save(version, model);
    }
    const target = (await list()).find((e) => e.version === 7)!;
    await restore(22, target.id);
    await db.exec("reset role");
    const result = (
      await db.query<{
        version: number;
        remark: string;
        versions: number;
        oldest: number;
        newest: number;
        uploaders: string[];
        audits: number;
      }>(`
      select w.version, w.model->'groups'->'A'->'staff'->0->>'remark' remark,
        (select count(*)::int from public.schedule_versions) versions,
        (select min(workspace_version)::int from public.schedule_versions) oldest,
        (select max(workspace_version)::int from public.schedule_versions) newest,
        (select array_agg(distinct uploader_label) from public.schedule_versions) uploaders,
        (select count(*)::int from public.autoschedule_audit_entries) audits
      from public.autoschedule_workspace w`)
    ).rows[0]!;
    expect(result).toEqual({
      version: 23,
      remark: "artifact-7",
      versions: 20,
      oldest: 3,
      newest: 22,
      uploaders: ["original@example.invalid"],
      audits: 23,
    });
    writeFileSync(
      "docs/acceptance/evidence/2026-11-17-versions-final-database.json",
      JSON.stringify(
        {
          environment:
            "PGlite PostgreSQL, synthetic Auth and data; not real Supabase",
          ...result,
        },
        null,
        2
      ) + "\n"
    );
  });
});
