/**
 * 抓取流程：开会话 → 导航 → 自动过验证码 → 抓 HTML/正文 → 落盘。
 * 把结果整理成统一结构返回给宿主工具。
 *
 * @module dsh-bsk-fetch/lib/fetch
 */

import fs from 'node:fs'
import path from 'node:path'
import { sessionStart, navigate, getHtml, sessionStop, snapshot } from './bsk.mjs'
import { passCaptcha, readState } from './captcha.mjs'

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
    maxBytes = 0, sessionId: reuseId = '', log = () => {},
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
      captcha = await passCaptcha(sessionId, { waitMs, rounds, log })
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
export async function passOnly(sessionId, { waitMs = 40000, rounds = 6, log = () => {} } = {}) {
  if (!sessionId) throw new Error('bsk_pass_captcha 必须先有一个浏览器会话（sessionId）')
  const captcha = await passCaptcha(sessionId, { waitMs, rounds, log })
  const after = await readState(sessionId)
  return {
    ok: true,
    sessionId,
    captcha: { ...captcha, hasClearance: after.cfClearance },
    title: after.title,
    finalUrl: after.url,
  }
}
