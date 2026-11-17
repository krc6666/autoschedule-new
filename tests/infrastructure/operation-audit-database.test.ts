import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudFixture, cloudModel, MemoryCloudStorage } from "../helpers/cloud";
import * as XLSX from "xlsx-js-style";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { CloudWorkspace } from "../../src/app/cloud-workspace";
import {
  createBrowserCloudPersistence,
  readCloudRecoveryFile,
} from "../../src/infrastructure/cloud-recovery-store";

describe("cloud modification audit through actual workspace RPC", () => {
  let db: PGlite;
  const admin = "00000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      insert into auth.users values ('${admin}', 'audit@example.invalid');
    `);
    for (const path of [
      "supabase/migrations/202611150001_cloud_workspace.sql",
      "supabase/migrations/202611150002_operation_audit.sql",
      "supabase/migrations/202611170001_workspace_versions.sql",
    ])
      await db.exec(readFileSync(path, "utf8"));
    await db.query("insert into public.autoschedule_admin values(true, $1)", [
      admin,
    ]);
  }, 30000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec(
      "reset role; truncate public.schedule_versions; truncate public.autoschedule_audit_entries cascade; truncate public.autoschedule_workspace;"
    );
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
  });
  const save = (version: number, model = cloudModel()) =>
    db.query("select public.cloud_save_workspace($1, $2::jsonb)", [
      version,
      JSON.stringify(model),
    ]);
  async function list(cursor: string | null = null) {
    return (
      await db.query<{
        data: {
          entries: Array<{
            id: string;
            actor: string;
            version: number;
            changeCount: number;
          }>;
          nextCursor: string | null;
        };
      }>("select public.cloud_list_audit($1::bigint) as data", [cursor])
    ).rows[0]!.data;
  }
  async function details(id: string, cursor = 0) {
    return (
      await db.query<{
        data: {
          changes: Array<{
            index: number;
            scope: string;
            area: string;
            key: string;
            operation: string;
            before: unknown;
            after: unknown;
          }>;
          nextCursor: number | null;
          staffLabels: unknown;
        };
      }>("select public.cloud_audit_details($1::bigint, $2::integer) as data", [
        id,
        cursor,
      ])
    ).rows[0]!.data;
  }

  it("records account and exact A/B/shared changes once, without duplicate root projections", async () => {
    const model = cloudModel();
    await save(0, model);
    model.groups.A.staff[0]!.name = "示例乙";
    model.staff[0]!.name = "示例乙";
    model.groups.B.settings.maxDailyHours = 9;
    model.shared.templates[0]!.remark = "共享修改";
    await save(1, model);
    const page = await list();
    expect(page.entries[0]).toMatchObject({
      actor: "audit@example.invalid",
      version: 2,
      changeCount: 3,
    });
    const data = await details(page.entries[0]!.id);
    expect(data.changes.map((c) => [c.scope, c.area])).toEqual([
      ["A", "staff"],
      ["B", "settings"],
      ["shared", "templates"],
    ]);
    expect(data.changes[0]!.after).toMatchObject({ name: "示例乙" });
    expect(data.changes[0]!.before).not.toMatchObject({ name: "示例乙" });
    expect(data.changes[1]).toMatchObject({
      key: "maxDailyHours",
      before: 12,
      after: 9,
    });
  });

  it("ignores reads, active-group/root/updatedAt changes and identical saves; retains CAS version contract", async () => {
    const model = cloudModel();
    await save(0, model);
    model.updatedAt = "2026-11-15T10:00:00Z";
    model.activeGroupId = "B";
    model.groups.A.scheduleRuleFingerprint = "technical-only";
    model.groups.A.schedulePolicyStale = !model.groups.A.schedulePolicyStale;
    await save(1, model);
    await db.query("select public.cloud_load_workspace()");
    await list();
    expect((await list()).entries).toHaveLength(1);
    await expect(save(1, model)).rejects.toThrow("WORKSPACE_CONFLICT");
    expect((await list()).entries).toHaveLength(1);
  });

  it("records date-keyed rosters, half rest, count corrections and shared weekly plans", async () => {
    const model = cloudModel();
    await save(0, model);
    const staffId = model.groups.A.staff[0]!.id;
    model.groups.A.dutyRosterOverrides = [
      {
        date: "2026-11-18",
        dutyStaffId: staffId,
        cxPreflightStaffId: null,
        standbyStaffIds: [null, null],
      },
    ];
    model.groups.A.halfRestSelections = [
      { date: "2026-11-18", modes: { [staffId]: "early-finish" } },
    ];
    model.groups.A.latePriorityFrequencyAdjustments = [
      {
        month: "2026-11",
        staffId,
        flightNo: "CX931",
        kind: "supervisor",
        delta: 0,
      },
    ];
    model.shared.weeklyFlightPlans = [{ weekday: 3, flightNos: ["CX931"] }];
    await save(1, model);
    const page = await list();
    const changes = (await details(page.entries[0]!.id)).changes;
    expect(changes).toContainEqual(
      expect.objectContaining({
        area: "dutyRosterOverrides",
        key: "2026-11-18",
        after: expect.objectContaining({ dutyStaffId: staffId }),
      })
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ area: "halfRestSelections", key: "2026-11-18" })
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        area: "latePriorityFrequencyAdjustments",
        after: expect.objectContaining({ delta: 0 }),
      })
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        scope: "shared",
        area: "weeklyFlightPlans",
        key: "3",
      })
    );
    const labels = (await details(page.entries[0]!.id)).staffLabels;
    expect(JSON.stringify(labels)).toContain(model.groups.A.staff[0]!.name);
  });

  it("starts without backfilling old workspaces and preserves data while applying the additive migration", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(`create role anon; create role authenticated; create schema auth;
        create table auth.users(id uuid primary key, email text);
        create function auth.uid() returns uuid language sql stable as $$ select '${admin}'::uuid $$;
        insert into auth.users values ('${admin}', 'existing@example.invalid');`);
      await isolated.exec(
        readFileSync(
          "supabase/migrations/202611150001_cloud_workspace.sql",
          "utf8"
        )
      );
      await isolated.query(
        "insert into public.autoschedule_admin values(true, $1)",
        [admin]
      );
      const model = cloudModel();
      await isolated.query("select public.cloud_save_workspace(0, $1::jsonb)", [
        JSON.stringify(model),
      ]);
      await isolated.exec(
        readFileSync(
          "supabase/migrations/202611150002_operation_audit.sql",
          "utf8"
        )
      );
      const stored = (
        await isolated.query<{ version: number; model: unknown }>(
          "select version,model from public.autoschedule_workspace"
        )
      ).rows[0]!;
      expect(stored).toEqual({ version: 1, model });
      expect(
        (
          await isolated.query<{ n: number }>(
            "select count(*)::integer n from public.autoschedule_audit_entries"
          )
        ).rows[0]!.n
      ).toBe(0);
      model.groups.A.staff[0]!.remark = "first audited edit";
      await isolated.query("select public.cloud_save_workspace(1, $1::jsonb)", [
        JSON.stringify(model),
      ]);
      expect(
        (
          await isolated.query<{ n: number }>(
            "select count(*)::integer n from public.autoschedule_audit_entries"
          )
        ).rows[0]!.n
      ).toBe(1);
    } finally {
      await isolated.close();
    }
  });

  it("records restored/deleted entities and qualifications without replacing previous audit", async () => {
    const model = cloudModel();
    await save(0, model);
    const prior = (await list()).entries[0]!.id;
    const removed = model.groups.A.staff.pop()!;
    model.groups.A.positionRules[0]!.qualifiedStaffIds = [];
    await save(1, model);
    const entry = (await list()).entries[0]!;
    const data = await details(entry.id);
    expect(data.changes).toContainEqual(
      expect.objectContaining({
        area: "staff",
        key: removed.id,
        operation: "delete",
        before: removed,
        after: null,
      })
    );
    expect(data.changes).toContainEqual(
      expect.objectContaining({
        area: "positionRules",
        after: expect.objectContaining({ qualifiedStaffIds: [] }),
      })
    );
    // A complete restore can change business data, but cannot supply audit contents.
    await save(2, cloudModel());
    expect((await list()).entries.map((e) => e.id)).toContain(prior);
  });

  it("retains genuine row order changes and records assignment name/time/date", async () => {
    const model = cloudModel();
    await save(0, model);
    model.groups.A.positionRules.reverse();
    model.groups.A.activeScheduleDate = "2026-11-18";
    model.groups.A.assignments = [
      {
        id: "slot",
        flightId: "flight",
        flightNo: "CX931",
        positionRuleId: null,
        position: "G14",
        staffId: "example",
        staffName: "示例甲",
        startTime: "08:00",
        endTime: "10:00",
        workHours: 2,
        fatiguePoints: 4,
        remark: "",
        manualRemark: "",
        status: "assigned",
      },
    ];
    await save(1, model);
    model.groups.A.assignments[0]!.staffName = "示例乙";
    model.groups.A.assignments[0]!.decisionEvidence = {
      scheduleRunId: "ignored",
      ruleFingerprint: "ignored",
    };
    await save(2, model);
    const entry = (await list()).entries[0]!;
    expect(entry.changeCount).toBe(1);
    expect((await details(entry.id)).changes[0]).toMatchObject({
      scope: "A",
      area: "assignments",
      before: { staffName: "示例甲", date: "2026-11-18" },
      after: {
        staffName: "示例乙",
        position: "G14",
        flightNo: "CX931",
        date: "2026-11-18",
      },
    });
    const previous = (await list()).entries[1]!;
    expect((await details(previous.id)).changes).toContainEqual(
      expect.objectContaining({ area: "positionRules", key: "$order" })
    );
  });

  it("rolls back business state and revision when audit insertion fails", async () => {
    const model = cloudModel();
    await save(0, model);
    await db.exec(
      "alter table public.autoschedule_audit_entries add constraint probe_failure check (workspace_version <> 2)"
    );
    try {
      model.groups.A.staff[0]!.remark = "must rollback";
      await expect(save(1, model)).rejects.toThrow();
      const stored = (
        await db.query<{ version: number; model: typeof model }>(
          "select version,model from public.autoschedule_workspace"
        )
      ).rows[0]!;
      expect(stored.version).toBe(1);
      expect(stored.model.groups.A.staff[0]!.remark).not.toBe("must rollback");
      expect((await list()).entries).toHaveLength(1);
    } finally {
      await db.exec(
        "alter table public.autoschedule_audit_entries drop constraint probe_failure"
      );
    }
  });

  it("keeps real workbook import and JSON recovery on the same audited save path", async () => {
    const model = cloudModel();
    await save(0, model);
    const originalEntry = (await list()).entries[0]!.id;
    const backend = cloudFixture(model).backend;
    backend.save.mockImplementation(async (version, snapshot) => {
      await save(version, snapshot);
      return version + 1;
    });
    const persistence = createBrowserCloudPersistence(
      "audit",
      admin,
      new MemoryCloudStorage()
    );
    const workspace = new CloudWorkspace(
      backend,
      { version: 1, model },
      persistence.recovery
    );
    try {
      const source = cloudModel();
      source.staff[0]!.name = "导入示例人员";
      const bytes = XLSX.write(buildConfigWorkbook(source), {
        bookType: "xlsx",
        type: "buffer",
      });
      const target = structuredClone(workspace.store.getState().model);
      const imported = parseWorkbook(
        XLSX.read(bytes, { type: "buffer" }),
        target.staff
      );
      expect(
        applyWorkbookImport(target, imported, "config").errors
      ).toBeUndefined();
      workspace.store.getState().replaceModel(target);
      await workspace.save();
      const importedEntry = (await list()).entries[0]!;
      const importedChanges = [];
      let cursor = 0;
      do {
        const page = await details(importedEntry.id, cursor);
        importedChanges.push(...page.changes);
        cursor = page.nextCursor ?? 0;
      } while (cursor);
      expect(importedChanges).toHaveLength(importedEntry.changeCount);
      expect(importedChanges).toContainEqual(
        expect.objectContaining({
          area: "staff",
          after: expect.objectContaining({ name: "导入示例人员" }),
        })
      );
      const restored = await readCloudRecoveryFile(
        new File([JSON.stringify({ baseVersion: 1, model })], "recovery.json", {
          type: "application/json",
        })
      );
      workspace.restoreRecovery(restored);
      await workspace.save();
      expect((await list()).entries.map((entry) => entry.id)).toEqual([
        expect.any(String),
        importedEntry.id,
        originalEntry,
      ]);
      expect(workspace.cloudVersion).toBe(3);
      expect(workspace.hasUnsavedChanges).toBe(false);
    } finally {
      workspace.dispose();
    }
  });

  it("paginates headers and details with bounded stable cursors", async () => {
    const model = cloudModel();
    await save(0, model);
    const initial = (await list()).entries[0]!;
    const firstDetails = await details(initial.id);
    expect(firstDetails.changes).toHaveLength(50);
    expect(firstDetails.nextCursor).toBe(50);
    const nextDetails = await details(initial.id, 50);
    expect(nextDetails.changes[0]!.index).toBe(51);
    for (let version = 1; version <= 22; version++) {
      model.groups.A.staff[0]!.remark = `revision-${version}`;
      await save(version, model);
    }
    const first = await list();
    expect(first.entries).toHaveLength(20);
    const second = await list(first.nextCursor);
    expect(second.entries).toHaveLength(3);
    expect(
      new Set([...first.entries, ...second.entries].map((e) => e.id)).size
    ).toBe(23);
    expect(second.nextCursor).toBeNull();
    await expect(details(initial.id, -1)).rejects.toThrow(
      "INVALID_AUDIT_CURSOR"
    );
  });

  it("blocks anonymous/non-admin reads and all direct client writes including forged identities", async () => {
    await save(0);
    for (const role of ["anon", "authenticated"]) {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
        role === "anon" ? "" : "00000000-0000-4000-8000-000000000002",
      ]);
      await db.exec(`set role ${role}`);
      try {
        await expect(list()).rejects.toThrow();
        await expect(details("1")).rejects.toThrow();
        await expect(
          db.query("select * from public.autoschedule_audit_entries")
        ).rejects.toThrow();
        await expect(
          db.query("delete from public.autoschedule_audit_changes")
        ).rejects.toThrow();
      } finally {
        await db.exec("reset role");
      }
    }
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      admin,
    ]);
    await db.exec("set role authenticated");
    try {
      expect((await list()).entries).toHaveLength(1);
      await expect(
        db.query(
          "update public.autoschedule_audit_entries set actor_label='forged'"
        )
      ).rejects.toThrow();
      await expect(
        db.query("delete from public.autoschedule_audit_entries")
      ).rejects.toThrow();
      await expect(
        db.query(
          "insert into public.autoschedule_audit_changes values(1, 999, 'A', 'staff', 'forged', 'add', null, '{}'::jsonb)"
        )
      ).rejects.toThrow();
      await expect(
        db.query("select * from public.cloud_audit_entities('{}'::jsonb)")
      ).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });
});
