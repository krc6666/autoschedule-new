# Supabase 本地准备协议依据

- 核查日期：2026-11-15。
- 性质：官方协议调查与建议，不改变现行产品事实；没有注册账号、部署远端、创建云数据库、索取或保存密钥。
- 业务范围：一个管理员修改，跨设备保存；按发布链接匿名查看已发布快照。页面建议继续由现有 GitHub Pages 承载，Supabase 负责 Auth 与数据库；求解继续在浏览器 Worker/WASM。
- 本次已经读取官方正文的事实与建议分开记录。无法访问的页面不能用记忆内容代替已核实协议。

## Auth 客户端协议

| 方法                      | 官方正文核实结果                                                                                                                                                                                 | 本项目消费建议                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.signInWithPassword` | 已存在用户可用邮箱/密码或手机/密码登录；错误信息可能不区分用户不存在、密码不对或用户只支持社交登录。[S1]                                                                                         | 只提供管理员登录，不提供公开注册。登录成功只是获得会话，数据库仍须确认该用户是唯一管理员。                                                                                 |
| `auth.getSession`         | 返回会话，必要时刷新；无登录会话时可为 `null`。值直接来自客户端配置的 storage，特别是请求 cookie 场景不可作为可信授权依据。[S2]                                                                  | 用于恢复客户端会话和按钮状态，不能把本机保存的 user/session 当作服务端管理员权限证明。                                                                                     |
| `auth.getUser`            | 向 Supabase Auth 服务发网络请求，返回用户是经过服务器验证的，可作为授权规则依据。[S3]                                                                                                            | 登录恢复时可验证用户；网络失败要保留本地数据并明确错误。最终写入仍由 SQL 里的 `auth.uid()` 与管理员记录检查决定。                                                          |
| `auth.onAuthStateChange`  | 收到认证事件通知；官方示例包含 `INITIAL_SESSION`、`SIGNED_IN`、`SIGNED_OUT`、`TOKEN_REFRESHED`、`USER_UPDATED`。同步 callback 足够使用；返回的 subscription 应在生命周期结束时 unsubscribe。[S4] | callback 只更新会话投影/通知，不在其中等待另一次 Auth 调用；异步验证或云读取在回调外排队执行，避免交错会话覆盖。                                                           |
| `auth.signOut`            | 官方页面路径确认存在，但多次读取正文超时；本次未核实其当前默认 scope、各 scope 行为和 access-token 失效细节。[S5]                                                                                | 不依赖未经核实的默认全设备退出语义。实现前结合安装 SDK 的类型/源码明确 scope，并保留真实 SDK 行为测试。退出不能删除本机班表；服务器权限仍以 token 有效性和管理员检查为准。 |

## API key 和授权边界

成功读取的最新官方 API keys 页面已经迁至 `/docs/guides/getting-started/api-keys`；旧 `/docs/guides/api/api-keys` 返回 HTTP 308。[S6]

- 新项目优先使用 publishable key。它用于客户端识别项目，不表示管理员身份；用户登录后的 JWT 和数据库权限负责实际授权。[S6][S7]
- `anon` / `service_role` 是旧式 key；官方页面将继续读取旧 `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 描述为留在 deprecated 路径。[S6]
- secret key 和 `service_role` 不得放进浏览器、Vite 构建变量、GitHub Pages 产物或聊天。官方明确 secret 不能出现在浏览器（包括 localhost）、URL、源码仓库中。[S6]
- publishable/secret key 不是 JWT，使用 `apikey` header；不能把 publishable key 当 `Authorization: Bearer` 的用户 JWT。使用官方 `@supabase/supabase-js` 处理这些传输细节。[S6]
- 本项目只需在前端配置项目 URL 与 publishable key；建立管理员或部署 SQL 应通过账号控制台/迁移工具完成，不需要将 service-role key 配给网页。

## Postgres RPC、RLS 与 CAS

官方 Functions 文档明确：优先使用默认 `security invoker`；若使用 `security definer`，必须固定 `search_path`，空路径下函数体中所有关系都用 schema 全名。Definer 以创建者权限运行；迁移/控制台创建者通常是可绕过 RLS 的 `postgres`，因此仅启用 RLS 并不能保护 definer RPC。[S8]

官方还明确：函数默认可被所有角色执行；必须从 `PUBLIC` 和持有直接 grant 的角色（如 `anon`）分别撤销，再仅给需要的角色授权。[S8][S7]

本项目的建议合同如下；这是设计建议，不代表已有实现：

1. 私有状态、管理员名单、发布快照启用 RLS；撤销不需要的直接表访问。不能只隐藏页面按钮。
2. 管理 RPC 限 `authenticated` 执行；函数内部仍核实 `auth.uid()` 等于唯一管理员记录。登录用户不自动等于管理员。管理员表不能允许客户端自行添加或修改管理员身份。
3. 如 definer RPC 需要访问私有表，使用 `security definer set search_path = ''`，表和函数一律 schema 限定；明确检查所有权，不能接受客户端传来的 user ID 作为证明。
4. 保存 RPC 参数包含 `expected_revision`；数据库原子地比较当前版本并提交下一版。版本不符返回明确冲突，不覆盖最新状态。首次创建的并发竞争也需要数据库唯一键和同一事务处理。
5. 发布 RPC 在同一事务内检查管理员及版本，把已确认的发布投影写成稳定快照；发布内容不包含整份私有 AppState。失败不替换上次发布版本。
6. 匿名只允许调用“按 token 读已发布快照”的窄 RPC。撤销默认执行权限后显式授予 `anon` 所需的读 RPC；RPC 返回固定白名单字段，未命中 token 返回无结果，不提供枚举全部发布或读取私有状态的能力。
7. token 只是查看链接的能力凭证，不能拥有写权限；不要在公开快照里回传管理员邮箱、会话、密钥或人员配置。
8. RPC 的权限、CAS、首次创建、错误事务回滚、匿名与非管理员拒绝均需真实 Postgres 测试。前端 mock 不能证明 RLS 和 definer 安全。

## 本地 CLI 与无账号准备

官方最新 CLI 文档核实：[S9]

- `supabase init` 只创建本地 `supabase/` 和 `config.toml`，不登录、不连接远端。
- CLI 可作为项目 dev dependency 安装；经 npm/npx 运行要求 Node.js 20 或更新。
- 常规本地完整栈通过 Docker 容器运行，需要容器运行时；Windows 可用 Docker Desktop 或 Docker-compatible API 的替代工具。
- 文档另有实验 native runtime，只支持 Linux 与 Apple silicon macOS，不能据此声称本 Windows 工作区无需 Docker 就能跑官方完整栈。
- `supabase start` 首次需要拉取运行组件；安装 CLI 不等于数据库已经启动，也不等于完成 Auth/PostgREST/RLS 验证。
- 不应公开暴露本地开发栈；本文未安装/启动 Docker，也没有验证本机容器能力。

可离线准备 SDK 适配、配置模板、SQL 迁移、测试和接入文档；是否能完成本地真实入口验证取决于本机 Docker/数据库能力，不可用时明确留待验证，不能用编译成功代替。

## Free 方案已核实条件

截至本次读取到的官方 billing 与生产清单：[S10][S11]

| 项目        | 已读取内容                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Free 项目数 | 总共两个免费项目，限制跨该用户拥有 Owner/Administrator 身份的组织；暂停项目不计入当前免费项目上限。                |
| 数据库容量  | 每项目 500 MB。                                                                                                    |
| Egress      | 免费额度 5 GB。额度表按 billing 计划统计，实际产品计量需按最终选用项再次核对。                                     |
| Auth MAU    | 50,000 月活用户。                                                                                                  |
| 不活跃暂停  | Free 在连续 7 天低活动情况下可能暂停；可在控制台恢复。不能承诺永久免费永不休眠，也不能靠人为保活作为可靠服务合同。 |
| 平台备份    | Free 不能下载平台数据库备份；官方建议定期用 CLI `db dump` 导出并保留异地备份。[S12]                                |

Free 是否要求绑卡、本地移动网络访问稳定性、未来额度变化没有验证；不能据此承诺零门槛或永久可用。数据没有实际迁移，真实容量与流量也没有测量。

## 官方来源

- [S1] https://supabase.com/docs/reference/javascript/auth-signinwithpassword
- [S2] https://supabase.com/docs/reference/javascript/auth-getsession
- [S3] https://supabase.com/docs/reference/javascript/auth-getuser
- [S4] https://supabase.com/docs/reference/javascript/auth-onauthstatechange
- [S5] https://supabase.com/docs/reference/javascript/auth-signout （正文获取超时，不能当已核实默认语义）
- [S6] https://supabase.com/docs/guides/getting-started/api-keys
- [S7] https://supabase.com/docs/guides/api/securing-your-api
- [S8] https://supabase.com/docs/guides/database/functions
- [S9] https://supabase.com/docs/guides/local-development/cli/getting-started
- [S10] https://supabase.com/docs/guides/platform/billing-on-supabase
- [S11] https://supabase.com/docs/guides/deployment/going-into-prod
- [S12] https://supabase.com/docs/guides/platform/backups

## 获取失败与证据限制

- 官方站点请求不稳定；多个 URL 首次或重试超时，已成功读到正文的项目才写为已核实。查询参数仅用于重新请求同一官方页面。
- API keys 与 going-into-prod 旧路径返回 308；跟随其 Location 指向的新路径成功读取正文。
- `raw.githubusercontent.com/supabase/supabase/...` DNS 解析失败，没有取得 GitHub 原始源码。
- `https://supabase.com/pricing` 多次超时，Free 额度改由成功获取的官方 billing 文档确认。
- RLS 独立指南读取超时，相关事实使用已成功读取的官方 securing-your-api 和 Functions 正文。
- signOut 的 scope 语义本次未闭合。SDK 依赖版本、安装是否成功、本机 SQL 运行结果由实现/验证流程另行提供，不在此文推定。
