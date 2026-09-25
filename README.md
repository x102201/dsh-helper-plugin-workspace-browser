# dsh-helper-plugin-workspace-browser

给**当前工作区**起一个带调试端口的真实 Chrome —— 胶囊管开关和状态，右侧栏管看画面，模型用 `workspace_browser_*` 工具操作页面。

> 设计说明见 [`DESIGN.zh.md`](DESIGN.zh.md)；接口调研底稿见 [`BROWSER_PLUGIN_SLOT_RESEARCH.zh.md`](BROWSER_PLUGIN_SLOT_RESEARCH.zh.md)。

---

## 它解决什么

你手工那套是：

```
chrome.exe --remote-debugging-port=9222 --disable-web-security --user-data-dir=...
```

这个插件把它变成：**输入框旁边一个胶囊 + 一个按工作区分开的数据目录 + 随机端口 + 默认关闭的跨域**。

和"操控你日常浏览器"的扩展路线（`@caob23/dsh-browser-control`、`@yuxianglin/dsh-bridge-browser`）的区别：

| | 扩展路线 | 本插件 |
| --- | --- | --- |
| 和浏览器的关系 | 扩展 + 调试桥 | **无扩展，直连 CDP** |
| 准备 | 装扩展、开侧栏 | **点一下胶囊** |
| 登录态 | 你日常用的那个浏览器 | **这个工作区专属的 profile** |
| 画面 | 纯文本快照 | **右侧栏实时镜像**（P3） |
| 工具名 | `browser_*` | **`workspace_browser_*`**，可以和扩展路线同时装 |

---

## 安装

```bash
# 以 link 方式装进某个 profile（开发时最常用）
dsh plugin --profile web add link:/absolute/path/to/dsh-helper-plugin-workspace-browser
```

手写等价于两处改动（`dsh plugin add` 帮你做这两件事）：

1. `<DSH_HOME>/profiles/web/package.json` 的 `dependencies` 加：
   `"dsh-helper-plugin-workspace-browser": "link:C:/ProjectCode/20260925-dsh-helper-plugin-workspace-browser"`
2. 同一个文件里 `dsh.profile.bundles` 追加 `"dsh-helper-plugin-workspace-browser"`
3. 在 `profiles/web/node_modules/` 下建立指向本目录的符号链接（Windows 上权限不够时用 junction）

**装完必须重启 `dsh --profile web`（或 `dsh web`）** —— bundle 列表只在启动时读一次。`patchReload: live` 只重载 patch 层，不会重新扫 bundle。

### 两个已知的安装坑

- **`duplicate loader entry id`**：本包的 `cordis.patch.yml` 已经 insert 了 `id: workspace-browser`。如果 profile 自己的 `cordis.patch.yml` 里也 insert 了同一个 id，启动就会报这个错 —— 删掉其中一处。
- **工具重名**：`dsh-tools` 对重名工具**直接抛错**。本插件用 `workspace_browser_*` 前缀，和 `browser_*` 的扩展路线不冲突；但如果你把同名前缀的插件装两次，加载就会失败。

---

## 用起来是什么样

```
点胶囊        → 只打开小面板，不启动浏览器
点「启动」    → 窗口出现，右侧栏打开画面
关掉浏览器窗口 → 大约半秒后显示「未启动」，不会自己再打开
再点「启动」  → 一定还能起来
```

**胶囊永远点得动**是这个插件的硬要求：任何状态下点击都能打开小面板，任何状态下「启动」都能把浏览器拉起来。判"运行中"用的是端到端探测（连上 CDP 且能列出标签），不是"文件在不在"。

### 两个入口

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 胶囊 | 输入框那一行 | 点一下打开小面板（启动 / 停止 / 复制端点 / 跨域开关 / 打开画面） |
| `/browser` | 输入框命令 | 见下 |

> 曾经还有一个「会话头部右上角、紧挨『在本地打开』的图标按钮」，**已去掉**：打开画面在胶囊里和右侧栏本身都能做，多一个入口只是噪声。

---

## `/browser` 命令（P5）

| 输入 | 插件先做 | 模型收到 |
| --- | --- | --- |
| `/browser` | 启动窗口并打开画面 | **没有新消息** |
| `/browser https://…` | 冷启动时它就是第一页；已在跑则复用或后台新开 | 网址与 `targetId` |
| `/browser https://… 后面的话` | 同上 | 再加上这段话 |
| `/browser 一段没有网址的话` | 打开窗口和画面，不开标签 | 整段话，由模型自己决定去哪 |
| `/browser --new https://…` | 即使已有相同网址也新开一张 | 同有网址的一行 |

命令名是宿主侧注册的：DSH 对**没注册过的 `/xxx` 直接报错**，不会当成普通输入。

---

## 工具（P1 起）

| 级别 | 工具 |
| --- | --- |
| 读 | `workspace_browser_snapshot`、`get_text`、`list_tabs`、`select_tab`、`screenshot` |
| 写 | `click`、`type`、`press`、`scroll`、`navigate`、`open_tab`、`close_tab`、`back`、`forward`、`reload`、`wait` |
| 可选 | `evaluate`（默认不注册） |

工具在**插件加载时**就注册，不随实例启停增减 —— 提示词里始终看得到它们，实例没起来时返回结构化错误（`browser-not-running`、`chrome-not-installed`、`chrome-version-unsupported`、`chrome-launch-failed`，每个都带人话与 `hint.actions`），模型可以原样转述给你。

### 读类工具（P1，已实现）

| 工具 | 返回 |
| --- | --- |
| `workspace_browser_snapshot` | 标题、网址、正文、**带编号的可点元素清单**、表单字段（`password` / `hidden` / 名字敏感的字段值只给 `[已掩码]`） |
| `workspace_browser_get_text` | 一块区域的文字（可传 CSS 选择器） |
| `workspace_browser_list_tabs` | 这个工作区的标签页（复用 `pageTargets()` 排掉 devtools / 扩展 / Omnibox 等内部 target），**没有「属于哪个会话」** |
| `workspace_browser_select_tab` | 改之后命令的默认标签（画面焦点也跟着它）；**绝不把窗口带到前台** |
| `workspace_browser_screenshot` | `Page.captureScreenshot` 的 PNG：落到 `<browserRoot>/shots/` 并返回路径；宿主挂了附件服务时**额外**再给一个图片块 |

几条实现上的硬规矩：

- **「运行中」是端到端判据**：握手成功 + `Target.setDiscoverTargets` + `Target.getTargets` 全成功才算。`endpoint.json` 在、端口有 HTTP 响应都不算。
- **同一 target 的命令排队**（页面操作必须有序），**不同 target 并行**。
- **页面来的字符串一律不可信**：标题、网址、正文、元素文字都包在 `<UNTRUSTED_PAGE_CONTENT>` 里。
- 页面正文由页面侧脚本抽取、宿主侧整理：页面侧只搬数据不做判断，所以注入的代码极小；判断（编号、掩码、可点性）是宿主侧的纯函数，可以被测试直接覆盖。

写类工具默认直接执行。把 `toolsWriteRequireApproval` 打开后，才要先点一次「允许模型操作」。这是**防误点**，不是访问控制。

---

## 配置

设置路径：**设置 → 插件 → 插件配置**（namespace `dsh-helper-plugin-workspace-browser`，落在 `<DSH_HOME>/settings.yaml`）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `capsuleEnabled` | 开 | 显示输入框那一行的胶囊 |
| `capsuleShowPort` | 开 | 胶囊文案里带端口号 |
| `panelAutoOpenOnLaunch` | 开 | 冷启动成功后展开当前会话的画面 |
| `panelLayout` | `focus` | 布局；`grid` / `single` 这期不实现 |
| `panelTileSplit` | `0.55` | 焦点区高度占比（拖分隔条后写入） |
| `panelFollowFrontTab` | 关 | 焦点跟随窗口里最顶层的标签 |
| `streamFocusFps` / `streamFocusMaxWidth` / `streamFocusQuality` | `2` / `960` / `70` | 焦点流；质量是 **0–100 的整数** |
| `streamThumbFps` / `streamThumbMaxWidth` / `streamThumbQuality` | `0.25` / `160` / `50` | 缩略图；帧率 0 表示不要缩略图 |
| `chromePath` | 空 | 手动指定的 `chrome.exe` |
| `chromeCrossOrigin` | 关 | 加 `--disable-web-security --disable-features=IsolateOrigins,site-per-process` |
| `startupUrl` | 空 | **默认起始页**：没有可恢复的标签时开这个网址；留空则开 `about:blank` |
| `instanceRestoreTabsOnReopen` | 开 | 用户**再次启动**时按记忆恢复标签（这就是"继续浏览上次打开的网页"） |
| `instanceOnDshExit` | `keep` | `keep`（浏览器继续活着）或 `close` |
| `toolsWriteRequireApproval` | 关 | 打开后，写操作要先点「允许模型操作」 |
| `toolsWriteAuthorized` | 开/关 | 你点过允许之后为开 |
| `toolsExposeEvaluate` | 关 | 为开才注册 `evaluate` |

`stream.*` / `panel.*` / `capsule.*` 立即生效；`chrome.*` / `instance.*` 改完要重启实例，并且会先提示。

---

## 控制面 HTTP

前缀 `/dsh-helper-plugin-workspace-browser`，路径里不带 workspaceKey（一个宿主进程只服务一个工作区）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/status` | `{ state, port, wsPath, pid, crossOrigin, chrome, settings, panelOpen, diagnostic }`。**不启动进程** |
| POST | `/launch` | `ensure()` |
| POST | `/stop` | 停止 |
| POST | `/cross-origin` | body `{ enabled }`，写入设置并重启 |
| POST | `/delete-data` | 停止并删除这个工作区的 profile |
| GET | `/targets` | 标签列表 |
| POST | `/panel-open` | 请求客户端展开画面 |
| POST | `/prefs` | P3：画面自己那几个设置（白名单：`panelTileSplit`、`panelLayout`、`panelFollowFrontTab`、`streamFocusFps`） |
| POST | `/tab-action` | P3：画面悬停菜单的三条动作 —— body `{ action: 'bring-to-front' \| 'close' \| 'open', targetId?, url? }` |

`/tab-action` 的 `bring-to-front` 是**唯一会抢焦点的动作**（`/json/activate/<id>`，等价于 `Page.bringToFront`），而且只能由用户点；`close` 走 `/json/close/<id>`，`open` 走 `/json/new?<url>`（新标签在后台）。画面 WebSocket 的上行只有 subscribe / unsubscribe / ack / visibility 四种，这三条动作走 HTTP —— 不把帧通道变成命令通道。

---

## 画面（P3）

右侧栏的正文，默认布局 `focus`：上面一张焦点画面，下面一排所有标签的缩略图（胶片条），中间的分隔条可拖并写回 `panelTileSplit`。

```
┌ 工作区浏览器 ────────── ⏸ 2fps  布局  ?  ● ┐
│  ┌────────────────────────────────┐        │
│  │         主画面（等比）          │        │
│  └────────────────────────────────┘        │
│  github.com/… › 登录          [切到前台]   │
│  ╔════╗ ┌────┐ ┌────┐ ┌──┐                 │
│  ║ ●  ║ │ ○  │ │ ○  │ │＋│                 │
│  ╚════╝ └────┘ └────┘ └──┘                 │
│   ▔▔▔▔                                      │
└─────────────────────────────────────────────┘
```

**三个标记（颜色 + 形状双编码，色盲友好，位置互不重叠）**：

| 标记 | 位置 | 含义 |
| --- | --- | --- |
| accent 外框（2px） | 整张缩略图四边 | 正在主画面里显示的那张 |
| accent 短横（下划线） | 图片下方独立一行 | 那个窗口里最顶层的标签 |
| 圆点（6px） | 图片左上角 | 绿 = CDP 已接管，灰 = 未接管 |

面板头的 `?` 展示同一张图例；每张缩略图悬停有 tooltip。下划线的判据是已接管页面的 `document.visibilityState === 'visible'`；窗口最小化导致全部 hidden 时**沿用最后一次结果**，tooltip 会写明「推断」。

**交互**：点缩略图只改「我在看哪张」，**不动真实前台**；悬停菜单是 `切到前台` / `关闭标签` / `复制 URL` / `在新标签打开`；`panelFollowFrontTab` 打开时焦点跟随最顶层标签。空态：未启动 →「启动工作区浏览器」；已启动无标签 →「新建标签页」；Chrome 有问题 →「重新检测 / 去下载 Chrome / 指定 chrome.exe」。

**连接**：只有这张卡片真的看得见（框架给的 `tab.visible`，含浮出的面板）才连画面 WebSocket，不可见就断开 —— 后端不会对着没人看的画面空跑。

### 画面 WebSocket

```
ws://127.0.0.1:<DSH 端口>/dsh-helper-plugin-workspace-browser/stream
```

升级时对端**不是回环地址就直接断开**（403）：这是避免画面流跟着 DSH 的监听地址走出去，不是登录校验。

| 方向 | 消息 |
| --- | --- |
| 上行 | `{ t:'subscribe', targetIds, role:'focus'\|'thumb', fps, maxWidth, quality, visible? }` |
| 上行 | `{ t:'unsubscribe', targetIds }` |
| 上行 | `{ t:'ack', targetId, seq }`（页面侧 ack：只决定这条连接要不要丢旧帧） |
| 上行 | `{ t:'visibility', visible }`（连接还在、面板不可见时用） |
| 下行 | `{ t:'frame', targetId, seq, ts, mime:'image/jpeg', dataB64, w, h }` |
| 下行 | `{ t:'state', targetId, capturing, attached, frontmost, frontmostInferred, reason }` |
| 下行 | `{ t:'targets', targets:[…], capture:{ state, reason, viewers, capturing, attached } }` |

服务端行为：每个 target 在 Chrome 上**只开一路** `Page.startScreencast`（`format: jpeg`、`quality` 0–100 的整数、`maxWidth`、`everyNthFrame: 1`），再分给各订阅者；收到 `Page.screencastFrame` **立刻**回 `Page.screencastFrameAck`（给 Chrome 的确认，不是给页面的）；只保留最新一帧，投递前过三道闸门（`1000/fps` 间隔、socket 发送缓冲、未 ack 积压），任何一道不过就丢这一帧；**任何一个可见订阅者存在就继续推，全部不可见才 `Page.stopScreencast`**（会话 B 关画面不影响会话 A）；缩略图只给最近活跃的 12 张开采集，其余只出标题。

---

## 数据与目录

```
<workspace>/.workspace-browser/          # 点开头 + 隐藏属性，用户默认看不到
├── .gitignore          # 内容 `*`，git 自动忽略整个目录
├── chrome-profile/     # --user-data-dir，Chrome 自己维护
├── shots/              # 模型截图落这里（P1）
└── endpoint.json       # 本插件写，只是线索
```

- **数据跟着工作区走**：目录在工作区里、名字点开头、并设了 Windows 隐藏属性；删工作区就一起清掉。未分组会话（没有工作区）才退回 `<DSH_HOME>/workspace-browser/_ungrouped/`
- 目录里自带一份 `.gitignore`（内容 `*`），所以你 `git add .` 也不会把这几千个文件带进去
- 工作区里**已经有 `.gitignore`** 时，会顺手把 `.workspace-browser/` **追加**进去（幂等；没有那个文件就不替你建）
- 从旧版本升级时，**老位置的数据会自动迁过来**（`rename`，同盘瞬时），登录态不丢
- `workspaceKey` = `<工作区目录名>-<路径哈希前 8 位>`；未分组时是 `_ungrouped`
- **每个工作区一套 profile ⇒ 换工作区要重新登录**站点
- `endpoint.json` 只是线索：它在不代表浏览器还活着

---

## 本机验证

```bash
npm test                      # 纯逻辑 + 严格 ctx 挂载 + CDP 帧/客户端 + 读类工具（逐个直接跑）
node test/screencast.test.mjs # P3 服务端：帧率限流、可见性计数、12 张缩略图、丢帧
node test/stream.test.mjs     # P3 协议：帧编解码、回环校验、端到端画面流
node scripts/verify-p0.mjs    # 真机：起 Chrome、停、假 endpoint.json、kill -9（15 项）
```

`verify-p0.mjs` 会**真的打开一个 Chrome 窗口**（冷启动是本阶段验收项），跑完自己收尾。

### P1 自动化测试

`node test/cdp.test.mjs`（15 项）与 `node test/tools.test.mjs`（20 项）不需要真实 Chrome：

- 前者用手写的 RFC6455 编解码器互测，并对着一台**假 Chrome**（`test/helpers/fake-chrome.mjs`，同样用本仓库的帧编解码器）验证握手、掩码、分片、事件、同 target 排队 / 跨 target 并行、超时、断线 reject 在途请求。
- 后者用一段固定 HTML + 极简 DOM 跑 `snapshot` 的页面侧抽取，断言编号、可点元素、`password` / `hidden` / 名字敏感字段的掩码；再用 `node:vm` 执行宿主发过去的表达式，把五个工具对着假 Chrome 端到端跑通。
- **没有**覆盖到的：真实 Chrome 上的 `Runtime.evaluate` 行为、真实页面的可见性判定、`Page.captureScreenshot` 的真实输出、附件服务的真实入库。这些要有真机才能验。

### P3 自动化测试

`node test/screencast.test.mjs`（12 项）与 `node test/stream.test.mjs`（17 项）也不需要真实 Chrome，同样对着一台**假 Chrome** 跑：

- **screencast**：帧率限流（2 fps 两秒只投 4 帧）、可见性计数（A 可见 B 不可见仍推；都不可见才停）、缩略图上限 12（第 13 张不开采集，挤出前 12 的那张会被停掉）、一个 target 只开一路采集且参数取较高者、每帧立刻回 `Page.screencastFrameAck`（带的是采集会话 id）、背压丢帧（socket 缓冲过高、未 ack 积压）、最顶层标签（全 hidden 时沿用上一次结果并标「推断」）。
- **stream**：服务端帧不带掩码 / 客户端帧带掩码、16 与 64 位长度、分片拼接、控制帧插队、`Sec-WebSocket-Accept`、上行消息解析（含非法消息不崩）、回环校验（非回环 403 断开）、**裸套接字端到端**（101 握手 + 第一条就是 `targets` + 服务端首帧无掩码位）、真 `WebSocketClient` 端到端（subscribe → state → frame → ack → 垃圾消息不断连接 → visibility 停采集）。
- **客户端半边**：画面中枢（可见才连、按角色分两路订阅、收帧回 ack、暂停保留画面、不可见断开清缓存）、正文三条渲染路径（未启动 / 无标签 / 焦点 + 胶片条，含「推断」tooltip 与可拖分隔条）、`POST /prefs` 与 `POST /tab-action` 的校验。
- **没有**覆盖到的：真 Chrome 的 screencast 输出与 `deviceWidth/deviceHeight`、`document.visibilityState` 在最小化/被挡住时到底可不可靠（DESIGN §10 的待实测项）、真浏览器里 `<img>` 的等比留白观感、拖分隔条的手感。这些要有真机 + 真浏览器才能验。

### P0 实测结论（2026-09-25，本机）

15 项真机判据全部通过，12 项自动化测试通过。四条与设计假设不同、已按实测调整的实现：

1. **`chrome.exe --version` 从 Node 里 pipe 起来时不输出内容** —— Chrome 是 GUI 程序，`--version` 依赖控制台附着。所以版本改为优先读 **PE 文件版本资源**（`VersionInfo.ProductVersion`），`--version` 只作第一尝试。
2. **本机没有 `HKLM\SOFTWARE\Google\Chrome\BLBeacon`** —— 注册表这条探测在这台机器上拿不到版本，文件版本资源是唯一可靠来源。
3. **受限沙箱里 `Get-CimInstance Win32_Process` 被拒绝** —— 命令行查询拿不到进程时，降级为"按 `endpoint.json` 记录的 PID 结束残留"，并只在该 PID 还活着、CDP 又不响应时才动手。
4. **`/status` 的轮询路径完全不 spawn 进程**，只做文件存在性检查 —— 两秒一轮去开 `reg.exe` / `where.exe` 既贵，又会在 `execFile` 遇到 EPERM 时漏管道句柄。注册表与 PATH 只在「启动 / 重新检测」时才查。

另外，客户端在快速探测报 `missing` 时**仍然放行「启动」**：宿主会在真正启动前做一次彻底探测（注册表 + PATH），说不定快速探测没找到而它找得到；真找不到也会给出明确原因。

---

## 现状（按阶段）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P0** | `ensure()`、硬超时、按 user-data-dir 结束残留、Chrome 探测、胶囊与小面板、profile 目录、`endpoint.json`、控制面路由、设置命名空间 | ✅ 已实现并真机验证（15 项） |
| P1 | CDP 客户端与读类工具（含 `select_tab`） | ✅ 已实现，**真机通过**：`snapshot` / `get_text` / `list_tabs` / `select_tab` / `screenshot` 对真实页面全部验证 |
| P2 | 写类工具与「允许模型操作」 | ✅ 已实现并接线（11 个写类工具） |
| P3 | 画面（screencast、多路订阅、12 张缩略图、`focus` 布局与分隔条） | ✅ 服务端**真机通过**（929×917 JPEG、全部不可见即停推）；客户端面板已交付（焦点 + 胶片条、三通道状态、可拖分隔条、三种空态） |
| P4 | 关窗 500ms 防抖与恢复标签 | ✅ 防抖 + 标签记忆/恢复都在；CDP 事件已在 P3 接上 |
| P5 | `/browser`、设置卡片、删除数据、静默回归 | ✅ `/browser` 已接线（12 项测试）、设置卡片已实现（19 项配置、6 个分组）、`/prefs` 与 `/tab-action` 已就位 |

**测试总量：编码门禁 + 9 个测试文件，110 项左右自动化用例（全绿）；真机脚本 15 + 24 项（全过）。**

### 真机端到端验证

```bash
node scripts/verify-live.mjs    # 真起 Chrome：实例 → CDP 握手 → 读/写工具 → 画面
node scripts/verify-p0.mjs      # P0 回归：起停、假 endpoint.json、kill -9
node scripts/check-encoding.mjs # 门禁：找出非法 UTF-8 的源文件
```

`verify-live.mjs` 会真开一张 `data:` 页，用**工具定义本身**去读它（快照 / 取文 / 列标签 / 截图 / 切标签），再验证画面的帧、MIME、尺寸与"不可见即停推"。工具参数名不写死 —— 脚本从 `definition.parameters.properties` 里读，所以各阶段换了参数名也不会让脚本失效。

**真机跑出来的五个问题（都已修）**

1. **`/browser` 开完新标签没切默认 target** —— 命令把 targetId 告诉模型，可后续工具还在操作旧标签，两边各说各话。现在 `openTab` 之后会 `selectTarget()`。
2. **`Target.createTarget` 必须走浏览器级命令** —— 走普通 `command()` 会被 attach 到某个标签的会话上。为此给 CDP 客户端加了 `commandBrowser()`。
3. **`lib/write-tools.js` 曾整文件写成 GBK 乱码**（4507 处非法 UTF-8，还吞掉一个收尾引号）。`node --check` 抓不到这种损坏，于是加了 `scripts/check-encoding.mjs` 当门禁，并放进 `npm test` 第一步。
4. **`chrome.exe --version` 会拉起用户日常的 Chrome**（最严重的一条）。Windows 上它是 GUI 程序，非交互会话里 `--version` 不会被处理成"打印版本"，而是**把命令行交给已经在跑的默认 profile 实例** —— 用户的日常浏览器被切到 profile 选择器。实测：
   ```
   跑 --version 前：  pid 24176 窗口标题 = "支付明细 · dsh-helper 管理 - Google Chrome"
   跑 --version 后：  pid 24176 窗口标题 = "Google Chrome"     ← 变成「谁在使用 Chrome?」
   stdout = "在非交互式会话中打开。"（压根没输出版本号）
   ```
   触发路径正是用户点「启动」：`ensure()` → `coldStart()` → 探测版本。**现在探测路径永不执行 `chrome.exe`**：版本改读 **PE 文件版本资源**，失败退注册表，再失败标 `version-unconfirmed`（不阻塞启动）。`test/smoke.test.mjs` 里加了门禁——源码里再出现 `--version` 就红。
5. **有内容的标签一直显示「这张标签还没有画面」**。`Page.startScreencast` 是**事件驱动**的：Chrome 只在页面视觉变化时推 `Page.screencastFrame`。而服务端原来也只在收到帧事件时才投递 —— 于是"这一路采集早就开着（别人订过、焦点切走又切回、面板重新可见）"时，后订上来的观众**永远等不到初始帧**，哪怕缓存里明明有帧。现在**订阅时立刻补投缓存里的最新帧**（并跳过帧率间隔这一次），面板从不可见变回可见时同样补投。回归测试在 `test/screencast.test.mjs`（12 → 14 项）。


### 设置卡片为什么可能"看不见"

「设置 → 插件 → 插件配置」里出现本插件，取决于**两份账本的交集**：

1. 宿主半边注册了 settings namespace（`ctx.settings.installSection`）
2. **浏览器半边**在插槽 `settings.plugin.item` 注册了 `key` = 同一个 namespace 的卡片

少任何一条那一栏就是空的。两者都在本仓库里，注册成功时浏览器控制台会打一行
`[dsh-helper-plugin-workspace-browser] 注册插件配置卡片：…`，排障时可以看它。

---

## 许可证

MIT
