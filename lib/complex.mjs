/**
 * 复杂验证码求解：同源 canvas 走「取图 → 看图 → 合成点击」，跨域 iframe 走人工兜底。
 *
 * 设计依据（bsk 0.4.1 真机实测，2026-11-04）：
 *  - `click --capture --image-x/--image-y` 这条官方坐标点击路径存在**收据死锁**：
 *    strict sync 的 context 会被后续 observe/screenshot 作废（`requires the context
 *    returned by the latest cooperate sync`），而重做 sync 又会让 capture 失效
 *    （`capture expired, consumed or does not match the current visual ref`）。
 *    因此**不依赖 capture_id**。
 *  - 同源 canvas 元素可以 `toDataURL('image/png')` 直接取像素（无需截图），也能用
 *    `dispatchEvent(MouseEvent/PointerEvent)` 派发合成点击——实测能把图形点选验证码
 *    点到 `solved=true`。这是本插件自动解复杂验证码的**主路径**。
 *  - 跨域 iframe（hCaptcha / reCAPTCHA）里的 canvas 既拿不到 ref 也取不到像素
 *    （`observe` 只暴露按钮、`wait-for-element` 匹配不到 iframe 内选择器），
 *    故这类**只能**走 `request-help` 人工兜底。
 *
 * 「agent 当视觉」两段式接口（不依赖外部 visionEndpoint）：
 *   inspect(sessionId) → { pngPath, width, height, prompt, canvas }  交给调用方看图
 *   pick(sessionId, points) → 按点选坐标点击并轮询是否通过
 * 同时保留 callVision() 供配置了视觉后端时一次性自动完成。
 *
 * @module dsh-bsk-fetch/lib/complex
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  screenshot, observe, evaluate, waitForElement, requestHelp, snapshot, drag, click,
} from './bsk.mjs'

/* --------------------------- 小工具 --------------------------- */

/** bsk evaluate 返回信封 `{ok,tab_id,value}`，取出真正的值。 */
export function unwrapEval(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && ('ok' in v || 'tab_id' in v)) {
    return v.value
  }
  return v
}

/** 解析 PNG 的 IHDR，取像素宽高（仅读前 24 字节，不解码图像）。 */
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 把文件读成 data URL（base64），用于丢给多模态视觉接口。 */
function toDataUrl(p, mime = 'image/png') {
  const b = fs.readFileSync(p)
  return `data:${mime};base64,${b.toString('base64')}`
}

/** 临时文件路径。 */
function tmpPath(tag) {
  const dir = process.env.TMPDIR || process.env.TEMP || '.'
  return path.join(dir, `bsk-captcha-${Date.now()}-${tag}.png`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------- 同源 canvas：取图 / 点击 / 拖动 ------------------- */

/**
 * 探测页面里的验证码 canvas。
 * 返回 { found, w, h, cssW, cssH, selector } —— w/h 是 canvas 位图尺寸（看图坐标），
 * cssW/cssH 是屏幕上的显示尺寸（换算点击用）。
 */
export async function findCanvas(sessionId) {
  const raw = await evaluate(sessionId, `(function(){
    var cvs = Array.prototype.slice.call(document.querySelectorAll('canvas'));
    if (!cvs.length) return {found:false, count:0};
    // 挑面积最大的那个（验证码图通常就是页面上最大的 canvas）
    var best = null, bestArea = -1;
    cvs.forEach(function(c, i){
      var r = c.getBoundingClientRect();
      var a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a > bestArea) { bestArea = a; best = {c:c, i:i, r:r}; }
    });
    if (!best || best.r.width < 40 || best.r.height < 40) return {found:false, count:cvs.length};
    return {
      found: true, count: cvs.length, index: best.i,
      w: best.c.width, h: best.c.height,
      cssW: Math.round(best.r.width), cssH: Math.round(best.r.height)
    };
  })()`, { timeout: '15s' })
  const j = unwrapEval(raw) || {}
  return { found: Boolean(j.found), ...j }
}

/**
 * 把 canvas 位图直接导出成 PNG 落盘（不经过 bsk screenshot，避开 capture 收据）。
 * @returns {Promise<{ok, path?, width?, height?, cssWidth?, cssHeight?, error?}>}
 */
export async function grabCanvas(sessionId, { out } = {}) {
  const info = await findCanvas(sessionId)
  if (!info.found) return { ok: false, error: '页面上没有可用的 canvas' }

  const raw = await evaluate(sessionId, `(function(){
    var cvs = Array.prototype.slice.call(document.querySelectorAll('canvas'));
    var best = null, bestArea = -1;
    cvs.forEach(function(c){
      var r = c.getBoundingClientRect();
      var a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a > bestArea) { bestArea = a; best = c; }
    });
    if (!best) return '';
    try { return best.toDataURL('image/png'); } catch (e) { return 'ERR:' + e.message; }
  })()`, { timeout: '20s' })

  const dataUrl = unwrapEval(raw)
  if (typeof dataUrl !== 'string' || dataUrl.length < 200) {
    const why = typeof dataUrl === 'string' && dataUrl.startsWith('ERR:')
      ? dataUrl.slice(4)
      : 'canvas 像素不可读（多为跨域污染或被跨域 iframe 包裹）'
    return { ok: false, error: why, canvas: info }
  }
  const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
  const buf = Buffer.from(b64, 'base64')
  const size = pngSize(buf)
  if (!size) return { ok: false, error: 'canvas 导出的数据不是合法 PNG', canvas: info }

  const pngPath = out || tmpPath('canvas')
  fs.mkdirSync(path.dirname(pngPath), { recursive: true })
  fs.writeFileSync(pngPath, buf)
  return {
    ok: true,
    path: pngPath,
    width: size.width,
    height: size.height,
    cssWidth: info.cssW,
    cssHeight: info.cssH,
  }
}

/**
 * 在 canvas 上按**位图坐标**点击一次（自动换算到视口 CSS 坐标）。
 * 派发 pointerdown/mousedown/pointerup/mouseup/click 全套，兼容大多数验证码组件。
 */
export async function clickCanvas(sessionId, x, y) {
  const raw = await evaluate(sessionId, `(function(){
    var cvs = Array.prototype.slice.call(document.querySelectorAll('canvas'));
    var best = null, bestArea = -1;
    cvs.forEach(function(c){
      var r = c.getBoundingClientRect();
      var a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a > bestArea) { bestArea = a; best = c; }
    });
    if (!best) return {ok:false, err:'no canvas'};
    var r = best.getBoundingClientRect();
    var cx = r.left + ${Number(x)} * (r.width / best.width);
    var cy = r.top + ${Number(y)} * (r.height / best.height);
    var base = {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy,
                button:0, buttons:1, detail:1};
    function fire(type, Ctor, extra){
      try { best.dispatchEvent(new Ctor(type, Object.assign({}, base, extra||{}))); } catch(e){}
    }
    fire('pointerover', window.PointerEvent);
    fire('pointerdown', window.PointerEvent);
    fire('mousedown', window.MouseEvent);
    fire('pointerup', window.PointerEvent, {buttons:0});
    fire('mouseup', window.MouseEvent, {buttons:0});
    fire('click', window.MouseEvent, {buttons:0});
    return {ok:true, cx:cx, cy:cy};
  })()`, { timeout: '15s' })
  const j = unwrapEval(raw) || {}
  if (!j.ok) throw new Error(j.err || 'canvas 点击失败')
  return j
}

/**
 * 在 canvas 上做一次水平拖拽（滑块验证码用）：从 (x,y) 按下，拖 dx 像素后抬起。
 * 位图坐标语义，与 clickCanvas 一致。
 */
export async function dragCanvas(sessionId, x, y, dx, { steps = 24, holdMs = 0 } = {}) {
  const raw = await evaluate(sessionId, `(async function(){
    var cvs = Array.prototype.slice.call(document.querySelectorAll('canvas'));
    var best = null, bestArea = -1;
    cvs.forEach(function(c){
      var r = c.getBoundingClientRect();
      var a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a > bestArea) { bestArea = a; best = c; }
    });
    if (!best) return {ok:false, err:'no canvas'};
    var r = best.getBoundingClientRect();
    var sx = r.left + ${Number(x)} * (r.width / best.width);
    var sy = r.top + ${Number(y)} * (r.height / best.height);
    var dxCss = ${Number(dx)} * (r.width / best.width);
    function fire(type, cx, cy, buttons, Ctor){
      var opt = {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy,
                 button:0, buttons:buttons, detail:1};
      try { best.dispatchEvent(new Ctor(type, opt)); } catch(e){}
    }
    fire('pointerover', sx, sy, 0, window.PointerEvent);
    fire('pointerdown', sx, sy, 1, window.PointerEvent);
    fire('mousedown', sx, sy, 1, window.MouseEvent);
    var n = ${Math.max(1, Math.trunc(steps))};
    for (var i = 1; i <= n; i++) {
      var cx = sx + dxCss * (i / n);
      fire('pointermove', cx, sy, 1, window.PointerEvent);
      fire('mousemove', cx, sy, 1, window.MouseEvent);
      await new Promise(function(res){ setTimeout(res, 16); });
    }
    fire('pointerup', sx + dxCss, sy, 0, window.PointerEvent);
    fire('mouseup', sx + dxCss, sy, 0, window.MouseEvent);
    return {ok:true, sx:sx, sy:sy, dx:dxCss};
  })()`, { timeout: '30s', awaitPromise: true })
  const j = unwrapEval(raw) || {}
  if (!j.ok) throw new Error(j.err || 'canvas 拖拽失败')
  return j
}

/* ----------------------- 视觉后端（可插拔） ----------------------- */

/**
 * 调用一个 OpenAI 兼容的视觉接口，返回模型吐出的 JSON 对象。
 * 失败（网络/鉴权/解析）一律抛错，由上层决定降级到人工兜底。
 */
export async function callVision(cfg, img, instruction) {
  if (!cfg || !cfg.endpoint || !cfg.apiKey) throw new Error('未配置视觉后端（visionEndpoint/visionApiKey/visionModel）')
  const body = {
    model: cfg.model || 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a CAPTCHA solver. Always reply with a single JSON object and nothing else.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${instruction}\n\nImage size: ${img.width}x${img.height} px. Return pixel coordinates in this image's coordinate system (origin top-left).` },
          { type: 'image_url', image_url: { url: toDataUrl(img.path) } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  }
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`视觉接口 HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  const j = await res.json()
  const txt = j?.choices?.[0]?.message?.content
  if (!txt) throw new Error('视觉接口未返回内容')
  const m = txt.match(/\{[\s\S]*\}/)
  return JSON.parse(m ? m[0] : txt)
}

/* --------------------------- 检测 --------------------------- */

/**
 * 检测当前页是否处于验证码挑战中，并尽量识别类型与提示语。
 * @returns {Promise<{kind, prompt, canvas, blocked}>}
 *   kind ∈ 'canvas' | 'hcaptcha' | 'recaptcha' | 'slider' | 'cloudflare' | 'unknown'
 *   blocked=true 表示挑战在跨域 iframe 内，自动点击不可用
 */
/**
 * 从 DOM 里读验证码的题目文字（比 snapshot 正则可靠得多）。
 *
 * 先找 id/class 带 prompt/task/hint/question/instruction 的元素，
 * 再退回「文本里含 点击所有 / select all / 请点选」的短文本节点。
 * 都找不到返回空串。
 */
export async function readPrompt(sessionId) {
  const expr = `(() => {
    const SEL = ['prompt','task','hint','question','instruction','challenge-text','captcha-text']
    const sel = SEL.map((k) => '[id*="' + k + '" i],[class*="' + k + '" i]').join(',')
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
    const cands = []
    for (const el of document.querySelectorAll(sel)) {
      const t = clean(el.textContent)
      if (t && t.length <= 120) cands.push({ t, src: 'selector' })
    }
    if (!cands.length) {
      for (const el of document.querySelectorAll('p,div,span,h1,h2,h3,label')) {
        const t = clean(el.textContent)
        if (!t || t.length > 120) continue
        if (/点击所有|请点选|请选择|select all|click all|click on all/i.test(t)) cands.push({ t, src: 'keyword' })
      }
    }
    if (!cands.length) return { prompt: '' }
    // 优先挑含动作词的、且更短的那条
    const scored = cands.map((c) => ({
      ...c,
      score: (/点击所有|请点选|请选择|select all|click all/i.test(c.t) ? 10 : 0) + (c.src === 'selector' ? 5 : 0) - c.t.length / 200,
    })).sort((a, b) => b.score - a.score)
    return { prompt: scored[0].t }
  })()`
  try {
    const v = unwrapEval(await evaluate(sessionId, expr))
    return v && typeof v.prompt === 'string' ? v.prompt : ''
  } catch {
    return ''
  }
}

export async function detectCaptcha(sessionId, { log = () => {} } = {}) {
  let kind = 'unknown'
  let prompt = ''
  const signals = []

  // 1) 有没有同源 canvas —— 有就是能自动点的那条路
  let canvas = { found: false }
  try {
    canvas = await findCanvas(sessionId)
    if (canvas.found) { kind = 'canvas'; signals.push('canvas') }
  } catch (e) { log(`canvas 探测失败: ${e.message}`) }

  // 2) 题目文字：先读 DOM 上的 prompt 元素，读不到再退回 snapshot 正则
  try {
    prompt = await readPrompt(sessionId)
    if (prompt) signals.push('prompt-dom')
  } catch (e) { log(`prompt 探测失败: ${e.message}`) }

  // 3) 页面文本（snapshot 只读，不耗 context）
  try {
    const snap = await snapshot(sessionId)
    const t = typeof snap === 'string' ? snap : String(snap?.stdout || '')
    if (/点击所有|请按提示点选|select all (the )?(images|squares|tiles)|click (on )?(the )?(images|matching)/i.test(t)) {
      signals.push('prompt-text')
      if (!prompt) {
        // 优先「点击所有…」，其次才是泛化的提示语
        const pm = t.match(/点击所有[^\n"]{1,20}/i) || t.match(/select all[^\n"]{1,40}/i) || t.match(/请按提示点选[^\n"]{0,20}/i)
        if (pm) prompt = pm[0].trim()
      }
    }
    if (/滑块|拖动|slide to|drag the slider/i.test(t)) { kind = kind === 'canvas' ? 'canvas' : 'slider'; signals.push('slider-text') }
    if (/i'?m (a|not a) robot|verify you are human|just a moment|安全验证/i.test(t)) {
      signals.push('cf-or-verify')
      if (kind === 'unknown') kind = 'cloudflare'
    }
  } catch (e) { log(`snapshot 检测失败: ${e.message}`) }

  // 4) 元素树里找 hCaptcha / reCAPTCHA 的跨域 iframe
  let blocked = false
  try {
    const obs = await observe(sessionId, { json: true, maxDepth: 6, maxTokens: 4000 })
    const s = typeof obs === 'string' ? obs : String(obs?.stdout || '')
    if (/hcaptcha/i.test(s)) {
      blocked = true
      if (kind === 'unknown' || kind === 'canvas') kind = 'hcaptcha'
      signals.push('hcaptcha-ref')
    }
    if (/grecaptcha|rc-imageselect|google\.com\/recaptcha/i.test(s)) {
      blocked = true
      if (kind === 'unknown' || kind === 'canvas') kind = 'recaptcha'
      signals.push('recaptcha-ref')
    }
  } catch (e) { log(`observe 检测失败: ${e.message}`) }

  return { kind, prompt, canvas, blocked, signals }
}

/* ---------------- 跨域 iframe：靠无障碍树里的 ref 点复选框 ---------------- */

/**
 * 在 snapshot 里找「我是真实访客 / I am human」复选框的 ref。
 *
 * 关键发现（bsk 0.4.1 实测）：`snapshot` 能读到跨域 iframe **内部**的无障碍树，
 * 把 hCaptcha 的复选框暴露成 `@eN checkbox "hCaptcha 复选框，带有文本"我是真实访客"…"`
 * 和 `@eM button "我是真实访客"`；`observe` 只给 1 个 ref，读不到这些。
 * 有了 ref 就能用普通 click 点它（坐标点击那条路依然是死的）。
 *
 * @returns {Promise<{ref:string, via:string}|null>}
 */
export async function findCheckboxRef(sessionId, { attempts = 8, gapMs = 1200 } = {}) {
  // 跨域 iframe 的无障碍树要等 iframe 加载完才出现在 snapshot 里，
  // 刚导航完第一次读往往只有页面骨架（实测 533 字符 vs 完整 1046 字符），故轮询。
  let text = ''
  for (let i = 0; i < attempts; i++) {
    try {
      const sn = await snapshot(sessionId)
      text = typeof sn === 'string' ? sn : String(sn?.stdout ?? sn ?? '')
    } catch {
      text = ''
    }
    if (text && /checkbox|真实访客|i am human|verify you are human/i.test(text)) break
    if (i < attempts - 1) await sleep(gapMs)
  }
  if (!text) return null

  const lines = text.split('\n')
  // 1) 优先 aria checkbox，且文案像人机验证
  for (const line of lines) {
    const m = line.match(/(@e\d+)\s+checkbox\b/)
    if (!m) continue
    if (/真实访客|人机|robot|human|verify|挑战|challenge/i.test(line)) {
      return { ref: m[1], via: 'checkbox' }
    }
  }
  // 2) 退回「我是真实访客」按钮
  for (const line of lines) {
    const m = line.match(/(@e\d+)\s+button\s+"([^"]*)"/)
    if (!m) continue
    if (/我是真实访客|i am human|verify you are human/i.test(m[2])) {
      return { ref: m[1], via: 'button' }
    }
  }
  // 3) 任意 checkbox（有的站点不给文案）
  for (const line of lines) {
    const m = line.match(/(@e\d+)\s+checkbox\b/)
    if (m) return { ref: m[1], via: 'checkbox-any' }
  }
  return null
}

/**
 * 点掉跨域 iframe 里的人机验证复选框（不是图片点选，只是那个勾选框）。
 *
 * ref 是「某次 observation 内」的临时编号：snapshot 之后再隔一段时间点，bsk 会报
 * `observation ref was not found for this tab ... ref @eN unknown`。所以这里每次
 * 都「取最新 snapshot → 立刻点」，失败就整体重来（最多 attempts 次）。
 */
export async function clickCheckbox(sessionId, { waitMs = 6000, log = () => {}, attempts = 4 } = {}) {
  let found = null
  let lastErr = ''
  for (let i = 0; i < attempts; i++) {
    found = await findCheckboxRef(sessionId, { attempts: 3, gapMs: 800 })
    if (!found) { lastErr = '页面上没找到人机验证复选框'; await sleep(1000); continue }
    log(`找到复选框 ${found.ref}（${found.via}），点击`)
    try {
      await click(sessionId, { target: found.ref })
      lastErr = ''
      break
    } catch (e) {
      lastErr = String(e.message)
      // ref 过期 / 页面已变化：重新取 snapshot 再来
      if (!/ref was not found|unknown for tab|does not exist|observation/i.test(lastErr)) break
      log(`ref 失效，重新取快照（第 ${i + 1} 次）`)
      await sleep(700)
      found = null
    }
  }
  if (!found || lastErr) {
    return { ok: false, clicked: false, ref: found?.ref, error: lastErr || '点击未成功' }
  }

  const deadline = Date.now() + waitMs
  let passed = false
  while (Date.now() < deadline) {
    await sleep(900)
    passed = await isSolved(sessionId)
    if (passed) break
  }
  log(passed ? '复选框点完直接放行' : '复选框已点，但还需要完成图片挑战')
  return { ok: true, clicked: true, ref: found.ref, via: found.via, passed }
}

/* --------------------- 「agent 当视觉」两段式接口 --------------------- */

/**
 * 第一步：把当前挑战图导出成 PNG 并返回路径，交给调用方（agent）自己看图。
 *
 * 同源 canvas 走 `grabCanvas`（直接取像素，最清晰）；没有 canvas 时退回整屏截图，
 * 这样跨域 iframe 的挑战也能被看见（但只能人工点）。
 *
 * @returns {Promise<{ok, pngPath?, width?, height?, source?, prompt?, kind?, blocked?, canvas?, error?}>}
 */
export async function inspectChallenge(sessionId, { log = () => {}, outDir } = {}) {
  const det = await detectCaptcha(sessionId, { log })

  // 优先：同源 canvas 直取
  if (det.canvas && det.canvas.found) {
    const out = outDir ? path.join(outDir, `challenge-canvas-${Date.now()}.png`) : undefined
    const g = await grabCanvas(sessionId, { out })
    if (g.ok) {
      return {
        ok: true,
        source: 'canvas',
        pngPath: g.path,
        width: g.width,
        height: g.height,
        cssWidth: g.cssWidth,
        cssHeight: g.cssHeight,
        coordSpace: 'canvas',
        kind: det.kind,
        prompt: det.prompt,
        blocked: false,
      }
    }
    log(`canvas 直取失败，退回整屏截图: ${g.error}`)
  }

  // 兜底：整屏截图（跨域 iframe 的挑战只能这样看）
  const out = outDir ? path.join(outDir, `challenge-page-${Date.now()}.png`) : tmpPath('page')
  try {
    await screenshot(sessionId, { out, fullPage: false, timeout: '30s' })
  } catch (e) {
    return { ok: false, error: `截图失败: ${e.message}`, kind: det.kind, blocked: det.blocked }
  }
  let size = null
  try { size = pngSize(fs.readFileSync(out)) } catch { /* noop */ }
  return {
    ok: true,
    source: 'viewport',
    pngPath: out,
    width: size?.width,
    height: size?.height,
    coordSpace: 'viewport',
    kind: det.kind,
    prompt: det.prompt,
    blocked: det.blocked,
    note: det.blocked
      ? '挑战在跨域 iframe 内，bsk 无法按坐标点击；请看图确认后改用 bsk_captcha_pick 的 human=true 走人工兜底'
      : undefined,
  }
}

/**
 * 第二步：按调用方给出的坐标点选。
 *
 * @param {string} sessionId
 * @param {object} opts
 * @param {Array<[number,number]>} opts.points 要点击的坐标（默认 canvas 位图坐标系）
 * @param {'canvas'|'viewport'} opts.coordSpace
 * @param {boolean} opts.human true 时直接走 request-help 人工兜底
 * @param {number} opts.waitMs 点完等多久再判定
 */
export async function pickPoints(sessionId, {
  points = [], coordSpace = 'canvas', human = false, waitMs = 2500, log = () => {},
} = {}) {
  if (human) {
    log('走人工兜底：请在浏览器里完成验证')
    const r = await requestHelp(sessionId, {
      prompt: '请完成当前页面上的验证码（按要求点选/拖动后提交），完成后告诉我。',
      timeout: '10m',
    })
    const passed = await isSolved(sessionId)
    return { ok: true, passed, humanUsed: true, outcome: r?.outcome || 'unknown', clicked: 0 }
  }

  if (!points.length) return { ok: false, error: '没有给任何坐标点', clicked: 0 }

  // 跨域 iframe 的挑战（hCaptcha/reCAPTCHA）没有同源 canvas，坐标点击无从下手。
  const cv = await findCanvas(sessionId)
  if (!cv.found) {
    return {
      ok: false,
      clicked: 0,
      error: '当前页没有同源 canvas，无法按坐标点击（跨域 iframe 里的 hCaptcha/reCAPTCHA 属于这种情况）。'
        + '请改用 human=true 让真人完成验证。',
    }
  }

  if (coordSpace === 'viewport') {
    return {
      ok: false,
      clicked: 0,
      error: '视口坐标点击依赖 bsk 的 --capture 收据，当前版本存在收据死锁（见 complex.mjs 顶部说明），无法可靠执行。'
        + '请改用 canvas 坐标系，或传 human=true 走人工兜底。',
    }
  }

  let clicked = 0
  for (const p of points) {
    const [x, y] = Array.isArray(p) ? p : [p?.x, p?.y]
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) continue
    try {
      await clickCanvas(sessionId, Number(x), Number(y))
      clicked++
      log(`已点击 canvas(${x}, ${y})`)
    } catch (e) {
      log(`点击 (${x}, ${y}) 失败: ${e.message}`)
    }
    await sleep(220)
  }

  if (clicked === 0) {
    return { ok: false, clicked: 0, error: '所有坐标点击都失败了，页面可能已变化；请重新 inspect 再试' }
  }

  if (waitMs > 0) await sleep(waitMs)
  const passed = await isSolved(sessionId)
  return { ok: true, passed, clicked, humanUsed: false }
}

/* ----------------------- 自动求解（有视觉后端时） ----------------------- */

/**
 * 自动解「图片点选」类验证码：canvas 取图 → 视觉后端给坐标 → 合成点击 → 判定。
 * 无视觉后端或失败时退回人工兜底。
 */
export async function solveImageSelect(sessionId, {
  vision = null, rounds = 6, waitMs = 40000, humanFallback = true, log = () => {},
} = {}) {
  let humanUsed = false
  for (let i = 1; i <= rounds; i++) {
    log(`[图片点选] 第 ${i}/${rounds} 轮`)
    const info = await inspectChallenge(sessionId, { log })
    if (!info.ok) {
      if (humanFallback) {
        humanUsed = true
        const r = await pickPoints(sessionId, { human: true, log })
        return { ok: true, passed: r.passed, kind: 'image-select', rounds: i, humanUsed }
      }
      return { ok: false, passed: false, kind: 'image-select', rounds: i, lastError: info.error, humanUsed }
    }

    let decision
    try {
      decision = await callVision(vision, { path: info.pngPath, width: info.width, height: info.height },
        `This is a CAPTCHA image-selection challenge${info.prompt ? ` with instruction: "${info.prompt}"` : ''}. `
        + 'Identify the tile centers that match the instruction. '
        + 'Reply JSON: {"tiles":[[x,y],...], "done":false, "note":"..."}. '
        + 'If already solved or nothing matches, set "tiles":[] and "done":true.')
    } catch (e) {
      log(`[图片点选] 视觉后端失败: ${e.message}`)
      if (humanFallback) {
        humanUsed = true
        const r = await pickPoints(sessionId, { human: true, log })
        return { ok: true, passed: r.passed, kind: 'image-select', rounds: i, humanUsed }
      }
      return { ok: false, passed: false, kind: 'image-select', rounds: i, lastError: e.message, humanUsed }
    }

    if (decision.done) {
      log('[图片点选] 视觉后端判定已通过')
      return { ok: true, passed: true, kind: 'image-select', rounds: i, humanUsed }
    }

    const tiles = Array.isArray(decision.tiles) ? decision.tiles : []
    const r = await pickPoints(sessionId, { points: tiles, coordSpace: info.coordSpace, log })
    if (r.passed) {
      log('[图片点选] 已通过')
      return { ok: true, passed: true, kind: 'image-select', rounds: i, humanUsed }
    }
    await sleep(Math.max(1200, Math.trunc(waitMs / rounds)))
    if (await isSolved(sessionId)) {
      log('[图片点选] 已通过')
      return { ok: true, passed: true, kind: 'image-select', rounds: i, humanUsed }
    }
  }
  return { ok: false, passed: false, kind: 'image-select', rounds, lastError: '轮次耗尽仍未通过', humanUsed }
}

/**
 * 自动解滑块类验证码：canvas 取图 → 视觉后端估 dx → canvas 合成拖拽 → 判定。
 */
export async function solveSlider(sessionId, {
  vision = null, rounds = 4, waitMs = 30000, humanFallback = true, log = () => {},
} = {}) {
  for (let i = 1; i <= rounds; i++) {
    log(`[滑块] 第 ${i}/${rounds} 轮`)
    const info = await inspectChallenge(sessionId, { log })
    if (!info.ok || info.coordSpace !== 'canvas') {
      if (humanFallback) {
        const r = await pickPoints(sessionId, { human: true, log })
        return { ok: true, passed: r.passed, kind: 'slider', rounds: i, humanUsed: true }
      }
      return { ok: false, passed: false, kind: 'slider', rounds: i, lastError: info.error || '无同源 canvas', humanUsed: false }
    }

    let d = null
    try {
      d = await callVision(vision, { path: info.pngPath, width: info.width, height: info.height },
        'This is a slide-to-fit CAPTCHA. Find the slider handle and the gap it must reach. '
        + 'Reply JSON: {"dx":<horizontal pixels to drag right>, "handle":[x,y]}. If unclear, {"dx":0,"handle":null}.')
    } catch (e) {
      log(`[滑块] 视觉后端失败: ${e.message}`)
    }

    const dx = Number(d?.dx)
    const handle = Array.isArray(d?.handle) ? d.handle : null
    if (Number.isFinite(dx) && dx > 0 && handle) {
      try {
        await dragCanvas(sessionId, Number(handle[0]), Number(handle[1]), dx)
        await sleep(1200)
        if (await isSolved(sessionId)) {
          return { ok: true, passed: true, kind: 'slider', rounds: i, humanUsed: false }
        }
      } catch (e) { log(`[滑块] canvas 拖拽失败: ${e.message}`) }
    }

    // 退一步：用 bsk 原生 drag 拖真实 DOM 滑块（非 canvas 场景）
    if (!handle) {
      try {
        await drag(sessionId, { selector: '[class*=slider],[class*=handle],[class*=btn]', dx: Math.trunc(dx || 0) })
        await sleep(1200)
        if (await isSolved(sessionId)) {
          return { ok: true, passed: true, kind: 'slider', rounds: i, humanUsed: false }
        }
      } catch (e) { log(`[滑块] DOM 拖拽失败: ${e.message}`) }
    }

    if (humanFallback) {
      log('[滑块] 退回人工兜底')
      const r = await pickPoints(sessionId, { human: true, log })
      return { ok: true, passed: r.passed, kind: 'slider', rounds: i, humanUsed: true }
    }
  }
  return { ok: false, passed: false, kind: 'slider', rounds, lastError: '轮次耗尽仍未通过', humanUsed: false }
}

/* ----------------------- 通过判定 ----------------------- */

/**
 * 判定验证码是否已通过。
 * 顺序：页面内通用标记（自定义 solved 标志 / hCaptcha-reCAPTCHA 响应令牌 / 覆盖层消失）
 *      → snapshot 文本是否还带挑战关键词。
 */
export async function isSolved(sessionId) {
  try {
    const raw = await evaluate(sessionId, `(function(){
      // 页面自报（mock / 站点自挂的钩子）
      if (window.__captchaSolved === true) return true;
      if (window.__captchaMeta && typeof window.__captchaMeta === 'function') {
        try { var m = window.__captchaMeta(); if (m && m.solved === true) return true; if (m && m.solved === false) return false; } catch (e) {}
      }
      // hCaptcha / reCAPTCHA 的隐藏响应字段：有值才算过
      var tk = document.querySelector('textarea[name=h-captcha-response],textarea[name=g-recaptcha-response],input[name=h-captcha-response],input[name=g-recaptcha-response]');
      if (tk && typeof tk.value === 'string' && tk.value.length > 20) return true;

      // 跨域挑战 iframe：存在即说明挑战还没过（不能因为读不到内容就判通过）
      var ch = document.querySelector('iframe[src*="hcaptcha.com"],iframe[src*="recaptcha"],iframe[title*="hCaptcha"],iframe[title*="reCAPTCHA"],iframe[title*="挑战"]');
      if (ch) return false;

      // 覆盖层仍在也算没过
      var ov = document.querySelector('.hcaptcha-box,.g-recaptcha,.geetest_panel,.challenge-container,#challenge-stage');
      if (ov) return false;

      return null;  // 没有明确信号，交给上层兜底
    })()`, { timeout: '12s' })
    const v = unwrapEval(raw)
    if (v === true || v === false) return v
  } catch { /* ignore */ }

  // 兜底：看页面文本里还有没有挑战话术
  try {
    const snap = await snapshot(sessionId)
    const t = (typeof snap === 'string' ? snap : String(snap?.stdout || '')).toLowerCase()
    if (/just a moment|verify you are human|select all (the )?images|please click|点击所有|安全验证|hcaptcha|recaptcha/.test(t)) return false
    return true
  } catch { return false }
}

/* ----------------------- 总入口 ----------------------- */

/**
 * 自动判别验证码类型并分派。
 * 注意：跨域 iframe（hCaptcha/reCAPTCHA）无法自动点击，只能人工兜底。
 */
export async function solveComplex(sessionId, {
  vision = null, rounds = 6, waitMs = 40000, humanFallback = true, forceKind = null, log = () => {},
} = {}) {
  const det = await detectCaptcha(sessionId, { log })
  const kind = forceKind || det.kind
  log(`[复杂验证码] 检测类型=${det.kind}${det.prompt ? ` 提示="${det.prompt}"` : ''}${det.blocked ? '（跨域 iframe）' : ''} → 采用=${kind}`)

  if (det.blocked) {
    // 跨域 iframe 的图片点选点不了，但那个「我是真实访客」复选框可以靠无障碍 ref 点掉，
    // 点完有概率直接放行（hCaptcha 有时只给一次挑战，有时干脆不弹）。
    const cb = await clickCheckbox(sessionId, { waitMs: Math.min(waitMs, 8000), log }).catch((e) => ({ ok: false, error: String(e.message) }))
    if (cb?.passed) {
      return { ok: true, passed: true, kind, rounds: 1, humanUsed: false, checkbox: cb, note: '跨域 iframe 挑战，勾选复选框后直接放行' }
    }
    if (!humanFallback) {
      return {
        ok: false, passed: false, kind, humanUsed: false, checkbox: cb,
        lastError: '挑战位于跨域 iframe（hCaptcha/reCAPTCHA），图片点选无法按坐标点击；已尝试点复选框但未直接放行，且已禁用人工兜底',
      }
    }
    const r = await pickPoints(sessionId, { human: true, log })
    return { ok: true, passed: r.passed, kind, rounds: 0, humanUsed: true, checkbox: cb, note: '跨域 iframe 挑战，已走人工兜底' }
  }

  if (kind === 'slider') return solveSlider(sessionId, { vision, rounds, waitMs, humanFallback, log })
  return solveImageSelect(sessionId, { vision, rounds, waitMs, humanFallback, log })
}
