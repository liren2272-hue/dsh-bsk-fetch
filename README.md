# dsh-bsk-fetch

用 **bsk** 驱动真实浏览器，自动通过带验证码的网页，再抓取页面 HTML / 正文并落盘。
以 **[vcb-s.com](https://vcb-s.com)**（VCB-Studio，动画 BDRip 组）为例——它用 Cloudflare
Managed Challenge（Turnstile「Verify you are human」复选框），本插件能自动点过、拿到 `cf_clearance`
后抓取真实页面。

三类能力，按验证码难度分层：

| 验证码类型 | 能否自动 | 走哪条路 |
| --- | --- | --- |
| Cloudflare Turnstile 复选框 | ✅ 全自动 | 检测挑战页 → 点复选框/提交 → 轮询离开挑战页 |
| **同源 canvas** 图形点选 / 滑块 | ✅ 全自动（agent 当视觉） | `canvas.toDataURL()` 取像素 → 看图给坐标 → 合成事件点击 |
| hCaptcha / reCAPTCHA 图片点选（跨域 iframe） | ⚠️ 复选框可自动，图片挑战只能人工 | 无障碍 ref 点复选框；图片挑战走 `request-help` |

> 不需要 Python、不需要 OpenCV、不需要外部视觉 API。源码全部内嵌在插件里。

## 架构

纯 Node.js 插件，通过 `bsk` CLI 直驱浏览器：

```
lib/index.mjs    Cordis 入口，注册六个工具
lib/bsk.mjs      bsk CLI 薄封装（cooperate 收据、会话、snapshot/screenshot/observe/click/evaluate）
lib/captcha.mjs  Cloudflare Turnstile 自动通过逻辑
lib/complex.mjs  复杂验证码：canvas 取图/合成点击、跨域复选框、人工兜底
lib/fetch.mjs    抓取流程（导航→过验证码→抓 HTML/正文→落盘）
lib/config.mjs   配置归一化（含可选视觉后端 / 人工兜底开关）
lib/tools.mjs    defineTool 动态导入 + 恒等兜底
selftest.mjs     离线自测（node selftest.mjs）
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `bsk_fetch` | 导航到 url → 自动过验证码 → 抓 HTML 与可读正文 → 落盘 |
| `bsk_pass_captcha` | 只过当前页简单验证码（需 `sessionId`，不抓取） |
| `bsk_doctor` | 环境体检：bsk 路径、daemon 状态、浏览器连通性 |
| `bsk_solve_captcha` | 一键解复杂验证码（需 `sessionId`）：canvas 自动点、跨域先点复选框再人工兜底 |
| `bsk_captcha_inspect` | **两段式第一步**：把挑战图导出成 PNG 并返回绝对路径，交给 agent 自己看图 |
| `bsk_captcha_pick` | **两段式第二步**：按 agent 给的坐标点选并判定是否通过；`human=true` 走人工 |

### agent 当视觉（推荐路径）

模型本身能看图时，不需要配置 `visionEndpoint`。两步走：

```
1) bsk_captcha_inspect({"sessionId":"<id>"})
   → { ok:true, source:"canvas", pngPath:".../challenge-canvas-*.png",
       width:300, height:300, coordSpace:"canvas", prompt:"点击所有圆形", blocked:false }

2) 用 read_image 看那张 PNG，判断该点哪里

3) bsk_captcha_pick({"sessionId":"<id>", "points":[[150,50],[150,150]]})
   → { ok:true, passed:true, clicked:2, humanUsed:false }
```

`coordSpace` 决定坐标系：

- `canvas` —— 位图坐标（相对 canvas 左上角），**可以点**；
- `viewport` —— 视口像素（整屏截图），**当前 bsk 版本点不了**（见下方「收据死锁」）；
  这种情况说明挑战在跨域 iframe 里，`blocked:true`，改用 `human:true`。

### 视觉后端（可选，用于一次性全自动）

想不经过 agent 直接一次跑完，在插件配置里填 OpenAI 兼容多模态接口：

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `visionEndpoint` | 如 `https://api.openai.com/v1/chat/completions` | 空 |
| `visionApiKey` | 对应 API Key | 空 |
| `visionModel` | 模型名 | `gpt-4o` |
| `humanFallback` | 无后端/失败时是否退回 `request-help` | `true` |

## 关键实现准则（全部来自真机实测）

### 1. 收据模型（context / observation）

- `cooperate sync --json` 返回扁平 JSON：`context_id` + `observation_id`。
- `context_id`：DOM 目标类写动作（`click @eN`、`--selector`、`fill`、`navigate`）够用。
- `observation_id`：`evaluate` / `drag --dx` / `click --capture` 额外必需，**一次用一次**。
- observation 是**紧邻**语义：sync 与动作之间页面任何变动都作废。
- 新会话停在 `about:blank` 时扩展没注入 content script，`cooperate sync` 会报
  `Could not establish connection`；**必须先无 `--context` 的 `navigate` 把页面拉起**。

### 2. `--capture` 坐标点击存在收据死锁（重要）

`click --capture <id> --image-x/--image-y` 是 bsk 官方给的像素级点击路径，但在 0.4.1 上**无法闭环**：

- `screenshot --ref @eN` **不带** `--context` 会返回可用 `capture_id`，但**作废**了之前拿到的 sync context
  → 点击报 `This action requires the context returned by the latest cooperate sync`；
- `screenshot --ref @eN --context C` **保住** context，却**不返回** `capture_id`
  → 点击报 `This action requires an unused strict observation from cooperate sync`；
- 截图成功后再补 `cooperate sync`，context/observation 新了，capture 又失效
  → `capture expired, consumed or does not match the current visual ref`。

官方文档描述的正是这套流程（"retain context_id and observation_id from sync, then observe and
screenshot the visual ref, retain that screenshot's capture_id"），实测走不通。**因此本插件不依赖
`capture_id`**，改用下面两条原语。

### 3. 同源 canvas：`toDataURL` 取图 + 合成事件点击

- 取图：`evaluate` 执行 `canvas.toDataURL('image/png')`，直接拿到 base64 像素，**不需要截图**，
  也不消耗任何协作收据。
- 点击：`evaluate` 里按 `bitmap → CSS` 比例换算后 `dispatchEvent` 一串
  `pointerover/pointerdown/mousedown/pointerup/mouseup/click`。
- 实测：mock 图形点选页 3 次不同随机题目全部点到 `solved=true`。

### 4. 跨域 iframe：snapshot 能读无障碍树，但只能点「复选框」

hCaptcha 挑战在跨进程 iframe 里：

- `observe` 只暴露 1 个 ref，`wait-for-element` 的所有选择器都 `attached=false`（只匹配主文档）；
- **但 `snapshot` 能读到 iframe 内部的无障碍树**，给出
  `@eN checkbox "hCaptcha 复选框，带有文本"我是真实访客"…"` 和 `@eM button "我是真实访客"`；
- 有 ref 就能用普通 `click` 点掉那个复选框（点完有概率直接放行，多数时候会弹图片挑战）；
- 图片挑战本身：拿不到 canvas、取不到像素、无坐标点击原语 → **只能人工**。

⚠️ ref 是「某次 observation 内」的临时编号，snapshot 之后隔一会儿再点会报
`observation ref was not found for this tab`。所以每次都要「取最新 snapshot → 立刻点」，
失败就整体重来（`clickCheckbox` 已内建重试）。

### 5. `isSolved` 的判据

不能只靠「读不到挑战内容」就判通过——跨域 iframe 里本来就读不到。判据顺序：

1. 页面自报钩子（`window.__captchaSolved` / `__captchaMeta().solved`）；
2. hCaptcha/reCAPTCHA 的隐藏响应字段（`textarea[name=h-captcha-response]`）有值；
3. 挑战 iframe 存在 → **判未通过**；
4. 覆盖层仍在 → 判未通过；
5. 都没有明确信号才退回 snapshot 关键词兜底。

### 6. 其他硬规则

- 页面状态一律用 `snapshot` / `evaluate` 读，不用增量式 `cooperate sync` 的 `observation.text`
  判「已放行」（会误报）。
- `--timeout` 必须带单位（`45s` / `1m` / `1500ms`）。`screenshot --timeout` 只能配 `--full-page`。
- `bsk evaluate` 返回信封 `{ok, tab_id, value}`，必须取 `.value`（否则静默读到空）。
- daemon 默认 10 分钟空闲退出，常驻用：
  ```bash
  bsk daemon start --foreground --daemon-idle 240h
  ```
  （`--mode server` 与 `--daemon-idle` 不能同用；Windows 上 detached 启动会被
  `Job Object breakaway` 拒绝，必须在独立常驻任务里前台跑。）
- 客户端命令统一设 `BSK_AUTO_START=0`。

## 前置条件

1. 安装 `bsk` CLI（`$HOME/.local/bin/bsk(.exe)`），并让它连上浏览器（装好浏览器扩展、配对成功、
   窗口打开）。`bsk doctor` 应显示 `extension connected`。
2. 扩展协议版本要与 CLI 匹配——不匹配时扩展**拒绝连接**（症状：`0 browsers connected`）。
   用 `bsk update -y` 升级 CLI，然后**重启 daemon**。
3. daemon 在独立常驻任务里前台跑。

## 安装 / 接线（本机已做）

- 插件目录 junction 到 profile 的 `node_modules/@local`：
  ```cmd
  mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-bsk-fetch" "C:\Users\15940\Documents\dsh-plugins\dsh-bsk-fetch"
  ```
- profile `package.json` 的 `dependencies` 加 `"@local/dsh-bsk-fetch": "link:."`，并加入
  `dsh.profile.bundles`。
- profile `cordis.patch.yml` 加：
  ```yaml
  - insert:
      - id: dsh-bsk-fetch
        name: dsh-bsk-fetch
  ```
- 重启 DSH 桌面端使 bundle 生效。

## 验证

```bash
node --check lib/*.mjs && node selftest.mjs   # 离线自测全绿（含 CF 反复点击回归）
```

真机冒烟（需 daemon 已起、浏览器连上）：

```
bsk_doctor                                      # 先看 daemon / 浏览器状态
bsk_fetch({"url":"https://vcb-s.com/"})         # 自动过 Cloudflare 并抓首页
# 复杂验证码（agent 当视觉）：
bsk_captcha_inspect({"sessionId":"<id>"})       # 拿 pngPath
# → read_image 看那张图 → 判断坐标
bsk_captcha_pick({"sessionId":"<id>","points":[[150,50]]})
```

## 许可

MIT


## 七、更新记录

### 0.2.2（2026-11-07，bugfix：Cloudflare 托管质询真机可过）

起因：外文期刊补查时用本插件思路过 tandfonline / ScienceDirect 的 Cloudflare
质询失败——点完复选框后立刻回到「正在进行安全验证 / Ray ID」。真机逐轮取证后
定位到两处实现缺陷，均在本版修正：

1. **`lib/captcha.mjs`：点完立刻轮询 = 打断验证。** 旧 `passCaptcha` 每 1.5s 调
   一次 `readState()`（内部 `evaluate` → `cooperate sync` + `evaluate`），在
   Cloudflare「正在验证您是否是真人」窗口里反复同步/执行脚本，把挑战重置。
   新逻辑：
   - 挑战页判定与找复选框 `@eN` **一律只用 `bsk snapshot`**（aria 文本，只读、
     不消耗 context），纯函数 `isChallenge()` / `findCheckboxRef()` 可离线断言；
   - 点击前才取一次 `cooperate sync` 收据，`@eN` 作为 **位置参数** 传给 `click`，
     并同时带 `--context` 与**顶层** `--observation`；
   - 点完 **静默等待默认 16000ms**（`silentMs`），期间绝不做任何 snapshot /
     sync / evaluate，让 CF 自行完成；
   - 反复 2~4 轮直到 snapshot 不再是挑战页。真机日志：2 轮点击即放行到正文页。
   核心流程拆成 `passCaptchaWith(driver, ...)` 工厂供 selftest 注入假 driver，
   断言「静默窗口内没有任何页面读取动作」这一回归不变量。

2. **`lib/bsk.mjs::getSync` 取错 observation_id。** bsk 0.4.x 的 `cooperate sync
   --json` 同时有顶层 `observation_id` 与嵌套 `observation.observation_id`，
   按键名字母序嵌套值先出现；旧正则取「第一个」= 嵌套值 → `evaluate` / `click-ref`
   报 `pass the sync reply's top-level observation_id, not observation.observation_id`。
   改为先 `JSON.parse` 取顶层，正则仅作解析失败兜底。

3. **新增「放行后抓同源二进制」能力。** 真机结论：CF 放行后 `bsk download --ref`
   因新窗口 `target=_blank` 报 `the browser download could not be attributed or
   completed`，trusted click 又常报 `control context no longer belongs to the
   current document`；只有页面内 `fetch(pdfPath)` → `arrayBuffer` → `btoa(base64)`
   稳定拿到 `200 application/pdf`。`bsk_fetch` 新增可选参数 `fetchPath`，过验证码
   后走这条链把 PDF 落盘并回传 `binaryPath/binarySize`；`parseFetchBinary()` 显式
   拦截 OneTrust 同意弹窗 HTML（不把 HTML 当 PDF）。ScienceDirect 实测有效，
   tandfonline 实测有效。

4. **`lib/bsk.mjs::sessionStop` 参数形式错误。** bsk 0.4.x 的 `session stop` 把
   `SESSION_ID` 作为**位置参数**，旧实现传 `--session <id>` 会报
   `error: unexpected argument '--session' found`，导致过完验证码后无法正常收尾
   切换会话。改为 `runOrThrow(['session', 'stop', sessionId])`，并在 selftest
   加源码级断言固化。

> 真机证据（会话 `docs/` 与 `data/foreign/_cf_d3.log`）：#04 / #19 两篇
> tandfonline 文献经「反复点击 → 静默等待 → 页内同源 fetch」拿到 9 页 / 22 页真
> PDF；插件自身 `passCaptcha` 真机日志 `passed=true clicks=1~2 rounds=3~6
> secs=45~85`；全链路 E2E（插件自身模块：开会话→导航→过质询→`sessionStop`
> 换会话→真实正文页判定→页内同源 fetch→`parseFetchBinary`）`E2E2_PASS`
> `{"passed":true,"realPage":true,"pdf":true,"pdfSize":1105513}`；
> 用户「反复点击肯定能通过」的判断成立。

### 0.2.1

更新依赖锁定文件；加 examples/ 联调脚本（mock 验证码页 + 两段式 e2e）。
