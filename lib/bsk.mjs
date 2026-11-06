/**
 * bsk CLI 薄封装：只负责找到 bsk 可执行文件、用子进程驱动它，并把常用子命令
 * 包成 Promise 函数。所有「写入动作」都严格走 cooperate 协议：先 cooperate wait
 * 再 cooperate sync 取 context_id，然后把这个 context 带进动作里（一个 context
 * 只能用一次）。只读的 snapshot 不消耗 context。
 *
 * @module dsh-bsk-fetch/lib/bsk
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'

const FLOCK = '🔒'

/** 解析 bsk 可执行文件：BSK_BIN → $HOME/.local/bin/bsk(.exe) → PATH。 */
export function findBsk() {
  if (process.env.BSK_BIN && process.env.BSK_BIN.trim() !== '') return process.env.BSK_BIN.trim()
  const home = process.env.HOME || process.env.USERPROFILE
  const candidates = [
    home && `${home}/.local/bin/bsk.exe`,
    home && `${home}/.local/bin/bsk`,
    'bsk.exe',
    'bsk',
  ].filter(Boolean)
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch { /* keep looking */ }
  }
  return 'bsk'
}

/**
 * 跑一条 bsk 命令，返回 { code, stdout, stderr }。
 * 用 spawn 而非 exec，避免命令行特字符转义；参数一律作为独立 argv 元素传入。
 */
export function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = findBsk()
    const env = { ...process.env, BSK_AUTO_START: '0' }
    let child
    try {
      child = spawn(bin, args, { env, windowsHide: true })
    } catch (e) {
      return reject(e)
    }
    let out = ''
    let err = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => { try { child.kill('SIGKILL') } catch { /* noop */ } }, opts.timeoutMs)
      : null
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 0, stdout: out, stderr: err })
    })
  })
}

/** 执行并抛错（非 0 退出视为失败），返回 stdout。 */
async function runOrThrow(args, opts = {}) {
  const r = await run(args, opts)
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `bsk ${args[0]} 退出码 ${r.code}`
    throw new Error(`${msg}`)
  }
  return r.stdout
}

/** 解析 JSON 输出；失败回退成原始文本。 */
function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取一次协作「收据」：context_id + observation_id。
 *
 * 两者的用途不同（bsk 0.4.x 实测语义）：
 *  - `context_id`：DOM 目标类写动作（click @eN / --selector、fill、navigate）只需它，
 *    在文档变化或人接管前一直有效；
 *  - `observation_id`：**脚本与按坐标/位移的视觉动作**（evaluate、drag --dx/--dy、
 *    click --capture）额外需要它，且**一次用一次**，用完即失效。
 *
 * 页面刚导航完/仍在加载时 sync 会以 `cooperate_sync_required`（Page changed while
 * synchronizing）或 `Could not establish connection` 暂时性拒绝，故做有限重试。
 */
export async function getSync(sessionId, { attempts = 8, waitMs = '8000', gapMs = 1200, policy = '' } = {}) {
  let last = ''
  for (let i = 1; i <= attempts; i++) {
    await run(['cooperate', 'wait', '--session', sessionId, '--timeout-ms', waitMs])
    const syncArgs = ['cooperate', 'sync', '--json', '--session', sessionId]
    if (policy) syncArgs.push('--policy', policy)
    const r = await run(syncArgs)
    // v0.2.2：必须取【顶层】observation_id。旧实现用正则取 stdout 里第一个
    // "observation_id"，而 bsk 0.4.x 的 sync JSON 里 observation（嵌套对象）按
    // 键名字母序排在 observation_id 之前 → 正则会误取 observation.observation_id。
    // 顶层 observation_id 才是 click-ref / evaluate 需要的「当前观察」；传嵌套值
    // 会报 "pass the sync reply's top-level observation_id, not observation.observation_id"。
    const j = parseJson(r.stdout)
    if (j && j.context_id) {
      const obs = j.observation_id || (j.observation && j.observation.observation_id) || ''
      return { contextId: j.context_id, observationId: obs }
    }
    const c = r.stdout.match(/"context_id":\s*"([^"]+)"/)
    const o = r.stdout.match(/"observation_id":\s*"([^"]+)"/)
    if (c) return { contextId: c[1], observationId: o ? o[1] : '' }
    const reason = (r.stdout.match(/"reason":\s*"([^"]+)"/) || [])[1]
      || (r.stdout.match(/"message":\s*"([^"]+)"/) || [])[1]
      || (r.stderr || '').trim()
    last = reason || `exit ${r.code}`
    // 只对暂时性错误重试；权限/参数类硬失败立即抛出，避免空转。
    if (!/cooperate_sync_required|Page changed while synchronizing|Could not establish connection|cooperation_sync_required|unavailable/i.test(last)) {
      break
    }
    await sleep(gapMs)
  }
  throw new Error(`cooperate sync 未返回 context_id（最后一次：${last}）`)
}

/** 只要 context_id（DOM 目标类动作足够用）。 */
export async function getContext(sessionId, opts = {}) {
  const { contextId } = await getSync(sessionId, opts)
  return contextId
}

/** 拿一次 context 后执行动作；一个 context 只供一个写动作使用。 */
async function withContext(sessionId, fn) {
  const ctx = await getContext(sessionId)
  return fn(ctx)
}

/** 拿一次 (context, observation) 收据后执行动作；observation 一次用一次。 */
async function withSync(sessionId, fn) {
  const receipt = await getSync(sessionId)
  return fn(receipt)
}

/* ----------------------------- 只读 ----------------------------- */

/** 页面快照（aria 文本）。不加 --context，不消耗协作上下文。 */
export async function snapshot(sessionId, { json = false } = {}) {
  const args = ['snapshot', '--session', sessionId]
  if (json) args.push('--json')
  return runOrThrow(args)
}

/** 抓当前页 HTML；可写盘到 out，可限制 maxBytes。返回 stdout（或写盘结果）。 */
export async function getHtml(sessionId, { out, maxBytes, ref } = {}) {
  const args = ['get-html', '--session', sessionId]
  if (ref) args.push('--ref', ref)
  if (maxBytes) args.push('--max-bytes', String(maxBytes))
  if (out) args.push('--out', out)
  return runOrThrow(args)
}

/* --------------------------- 写入动作 --------------------------- */

/**
 * 导航到 URL（位置参数）。
 *
 * 重要：**新会话停在 about:blank 时扩展还没注入 content script**，此时
 * `cooperate sync` 会报 `Could not establish connection. Receiving end does not
 * exist.`，拿不到 context —— 于是「先 sync 再 navigate」会死锁。而 bsk 本身
 * 允许 navigate 不带 `--context`（实测 exit 0）。所以这里先走无 context 的
 * 导航把页面拉起来，只有该路径被拒时才退回「取 context 再导航」。
 */
export async function navigate(sessionId, url, { waitUntil = 'load', timeout = '45s' } = {}) {
  const base = ['navigate', url, '--session', sessionId, '--wait-until', waitUntil, '--timeout', timeout]
  const direct = await run(base)
  if (direct.code === 0) return direct.stdout
  // 只有在「确实要求 context」时才去取 context，避免空转重试。
  const needsCtx = /context|cooperation_sync_required|Receiving end does not exist/i
    .test(`${direct.stdout}${direct.stderr}`)
  if (!needsCtx) {
    throw new Error(((direct.stderr || direct.stdout || '').trim()) || `navigate 退出码 ${direct.code}`)
  }
  return withContext(sessionId, async (ctx) => runOrThrow([
    ...base, '--context', ctx,
  ]))
}

/** 点击：给定 --selector 或位置参数 target（如快照 ref @e5）。
 * 也可按视口像素坐标点击：传 capture:true + imageX/imageY（需 bsk 支持）。 */
export async function click(sessionId, { selector, target, capture = false, imageX, imageY, button, clickCount, modifiers } = {}) {
  return withContext(sessionId, async (ctx) => {
    const args = ['click', '--session', sessionId, '--context', ctx]
    if (selector) args.push('--selector', selector)
    if (target) args.push(target)
    if (capture) args.push('--capture')
    if (typeof imageX === 'number') args.push('--image-x', String(imageX))
    if (typeof imageY === 'number') args.push('--image-y', String(imageY))
    if (button) args.push('--button', button)
    if (clickCount) args.push('--click-count', String(clickCount))
    if (modifiers) args.push('--modifiers', modifiers)
    return runOrThrow(args)
  })
}

/**
 * 语义 VOM 观察：返回页面元素树（含 @eN ref、坐标、可点击/可填等标记）。
 * 这是只读动作，不消耗协作上下文。可选 --json 取机器可读结构。
 */
export async function observe(sessionId, { json = false, maxDepth, maxTokens, ref, dependsOn } = {}) {
  const args = ['observe', '--session', sessionId]
  if (json) args.push('--json')
  if (maxDepth) args.push('--max-depth', String(maxDepth))
  if (maxTokens) args.push('--max-tokens', String(maxTokens))
  if (ref) args.push('--cursor', ref)
  if (dependsOn) { for (const d of [].concat(dependsOn)) args.push('--depends-on', d) }
  return runOrThrow(args)
}

/** 截图：可截视口/全页/某个 ref（@eN）区域；默认落到 out（PNG）。 */
export async function screenshot(sessionId, { out, ref, fullPage = false, scope = 'current', timeout = '30s' } = {}) {
  const args = ['screenshot', '--session', sessionId]
  if (ref) args.push('--ref', ref)
  // bsk 只在 --full-page 时才接受 --timeout；视口截图带 --timeout 会被参数校验拒掉。
  if (fullPage) { args.push('--full-page'); args.push('--scope', scope); if (timeout) args.push('--timeout', timeout) }
  if (out) args.push('--out', out)
  return runOrThrow(args)
}

/** 悬停：ref 或 selector 二选一。 */
export async function hover(sessionId, { selector, target } = {}) {
  return withContext(sessionId, async (ctx) => {
    const args = ['hover', '--session', sessionId, '--context', ctx]
    if (selector) args.push('--selector', selector)
    if (target) args.push(target)
    return runOrThrow(args)
  })
}

/**
 * 拖拽：把 source（ref 或 selector）拖到 to（ref 或 selector），或按
 * --dx/--dy 相对位移拖。--observation-id 来自最近一次 observe，可选。
 */
export async function drag(sessionId, { source, to, selector, dx, dy, mode = 'press-move-release', observationId } = {}) {
  return withContext(sessionId, async (ctx) => {
    const args = ['drag', source || '', '--session', sessionId, '--context', ctx]
    if (to) args.push('--to', to)
    if (selector) args.push('--selector', selector)
    if (typeof dx === 'number') args.push('--dx', String(dx))
    if (typeof dy === 'number') args.push('--dy', String(dy))
    args.push('--mode', mode)
    if (observationId) args.push('--observation-id', observationId)
    return runOrThrow(args)
  })
}

/** 等待某元素达到指定状态（visible/hidden/attached/detached）。 */
export async function waitForElement(sessionId, { selector, target, state = 'visible', timeout = '10s' } = {}) {
  const args = ['wait-for-element', '--session', sessionId]
  if (selector) args.push('--selector', selector)
  if (target) args.push(target)
  args.push('--state', state)
  if (timeout) args.push('--timeout', timeout)
  const r = await run(args)
  // wait-for-element 超时返回 exit 0 + satisfied=false，这里当作「未满足」而非异常
  return { code: r.code, satisfied: !/(satisfied[:=]\s*false|not (found|visible))/i.test(r.stdout + r.stderr) }
}

/** 等待一次页面导航（load/domcontentloaded/networkidle/commit）。 */
export async function waitForNavigation(sessionId, { waitUntil = 'load', timeout = '30s' } = {}) {
  return runOrThrow(['wait-for-navigation', '--session', sessionId, '--wait-until', waitUntil, '--timeout', timeout])
}

/**
 * 暂停让真人完成验证码/登录/确认（人工兜底原语）。
 * prompt 必填，可高亮 target（ref 或 selector），最长等 timeout（默认 5m）。
 */
export async function requestHelp(sessionId, { prompt, title, target, timeout = '5m' } = {}) {
  return withContext(sessionId, async (ctx) => {
    const args = ['request-help', '--session', sessionId, '--context', ctx, '--prompt', prompt]
    if (title) args.push('--title', title)
    if (target) args.push('--target', target)
    if (timeout) args.push('--timeout', timeout)
    return runOrThrow(args)
  })
}

/**
 * 在页面里执行 JS 表达式，返回解析后的 JSON 值（失败时抛错）。
 *
 * 注意：`evaluate` 属于 bsk 的「脚本」动作，**除了 --context 还要一次性的
 * --observation**（来自同一次 cooperate sync）。只带 --context 会被拒：
 * `This action requires an unused strict observation from cooperate sync`。
 * 而且 observation 是**紧邻**语义的：sync 与 evaluate 之间页面有任何变动
 * （广告刷新、计时器、懒加载）都会让收据作废，报 `The action's observed
 * content changed; synchronize and replan`。因此这里做「重新 sync → 立刻
 * evaluate」的短重试，并默认用 `--policy strict`（strict 下收据校验最严格，
 * target 策略下 evaluate 甚至不接受 observation）。
 */
export async function evaluate(sessionId, expression, { timeout = '30s', attempts = 5, policy = 'strict' } = {}) {
  let lastErr = ''
  for (let i = 1; i <= attempts; i++) {
    const { contextId, observationId } = await getSync(sessionId, { policy })
    const args = [
      'evaluate', expression, '--session', sessionId, '--context', contextId,
      '--timeout', timeout, '--json', '--await-promise', 'true', '--return-by-value', 'true',
    ]
    if (observationId) args.push('--observation', observationId)
    const r = await run(args)
    if (r.code === 0) {
      const j = parseJson(r.stdout)
      return j !== null ? j : r.stdout
    }
    const body = `${r.stdout}${r.stderr}`
    lastErr = (r.stdout.match(/"message":\s*"([^"]+)"/) || [])[1] || body.trim().slice(0, 200)
    // 只有「收据过期/内容变动」值得重试；语法错误等硬失败直接抛。
    if (!/observation_required|observed content changed|cooperation_sync_required|requires an unused strict observation/i.test(body)) {
      break
    }
    await sleep(900)
  }
  throw new Error(`evaluate 失败：${lastErr}`)
}

/* ----------------------------- 会话 ----------------------------- */

/** 开一个新浏览器会话，返回 sessionId 字符串。 */
export async function sessionStart({ name, browser, incognito = false, width, height } = {}) {
  const args = ['session', 'start', '--json']
  if (name) args.push('--name', name)
  if (browser) args.push('--browser', browser)
  if (incognito) args.push('--incognito')
  if (width && height) args.push('--width', String(width), '--height', String(height))
  const out = await runOrThrow(args)
  const j = parseJson(out)
  if (j && j.session_id) return j.session_id
  const m = out.match(/"session_id":\s*"([^"]+)"/)
  if (m) return m[1]
  const m2 = out.match(/[A-Za-z0-9_-]{6,}/)
  if (m2) return m2[0]
  throw new Error(`无法从 session start 输出解析 sessionId：${out.slice(0, 200)}`)
}

/** 关闭指定会话。bsk 0.4.x：`session stop` 的 SESSION_ID 是【位置参数】，不认 --session。 */
export async function sessionStop(sessionId) {
  return runOrThrow(['session', 'stop', sessionId])
}

/** 关闭所有会话（调试/清理用）。 */
export async function sessionStopAll() {
  return runOrThrow(['session', 'stop', '--all'])
}

/* ----------------------------- 守护 ----------------------------- */

/** 读取 daemon 状态（JSON 优先，失败回退文本）。 */
export async function status() {
  const r = await run(['status', '--json'])
  const j = parseJson(r.stdout)
  if (j) return { ok: true, json: j, raw: r.stdout }
  return { ok: r.code === 0, raw: r.stdout || r.stderr }
}

/** 尝试拉起 daemon；Windows 上常因 Job Object 被拒，调用方需捕获并给出引导。 */
export async function daemonStart({ mode = 'server', idle = '240h' } = {}) {
  return runOrThrow(['daemon', 'start', '--mode', mode, '--daemon-idle', idle])
}

export { FLOCK }
