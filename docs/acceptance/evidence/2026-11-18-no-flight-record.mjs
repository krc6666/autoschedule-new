import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const file = "docs/acceptance/2026-11-18-no-flight-period-summary.json";
const record = JSON.parse(readFileSync(file, "utf8"));
const evidence = (suffix, summary) => {
  const path = "docs/acceptance/evidence/2026-11-18-no-flight-" + suffix;
  let bytes = readFileSync(path);
  if (!suffix.endsWith(".png"))
    bytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
  return {
    path,
    summary,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const related = evidence(
  "related.txt",
  "18个直接相关测试文件129项通过，含新行为、原统计/查询/排序与消费者回归。"
);
const browser = evidence(
  "browser.json",
  "隔离Chrome真实应用挂载与导航、Store人工改派/清空、历史查询、全空名单、独立重算及390px通过；无页面异常。"
);
const check = (reason, items) => ({
  status: "verified",
  reason,
  evidence: items,
});
record.checks = {
  reproduction: check(
    "旧实现5项新断言失败、9项原行为通过；修改后18文件129项通过。",
    [
      evidence(
        "red.txt",
        "改前5项失败、9项通过，缺少上午/午后字段及固定三行。"
      ),
      related,
    ]
  ),
  normalPath: check(
    "11:50开始13:00结束只算上午，12:01开始算午后，全天无人仅列首行，空名单显示无。",
    [related, browser, evidence("desktop.png", "桌面三行匿名名单。")]
  ),
  alternatePath: check(
    "覆盖12:00/12:01、晚间、跨午、零工时、轮值、病休/行政、完整历史/当前优先/部分历史/无记录及200人名单。",
    [related, browser]
  ),
  postProcessing: check(
    "真实Store人工改派后名单更新，清空后全部进入首行且后两行无；查询历史自动切换，不持久化影子名单。",
    [browser, related]
  ),
  finalGuard: check(
    "最终DOM固定三行；完整结果空名单为无，无完整证据为无法判断；匿名开始时间按分钟独立枚举与三行一致。无新增排班硬约束。",
    [browser, evidence("final.html", "真实浏览器最终三行全空仍固定显示无。")]
  ),
  unchanged: check(
    "原航班去重/人数/病休/排序/查询及只读性回归通过；月度下午统计定向测试通过，未设置半休。未改求解、AppState、存储、Excel、云端。",
    [
      related,
      evidence(
        "focused.txt",
        "4文件44项通过，包含原月度轻松班次统计与排班展示。"
      ),
      evidence("typecheck.txt", "npm.cmd run typecheck退出0。"),
      evidence(
        "build.txt",
        "npm.cmd run build退出0，Vite 7.18秒；原外部化和大块提示保留。"
      ),
      browser,
    ]
  ),
  finalArtifact: check(
    "Owner授权独自完成后，隔离Chrome使用真实mountAutoscheduleApp、导航、内存Store及现有人工命令完成匿名场景。桌面/390px、换人/清空/查询、三行全空均通过；仅为本地新功能验收，不代表私人班表复现或云端发布。",
    [
      browser,
      evidence("desktop.png", "桌面三行人员名单。"),
      evidence("mobile.png", "390px窄屏三行文字完整。"),
      evidence("final.html", "最终三行空名单仍显示无。"),
    ]
  ),
};
record.answers = {
  originalFailure:
    "red.txt保留5项失败，related.txt证明改后18文件129项通过；原缺少半天名单且空名单整行消失由领域与UI断言发现。",
  laterChanges:
    "人工改派、清空及查询历史会改变输入。browser.json记录真实Store命令后的名单，related.txt保留长期回归；新投影只读，不进入后置排班写入或月度计次。",
  finalArtifact:
    "browser.json、desktop.png、mobile.png及final.html为本次实际本地应用匿名输出，开始时间独立重算一致；build.txt证明生产构建通过。未连接云端，不推断私人班表漏排根因。",
};
record.review = {
  missedScope:
    "已检查当前与完整历史、全天排空、人工更新、人员范围、200人和窄屏。仅在原人员当日航班区域增加三行，不新增归档只读页独立区域；无完整记录显示无法判断。不验证私人班表及线上部署；无排班/存储/Excel改动，按L1加构建/浏览器完成，不运行全量、性能或verify，不commit/push。填报首轮受PowerShell到node -e引号丢失影响未写记录，改用UTF-8文件脚本执行后重新检查。",
  rootCause:
    "原当日统计只有全天零航班名单。初始按出勤重叠理解与Owner的开始时间口径不一致，写实现前已按其纠正为严格晚于12:00；原月度下午出勤合同保留。",
  earlyDetection:
    "下次写代码前用11:50跨午、12:00、12:01锁定时间含义，先跑三行固定/空名单失败测试；修改后检查真实人工变更/查询后的最终DOM及独立名单，避免混用半休选择或月度计次。",
};
record.checks.unchanged.evidence.push(
  evidence(
    "commit-verify.txt",
    "提交前完整npm.cmd run verify退出0：232文件2240项功能、7文件19项性能、类型检查及构建通过。"
  )
);
record.review.missedScope =
  "当前/完整历史、人工更新、200人及窄屏已验证；Owner授权commit后已完成完整verify，原提交钩子保留。原区域固定三行，不扩展归档只读页；无完整记录明确无法判断。未复现私人班表，不push或发布；其他已有改动不纳入本提交。";
record.testedVersion = execFileSync(
  process.execPath,
  ["scripts/check-acceptance.mjs", "--fingerprint"],
  { encoding: "utf8" }
).trim();
writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
console.log(record.testedVersion);
