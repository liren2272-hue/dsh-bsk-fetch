/**
 * 抓取流程：开会话 → 导航 → 自动过验证码 → 抓 HTML/正文 → 落盘。
 * 把结果整理成统一结构返回给宿主工具。
 *
 * @module dsh-bsk-fetch/lib/fetch
 */

import fs from 'node:fs'
import path from 'node:path'
import { sessionStart, navigate, getHtml, sessionStop, snapshot, evaluate } from './bsk.mjs'
import { passCaptcha, readState, unwrapEval } from './captcha.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 outputDir：空则用 `<pluginRoot>/data/fetched`。 */
function resolveOutputDir(outputDir, pluginRoot) {
  if (outputDir && outputDir.trim() !== '') {
    try { fs.mkdirSync(outputDir, { recursive: true }); return outputDir } catch { /* fallthrough */ }
  }
  const fallback = path.join(pluginRoot || process.cwd(), 'data', 'fetched')
  fs.mkdirSync(fallback, { recursive: true })
  return fallback
}

/** 给落盘文件起个不冲突的名字。 */
function safeFileName(prefix, ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `${prefix}-${ts}.${ext}`
}

/**
 * 解析「页内同源 fetch」返回的 base64 结果（纯函数，可离线断言）。
 *
 * 真机结论：CF 放行后 `bsk download --ref` 会因「新窗口 target=_blank 无法归因」
 * 报 `the browser download could not be attributed or completed`，trusted click
 * 又常报 `control context no longer belongs to the current document`；只有页面内
 * `fetch(pdfPath)` → arrayBuffer → btoa(base64) 稳定拿到 200 application/pdf。
 * ScienceDirect 会先回 OneTrust 同意弹窗 HTML，这里显式拦截（不把 HTML 当 PDF）。
 */
export function parseFetchBinary(val) {
  let obj = val
  if (typeof obj === 'string') obj = JSON.parse(obj)
  if (!obj || typeof obj !== 'object') throw new Error('同源 fetch 无返回')
  if (obj.status !== 200) throw new Error(`同源 fetch status=${obj.status}`)
  if (!obj.b64) throw new Error('同源 fetch 无 b64')
  const bytes = Buffer.from(obj.b64, 'base64')
  if (!bytes.length) throw new Error('同源 fetch 字节为空')
  const head = bytes.subarray(0, 32).toString('latin1')
  if (/^\s*<(!doctyp|html)/i.test(head)) throw new Error('得到 HTML 质询/同意页而非二进制')
  const ext = /pdf/i.test(obj.ct || '') ? 'pdf' : 'bin'
  return { bytes, ext, size: bytes.length, ct: obj.ct || '' }
}

/** 放行后用页内同源 fetch + base64 抓二进制并落盘。 */
async function fetchBinary(sessionId, fetchPath, outDir) {
  const expr = `(async function(){try{var r=await fetch(${JSON.stringify(fetchPath)});` +
    `var a=await r.arrayBuffer();var u=new Uint8Array(a);var s='';` +
    `for(var i=0;i<u.length;i++){s+=String.fromCharCode(u[i]);}` +
    `return JSON.stringify({status:r.status,ct:r.headers.get('content-type'),` +
    `size:u.length,b64:btoa(s)});}catch(e){return JSON.stringify({err:String(e)});}})()`
  const raw = await evaluate(sessionId, expr, { timeout: '90s' })
  const parsed = parseFetchBinary(unwrapEval(raw))
  const outPath = path.join(outDir, safeFileName('binary', parsed.ext))
  fs.writeFileSync(outPath, parsed.bytes)
  return { path: outPath, size: parsed.size, ext: parsed.ext, ct: parsed.ct }
}

/**
 * 完整抓取：导航到 url，自动过验证码，抓 HTML 存盘。
 *
 * @param {object} opts
 * @param {string} opts.url                 目标网址
 * @param {string} [opts.outputDir]        落盘目录（空则插件内 data/fetched）
 * @param {string} [opts.pluginRoot]       插件根目录（用于回退落盘）
 * @param {number} [opts.waitMs]           过验证码单轮等待
 * @param {number} [opts.rounds]           过验证码轮数
 * @param {number} [opts.maxBytes]         HTML 截断字节数
 * @param {string} [opts.sessionId]        复用已有会话（不传则新建）
 * @param {(msg:string)=>void} [opts.log]  进度回调
 * @returns {Promise<object>} 结构化结果
 */
export async function fetchPage(opts) {
  const {
    url, outputDir = '', pluginRoot = process.cwd(), waitMs = 40000, rounds = 6,
    silentMs = 0, fetchPath = '', maxBytes = 0, sessionId: reuseId = '', log = () => {},
  } = opts

  if (!/^https?:\/\//i.test(url || '')) {
    throw new Error(`url 必须是 http(s) 开头：${url}`)
  }

  const ownSession = !reuseId
  const sessionId = reuseId || await sessionStart({ name: `bsk-fetch::${url}` })
  log(`会话 ${sessionId} 已就绪，导航到 ${url} …`)
  try {
    await navigate(sessionId, url, { waitUntil: 'load', timeout: '45s' })
    await sleep(800)

    const before = await readState(sessionId)
    let captcha = { passed: !before.challenge, leftChallenge: !before.challenge, hasClearance: before.cfClearance, rounds: 0, reason: before.challenge ? '未处理' : '导航后直接是正常页', state: before }
    if (before.challenge) {
      log('检测到验证码/质询页，尝试自动通过…')
      captcha = await passCaptcha(sessionId, { waitMs, rounds, silentMs, log })
    } else {
      log('导航后未检测到挑战页，直接抓取。')
    }

    // 抓 HTML（写盘；同时尽量回读一份用于返回）
    const dir = resolveOutputDir(outputDir, pluginRoot)
    const htmlPath = path.join(dir, safeFileName('page', 'html'))
    await getHtml(sessionId, { out: htmlPath, maxBytes: maxBytes || undefined })
    let html = ''
    try { html = fs.readFileSync(htmlPath, 'utf8') } catch { html = '' }

    // 抓正文（可读文本）：用 snapshot（aria 树，纯文本，不消耗 context）
    let text = ''
    try { text = await snapshot(sessionId) } catch { text = '' }

    const after = await readState(sessionId)

    // 可选：放行后抓同源二进制（PDF）。失败不阻断 HTML/正文抓取，只如实上报。
    let binary = null
    let binaryError = ''
    if (fetchPath && fetchPath.trim() !== '') {
      try {
        binary = await fetchBinary(sessionId, fetchPath.trim(), dir)
        log(`同源 fetch 已落盘二进制：${binary.path} (${binary.size} bytes)`)
      } catch (e) {
        binaryError = String(e && e.message || e)
        log(`同源 fetch 失败：${binaryError}`)
      }
    }
    return {
      ok: true,
      url,
      sessionId,
      captcha: { ...captcha, leftChallenge: !after.challenge || captcha.leftChallenge, hasClearance: after.cfClearance },
      htmlPath: fs.existsSync(htmlPath) ? htmlPath : '',
      htmlLength: html.length,
      textLength: text.length,
      textSample: text.slice(0, 4000),
      title: after.title,
      finalUrl: after.url,
      binaryPath: binary ? binary.path : '',
      binarySize: binary ? binary.size : 0,
      binaryError,
    }
  } finally {
    if (ownSession) {
      try { await sessionStop(sessionId) } catch { /* best-effort */ }
    }
  }
}

/**
 * 只过当前页验证码（复用会话），不抓取。
 * @returns {Promise<object>}
 */
export async function passOnly(sessionId, { waitMs = 40000, rounds = 6, silentMs = 0, log = () => {} } = {}) {
  if (!sessionId) throw new Error('bsk_pass_captcha 必须先有一个浏览器会话（sessionId）')
  const captcha = await passCaptcha(sessionId, { waitMs, rounds, silentMs, log })
  const after = await readState(sessionId)
  return {
    ok: true,
    sessionId,
    captcha: { ...captcha, hasClearance: after.cfClearance },
    title: after.title,
    finalUrl: after.url,
  }
}
