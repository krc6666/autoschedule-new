import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const RECORDS = "docs/acceptance";
const EVIDENCE = `${RECORDS}/evidence/`;
const CHECK_IDS = [
  "reproduction",
  "normalPath",
  "alternatePath",
  "postProcessing",
  "finalGuard",
  "unchanged",
  "finalArtifact",
];
const REQUIRED = new Set([
  "reproduction",
  "normalPath",
  "unchanged",
  "finalArtifact",
]);
const ANSWERS = ["originalFailure", "laterChanges", "finalArtifact"];
const REVIEW = ["missedScope", "rootCause", "earlyDetection"];
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function git(root, args, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(
    result.status === 0,
    `无法读取 Git 文件状态：${result.stderr || result.error?.message || args.join(" ")}`
  );
  return result.stdout.trimEnd();
}

// Hash canonical Git blobs, so Windows CRLF and Linux LF checkouts agree.
function fingerprint(root) {
  const files = [
    ...new Set(
      git(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]).split("\0")
    ),
  ]
    .filter(
      (path) =>
        path &&
        !path.startsWith(".cursor/") &&
        !path.startsWith(EVIDENCE) &&
        !new RegExp(`^${RECORDS}/[^/]+\\.json$`).test(path) &&
        existsSync(join(root, path))
    )
    .sort();
  assert(files.length > 0, "没有可绑定验收证据的受检文件");
  assert(
    files.every((path) => !/[\u0000-\u001f]/.test(path)),
    "受检文件名含不支持的控制字符"
  );
  const blobs = git(
    root,
    ["hash-object", "--stdin-paths"],
    `${files.map((path) => JSON.stringify(path)).join("\n")}\n`
  ).split(/\r?\n/);
  assert(blobs.length === files.length, "无法完整计算受检文件版本");
  return createHash("sha256")
    .update(files.map((path, i) => `${path}\0${blobs[i]}\n`).join(""))
    .digest("hex");
}

function evidenceFile(root, path) {
  assert(
    text(path) &&
      path.startsWith(EVIDENCE) &&
      !path.includes("\\") &&
      !isAbsolute(path),
    "证据必须位于 docs/acceptance/evidence/ 内"
  );
  assert(
    !path
      .split("/")
      .some((part) => part === ".." || part === "." || part === ""),
    "证据路径不能跨出证据目录"
  );
  const file = resolve(root, path);
  assert(existsSync(file), `证据文件不存在：${path}`);
  const resolved = relative(realpathSync(root), realpathSync(file));
  assert(
    resolved &&
      !resolved.startsWith("..") &&
      !isAbsolute(resolved) &&
      lstatSync(file).isFile(),
    `证据不是仓库内的普通文件：${path}`
  );
  return file;
}

function evidenceHash(root, path) {
  const file = evidenceFile(root, path);
  let content = readFileSync(file);
  if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
    content = Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"));
  }
  return createHash("sha256").update(content).digest("hex");
}

function validateRecord(root, file) {
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`验收记录不是合法 JSON：${relative(root, file)}`);
  }
  const id = record?.taskId;
  assert(
    object(record) && record.schemaVersion === 1,
    "验收记录 schemaVersion 必须为 1"
  );
  assert(
    text(id) &&
      /^[a-z0-9][a-z0-9-]{0,79}$/.test(id) &&
      file === join(root, RECORDS, `${id}.json`),
    "任务编号必须与记录文件名一致"
  );
  assert(
    text(record.title) && text(record.startedFrom),
    `${id}：缺少任务标题或开始版本`
  );
  assert(object(record.expectation), `${id}：缺少改前期望`);
  for (const key of ["example", "expected", "unchanged", "fallback"]) {
    assert(text(record.expectation[key]), `${id}：期望缺少 ${key}`);
  }
  assert(object(record.checks), `${id}：缺少逐项验收检查`);
  for (const key of CHECK_IDS) {
    const check = record.checks[key];
    const label = `${id} / ${key}`;
    assert(object(check), `${label}：缺少必查项`);
    assert(text(check.reason), `${label}：必须说明验证结果或不适用原因`);
    assert(
      check.status === "verified" || check.status === "not_applicable",
      `${label}：尚未验收通过（${check.status || "缺少状态"}）`
    );
    if (check.status === "not_applicable") {
      assert(!REQUIRED.has(key), `${label}：该项必须实际验证，不能标记不适用`);
      continue;
    }
    assert(
      Array.isArray(check.evidence) && check.evidence.length > 0,
      `${label}：已验证项必须附证据`
    );
    for (const evidence of check.evidence) {
      assert(
        object(evidence) && text(evidence.summary),
        `${label}：证据缺少结果摘要`
      );
      assert(
        typeof evidence.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(evidence.sha256),
        `${label}：证据缺少合法 SHA-256`
      );
      assert(
        evidenceHash(root, evidence.path) === evidence.sha256,
        `${label}：证据内容已改变：${evidence.path}`
      );
    }
  }
  assert(object(record.answers), `${id}：缺少三个交付回答`);
  for (const key of ANSWERS)
    assert(text(record.answers[key]), `${id}：交付问题 ${key} 尚未回答`);
  assert(object(record.review), `${id}：缺少交付后复盘`);
  for (const key of REVIEW)
    assert(text(record.review[key]), `${id}：交付复盘 ${key} 尚未回答`);
  assert(
    typeof record.testedVersion === "string" &&
      /^[a-f0-9]{64}$/.test(record.testedVersion),
    `${id}：缺少所验版本指纹`
  );
  return record;
}

function taskPath(root, id) {
  assert(
    typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id),
    "任务编号只能含小写字母、数字和连字符，最多 80 字符"
  );
  return join(root, RECORDS, `${id}.json`);
}

function initialize(root, id) {
  const file = taskPath(root, id);
  assert(!existsSync(file), `验收记录已存在，不能覆盖：${id}`);
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const record = {
    schemaVersion: 1,
    taskId: id,
    title: "",
    startedFrom: head.status === 0 ? head.stdout.trim() : "unborn",
    expectation: { example: "", expected: "", unchanged: "", fallback: "" },
    testedVersion: "",
    checks: Object.fromEntries(
      CHECK_IDS.map((key) => [
        key,
        { status: "unverified", reason: "", evidence: [] },
      ])
    ),
    answers: Object.fromEntries(ANSWERS.map((key) => [key, ""])),
    review: Object.fromEntries(REVIEW.map((key) => [key, ""])),
  };
  mkdirSync(join(root, RECORDS), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(
    `已创建待验收记录：${relative(root, file)}。先填写期望，再修改实现。`
  );
}

function check(root, selected) {
  const folder = join(root, RECORDS);
  const files = selected
    ? [taskPath(root, selected)]
    : existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(folder, name))
      : [];
  assert(
    files.length > 0 && files.every(existsSync),
    "缺少验收记录：先用 --init 创建当前任务记录"
  );
  const version = fingerprint(root);
  const errors = [];
  const records = [];
  for (const file of files) {
    try {
      records.push(validateRecord(root, file));
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  assert(
    records.some((record) => record.testedVersion === version),
    "版本已过期：没有对应当前受检文件的验收记录。代码或输入变更后重新验证，不得只更新指纹冒充通过。"
  );
  console.log(
    `验收材料检查通过：${records.length} 个任务；当前版本 ${version}。此检查不代替业务正确性与现场验收。`
  );
}

try {
  const root = resolve(git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const args = process.argv.slice(2);
  if (args.length === 0) check(root);
  else if (args.length === 1 && args[0] === "--fingerprint")
    console.log(fingerprint(root));
  else if (args.length === 2 && args[0] === "--init") initialize(root, args[1]);
  else if (args.length === 2 && args[0] === "--record") check(root, args[1]);
  else if (args.length === 2 && args[0] === "--evidence-hash")
    console.log(evidenceHash(root, args[1]));
  else
    throw new Error(
      "用法：node scripts/check-acceptance.mjs [--init 任务编号 | --record 任务编号 | --fingerprint | --evidence-hash 证据路径]"
    );
} catch (error) {
  console.error(`验收材料检查失败：\n${error.message}`);
  process.exitCode = 1;
}
