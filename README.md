# dsh-bsk-fetch

用 **bsk** 驱动真实浏览器，自动通过带验证码的网页，再抓取页面 HTML / 正文并落盘。
以 **[vcb-s.com](https://vcb-s.com)**（VCB-Studio，动画 BDRip 组）为例——它用 Cloudflare
Managed Challenge（Turnstile「Verify you are human」复选框），本插件能自动点过、拿到 `cf_clearance`
后抓取真实页面。

两种能力：

1. **简单验证码（自动点过）**：Cloudflare Turnstile 复选框 / 提交按钮，无需任何视觉后端，自动点过。
2. **复杂验证码（自动视觉 + 拖拽）**：hCaptcha 图片点选、reCAPTCHA 网格、滑块拼图。把整屏截图交给
   **视觉后端**（OpenAI 兼容多模态接口）判读要点的图块与提交按钮坐标，再用 bsk 按坐标点击或拖拽滑块；
   **未配置视觉后端或调用失败时自动退回 `request-help` 让真人完成**。

> 简单验证码不需要 OCR、不需要 OpenCV。复杂验证码需要你在插件配置里填一个多模态视觉接口。

## 架构

纯 Node.js 插件（源码全部在插件内，不依赖 Python 或其他运行时），通过 `bsk` CLI 直驱浏览器：

```
lib/index.mjs    Cordis 入口，注册四个工具
lib/bsk.mjs      bsk CLI 薄封装（cooperate 协议、会话、snapshot/screenshot/observe/drag/click）
lib/captcha.mjs  Cloudflare Turnstile 自动通过逻辑
lib/complex.mjs  复杂验证码：detectCaptcha + solveImageSelect + solveSlider + 人工兜底
lib/fetch.mjs    抓取流程（导航→过验证码→抓 HTML/正文→落盘）
lib/config.mjs   配置归一化（含视觉后端 / 人工兜底开关）
lib/tools.mjs    defineTool 动态导入 + 恒等兜底
selftest.mjs     离线自测（node selftest.mjs）
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `bsk_fetch` | 导航到 url → 自动过验证码 → 抓 HTML 与可读正文 → 落盘；返回结构化结果 |
| `bsk_pass_captcha` | 只过当前页简单验证码（需传入已有 `sessionId`，不抓取） |
| `bsk_solve_captcha` | 解复杂验证码（自动视觉+拖拽）：截图→视觉后端判读→按坐标点击/拖拽；失败退回人工兜底。需传入已有 `sessionId` |
| `bsk_doctor` | 环境体检：bsk 路径、daemon 状态、浏览器连通性 |

`bsk_solve_captcha` 参数：`sessionId`(必填)、`kind`(可选 `image-select`/`slider` 强制造型)、
`rounds`(默认 6)、`waitMs`(默认 40000)、`noHumanFallback`(true 时禁用人工兜底)。

## 视觉后端配置（复杂验证码用）

在 DSH 桌面端的插件配置里填：

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `visionEndpoint` | OpenAI 兼容多模态接口 URL，如 `https://api.openai.com/v1/chat/completions` | 空 |
| `visionApiKey` | 对应 API Key | 空 |
| `visionModel` | 模型名，如 `gpt-4o` | `gpt-4o` |
| `humanFallback` | 无视觉后端 / 调用失败时是否退回 `request-help` 人工兜底 | `true` |

只有 `visionEndpoint` 与 `visionApiKey` 都填了，才会启用自动视觉；否则 `bsk_solve_captcha`
直接走人工兜底（在 DSH 会话里暂停等你手动完成验证）。视觉请求体为 OpenAI 多模态格式，
`response_format: {type:"json_object"}`，期望返回 `{tiles:[[x,y],...], submit:[x,y], done:bool}`。

## 关键实现准则（来自实测踩坑）

- **页面状态一律用 `bsk snapshot` / `evaluate` 读**，不消费协作 context，避免增量观察误报把验证页当正文。
- **写动作（click/drag/hover/navigate/evaluate/request-help）必须走 cooperate**：先
  `cooperate wait --timeout-ms 5000` 再 `cooperate sync --json` 取 `context_id`，然后带 `--context <id>`。
  **一个 context 只能用一次**，每次写动作前重新取。只读动作（snapshot/observe/screenshot/get-html）不耗 context。
- **`--timeout` 必须带单位**：bsk 要求 `45s` / `1m` / `1500ms`，不能裸数字。
- **daemon 保活**：默认 10 分钟空闲退出，常驻用前台模式 + 长空闲窗口：
  ```bash
  bsk daemon start --foreground --daemon-idle 240h
  ```
  （`--mode server` 与 `--daemon-idle` 在 0.4.0 上不能同用；Windows 上 detached 自动启动会被
  `Job Object breakaway` 拒绝，必须在一个独立常驻任务里前台跑 daemon。）
- **Cloudflare 通过标志**：离开挑战页（title 不再 `Just a moment...` / URL 不含 `cf-mitigated`）或检测到
  `cf_clearance` cookie 即视为通过；Turnstile 有时会自动放行，所以每轮先等一小段再点。
- **复杂验证码按「坐标」点击**：`click --capture --image-x <px> --image-y <px>` 按视口像素坐标点；
  先试带 `--capture`（像素精确）失败回落无 capture 的 CSS 选择子方式。
- **滑块拼图用 `drag --dx <像素>`** 横向拖到位，再轮询检测通过。

## 前置条件

1. 安装 `bsk` CLI（本机路径 `$HOME/.local/bin/bsk(.exe)`），并让它连上浏览器（装好浏览器扩展、
   配对成功且窗口打开）。`bsk doctor` 应显示 `extension connected`，否则 daemon 起得来也驱动不了浏览器。
2. 拉起 daemon（独立常驻任务，前台跑，别让宿主沙箱 breakaway 杀掉）：
   ```bash
   bsk daemon start --foreground --daemon-idle 240h
   ```
   客户端命令统一设 `BSK_AUTO_START=0`，避免重复拉起失败。
3. 本插件在 DSH 桌面端以独立节点进程执行 `bsk`（不走宿主浏览器沙箱），所以 daemon 必须已经在外独立运行。

## 安装 / 接线（本机已做）

- 插件目录软链（junction）到 profile 的 `node_modules/@local`：
  ```cmd
  mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-bsk-fetch" "C:\Users\15940\Documents\dsh-plugins\dsh-bsk-fetch"
  ```
- profile `package.json` 的 `dependencies` 加 `"@local/dsh-bsk-fetch": "link:."`（或对应软链名）。
- profile `cordis.patch.yml` 加：
  ```yaml
  - insert:
      - id: dsh-bsk-fetch
        name: dsh-bsk-fetch
  ```
- 重启 DSH 桌面端使 bundle 生效。

## 验证

```bash
node --check lib/*.mjs && node selftest.mjs   # 离线：23 项全绿
```

真机冒烟（需 daemon 已起、浏览器连上）：

```
bsk_doctor                            # 先看 daemon / 浏览器状态
bsk_fetch({"url":"https://vcb-s.com/"})          # 自动过简单验证码并抓首页
# 复杂验证码：先用 bsk 建会话拿到 sessionId，再：
bsk_solve_captcha({"sessionId":"<id>"})         # 截图→视觉判读→点击/拖拽，或人工兜底
```
