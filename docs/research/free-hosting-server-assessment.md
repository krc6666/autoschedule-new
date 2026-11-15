# 排班系统免费公网托管方案核查

- 核查日期：2026-11-14。
- 性质：只读调查及方案建议；没有注册、部署、购买、迁移数据，也没有修改产品代码或现行规范。
- 已确认业务范围：一个管理账号负责修改，跨设备使用同一份数据；管理员发布后，其他人拿链接匿名查看；手机流量可以访问；优先免费服务。
- 边界：公开入口只提供已发布班表，草稿、人员配置、历史原始数据和管理权限不能由公开链接取得。

## 建议

优先评估 Cloudflare Workers Free（接口及静态资源）+ D1 Free（持久化）。也可使用 Pages 承载静态页面，Pages Functions 消费 Workers 额度。排班求解继续运行在浏览器 Worker/WASM，服务端只负责登录、保存、读取和发布。

这是方案建议，不是已部署结果。现有系统的浏览器 Worker 创建点在 `src/infrastructure/schedule-runner.ts:172`，本地保存适配器在 `src/infrastructure/storage.ts:54`、`:73`、`:111`。目前存储容量告警阈值是 4 MiB（同文件第 10 行），不能推定实际数据量或把完整状态直接塞进 D1 单行。

## 已由官方资料核实的事实

| 项目                 | 本次读取到的官方事实                                                                                                                                        | 来源     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Workers 免费接口额度 | 默认可使用 Free；每天 100,000 次请求，每次调用 10 ms CPU；直接静态资源请求免费且不限次数。静态资源若走 Workers Caching 等其他机制，需按对应计费规则另核对。 | [S1]     |
| 超出接口额度         | Free 每日请求达到限制后返回 Error 1027，额度在 UTC 零点重置。不能把免费额度理解为无限服务。                                                                 | [S2]     |
| D1 免费额度          | 每天读 5,000,000 行、写 100,000 行，账号总存储 5 GB。行扫描数量并不等于请求数；索引也影响读写计数。                                                         | [S3]     |
| D1 实际容量边界      | Free 每账号最多 10 个数据库，每库最多 500 MB；字符串、BLOB 或表单行最大 2,000,000 字节；每次 Worker 调用最多 50 次查询。                                    | [S4]     |
| D1 超额行为          | 达到每日读写额度时查询会报错；存储额度用尽后，新增数据/表/索引等受限。切换付费是另一个操作，不能默认自动升级。                                              | [S3]     |
| 数据恢复             | D1 Time Travel 自动启用；Free 恢复窗口为 7 天，Paid 为 30 天；恢复和数据库历史不额外收费。7 天恢复窗口不等于长期异地备份。                                  | [S4][S5] |
| 免费访问域名         | Workers 部署支持 `*.workers.dev`，Pages 项目提供 `<project>.pages.dev`（重名时可能追加字符）。因此可以先用平台子域名，不必先购买独立域名。                  | [S6][S7] |
| Pages 构建限制       | Pages Free 每月 500 次构建、每项目最多 20,000 个文件。Pages Functions 按 Workers 计费和额度处理。                                                           | [S8][S1] |

## 尚未核实及不能承诺的内容

- **国内手机流量可达性及速度**：未用 owner 所在地运营商实测。能取得官方文档不能证明部署后的 `workers.dev` / `pages.dev` 在目标网络可稳定访问；购买域名也不能作为稳定访问的保证。正式迁移前应由 owner 用实际移动网络打开测试入口，再决定采用平台。
- **绑卡要求**：可访问官方文档确认默认 Free，但本次没有取得明确“不需信用卡”的官方条款，也没有注册账号验证。不要把“不用绑卡”写成已验证事实。
- **Cloudflare 不活跃休眠政策**：本次核查页面没有找到明确条款，不宣称永不休眠或永久可用。
- **Supabase Free 对比**：尝试访问官方 pricing、billing、backups、going-into-prod 页面，前三类页面读取超时，going-into-prod 返回 HTTP 308，未取得足够证据。本记录不确认其现行容量、不活跃暂停、备份或绑卡条件，也不以记忆中的额度作最终选型依据。
- **永久免费及未来政策**：只确认本次访问时存在 Free 方案，不能承诺未来额度和条件不变。
- **本项目能否始终零费用**：实际班表数据大小、读取人数、API CPU 和访问量没有测量；目前只能判断是适合验证的候选方案。域名如另外购买，费用单列。

## 实现前必须保留的范围

1. 不把 HiGHS 求解搬进 Free Worker。其每次 10 ms CPU 上限与当前浏览器长时间求解不同；服务端接口设计本身也需要测量 CPU。
2. 为配置、草稿、归档和发布快照确定持久化职责及容量边界，不能仅将 `localStorage` 的整个 JSON 换成一行数据库写入。D1 单行限制与现有本地状态容量告警不同。
3. 管理员权限必须由服务端核实；匿名接口只读取发布投影。公开链接只代表查看已发布班表的权限。
4. 跨设备保存需要版本检查，拒绝旧页面覆盖新数据；保存失败保留未提交内容，发布失败保留上次成功发布的版本。
5. 免费额度耗尽、网络失败和平台不可用应明确提示；保留 Excel 导出和独立备份出口。具体备份策略及恢复验收待业务确认后设计。

## 资料来源与获取记录

以下成功来源均通过官方站点的 `/index.md` 端点读取；链接指向可读网页版本：

- [S1] Cloudflare Workers Pricing：https://developers.cloudflare.com/workers/platform/pricing/
- [S2] Cloudflare Workers Limits：https://developers.cloudflare.com/workers/platform/limits/
- [S3] Cloudflare D1 Pricing：https://developers.cloudflare.com/d1/platform/pricing/
- [S4] Cloudflare D1 Limits：https://developers.cloudflare.com/d1/platform/limits/
- [S5] Cloudflare D1 Time Travel and backups：https://developers.cloudflare.com/d1/reference/time-travel/
- [S6] Cloudflare Workers CLI guide：https://developers.cloudflare.com/workers/get-started/guide/
- [S7] Cloudflare Pages Direct Upload：https://developers.cloudflare.com/pages/get-started/direct-upload/
- [S8] Cloudflare Pages Limits：https://developers.cloudflare.com/pages/platform/limits/

获取失败也保留，避免误写成核实通过：Workers Pricing 普通 HTML 首次返回 403，后改用官方 Markdown 成功；Cloudflare Workers 产品官网连接被拒绝；GitHub 官方文档镜像域名解析失败；Supabase 官方页面读取超时或返回 HTTP 308。以上失败只说明本次调查环境的获取结果，不证明终端用户的部署访问结果。
