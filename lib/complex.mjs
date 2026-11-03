/**
 * 复杂验证码求解：自动视觉 + 拖拽。
 *
 * 设计原则（不依赖 bsk observe 的未知 JSON schema）：
 *   - 用 `screenshot` 截整屏视口，得到一张 PNG；
 *   - 把这张图交给「视觉后端」（OpenAI 兼容的多模态接口，或人工兜底
 *     request-help）去理解：当前是什么验证码、提示语是什么、要点的图块
 *     中心像素坐标、提交按钮的像素坐标、滑块要拖多远；
 *   - 视觉后端返回**屏幕像素坐标**，直接用 `click --capture --image-x/--image-y`
 *     按坐标点击（与截图同一视口，坐标一致）；滑块用 `drag --dx` 拖动；
 *   - 提交后轮询，直到挑战页消失 / 出现通过标记。
 *
 * 视觉后端未配置或调用失败时，自动退回 `request-help` 让真人完成（人工兜底
 * 原语），保证「永远能解，只是有时需要人」。
 *
 * @module dsh-bsk-fetch/lib/complex
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  screenshot, observe, click, drag, evaluate, waitForElement,
  waitForNavigation, requestHelp, snapshot,
} from './bsk.mjs'

/* --------------------------- 小工具 --------------------------- */

/** 解析 PNG 的 IHDR，取像素宽高（仅读前 24 字节，不解码图像）。 */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 把文件读成 data URL（base64），用于丢给多模态视觉接口。 */
function toDataUrl(p, mime = 'image/png') {
  const b = fs.readFileSync(p)
  return `data:${mime};base64,${b.toString('base64')}`
}

/** 取视口尺寸，用于把视觉后端返回的坐标对齐到屏。 */
async function viewport(sessionId) {
  try {
    const r = await evaluate(sessionId, '(function(){return {w:window.innerWidth,h:window.innerHeight}})()', { timeout: '10s' })
    if (r && r.w && r.h) return r
  } catch { /* cross-origin 等场景 evaluate 可能失败，忽略 */ }
  return null
}

/* ----------------------- 视觉后端（可插拔） ----------------------- */

/**
 * 调用一个 OpenAI 兼容的视觉接口，返回模型吐出的 JSON 对象。
 * 失败（网络/鉴权/解析）一律抛错，由上层决定降级到人工兜底。
 *
 * @param {object} cfg { endpoint, apiKey, model }
 * @param {object} img { path, width, height }
 * @param {string} instruction 给模型的指令（含坐标体系说明）
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
  // 容错：模型有时会在 JSON 外包一层 ```json ... ```
  const m = txt.match(/\{[\s\S]*\}/)
  return JSON.parse(m ? m[0] : txt)
}

/* --------------------------- 检测 --------------------------- */

/**
 * 粗粒度检测当前页是否处于某种验证码挑战中。
 * 用 snapshot 文本 + observe 元素树（不强依赖具体 schema）做多信号判断。
 * 返回 { kind, prompt, confidences }，其中 kind ∈
 * 'hcaptcha' | 'recaptcha' | 'slider' | 'cloudflare' | 'unknown'。
 */
export async function detectCaptcha(sessionId, { log = () => {} } = {}) {
  let kind = 'unknown'
  let prompt = ''
  const signals = []
  try {
    const snap = await snapshot(sessionId, { json: false })
    const t = (snap?.stdout || snap || '').toString()
    if (/select all (the|images)|click (on )?(the )?(images|matching)|please (click|select)/i.test(t)) { kind = kind === 'unknown' ? 'recaptcha' : kind; signals.push('prompt-text') }
    if (/i'?m (a|not a) robot|verify you are human|just a moment/i.test(t)) { signals.push('cf-or-verify'); if (/just a moment/i.test(t)) kind = 'cloudflare' }
  } catch (e) { log(`snapshot 检测失败: ${e.message}`) }

  try {
    const obs = await observe(sessionId, { json: true, maxDepth: 6, maxTokens: 4000 })
    const s = obs?.stdout || ''
    if (/hcaptcha/i.test(s)) { kind = 'hcaptcha'; signals.push('hcaptcha-ref') }
    if (/grecaptcha|rc-imageselect|google\.com\/recaptcha/i.test(s)) { kind = 'recaptcha'; signals.push('recaptcha-ref') }
    if (/geetest|slider|拖动|drag the/i.test(s)) { kind = 'slider'; signals.push('slider-ref') }
    // 试着从 observe 文本里抠出提示语
    const pm = s.match(/(select all .{0,80}?)(?:\\n|"|<|\.)/i) || s.match(/(please .{0,80}?)(?:\\n|"|<|\.)/i)
    if (pm) prompt = pm[1].trim()
  } catch (e) { log(`observe 检测失败: ${e.message}`) }

  return { kind, prompt, signals }
}

/* ----------------------- 图片点选求解 ----------------------- */

/**
 * 解「图片点选」类验证码（hCaptcha / reCAPTCHA 网格）。
 * 流程：截图 → 视觉后端给出要点的图块坐标 + 提交按钮坐标 → 逐个点击 →
 * 点提交 → 轮询直到通过。无视觉后端或失败时退回人工兜底。
 *
 * @returns {{ok:boolean, passed:boolean, kind:string, rounds:number, lastError?:string, humanUsed:boolean}}
 */
export async function solveImageSelect(sessionId, {
  vision = null, rounds = 6, waitMs = 40000, humanFallback = true, log = () => {},
} = {}) {
  const tmp = (name) => path.join(process.env.TMPDIR || process.env.TEMP || '.', `bsk-complex-${Date.now()}-${name}.png`)
  let humanUsed = false

  for (let i = 1; i <= rounds; i++) {
    log(`[图片点选] 第 ${i}/${rounds} 轮`)
    const imgPath = tmp(`shot-${i}`)
    await screenshot(sessionId, { out: imgPath, fullPage: false, timeout: '30s' })
    const buf = fs.readFileSync(imgPath)
    const size = pngSize(buf) || (await viewport(sessionId)) || { width: 1280, height: 800 }

    let decision
    try {
      decision = await callVision(vision, { path: imgPath, width: size.width, height: size.height },
        'This is a CAPTCHA image-selection challenge. Identify which tiles contain the requested object, '
        + 'and the location of the submit/verify button. '
        + 'Reply JSON: {"tiles":[[x,y],...], "submit":[x,y], "done":false, "note":"..."}. '
        + 'If the challenge is already solved or no tiles match, set "tiles":[] and "done":true.')
    } catch (e) {
      log(`[图片点选] 视觉后端失败: ${e.message}`)
      if (humanFallback) {
        humanUsed = true
        log('[图片点选] 退回人工兜底：请在浏览器里完成验证')
        await requestHelp(sessionId, { prompt: '请完成这个图片点选验证码（按要求点击图块并提交），完成后告诉我。', timeout: '10m' })
        const passed = await isSolved(sessionId)
        return { ok: true, passed, kind: 'image-select', rounds: i, humanUsed: true }
      }
      return { ok: false, passed: false, kind: 'image-select', rounds: i, lastError: e.message, humanUsed: false }
    }

    if (decision.done) {
      log('[图片点选] 视觉后端判定已通过')
      return { ok: true, passed: true, kind: 'image-select', rounds: i, humanUsed }
    }

    const tiles = Array.isArray(decision.tiles) ? decision.tiles : []
    for (const [x, y] of tiles) {
      // 按像素坐标点击（与截图同视口）
      await clickByImage(sessionId, x, y, log)
    }
    if (Array.isArray(decision.submit) && decision.submit.length === 2) {
      await clickByImage(sessionId, decision.submit[0], decision.submit[1], log)
    }

    // 等一会儿让挑战响应
    await new Promise((r) => setTimeout(r, Math.max(2000, Math.trunc(waitMs / rounds))))
    if (await isSolved(sessionId)) {
      log('[图片点选] 已通过')
      return { ok: true, passed: true, kind: 'image-select', rounds: i, humanUsed }
    }
  }
  return { ok: false, passed: false, kind: 'image-select', rounds, lastError: '轮次耗尽仍未通过', humanUsed }
}

/** 按视口像素坐标点击（优先 --capture + 坐标，失败退回无 --capture）。 */
async function clickByImage(sessionId, x, y, log) {
  try {
    await click(sessionId, { selector: '', target: '', capture: true, imageX: Math.trunc(x), imageY: Math.trunc(y) })
  } catch (e1) {
    try {
      await click(sessionId, { selector: '', target: '', imageX: Math.trunc(x), imageY: Math.trunc(y) })
    } catch (e2) {
      log(`点击坐标 (${Math.trunc(x)},${Math.trunc(y)}) 失败: ${e2.message}`)
    }
  }
}

/* ----------------------- 滑块求解 ----------------------- */

/**
 * 解「滑块拼图」类验证码（Geetest 等）。
 * 优先用视觉后端估算需拖动的像素距离（dx），再用 `drag --dx` 拖动滑块手柄；
 * 拿不到就退回人工兜底。
 */
export async function solveSlider(sessionId, {
  vision = null, rounds = 4, waitMs = 30000, humanFallback = true, log = () => {},
} = {}) {
  for (let i = 1; i <= rounds; i++) {
    log(`[滑块] 第 ${i}/${rounds} 轮`)
    const tmp = path.join(process.env.TMPDIR || process.env.TEMP || '.', `bsk-slider-${Date.now()}-${i}.png`)
    await screenshot(sessionId, { out: tmp, fullPage: false, timeout: '30s' })
    const buf = fs.readFileSync(tmp)
    const size = pngSize(buf) || (await viewport(sessionId)) || { width: 1280, height: 800 }

    let dx
    try {
      const d = await callVision(vision, { path: tmp, width: size.width, height: size.height },
        'This is a slide-to-fit CAPTCHA. Find the slider handle and the target gap. '
        + 'Reply JSON: {"dx":<pixels to drag right>, "handle":[x,y]}. If unclear, {"dx":0,"handle":null}.')
      dx = Number(d?.dx)
    } catch (e) {
      log(`[滑块] 视觉后端失败: ${e.message}`)
      dx = 0
    }

    if (dx && dx > 0) {
      try {
        await drag(sessionId, { source: '@slider', dx: Math.trunc(dx), mode: 'press-move-release' })
        await new Promise((r) => setTimeout(r, 800))
        if (await isSolved(sessionId)) return { ok: true, passed: true, kind: 'slider', rounds: i, humanUsed: false }
        continue
      } catch (e) { log(`[滑块] 拖动失败: ${e.message}`) }
    }

    if (humanFallback) {
      log('[滑块] 退回人工兜底')
      await requestHelp(sessionId, { prompt: '请完成这个滑块验证码（把拼图拖到正确位置），完成后告诉我。', timeout: '10m' })
      return { ok: true, passed: await isSolved(sessionId), kind: 'slider', rounds: i, humanUsed: true }
    }
    return { ok: false, passed: false, kind: 'slider', rounds: i, lastError: '无法估算拖动距离且无人工兜底', humanUsed: false }
  }
  return { ok: false, passed: false, kind: 'slider', rounds, lastError: '轮次耗尽仍未通过', humanUsed: false }
}

/* ----------------------- 通过判定 ----------------------- */

/**
 * 粗判验证码是否已通过：挑战覆盖层是否还在。
 * 用 evaluate 探测 hCaptcha/reCAPTCHA 的响应标记或 overlay 是否消失；
 * 探测失败时退回「observe 是否还能看到挑战文本」。
 */
export async function isSolved(sessionId) {
  try {
    const r = await evaluate(sessionId,
      '(function(){'
      + 'var tk=document.querySelector("textarea[name=h-captcha-response],textarea[name=g-recaptcha-response]");'
      + 'if(tk&&tk.value&&tk.value.length>20)return true;'
      + 'var ov=document.querySelector(".hcaptcha-box,.g-recaptcha,.geetest_panel,.challenge-container");'
      + 'return !ov;'
      + '})()',
      { timeout: '10s' })
    if (typeof r === 'boolean') return r
  } catch { /* ignore */ }
  // 退回：看 snapshot 是否还有挑战关键词
  try {
    const snap = await snapshot(sessionId, { json: false })
    const t = (snap?.stdout || snap || '').toString().toLowerCase()
    if (/just a moment|verify you are human|select all (the )?images|please click/i.test(t)) return false
    return true
  } catch { return false }
}

/* ----------------------- 总入口 ----------------------- */

/**
 * 自动判别验证码类型并分派到对应求解器。
 * @returns {object} 与具体求解器一致的返回形状，外加 kind 字段。
 */
export async function solveComplex(sessionId, {
  vision = null, rounds = 6, waitMs = 40000, humanFallback = true, forceKind = null, log = () => {},
} = {}) {
  const det = await detectCaptcha(sessionId, { log })
  const kind = forceKind || det.kind
  log(`[复杂验证码] 检测类型=${det.kind}${det.prompt ? ` 提示="${det.prompt}"` : ''} → 采用=${kind}`)
  if (kind === 'slider') return solveSlider(sessionId, { vision, rounds, waitMs, humanFallback, log })
  if (kind === 'hcaptcha' || kind === 'recaptcha' || kind === 'image-select' || kind === 'unknown') {
    return solveImageSelect(sessionId, { vision, rounds, waitMs, humanFallback, log })
  }
  return { ok: false, passed: false, kind, lastError: '未识别的验证码类型', humanUsed: false }
}
