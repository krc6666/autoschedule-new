import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/check-acceptance.mjs", import.meta.url)
);
const roots: string[] = [];
const proofPath = "docs/acceptance/evidence/proof.txt";
const proof = "最终产物：甲 3 个航班，乙 3 个航班，差值 0。\n";

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, "utf8");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "autoschedule-acceptance-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  write(root, "src/example.ts", "export const flightGap = 1;\n");
  write(root, proofPath, proof);
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function record(root: string, taskId = "example") {
  const snapshot = run(root, "--fingerprint");
  expect(snapshot.status, snapshot.output).toBe(0);
  const evidence = [
    {
      path: proofPath,
      sha256: createHash("sha256").update(proof).digest("hex"),
      summary: "按人员与不同航班集合独立核对，得到 3/3。",
    },
  ];
  const verified = () => ({
    status: "verified",
    reason: "已验证对应场景。",
    evidence,
  });
  return {
    schemaVersion: 1,
    taskId,
    title: "航班均衡验收",
    startedFrom: "a".repeat(40),
    expectation: {
      example: "同一工作班原为 4/2。",
      expected: "最终差值最多 1。",
      unchanged: "保留资质和时间规则。",
      fallback: "不能合法调整时按已确认规则留空。",
    },
    testedVersion: snapshot.output.trim(),
    checks: {
      reproduction: verified(),
      normalPath: verified(),
      alternatePath: verified(),
      postProcessing: verified(),
      finalGuard: verified(),
      unchanged: verified(),
      finalArtifact: verified(),
    },
    answers: {
      originalFailure: "用 4/2 失败场景固定原问题。",
      laterChanges: "覆盖会换人，验证最终拒绝改坏的结果。",
      finalArtifact: "当前版本的独立核对记录显示 3/3。",
    },
    review: {
      missedScope: "复核了普通、大候选、后置和最终产物路径。",
      rootCause: "原问题是只验证局部统计，没有验证最终 assignments。",
      earlyDetection: "改前列出路径，改后用最终产物独立重算。",
    },
  };
}

function save(root: string, value: { taskId: string }) {
  write(
    root,
    `docs/acceptance/${value.taskId}.json`,
    `${JSON.stringify(value, null, 2)}\n`
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only remove the exact temporary directories created by this test.
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("autoschedule-acceptance-")
    ) {
      throw new Error(
        "Refusing to remove a directory outside the acceptance test fixtures"
      );
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("acceptance release gate", () => {
  it("rejects a repository with no task records", () => {
    const result = run(fixture());
    expect(result.status).toBe(1);
    expect(result.output).toContain("缺少验收记录");
  });

  it("accepts complete evidence for the actual current files", () => {
    const root = fixture();
    save(root, record(root));
    expect(run(root)).toMatchObject({ status: 0 });
  });

  it("rejects unverified final output even when another current task passes", () => {
    const root = fixture();
    const pending = record(root, "pending");
    pending.checks.finalArtifact.status = "unverified";
    save(root, pending);
    save(root, record(root, "complete"));
    expect(run(root).output).toContain("pending / finalArtifact");
    expect(run(root).status).toBe(1);
    expect(run(root, "--record", "complete").status).toBe(0);
  });

  it("rejects a formerly valid record after a later source rewrite", () => {
    const root = fixture();
    save(root, record(root));
    expect(run(root).status).toBe(0);
    write(root, "src/example.ts", "export const flightGap = 2;\n");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("版本已过期");
  });

  it("also catches changed build settings and newly added source files", () => {
    const root = fixture();
    save(root, record(root));
    write(root, "package.json", '{"scripts":{"build":"changed"}}\n');
    expect(run(root).status).toBe(1);
    save(root, record(root));
    write(root, "src/later.ts", "export const later = true;\n");
    expect(run(root).status).toBe(1);
  });

  it("rejects evidence altered after a successful check", () => {
    const root = fixture();
    save(root, record(root));
    expect(run(root).status).toBe(0);
    write(root, proofPath, "最终产物：甲 4 个航班，乙 2 个航班。\n");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("证据内容已改变");
  });

  it("rejects missing evidence and verified checks without evidence", () => {
    const root = fixture();
    const value = record(root);
    value.checks.finalArtifact.evidence = [];
    save(root, value);
    expect(run(root).status).toBe(1);
    value.checks.finalArtifact.evidence = value.checks.normalPath.evidence;
    save(root, value);
    rmSync(join(root, proofPath));
    expect(run(root).output).toContain("证据文件不存在");
    expect(run(root).status).toBe(1);
  });

  it("rejects omitted required checks and empty delivery answers", () => {
    const root = fixture();
    const value = record(root);
    const omitted = {
      ...value,
      checks: Object.fromEntries(
        Object.entries(value.checks).filter(([id]) => id !== "alternatePath")
      ),
    };
    save(root, omitted);
    expect(run(root).status).toBe(1);
    value.answers.laterChanges = "";
    save(root, value);
    expect(run(root).status).toBe(1);
  });

  it("requires a completed delivery review for missed scope, root cause, and early detection", () => {
    const root = fixture();
    const value = record(root);
    value.review.rootCause = "";
    save(root, value);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("交付复盘 rootCause 尚未回答");
  });

  it("requires reasons for inapplicable paths and cannot exempt final output", () => {
    const root = fixture();
    const value = record(root);
    value.checks.postProcessing = {
      status: "not_applicable",
      reason: "",
      evidence: [],
    };
    save(root, value);
    expect(run(root).status).toBe(1);
    value.checks.postProcessing.reason = "此任务是单次文件解析，没有后续写入。";
    save(root, value);
    expect(run(root).status).toBe(0);
    value.checks.finalArtifact = {
      status: "not_applicable",
      reason: "没有验收。",
      evidence: [],
    };
    save(root, value);
    expect(run(root).status).toBe(1);
  });

  it("rejects malformed JSON and evidence outside the repository evidence folder", () => {
    const root = fixture();
    write(root, "docs/acceptance/broken.json", "{");
    expect(run(root).status).toBe(1);
    rmSync(join(root, "docs/acceptance/broken.json"));
    const value = record(root);
    value.checks.finalArtifact.evidence = [
      {
        path: "../../outside.txt",
        sha256: "a".repeat(64),
        summary: "不允许读取外部文件。",
      },
    ];
    save(root, value);
    expect(run(root).status).toBe(1);
  });

  it("keeps completed historical records while requiring current-version evidence", () => {
    const root = fixture();
    save(root, record(root, "previous"));
    write(root, "src/example.ts", "export const flightGap = 0;\n");
    expect(run(root).status).toBe(1);
    save(root, record(root, "current"));
    expect(run(root).status).toBe(0);
    expect(run(root, "--record", "previous").status).toBe(1);
  });

  it("normalizes Git line endings and separately hashes evidence consistently", () => {
    const root = fixture();
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root });
    const before = run(root, "--fingerprint").output;
    write(root, "src/example.ts", "export const flightGap = 1;\r\n");
    expect(run(root, "--fingerprint").output).toBe(before);
    write(root, proofPath, proof.replaceAll("\n", "\r\n"));
    expect(run(root, "--evidence-hash", proofPath).output.trim()).toBe(
      createHash("sha256").update(proof).digest("hex")
    );
  });

  it("does not invalidate code evidence for record updates or local cursor files", () => {
    const root = fixture();
    const before = run(root, "--fingerprint").output;
    save(root, record(root));
    write(root, ".cursor/local.txt", "本地编辑器配置\n");
    expect(run(root, "--fingerprint").output).toBe(before);
  });

  it("initializes an incomplete record without silently approving it or overwriting it", () => {
    const root = fixture();
    expect(run(root, "--init", "new-task").status).toBe(0);
    const initial = JSON.parse(
      readFileSync(join(root, "docs/acceptance/new-task.json"), "utf8")
    );
    expect(initial.checks.finalArtifact.status).toBe("unverified");
    expect(initial.review.earlyDetection).toBe("");
    expect(initial.testedVersion).toBe("");
    expect(run(root).status).toBe(1);
    expect(run(root, "--init", "new-task").status).toBe(1);
  });

  it("runs the same release checker before Pages artifacts are uploaded", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../../.github/workflows/deploy-pages.yml", import.meta.url)
      ),
      "utf8"
    );
    const gate = workflow.indexOf("node scripts/check-acceptance.mjs");
    expect(gate).toBeGreaterThan(workflow.indexOf("npm run verify"));
    expect(gate).toBeLessThan(
      workflow.indexOf("actions/upload-pages-artifact")
    );
    expect(workflow).not.toContain("continue-on-error: true");
  });
});
