# 工作区浏览器：实现说明

这份文档给改代码的人。怎么安装、怎么用，看 [README.md](README.md)。这里按实现写：入口、状态、接口、目录和当时为什么这样定。同一条规则只在一处写完整。

**怎么读**

| 你想弄清 | 读 |
| --- | --- |
| 点一下会发生什么 | 第 1–4 节 |
| 画面长什么样 | 第 5 节 |
| 模型怎么用 | 第 6 节 |
| 写代码时的接口、目录、配置 | 第 7–8 节 |
| 各阶段做到什么算完成 | 第 9 节 |
| 还没定的 | 第 10 节 |

文中的「已核实」表示在本机 DSH 里对过，不是猜的。

名词就这五个：

- **胶囊**：输入框那一行的按钮。点击只打开小面板。
- **小面板**：胶囊展开后的菜单（启动、停止、复制端点等）。
- **画面**：右侧栏里的实时镜像。
- **启动**：小面板、画面空态、会话头部、`/browser` 上的那一下。内部叫 `ensure()`。
- **profile**：这个工作区专属的 Chrome 用户数据目录。

---

## 1. 三个入口

```
点胶囊          → 只打开小面板，不启动浏览器
点「启动」      → ensure()，窗口出现
关掉浏览器窗口  → 大约半秒后显示「未启动」，不会自己再打开
再点「启动」    → 一定还能起来
```

### 胶囊

挂在 `conversation.input.right`（`id: workspace-browser`，`order: 10`）。任何状态下点击都打开小面板，包括正在检测 Chrome、正在启动、正在停止。

小面板里有：

- **启动 / 重试**：调用 `ensure()`
- **停止**：先确认，见第 4 节
- **复制端点**
- **跨域开关**：写入设置并重启，见第 4 节
- **打开浏览器画面**
- **允许模型操作**：还没授权时出现，见第 6 节

胶囊可以在插件配置里关掉（`capsuleEnabled`，默认开）。

### 会话头部不放按钮

打开画面已经有胶囊小面板、`/browser` 和启动后自动展开。会话头部不再挂图标。插槽 `conversation.session.header.utilities` 本身可用（`list` 型），如果以后要加回来，用 `id: workspace-browser`，放在「在本地打开」旁边即可。

### `/browser`

用户输入的命令，明确是「用这个工作区的 Chrome」。解析和交给模型的内容见第 6 节。命令会让**当前这一个会话**的右侧栏展开。

### 画面什么时候出现

插件加载时右侧栏不打开。下面几种情况会打开**触发它的那一个会话**：

1. 小面板里的「打开浏览器画面」
2. `/browser`
3. 冷启动成功，且 `panelAutoOpenOnLaunch` 为开（默认开）

刷新页面后右侧栏会回到收起。这是框架的限制，见第 7 节。

---

## 2. 已定规则

| | 规则 |
| --- | --- |
| 能力 | 胶囊 + 工具 + 画面，一次做完。工具名固定 `workspace_browser_*`，可以和别的 `browser_*` 插件同时装 |
| 数据 | 每个工作区一套 profile，换工作区要重新登录。目录是**工作区里的隐藏子目录** `<workspace>/.workspace-browser/`（点开头 + Windows 隐藏属性），未分组时才退回 `<DSH_HOME>/workspace-browser/_ungrouped/` |
| 窗口 | 插件自己只在已有窗口里开标签。用户 Ctrl+N、登录弹窗、`window.open` 产生的窗口留在胶片条里，不合并、不关闭 |
| Chrome | 没装或版本过低就拒绝启动，并给出下载、指定路径、重新检测。不代为下载 Chrome |
| 图标 | 自绘「浏览器窗口」简笔，可用时用品牌色。不带 Google 官方 logo |
| 安全 | 本机自用。调试端口无 token。写操作默认要用户点一次「允许模型操作」，这是防误点，不是访问控制 |
| 路由 | HTTP 和画面 WebSocket 都用前缀 `/dsh-helper-plugin-workspace-browser/` |
| 多会话 | 共用这一套标签页，不做隔离。同一标签上的命令按到达顺序执行；不同标签可以并行 |
| 静默 | 用户点「启动」时窗口出现。除此之外，模型的导航、点击、开标签、截图都不把窗口带到前台 |
| 关窗 | 回到「未启动」，不自动重开。胶囊永远开得了小面板，「启动」永远还能再拉起 |

一个 DSH 宿主进程只服务一个工作区。没有工作区时，目录名用 `_ungrouped`。两个工作区就是两个宿主进程。

---

## 3. 屏幕上的状态

用户只看到五种实例状态：

`未启动` · `启动中` · `运行中` · `停止中` · `失败`

Chrome 是否装好，是另一路信息，不塞进这五个词里。胶囊文案按下面顺序，用第一条说得上的：

1. 启动中，或停止中
2. 失败（带原因和「重试」）
3. 未启动，并且 Chrome 缺失 / 过低 / 有多个候选
4. 运行中 · 端口（可用设置关掉端口）
5. 未启动

图标是简笔窗口，不是 Chrome 产品图标。失败为红色角标，环境问题为黄色角标，运行中加一个绿点。悬停显示路径和版本；找不到时列出找过的位置。

**怎样才算运行中：** 连上 CDP，并且 `Target.getTargets` 成功。`endpoint.json` 在、或者端口有 HTTP 响应，都不算。

端口文件出现，只说明可以开始连，不能单独把状态打成运行中。

探活失败和启动失败分开：

- 旧端口连不上、进程已经没了 → **未启动**。内部可以记 `endpoint-stale`，界面上不写这个词。
- 启动超时、进程结束不掉、`--version` 超时 → **失败**，留下原因。
- 没装、过低、多个候选 → 保持未启动，用 Chrome 那一路文案。点「启动」不会去 spawn。

内部还可以记「锁还在」「没有页面」「还连着进程」，只给排查用，不进胶囊文案。

---

## 4. 启动、停止、关窗

### `ensure()`

「启动」和「重试」都走这一步。胶囊点击不走。

1. **正在启动**：跟上这一次，不另起一次。
2. **正在停止**：最多再等 8 秒，然后继续。
3. **CDP 通着，且至少有一个页面**：直接用，不把窗口带到前台。
4. **CDP 通着，但没有页面**：在这个进程里开窗口。这是用户要求启动，窗口出现在前台。
5. **CDP 不通**：结束命令行里带有这份 `--user-data-dir` 的 Chrome，确认锁释放，再冷启动。`endpoint.json` 里的 PID 只帮着找进程，不单独拿去 `taskkill`。
6. **到点必须落地**：启动最长 15 秒（等端口文件最多 10 秒，再等 `getTargets` 最多 3 秒）。停止最长 8 秒（`Browser.close` 最多 3 秒，然后按 user-data-dir 结束进程，再等最多 3 秒）。到点只能是运行中、未启动或失败。

冷启动时窗口出现。已经在运行时，模型再开的标签用后台方式，不抢焦点。用户点「切到前台」是画面上单独的一个按钮。

第 4 步或冷启动要恢复标签时：有记住的网址就不带 `about:blank`，也不加 `--restore-last-session`。第一个页面在前台，其余在后台。没有可恢复的网址时才开 `about:blank`。

`lastKnownTabs` 最多 20 条，跳过 `about:blank` 和 `chrome://`。只在用户再次启动且 `instance.restoreTabsOnReopen` 为开时使用。关窗不会自动用它重开。

### 关窗

用户关掉窗口就是不干了，界面回到未启动。不区分进程是否还在，也不弹错误。

- **CDP 断了**：立刻变为未启动，并忘掉「还连着」的记录。
- **CDP 还在，页面没了**：等 500 毫秒。若仍然没有 `type === 'page'` 的页面（排除 `devtools://` 和扩展页），再变为未启动，并记住这条连接。下次「启动」走上面的第 4 步，不再 spawn 第二个进程。这 500 毫秒是为了避开「关掉最后一个标签，Chrome 马上又开一个新标签」。
- **正在启动**：不因为暂时还没有页面就改成未启动。

另外每 3 秒做一次心跳，防止事件漏掉。进程被杀掉后，一个心跳周期内回到未启动。

### 停止

停止作用于这一个宿主里的那一个浏览器。确认文案：

> 停止会关掉这个工作区的浏览器，所有会话都会失去它。确定停止？

不统计「有几个会话正在用」。右侧栏没有枚举接口，这个数字拿不到。也不做引用计数，避免谁也停不掉。

### 跨域

真源只有设置项 `chrome.crossOrigin`（默认关）。小面板的开关调用 `POST /cross-origin`，写入这项，提示「要重启，已打开的标签会关掉」，然后按记住的网址再开。`endpoint.json` 只记录这次实际用过的值。

打开时同时加上：

```
--disable-web-security
--disable-features=IsolateOrigins,site-per-process
```

只加前一个，现在的 Chrome 里跨域请求仍可能被拦。

### 工作区没了

先停止实例。profile 留在 `DSH_HOME` 里，插件不跟着删。设置里有「删除这个工作区的浏览器数据」，对应 `POST /delete-data`：先停，再删这个 `workspaceKey` 的目录。

DSH 退出时浏览器默认继续活着（`instance.onDshExit = keep`）。可以改成随 DSH 关闭。

---

## 5. 画面

右侧栏是这个插件会不会被留下的地方。默认布局是**焦点 + 胶片条**：上面一大张当前标签，下面一排所有标签的缩略图。

```
┌ 工作区浏览器 ────────── ⏸ 2fps  布局  ?  ⚙ ┐
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

外框 = 正在主画面里看的这张。下划线 = 那个窗口里最顶层的标签。圆点 = 已接管（绿）或未接管（灰）。三个位置不重叠，悬停有字。面板头的 `?` 展示这张图例。

下划线的判据是已接管页面的 `document.visibilityState === 'visible'`。有两个窗口时，可以同时有两张带下划线。窗口最小化、全部变成 hidden 时，沿用最后一次的结果，tooltip 标明是推断。这一条还要实测（第 10 节）。

接管是按需的：工具碰过的标签，以及正在画缩略图的标签，才是绿点。面板关着时，没被碰过的标签保持灰点。

所有画面按原始视口比例缩放，不拉伸、不裁剪。焦点区宽度撑满，高度按比例；高度不够时改为按高度限制，左右留白，用面板底色。缩略图同样等比。CDP 只限制宽度，高度由 Chrome 按原比例给出。高 DPI 先按 `devicePixelRatio` 校正，仍然等比。

点缩略图只改变「我在看哪张」，不动真实前台。可以打开「跟随最顶层标签」（默认关）。悬停菜单：切到前台、关闭标签、复制 URL、在新标签打开。「切到前台」会抢焦点，必须用户自己点。

空态：未启动时一个大按钮「启动工作区浏览器」（调用 `ensure()`）；已启动但没有标签时是「新建标签页」。Chrome 有问题时，复用「重新检测 / 去下载 / 指定 chrome.exe」。

### 帧

数字以这张表为准。`quality` 是 **0–100 的整数**，对应 `Page.startScreencast` 的 `quality`。

| | 默认 | 可调 |
| --- | --- | --- |
| 焦点 | 2 fps，宽 960，质量 70 | 0.5–10 fps |
| 缩略图 | 0.25 fps，宽 160，质量 50 | 关，或 0.1–1 fps |
| 张数 | 最近活跃的 12 张有画面 | 其余只显示标题，不开采集 |

每个 target 在 CDP 上只开一路采集，再分给各个会话。收到 `Page.screencastFrame` 后立刻 `Page.screencastFrameAck`。不等浏览器页面回 ack；页面的 ack 只决定这条 WebSocket 要不要丢旧帧。`bufferedAmount` 过高时只留最新一帧。

谁在看，按可见订阅者计数。任何一个会话的 `tab.visible === true`（含浮出的面板）就继续推。全部不可见才停。会话 B 关掉画面，不能把会话 A 的帧停掉。

总带宽大约 4 Mbps，超出时先降缩略图帧率。

### 布局与拖拽

目前只做 `focus`：焦点区和胶片条之间的分隔条写入 `panelTileSplit`（默认 0.55），胶片条和技能区之间的分隔条写入 `panelSkillHeight`（默认 72）。`grid` 和 `single` 留在配置里，界面上显示尚未提供。拖拽不改变真实窗口大小。

右栏有多宽、能不能浮出，用框架已有的能力，自己不重做：

| 层 | 谁提供 | 行为 |
| --- | --- | --- |
| 右栏宽度 | `dsh-client-ui-layout` | 普通展开时有拖拽区；记住用户的像素宽度，上限约 70% |
| 左右分栏 | dockkit | 最多两格，分隔条约 20%–80%。`split()` 空间不够时返回空 |
| 浮出 | `float(tabId)` / `dock(paneId)` | 浮窗的拖动和缩放由框架负责。浮出后面板列收起也照样画 |
| 焦点 / 胶片条 / 技能区 | 本插件 | 两条分隔条，写入 `panelTileSplit` 和 `panelSkillHeight` |

刷新会收起右栏。全屏或右栏关闭时没有宽度拖拽区。

---

## 6. 模型怎么用

### 工具

插件加载时就注册，不随实例启停增减。实例没起来时，调用返回结构化错误，模型可以原样告诉用户。

前缀是常量 `workspace_browser_`，不放进设置。改前缀会和「重名直接抛错」「工具列表一变就冲掉提示词缓存」撞上。

| 级别 | 工具 | 作用 |
| --- | --- | --- |
| 读 | `snapshot` | 先给可见正文（供总结），再给无障碍树编号 `e1`、`e2`。敏感值掩码 |
| 读 | `get_text` | 默认读 `main` / `article` 的可见文字，默认最多 12000 字 |
| 读 | `list_tabs` | 这个工作区的标签，没有「属于哪个会话」 |
| 读 | `select_tab` | 改之后命令的默认标签，并把画面焦点切过去。不把窗口带到前台 |
| 读 | `screenshot` | 一张 PNG |
| 写 | `click` `type` `press` `scroll` | |
| 写 | `navigate` `open_tab` `close_tab` `back` `forward` `reload` | |
| 写 | `wait` | 等到页面稳定 |
| 可选 | `evaluate` | 任意 JS。默认不注册 |

`open_tab` 使用 `Target.createTarget`，不带 `newWindow`。`background: true` 的参数名还要实测；在核实前，已在运行时新开的标签不得把窗口带到前台。

写类工具返回实际作用的 `targetId`、url、title。

页面正文按 DSH 的 `<UNTRUSTED_PAGE_CONTENT>` 包起来。

能力提前写成一套，所有网站共用。模型每次只决定打开哪个网址、点哪个编号、正文怎么总结。模型不写页面脚本、CSS 或点击坐标。`evaluate` 默认关闭。截图不参与认元素。

正文和点击走 `playwright-core` 的 `connectOverCDP`，连到已经启动的 Chrome。进程、标签、画面、截图仍走 CDP。第一次需要读写页面时，若插件旁和 `<DSH_HOME>/workspace-browser/vendor/` 都没有这个库，就在 vendor 里安装钉死的 `playwright-core`，不下载浏览器。装不上时读写工具返回 `playwright-missing`，浏览器和画面照常。编号只对当前快照有效；写操作返回新快照，树没变时只说明无变化。正文为空时返回 `page-empty` 和原因，不当作成功。

### 技能

跑通的任务可以存成技能，文件在 `<workspace>/.workspace-browser/skills/<名字>.md`。存的是步骤说明，不存编号。这不是宿主 `.dsh/skills` 里的 SKILL.md。

新增和修改都在输入框里完成，胶片条下面不填表。用户输入 `/browser 新增技能`、`/browser 新增skill`、`/browser 保存skill` 或 `/browser 修改skill`，后面可以再带名字或补充。这些字只是线索。模型先复述意图（新建、把刚才的操作存下来，还是改已有技能），列出准备采用的名字和步骤，用户同意之后才调用 `workspace_browser_save_skill`（`confirm: true`）。修改用同一个名字覆盖。

胶片条和技能区之间有分隔条，高度写入 `panelSkillHeight`（默认 72，40–360）。说明收在「Skill」上，鼠标停上去才展开。名字横排换行，停在名字上会变色。右键菜单向上展开，避免被底边挡住：加入对话、查看（打开工作区里的技能文件）、在文件资源管理器中显示。画面可见时大约每两秒重新读取名单，模型保存或修改之后右侧栏自己更新。输入框 `@` 插入同一张芯片：脸上只有技能名，发给模型时才展开全文。芯片不自动发送。评论和发送默认先停下来等用户确认。

没装 Chrome、版本过低时，错误码是 `chrome-not-installed`、`chrome-version-unsupported`，带人话和 `hint.actions`（`install` / `set-path` / `recheck`）。实例未启动是 `browser-not-running`。启动过程失败是 `chrome-launch-failed`。

### 允许模型操作

`tools.writeRequireApproval` 默认关，写操作直接执行。打开之后，`tools.writeAuthorized` 默认关；未授权时写工具返回 `write-not-authorized`，文案告诉用户点「允许模型操作」。按钮在小面板和画面头上，点下去写入设置，一直有效，直到在插件配置里关掉。

`evaluate` 仍由 `tools.exposeEvaluate` 控制，默认不出现。

### `/browser`

必须注册成宿主命令。DSH 对没注册的 `/xxx` 直接报错，不会当成普通输入。命令注册表自己不往对话里塞内容；要模型接着做，handler 里调用 `agent.followup(createUserMessage(...))`。`rawInput` 是命令名后面的整行，没有 argv，我们自己切。

客户端不注册同名 `commandUi`，两边同名会冲突。

| 输入 | 插件先做 | 模型收到 |
| --- | --- | --- |
| `/browser` | `ensure()`，并打开当前会话的画面 | 没有新消息 |
| `/browser https://…` | 冷启动时，这个 URL 就是窗口里的第一页。已经在跑：去掉 `#` 后若已有相同 URL 就用那张标签，否则后台新开 | 网址和 `targetId` |
| `/browser https://… 后面的话` | 同上 | 再加上这段话，并写明必须用 `workspace_browser_*` |
| `/browser 一段没有网址的话` | `ensure()`，打开画面，不开标签 | 整段话，由模型自己 `navigate` / `open_tab` |
| `/browser --new https://…` | 即使已有相同网址也新开一张 | 同有网址的一行 |
| `/browser 新增技能`、`新增skill`、`保存skill`、`修改skill` | `ensure()`，打开画面，把已有技能名一并交给模型 | 先确认意图，用户同意后才调用 `workspace_browser_save_skill` |

`--new` 后面没有网址：返回错误文字，不启动、不给模型发消息。技能命令后面的字只是线索，不当作已经定下的名字。

已在运行时复用标签，不抢焦点。用户要看真实窗口，点画面上的「切到前台」。

打开画面的信号走 `GET /status` 里的 `panelOpen: { sessionId, epoch }`。只有会话 id 对得上的那个胶囊去 `openTab`。画面的 WebSocket 承担不了这件事，因为画面还没打开时连接还不存在。没有挂上会话面时，`openTab` 会抛错，接住后只留文字提示。

交给模型的是一条文件 mention（`@"外部浏览器｜…/<标签>"`）。气泡默认只显示最后一个斜杠后面的标签（用户的要求；没有要求时用页面标题或主机名），整段说明不铺开。鼠标悬停的提示和模型收到的是同一段：用本工作区的 Chrome，只能调用 `workspace_browser_*`；有 targetId 就先 `select_tab`，没有网址就自己 `navigate` 或 `open_tab`，然后 `snapshot`。不要用 DSH 自带的网页抓取、搜索，也不要调用 `browser_*`。

---

## 7. 接到 DSH 的方式

宿主半边注入 `webServer`、`tools`、`workspace`、`homePaths`、`settings`、`commands`。客户端半边注入 `slots`、`locale`、`sidebarRight`、`sidebarRightTabs`。路由、设置、命令的注册都放在 `ctx.effect` 里，卸载时自动撤下。重复注册同一路径或同一工具名会抛错。

### 插槽

| 放什么 | 插槽 | 注意 |
| --- | --- | --- |
| 胶囊 | `conversation.input.right` | list。不要碰 `conversation.input.model`，那是模型选择器 |
| 会话头部 | 不使用 `conversation.session.header.utilities` | 打开画面从胶囊或右侧栏走 |
| 画面正文 | `sidebar.right.pane.tab`，key = `workspace-browser/mirror` | 先 `sidebarRightTabs.register`，`kind` 为 `workspace-browser-mirror` |
| 设置卡片 | `settings.plugin.item`，key = 下面的 namespace | 没有这张卡片，设置页里就看不到 |

`openTab('workspace-browser-mirror')` 会顺带展开整列。正文用 `useTabInfo()` 拿到 `{ sidebar, panel, tab }`，`tab.visible` 表示这张卡片现在看不看得见。

右侧栏每个会话一张，没有 workspace 级插槽。画面内容用客户端上的一个单例（`ctx.provide`），各会话订同一份。展开与否仍是每个会话自己的，而且只在内存里。

关掉「唯一一个非引导 tab」会把整列收起。没有关闭 pane、也没有枚举 tab 的公开 API。所以不做「自动收起」。

### HTTP

前缀 `/dsh-helper-plugin-workspace-browser`。路径里不带 workspaceKey，因为一个进程只有一个工作区。


| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/status` | `{ state, port, wsPath, pid, crossOrigin, chrome, panelOpen, diagnostic }`。不启动进程，也不跑 `chrome --version` |
| POST | `/launch` | `ensure()`。跨域从设置读 |
| POST | `/stop` | 停止 |
| POST | `/cross-origin` | body `{ enabled }`，写入设置并重启 |
| POST | `/delete-data` | 停止并删除这个工作区的 profile 目录 |
| GET | `/targets` | 标签列表，无会话归属 |
| GET | `/skills` | 技能名单；`?name=` 取全文和发给模型的展开文本 |
| POST | `/skills/locate` | body `{ name, action }`。`open` 打开技能文件，`reveal` 在文件资源管理器中选中 |
| POST | `/skills` | 确认后保存技能（body 里 `confirm: true`） |
| DELETE | `/skills` | 删除一个技能 |

`status.chrome`：`state` 为 `ok | missing | too-old | ambiguous | probing`，外加 `path`、`version`、`minVersion`、`candidates`。

`diagnostic` 可选，例如 `endpoint-stale`、`lock-held`、`latched`。界面不展示。

### 画面 WebSocket

`ws://127.0.0.1:<dsh 端口>/dsh-helper-plugin-workspace-browser/stream`

升级时如果对端不是回环地址，直接断开。这是避免画面流跟着 DSH 的监听地址走出去，不是登录校验。

上行：

```json
{ "t": "subscribe", "targetIds": ["…"], "role": "focus", "fps": 2, "maxWidth": 960, "quality": 70 }
{ "t": "unsubscribe", "targetIds": ["…"] }
{ "t": "ack", "targetId": "…", "seq": 1 }
```

下行：`frame`（`mime: image/jpeg`，`dataB64`，宽高）、`state`、`targets`。

WebSocket 注册用 `registerUpgrade`，实现方式照 `dsh-api-gateway` 的 `WebSocketServer({ noServer: true })`。帧不走 DSH 原有的会话通道。

### CDP

连 `ws://127.0.0.1:<端口><wsPath>`。`wsPath` 来自 `DevToolsActivePort` 第二行。

- `Target.setDiscoverTargets({ discover: true })`
- 需要时 `Target.attachToTarget({ targetId, flatten: true })`，之后命令带 `sessionId`
- 同一 target 的命令排队；不同 target 可以并行
- 事件：`targetCreated` / `targetDestroyed` / `targetInfoChanged`、`Page.screencastFrame`、`Page.frameNavigated`

一个工作区一个 Chrome 进程、一个调试端口。里面可以有多张标签，也可以有用户另开的窗口，都走这一个端口。画面通道用的是 DSH 的端口，不是 Chrome 的端口。

### 命令与设置

```js
ctx.commands.register({
  name: 'browser',
  description: '用工作区里那个真 Chrome 干活（外部浏览器）',
  input: { hint: '[--new] [url] [指令]' },
  handler,
})
```

设置：`ctx.settings.register('dsh-helper-plugin-workspace-browser', schema)`。namespace 要匹配 `/^[a-z][a-z0-9-]*$/`。存在 `<DSH_HOME>/settings.yaml`。客户端用 `ctx.settingsScope.bind({ namespace })` 读写。界面路径是 **设置 → 插件 → 插件配置**。`plugin-inventory` 只是清单，不是配置页。

`stream*`、`panel*`、`capsule*` 立即生效。`chrome*`、`instance*` 改完要重启实例，并先提示。

安装时若 `cordis.patch.yml` 里已经 insert 了同一个 loader id，会报 `duplicate loader entry id`。README 里要写这一步。

可以照着抄的第一方插件：`dsh-client-ui-open-in-app`（图标按钮）、`dsh-session-log-export`（同一插槽的第二个按钮）、`dsh-client-ui-sidebar-files`（注册 tab）、`dsh-client-ui-sidebar-documentpreview`（`useTabInfo`）。本机没有 `@yuxianglin/dsh-bridge-browser`，不要拿它当模板。

---

## 8. Chrome、目录、配置

### 去哪找 chrome.exe

Windows 上按这个顺序，命中多个则 `ambiguous`，让用户选，并记到 `chrome.path`：

1. `chrome.path`（用户指定，压过自动探测）
2. `HKLM\SOFTWARE\Google\Chrome\BLBeacon` 的 version，配合 `App Paths\chrome.exe`
3. `HKCU` 和 `WOW6432Node` 下的同样位置
4. `%ProgramFiles%\Google\Chrome\Application\chrome.exe`，以及 `%LocalAppData%` 下的同样路径
5. `where.exe chrome`
6. **PE 文件版本资源**（`VersionInfo.ProductVersion`，用 PowerShell 的 `Get-Item` 读）

轮询 `/status` 只看注册表和文件在不在，不启动进程。

版本来源的顺序实测后改成：**PE 文件版本资源 → 注册表值 → 未知**。**探测路径永不执行 `chrome.exe`。**

原因是第二次真机排查发现了更严重的副作用：Windows 上 `chrome.exe --version` 在非交互会话里**不打印版本**，而是把命令行**交给已经在跑的默认 profile 实例** —— 用户的日常浏览器被切到「谁在使用 Chrome?」选择器。实测对照（同一台机器、同一次会话）：

```
跑 --version 之前：  pid 24176 窗口标题 = "支付明细 · dsh-helper 管理 - Google Chrome"
跑 --version 之后：  pid 24176 窗口标题 = "Google Chrome"
chrome --version 的 stdout = "在非交互式会话中打开。"
```

用户点「启动」就会撞上它（`ensure()` → `coldStart()` → 探测版本），所以这属于**必须修**的行为，也违背 D10 静默原则。三者都拿不到版本时不阻塞启动，只带 `diagnostic: 'version-unconfirmed'` 与空版本 —— 把能正常跑的 Chrome 判成「不可用」比版本未知更糟。回归门禁在 `test/smoke.test.mjs`（源码里再出现 `--version` 就红）。

最低版本暂定 **Chrome 92**（水位含义见下）。低于水位就拒绝启动，只提示安装或升级。

最低版本暂定 **Chrome 92**。真正用到的是扁平会话和 `Page.startScreencast`，都很老；92 是「低了不好排查、高了会挡住还能用的机器」的水位，P0 实测后再改。低于水位就拒绝启动，只提示安装或升级。

探测中胶囊仍能打开小面板。

### 冷启动参数

```
chrome.exe
  --remote-debugging-port=0
  --user-data-dir=<workspace>/.workspace-browser/chrome-profile
  --remote-allow-origins=*
  --no-first-run
  --no-default-browser-check
  --disable-session-crashed-bubble
  --hide-crash-restore-bubble
```

有标签要恢复时，不要在命令行上加 URL，也不要 `--restore-last-session`。没有可恢复标签时才加 `about:blank`。跨域的两个参数见第 4 节。

Windows 上 `spawn` 使用 `detached: true`、`stdio: 'ignore'`，并 `unref()`。否则宿主退不掉，或者浏览器跟着宿主一起退出。

Chrome 136 起，调试端口必须配非默认的 `--user-data-dir`。`--remote-debugging-port=0` 会把端口写进该目录的 `DevToolsActivePort`：第一行端口，第二行浏览器级 WebSocket 路径。本机实测过（headless，端口 59807）。

### 目录

```
<workspace>/.workspace-browser/          # 点开头 + 隐藏属性
├── .gitignore          # 内容 `*`
├── chrome-profile/     # Chrome 自己维护（--user-data-dir）
├── skills/             # 技能说明
├── shots/              # 截图
└── endpoint.json       # 本插件写，只是线索
```

未分组会话（没有工作区）退回 `<DSH_HOME>/workspace-browser/_ungrouped/`。

数据放在工作区里，是为了删工作区时一起清掉。目录点开头，Windows 上再加隐藏属性。目录内有一份内容为 `*` 的 `.gitignore`。工作区已经有 `.gitignore` 时追加一行 `.workspace-browser/`，没有那个文件就不代为创建。

`chrome-profile` 有数千个文件，还含 Cookie。

```json
{
  "schema": 1,
  "port": 59807,
  "wsPath": "/devtools/browser/…",
  "pid": 28188,
  "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "crossOrigin": false,
  "startedAt": "2026-09-25T12:30:49Z",
  "workspaceKey": "env_001ca237"
}
```

`endpoint.json` 按当前用户最小权限来写。文件在，不代表浏览器还活着。

### 配置项

键是扁平的 camelCase，和 `settings.yaml` 里看到的一致。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `capsuleEnabled` | 开 | 显示胶囊 |
| `capsuleShowPort` | 开 | 文案里带端口 |
| `panelAutoOpenOnLaunch` | 开 | 冷启动成功后展开当前会话的画面 |
| `panelLayout` | `focus` | `grid` / `single` 尚未实现 |
| `panelTileSplit` | `0.55` | 焦点区高度占比 |
| `panelSkillHeight` | `72` | 技能区高度，像素，40–360 |
| `panelFollowFrontTab` | 关 | 焦点跟最顶层标签 |
| `streamFocusFps` / `streamFocusMaxWidth` / `streamFocusQuality` | `2` / `960` / `70` | 质量是 1–100 的整数 |
| `streamThumbFps` / `streamThumbMaxWidth` / `streamThumbQuality` | `0.25` / `160` / `50` | 帧率为 0 表示不要缩略图 |
| `chromePath` | 空 | 手动指定的 chrome.exe |
| `chromeCrossOrigin` | 关 | 见第 4 节的两个参数 |
| `instanceRestoreTabsOnReopen` | 开 | 再次启动时恢复标签 |
| `startupUrl` | 空 | 没有可恢复标签时打开的网址，留空则是空白页 |
| `instanceOnDshExit` | `keep` | `keep` 或 `close` |
| `toolsWriteRequireApproval` | 关 | 打开后，写操作要先点「允许模型操作」 |
| `toolsWriteAuthorized` | 关 | 点过允许之后为开 |
| `toolsExposeEvaluate` | 关 | 为开才注册 `evaluate` |

---

## 9. 各阶段的完成标准

下面是交付时的切分，用来对照「怎样算做完」。阶段名留着，是为了和测试脚本、提交说明对得上。

### P0 拉得起、停得下

**状态：已完成并真机验证**（2026-09-25，15 项判据全过，见附录）。

`ensure()`、硬超时、按 user-data-dir 结束残留进程、Chrome 探测、胶囊和小面板、profile 目录、`endpoint.json`。

- 点胶囊只开小面板。点两次「启动」只有一个进程，端口与 `DevToolsActivePort` 第一行一致。
- 没装 Chrome：文案是「未检测到 Chrome」，有下载和指定路径，工具返回 `chrome-not-installed`。
- 版本过低：拒绝启动，并写出检测到的版本和最低版本。
- 多个候选：列出并记住选择。
- 假的 `endpoint.json`、或进程被 `kill -9`：一个心跳内回到未启动；再点「启动」能起来。杀进程时不按文件里的 PID 误杀。
- 进程还在、CDP 不通、锁还在：按 user-data-dir 结束后能重新启动。
- 无工作区时目录是 `_ungrouped`。两个工作区用两个宿主进程，profile 和端口都分开。

### P1 模型能读

CDP 客户端和读类工具，含 `select_tab`。模型能拿到页面文字和 PNG。未启动时返回 `browser-not-running`。

### P2 模型能写

写类工具。未点「允许模型操作」时返回 `write-not-authorized`，按钮点过之后可以点击、输入、导航。这些操作不改变前台窗口。

### P3 能看见

画面、多路订阅、CDP 立刻 ack、可见订阅者计数、最多 12 张缩略图、`focus` 布局和分隔条。质量是整数。

- 会话 A 开着画面、会话 B 关掉：A 仍有帧。都不可见才停。
- 分隔条的位置会记住。
- 插件自己 `open_tab` 不增加窗口数。用户另开的窗口出现在胶片条里，可以有多条下划线。

### P4 关窗和恢复

500 毫秒防抖、还连着进程时下次走「开窗口」而不是再 spawn、恢复标签时不多出 `about:blank`、不弹出崩溃恢复条。

- 手动关掉窗口后显示未启动，不自动出现。
- 再点「启动」，窗口出现；若开了恢复，原来的网址回来，没有多出来的空白页。

### P5 命令和设置页

`/browser`、设置卡片、删除数据、静默回归。

- `/browser` 只开窗口和画面，对话里没有新的用户消息。
- `/browser https://example.com 打开登录`：先有窗口和这个网址，再把指令交给模型。已经在跑时不重复启动。
- `/browser 查一下天气`：打开窗口和画面，整句交给模型，插件自己不猜网址。
- 设置里关掉胶囊立即生效。改 `chrome.path` 会提示将重启。

---

## 10. 还没定

| 项 | 现在怎么对待 |
| --- | --- |
| `Target.createTarget` 的 `background` 参数名和语义 | P1 实测。核实前，已在运行时新开标签不得抢前台 |
| `visibilityState` 在最小化、被挡住时是否可靠 | P3 实测。不可靠就用最后一次结果，并在 tooltip 标明推断 |
| 「切到前台」能否让操作系统把 Chrome 窗口激活 | CDP 往往只能把标签切到浏览器内部的最前。P3 先调 `Page.bringToFront`。若窗口仍在后面，再考虑 Win32，这期不挡画面 |
| 最低 Chrome 版本 | 暂定 92，P0 用扁平会话和 screencast 实测后改数字 |
| 拖拽是否同时改真实窗口大小 | 不做。改尺寸常常会把窗口带到前面，和静默冲突 |
| 刷新后右侧栏仍保持打开 | 框架只把展开态放在内存里。若要记住，以后用 `localStorage` 按会话恢复。`autoOpenOnLaunch` 只对启动那一下所在的会话生效 |
| 第一次使用要重新登录 | 已接受。首次启动时告诉用户：这是这个工作区自己的浏览器，站点要再登一次 |

明确不做的：代下 Chrome、访问控制、审计、多内核、远程浏览器、用户可见的 `stale` 状态、按会话锁浏览器、统计「几个会话正在使用」。

---

## 附录

### 本机实测（2026-09-25）

```
chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=<临时目录> --no-first-run about:blank
```

`DevToolsActivePort` 内容为端口 `59807`，以及 `/devtools/browser/be4bc857-4807-4e20-9be7-3342a15575d8`。

### P0 实测（2026-09-25，实现后回归）

`node scripts/verify-p0.mjs` —— 真机起 Chrome、停、假 `endpoint.json`、`kill -9`，15 项判据全过：

- 冷启动 961ms 落到运行中；`endpoint.json.port` 与 `DevToolsActivePort` 第一行一致
- 第二次 `ensure()` 复用同一进程（端口不变）
- 假 `endpoint.json`（端口 1、pid 999999）**不影响状态**：探测只看 Chrome 侧真相
- `kill -9` 后探测立刻不可达；再点「启动」照样起来
- `stop()` 回到未启动、实例确实停下、**profile 目录保留**（插件不自己删数据）

三条与设计假设不同的实测发现（已按实测调整实现）：

1. **`chrome.exe --version` 从 Node pipe 起来时无输出** → 版本改用 PE 文件版本资源（本机读出 `153.0.8010.53`）
2. **本机不存在 `HKLM\SOFTWARE\Google\Chrome\BLBeacon`** → 注册表这条探测在这台机器上拿不到版本
3. **受限沙箱里 `Get-CimInstance Win32_Process` 返回「拒绝访问」，且 `spawn` 捕获 stdout 会 `EPERM`** → 命令行查询降级为「按 `endpoint.json` 记录的 PID 结束残留」，且只在该 PID 还活着、CDP 又不响应时才动手。**在不受限的宿主进程里仍走命令行匹配这条正路。**
4. **`/status` 的轮询路径一个进程都不开** —— 只做文件存在性检查。两秒一轮去 spawn `reg.exe` / `where.exe` 既贵，又会在 `execFile` 遇到 `EPERM` 时漏管道句柄（实测把宿主的事件循环吊住）。注册表与 PATH 只在「启动 / 重新检测」时查，这与原本「轮询只看注册表和文件在不在」的分工一致，只是把注册表也移出了轮询。

另外：受限沙箱下 Chrome（含 `--headless=new`）**连调试端口都建不起来**，所以真机验证必须在放宽的条件下跑；这不影响插件在正常 DSH 宿主里的行为。

### P1–P5 实测（2026-09-25，`node scripts/verify-live.mjs`）

真起 Chrome，用**工具定义本身**操作一张真实的 `data:` 页。**24 项全过**：读类（snapshot 的标题/正文/编号元素/表单字段/密码掩码/不可信标记、get_text、list_tabs、screenshot 落盘 11.6KB PNG、select_tab）、写类（click 按快照编号真的点到元素、type 真的写进输入框、navigate 真的跳转 —— 都用页面副作用反查）、画面（收到 929×917 JPEG，MIME/尺寸/targetId 正确，全部订阅者不可见后停推）。

自动化测试：`smoke 9 + host 4 + cdp 15 + tools 20 + write-tools 17 + command 12 + model 5 = 82`，另加编码门禁 `scripts/check-encoding.mjs`。

真机打出来的三个问题（都已修，前面几节已按结论改写）：

1. **`/browser` 开完新标签没切默认 target**：命令把 targetId 告诉模型，后续工具却还在操作旧标签。现在 `openTab` 之后 `selectTarget()`。（这条是"读工具一直读到 `about:blank`"暴露出来的。）
2. **`Target.createTarget` 必须走浏览器级命令**：普通 `command()` 会先 attach 到某个标签的会话，语义不对。为此加了 `CdpClient.commandBrowser()`。
3. **`lib/write-tools.js` 曾整文件写成 GBK 乱码**（4507 处非法 UTF-8，还吞掉一个收尾引号）。`node --check` **抓不到**这种损坏，只有 `import` 才炸 —— 所以加了 `scripts/check-encoding.mjs` 当门禁，并放进 `npm test` 第一步。

另外两条实测得到的实现细节：

- **写类工具用快照编号定位元素**（`click {index: 1}`、`type {index: 2, text}`），与读类工具的 `[编号]` 对齐；模型该走的路径就是"先 snapshot 拿编号，再按编号操作"。
- `Page.startScreencast` **没有帧率参数**：Chrome 只在页面有视觉变化时推帧，能调的只有质量与宽度。所以静态页面收到 1 帧是正常的，帧率设置是**上限**而不是节拍器。

手工模式是这条设计的起点：`--remote-debugging-port=9222`、`--disable-web-security`、单独的 `--user-data-dir`。插件把它变成胶囊、按工作区分开的目录、随机端口、默认关闭的跨域。

### 标识符

| 用途 | 值 |
| --- | --- |
| 包名 / 客户端模块 id | `dsh-helper-plugin-workspace-browser` |
| loader 入口 id | `workspace-browser` |
| 路由前缀 | `/dsh-helper-plugin-workspace-browser/` |
| profile | `<workspace>/.workspace-browser/chrome-profile`（未分组时 `<DSH_HOME>/workspace-browser/_ungrouped/chrome-profile`） |
| 工具前缀 | `workspace_browser_` |
| 命令 | `/browser` |
| 画面 tab | id `workspace-browser/mirror`，kind `workspace-browser-mirror` |
| 设置 namespace | `dsh-helper-plugin-workspace-browser` |

### 依据

- Chrome 136 起调试开关必须搭配非默认 user-data-dir（官方博客，2025-03-17）
- 插槽目录：`@deepseek-ai/dsh-cordis-client-runner`
- 右侧栏：`@deepseek-ai/dsh-client-ui-sidebar-right`
- 设置：`@deepseek-ai/dsh-settings`、`dsh-client-ui-settings-plugins`；范例 `dsh-web-search-deepseek`
- HTTP / WebSocket：`@deepseek-ai/dsh-host-webserver`；范例 `dsh-api-gateway`
- 命令：`@deepseek-ai/dsh-commands`；范例 `/plan`（`agent.steer`）、`/goal`（`agent.followup`）
- 插槽名以当时装上的 `@deepseek-ai/dsh-cordis-client-runner` 为准

### 草案记录

- **v0.7**：收成一套状态和启动流程；profile 改到 `DSH_HOME`；画面多路推送、质量用 0–100、CDP 帧立刻确认；工具前缀定死；`/browser` 可以没有网址。全文按阅读顺序重排。
- v0.6：关窗回到未启动；胶囊要始终能操作；补了右栏宽度、分栏、浮出。
- v0.5：关窗不自动重开；胶片条三种标记；画面等比缩放。
- v0.4：一个工作区一个窗口；本机自用；路由前缀；默认静默。
