# Token Monitor 的 WakaTime 同步

把 Token Monitor 的 AI token 用量以 WakaTime 的 **AI Coding** 心跳上报，并在紧凑卡片里读回 WakaTime 当天数据。
单机可用，共享 Hub 的多设备场景也有配套的 Hub 桥（本仓库 `hub-bridge/`）。

> 非官方社区集成，与 WakaTime 官方及 Token Monitor 维护者无关。

## 它做什么

Token Monitor 按 AI 会话统计 50+ 种编程工具的 token，WakaTime 按编辑器文件统计时间。
插件每轮只上报增量，调用 `POST /api/v1/users/current/heartbeats.bulk`：

| Token Monitor | WakaTime 心跳 |
| --- | --- |
| 客户端（`codex`、`dsh`、`claude`…） | `entity: token-monitor:<client>` |
| 分类 | `ai coding`（可配置） |
| 会话 | `ai_session` |
| input + 缓存读/写增量 | `ai_input_tokens` |
| output 增量 | `ai_output_tokens` |
| 项目名或工作区文件夹 | `project` |
| 设备主机名 / 时区 | `X-Machine-Name` / `Timezone` 请求头 |
| 插件版本 | User-Agent `token-monitor/<version>` |

之后 WakaTime 的 AI Coding 时长与 AI token 计数会和手工编码并排出现。
AI **模型**归属交给 WakaTime 自己的 CLI 解析器：我们试过往 UA 塞自定义模型，会被当成虚构模型并推算出成本，所以不再发送。

## 兼容性

- Token Monitor：`>=0.82.0`（插件 API `tmApi: 1`，实验性）。构建与验证基于 0.87.x。
- 插件 UI：Windows 11（Token Monitor 桌面端）。其他桌面平台使用同一套宿主 API，但未在此环境验证。
- Hub 桥：Node 22.15+，Linux/macOS（与 Token Monitor hub 使用同一 Node）。

## 安装

1. 从 [Releases](https://github.com/Ayeez757/wakatime-sync/releases) 下载最新的 `wakatime-sync-<版本>.tmplugin`。
2. Token Monitor → 设置 → 插件 → 导入该文件（或本目录）→ 阅读可信代码警告 → **信任并安装启用**。
3. 在插件设置里填入 <https://wakatime.com/api-key> 的插件专用 key（只写）。
4. 打开「向 WakaTime 发送心跳」，首次启用时同意**后台执行**，Token Monitor 运行期间就会持续上报。
5. 可选：填入 <https://wakatime.com/oauth> 的个人 OAuth token，卡片才会显示 WakaTime 统计。API key 只能写不能读。

建议先打开「试运行」，确认心跳载荷后再正式发送。

## 按场景选择

| 场景 | 设置 |
| --- | --- |
| 单机本地采集 | `scope: auto`、`category: ai coding`、计入缓存 token |
| 多设备共享 Hub 且 Hub 上跑着桥 | 保持「检测到 Hub 桥时由 Hub 上报」开启：插件每轮询问桥并待命，由 Hub 统一上报所有设备 |
| 多设备但没有 Hub 桥 | 每台机器都开插件，`scope: auto` 只上报本机会话 |
| 只看板、不上报 | 关闭上报，只填 OAuth token |
| WakaTime 已经在记 AI coding | WakaTime 的 CLI 默认会解析 Claude/Codex/Copilot/DeepSeek/Cursor 转录。若已覆盖你的会话，请关掉本插件上报（只留卡片），否则会重复计数 |

同一个账号/机器只保留一个上报方：本插件、Hub 桥、WakaTime 自带 AI sync 三选一。

## 设置项

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 向 WakaTime 发送心跳 | 关 | 上报总开关 |
| WakaTime API key | — | 心跳用的只写 key |
| WakaTime OAuth access token | — | 卡片读统计 |
| 上报哪些会话 | auto | 用 Hub 设备列表定位本机；多设备 Hub 上匹配不到本机时**直接暂停上报**，绝不误传其他设备；`aggregate` 才上报全 Hub |
| WakaTime 分类 | ai coding | 选 `coding` 会并入手工编码，也可选其他分类 |
| 计入缓存 token | 开 | 把缓存读/写计入 `ai_input_tokens` |
| 项目名来源 | label | Token Monitor 项目名 / 工作区文件夹名 / 不上报 |
| 项目名前缀 | — | 可选，例如 `ai-` |
| 上报间隔 | 60 秒 | 30–900 秒，修改后无需重新加载插件 |
| 检测到 Hub 桥时由 Hub 上报 | 开 | 桥在 17322 端口应答时本插件待命 |
| Hub 桥地址 | 自动 | 留空 = 与 Hub 同主机 + 17322 端口 |
| 试运行 | 关 | 只记录不发送 |

## 计数行为

- 首轮只记录基线，不会一次性补发当天历史。
- 跨天或计数回退时重建基线，不发负数。
- 基线用「客户端 + 设备 + 会话开始时间」做 key，App 重启后不会因不透明行 id 变化而丢增量。
- 每轮每个会话一条心跳；多模型合并计算，同一批心跳使用不同的亚秒时间。
- 会话数据不可用时如实显示，绝不当作 0；分页被截断时显示 `(partial)`。

## 卡片

上报状态、今日心跳、已上报 input/output token、上报范围、已跟踪会话、最近上报、上次检查、会话数据可用性；
以及 WakaTime 当天：编码总时长、AI Coding 时长、AI token、AI 模型（含成本）、分类、项目、机器。
「刷新」会强制轮询并重读统计（统计缓存 30 秒）。

## Hub 桥（多设备）

`hub-bridge/` 是无头 Node 进程：读 Hub 的 `/api/stats`，为所有设备发送同样的心跳，并暴露 presence 接口
（`POST /presence/plugin`、`GET /presence`）供桌面插件协调。说明见 [hub-bridge/README.md](hub-bridge/README.md)。

## 数据与访问

- 插件属于可信代码，拥有本机用户的文件与网络权限，不做沙箱隔离。
- 只向 WakaTime 与配置的 Hub 发送 token 计数、会话 id、项目名、机器名、时区。
- 不会发送 prompt、对话内容、文件路径、账号邮箱或供应商凭证。
- API key、OAuth token、Hub 共享密钥从 Token Monitor 设置读取；基线（`state.json`，权限 0600）与插件偏好（明文 JSON，非加密保险库）保存在插件数据目录。
- 桥的配置与基线默认放在 `~/.config/wakatime-bridge/`，权限 0600。

## 更新

发布在 [GitHub Releases](https://github.com/Ayeez757/wakatime-sync/releases)，通过 设置 → 插件 替换包即可。
仓库根目录的 `catalog.json` 可作为 HTTPS catalog：在 设置 → 插件 → 发现 → 更多 → 自定义 catalog 源 里添加
`https://raw.githubusercontent.com/Ayeez757/wakatime-sync/main/catalog.json` 可在应用内发现更新。
回滚只恢复代码，不回滚插件数据。

## 开发

```sh
npm run check     # 语法、manifest、密钥扫描
npm test          # 单元测试（不联网）
npm run build     # 生成 dist/<id>-<版本>.tmplugin（需要 TM_REPO 指向 token-monitor 检出）
npm run catalog   # 用构建产物刷新 catalog.json
```

真实 WakaTime 校验是可选的：`WAKATIME_OAUTH_TOKEN=... npm test` 才会跑 statusbar 解析测试。

## 许可证与致谢

MIT。插件 API 与打包器来自 [Token Monitor](https://github.com/Javis603/token-monitor)；WakaTime 是独立服务。图标为本仓库原创。
