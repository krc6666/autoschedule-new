import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";

describe("航班档案云端旧页面保护、CAS与版本恢复", () => {
  let db: PGlite;
  const admin = "00000000-0000-4000-8000-000000000001",
    session = "identity-test-session";
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      insert into auth.users values ('${admin}','identity@example.invalid');`);
    for (const path of [
      "202611150001_cloud_workspace.sql",
      "202611150002_operation_audit.sql",
      "202611170001_workspace_versions.sql",
      "202611170002_single_editor_session.sql",
      "202611180001_editor_session_approval.sql",
      "202611200001_flight_identities.sql",
    ])
      await db.exec(readFileSync(`supabase/migrations/${path}`, "utf8"));
    await db.query("insert into public.autoschedule_admin values(true,$1)", [
      admin,
    ]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    await db.query("select public.cloud_acquire_editor_session($1,false)", [
      session,
    ]);
  }, 30000);
  afterAll(async () => db?.close());
  const save = (version: number, model: unknown) =>
    db.query(
      "select public.cloud_save_workspace_locked($1,$2::jsonb,$3) as version",
      [version, JSON.stringify(model), session]
    );
  it("旧格式可首次迁移，归并后拒绝旧页面漏字段，原工作区/备份/审计原子保留", async () => {
    const old = createDefaultState();
    delete old.shared.flightIdentities;
    delete old.shared.flightIdentitySchemaVersion;
    await save(0, old);
    const model = createDefaultState();
    model.shared.flightIdentities = [
      {
        id: "service",
        displayName: "CX937",
        aliases: [
          { flightNo: "CX937早" },
          { flightNo: "CX937晚" },
          { flightNo: "CX999" },
        ],
      },
    ];
    await save(1, model);
    const snapshot = () =>
      db.query(
        "select model,version,(select count(*) from public.schedule_versions) as backups,(select count(*) from public.autoschedule_audit_entries) as audits from public.autoschedule_workspace"
      );
    const before = await snapshot();
    await expect(save(2, old)).rejects.toThrow(
      "FLIGHT_IDENTITY_CLIENT_UPGRADE_REQUIRED"
    );
    expect((await snapshot()).rows).toEqual(before.rows);
    const broken = structuredClone(model);
    broken.shared.flightIdentities!.push({
      id: "second",
      displayName: "另一个",
      aliases: [{ flightNo: "CX999" }],
    });
    await expect(save(2, broken)).rejects.toThrow(
      "FLIGHT_IDENTITY_DATE_OVERLAP"
    );
    expect((await snapshot()).rows).toEqual(before.rows);
    await expect(save(1, model)).rejects.toThrow("WORKSPACE_CONFLICT");
    const audit = await db.query<{ area: string }>(
      "select area from public.autoschedule_audit_changes where area='flightIdentities'"
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const change of [
      (m: typeof model) => {
        m.shared.flightIdentities![0]!.aliases[0]!.flightNo = " @MISSING ";
      },
      (m: typeof model) => {
        m.shared.flightIdentities![0]!.displayName = "@MISSING";
      },
      (m: typeof model) => {
        m.shared.flightIdentities!.push({
          id: "same-label",
          displayName: "CX 937",
          aliases: [{ flightNo: "ZZ100" }],
        });
      },
      (m: typeof model) => {
        m.shared.flightIdentities![0]!.aliases.push({ flightNo: "123" });
        Object.assign(m.shared.flightIdentities![0]!.aliases[0]!, {
          positionSourceFlightNo: 123,
        });
      },
      (m: typeof model) => {
        m.groups.B.settings.latePriorityFlightNumbers = ["@MISSING"];
      },
      (m: typeof model) => {
        m.groups.B.settings.sameFlightStaffExclusions = [
          { id: "broken", enabled: true, flightNo: "@MISSING", staffIds: [] },
        ];
      },
    ]) {
      const invalid = structuredClone(model);
      change(invalid);
      await expect(save(2, invalid)).rejects.toThrow();
      expect((await snapshot()).rows).toEqual(before.rows);
    }
  });
  it("恢复旧备份明确升为独立名称，恢复新备份保留目录，并继续要求编辑会话", async () => {
    const backup = await db.query<{ id: number }>(
      "select id from public.schedule_versions where workspace_version=1"
    );
    await expect(
      db.query(
        "select public.cloud_restore_workspace_version_locked(2,$1,'wrong-session')",
        [backup.rows[0]!.id]
      )
    ).rejects.toThrow();
    await db.query(
      "select public.cloud_restore_workspace_version_locked(2,$1,$2)",
      [backup.rows[0]!.id, session]
    );
    const restored = await db.query<{
      model: ReturnType<typeof createDefaultState>;
      version: number;
    }>("select model,version from public.autoschedule_workspace");
    expect(restored.rows[0]!.model.shared.flightIdentities).toEqual([]);
    expect(restored.rows[0]!.model.shared.flightIdentitySchemaVersion).toBe(1);
    const newBackup = await db.query<{ id: number }>(
      "select id from public.schedule_versions where workspace_version=2"
    );
    await db.query(
      "select public.cloud_restore_workspace_version_locked(3,$1,$2)",
      [newBackup.rows[0]!.id, session]
    );
    const next = await db.query<{
      model: ReturnType<typeof createDefaultState>;
    }>("select model from public.autoschedule_workspace");
    expect(next.rows[0]!.model.shared.flightIdentities![0]!.id).toBe("service");
    const privileges = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('anon','public.cloud_validate_flight_identity_write()','execute') as allowed"
    );
    expect(privileges.rows[0]!.allowed).toBe(false);
  });
});
