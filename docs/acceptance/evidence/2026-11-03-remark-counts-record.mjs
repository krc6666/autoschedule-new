import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const path = "docs/acceptance/2026-11-03-position-remark-counts.json";
const record = JSON.parse(readFileSync(path, "utf8"));
function evidence(file, summary) {
  const path = `docs/acceptance/evidence/${file}`;
  const bytes = file.endsWith(".png")
    ? readFileSync(path)
    : Buffer.from(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
  return {
    path,
    summary,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const red = evidence(
  "2026-11-03-remark-counts-red.txt",
  "旧实现9项新回归7失败2通过：旧备注与现配置类别不重合，页面/历史草稿/自动频率/恢复均漏计送资料。"
);
const green = evidence(
  "2026-11-03-remark-counts-green.txt",
  "12文件173项通过：新9项、两表、历史/人工基准、配置再次修改与facts缓存、范围/界线、存储与Excel、真实Worker/WASM及UI。"
);
const verify = evidence(
  "2026-11-03-remark-counts-verify.txt",
  "npm.cmd run verify退出0：151文件1521功能、7文件19性能、类型检查和生产构建通过。"
);
const browser = evidence(
  "2026-11-03-remark-counts-browser.txt",
  "独立Chrome实际编辑TR121/H04备注，送资料1/申报0/普通H04为1；历史原文和另一组保留，历史保存、刷新、实际次数Excel下载、390px窄屏通过，无页面错误。"
);
const image = evidence(
  "2026-11-03-remark-counts-page.png",
  "匿名实际页面：送资料1、普通TR/H04为1，来自本次Chrome实际入口与独立导出核对。"
);
function check(id, reason, items) {
  record.checks[id] = { status: "verified", reason, evidence: items };
}
check(
  "reproduction",
  "owner提供TR121/H04原例，匿名诊断重放；新增测试先红后绿，未通过只改备注识别关键词的猜测修复。",
  [red, green]
);
check(
  "normalPath",
  "当前规则是唯一类别来源；二合一仅送资料1次，普通TR/H04仍1次；实际配置输入change后页面呈现。",
  [green, browser]
);
check(
  "alternatePath",
  "历史旧备注分别为申报/送资料/空白/二合一，分类和人工调整、重复/范围/界线/不匹配及Excel/存储均覆盖；未新增别名。",
  [green, verify]
);
check(
  "postProcessing",
  "历史编辑还原旧备注、保存再归档及刷新不恢复漏计；配置再次改回申报且复用同一facts时缓存重新归类，清空/人工基准减数有效。",
  [green, browser]
);
check(
  "finalGuard",
  "不新增硬规则、不改安全凭证与资格检查；自动仅常规类别参与，范围/结束界线仍过滤，Worker实际最终方案和完整安全回归通过。",
  [green, verify]
);
check(
  "unchanged",
  "历史原文/人工备注/人员事实不覆盖，普通重点键及集合不改；另一组与引导例外、末班范围/时段、H02月上限和冷却/恢复保护不改。",
  [green, browser, verify]
);
check(
  "finalArtifact",
  "Chrome真实配置动作及下载xlsx给出送资料1、无申报行；独立按单人单日单航班H04记录重算为1，页面及刷新一致。",
  [browser, image, verify]
);
record.answers = {
  originalFailure:
    "red.txt记录9项回归中的7项失败，诊断探针说明新旧类别交集为空；green.txt中相同行为转绿，browser.txt核对实际配置动作和最终显示。",
  laterChanges:
    "历史编辑草稿恢复旧备注、人工换人/清空、归档、存储/Excel恢复及配置再次修改可能改坏次数。green.txt固定这些路径和同一facts缓存反向回归，browser.txt核对保存刷新及实际导出。",
  finalArtifact:
    "browser.txt及page.png证明匿名真实页面结果，实际下载xlsx核对送资料1且无申报行；独立按一个H04实际承担事实期望1。verify.txt记录本次完整验证。",
};
record.review = {
  missedScope:
    "owner反馈两表；匿名复现普通重点H04原本仍1，不编造其缺陷，保留当前/历史/人工/往返断言。未重放owner私有存档；已用其航班岗位和备注原例完成独立实际页面验收。无新字段，未修改H02限次/冷却、恢复和安全规则。未commit、push或部署。",
  rootCause:
    "末班统计按当前规则类别与历史备注类别求交集；自动历史也先求交集再读旧备注。H04旧申报与当前二合一仅送资料互斥，真实人员记录被丢弃。owner明确裁决类别跟随当前配置，原文继续作为历史证据。",
  earlyDetection:
    "以后改岗位语义或统计前，先通过真实配置动作把已有历史的单类岗位改成二合一，再交叉核对两张表、自动月度/近期/上一班、历史编辑保存与Excel下载；不要只给测试记录填入新备注而绕过旧记录。",
};
record.testedVersion = execFileSync(
  process.execPath,
  ["scripts/check-acceptance.mjs", "--fingerprint"],
  { encoding: "utf8" }
).trim();
writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
console.log(record.testedVersion);
