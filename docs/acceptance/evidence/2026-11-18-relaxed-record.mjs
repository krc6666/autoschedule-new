import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const task = "2026-11-18-relaxed-flight-matrix";
const path = `docs/acceptance/${task}.json`;
const prefix = "docs/acceptance/evidence/2026-11-18-relaxed-";
const log = readFileSync(`${prefix}l2.txt`, "utf8");
if (
  !/Test Files\s+237 passed/.test(log) ||
  !/Tests\s+2282 passed/.test(log) ||
  !log.includes("built in")
)
  throw new Error("Final L2 result is not complete and successful.");
const record = JSON.parse(readFileSync(path, "utf8"));
function evidence(name, summary) {
  const path = `${prefix}${name}`;
  const sha256 = execFileSync(
    process.execPath,
    ["scripts/check-acceptance.mjs", "--evidence-hash", path],
    { encoding: "utf8" }
  ).trim();
  return { path, summary, sha256 };
}
const red = evidence(
  "matrix-red.txt",
  "修改前5项新行为失败：缺航班分列、下午空/休、日期展开和独立月份。"
);
const scopeRed = evidence(
  "scope-red.txt",
  "Excel字节/旧完整恢复/内置模板缺字段失败；另1项是coordinator夹具漏preferences，不算产品红灯。"
);
const gates = evidence(
  "l2.txt",
  "最终类型检查、237文件2282项完整功能及生产构建退出0；单worker，未修改性能门槛。"
);
const browser = evidence(
  "browser.json",
  "隔离Chrome真实app入口、Store/controller、浏览器存储、实际Excel上传预览确认；刷新前后每格数值日期、A/B/A、独立切月、人工换人清空后重算、390px与无脚本错误。"
);
const independent = evidence(
  "independent.json",
  "独立Python从匿名任务分钟重算70格数字及日期，直接解压XLSX核对8个范围值，全部一致。"
);
const template = evidence(
  "template.json",
  "原模板24张表942个单元格值/类型/样式不变，仅追加新范围表。"
);
const config = evidence(
  "config.xlsx",
  "本次真实页面状态导出的匿名配置Excel，包含已选8个完整航班号。"
);
const desktop = evidence(
  "desktop.png",
  "1440px本次轻松班次航班矩阵与展开日期。"
);
const mobile = evidence(
  "mobile.png",
  "390px日期展开且页面无横向溢出，沿用末班表移动布局。"
);
record.checks = {
  reproduction: {
    status: "verified",
    reason:
      "有效改前红灯与本次最终全量通过相对应；不把夹具启动失败当业务失败。",
    evidence: [red, scopeRed, gates],
  },
  normalPath: {
    status: "verified",
    reason:
      "人员原顺序、航班×人员次数、下午两项、点击MM-DD日期、0次、默认MF/CX和选月均已验证。",
    evidence: [browser, independent, gates],
  },
  alternatePath: {
    status: "verified",
    reason:
      "null/空数组/明确范围、旧状态、旧完整恢复、缺表保留、重复/空航班/坏表头、A/B、跨月、不完整历史、零工时出勤、12:00/12:01及18点边界、200人分支、航班改名删除有回归；实际字节与浏览器导入通过。",
    evidence: [gates, browser, template],
  },
  postProcessing: {
    status: "verified",
    reason:
      "最终岗位人工改派及清空、同日当前替换归档后重新统计；刷新后逐格核对数字和日期，没有仅检查设置字段。",
    evidence: [browser, independent, gates],
  },
  finalGuard: {
    status: "verified",
    reason:
      "不新增候选/求解/覆盖硬约束；最终数字日期由独立原始分钟核对，范围变更不改变规则指纹和安全凭证的长期回归通过。",
    evidence: [gates, independent, browser],
  },
  unchanged: {
    status: "verified",
    reason:
      "原提前下班和下午无航班/均衡、普通与末班重点、保存恢复和整体功能通过；配置导入继续原清空当前班表合同。模板942格不变。未改排班规则/求解/性能路径，不运行L3性能或L4提交门禁。",
    evidence: [gates, template, browser],
  },
  finalArtifact: {
    status: "verified",
    reason:
      "Owner已授权全程自主完成；本地隔离Chrome实际mountAutoscheduleApp及原Store/controllers/浏览器保存验收，不替代Owner私人数据或远端现场。桌面/窄屏截图、实际导出XLSX和独立核对闭合本次新功能。",
    evidence: [browser, desktop, mobile, config, independent],
  },
};
record.answers = {
  originalFailure:
    "relaxed-matrix-red.txt保存5项缺新行为失败；scope-red.txt中Excel/默认恢复/模板缺字段为有效红灯（preferences夹具错误单列）；relaxed-l2.txt最终237文件2282项、类型和构建通过。",
  laterChanges:
    "可能改坏来源为人工换人/清空、保存恢复、同日归档覆盖、切月/切组、航班改名/删除、Excel导入。browser.json实际命令验证人工后置刷新与每格重启一致，完整功能含上述边界及凭证/指纹保持；没有更改自动排班后置执行器。",
  finalArtifact:
    "本次browser.json及1440/390截图显示人员×完整航班号、下午空/休和点击日期；config.xlsx为本次页面实际导出，independent.json按匿名原始分钟独立核对70格和8个导出范围。实际文件上传/预览/确认另保留原配置导入清空合同。",
};
record.review = {
  missedScope:
    "已检查范围保存/刷新/A-B/Excel/模板/航班引用/指纹凭证、现有两表样式标识、实际人工后置与独立计数。未操作Owner私人班表、远端或另一台真实设备，不声称这些现场已验收；本地隔离入口是本次已授权新功能验收。",
  rootCause:
    "旧视图只有两类汇总，缺航班维度/可编辑范围/两个新下午含义；原下午无航班已参与排班，直接改口径会改变算法。使用原提前下班事件分列，原统计字段不变，新增只读日期及独立展示范围。",
  earlyDetection:
    "定义表格前先列当前统计消费者与展示/排班分界；增加字段时先对照默认/清洗/组保存/Excel/模板/指纹矩阵；先看12:00、12:01和18:00业务例子，验收时逐格比较刷新前后数字与日期并触发真实人工后置命令。",
};
record.testedVersion = execFileSync(
  process.execPath,
  ["scripts/check-acceptance.mjs", "--fingerprint"],
  { encoding: "utf8" }
).trim();
writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
console.log(`Recorded ${task} for ${record.testedVersion}`);
