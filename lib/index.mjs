/**
 * dsh-bsk-fetch 宿主插件入口（Cordis 风格）。
 *
 * 关键安全约束（来自 dsh-cordis-inject-service-safety 经验）：
 *  - 禁止 `ctx.服务名` 裸读；只读 `ctx.get?.('logger')` 与 `ctx.inject(['tools'], …)`。
 *  - inject 数组只声明本插件请求的服务；未声明的服务一律用 ctx.get?.('x') 取。
 *  - 未 await 的异步调用必须挂 .catch()，避免未处理 rejection 拖垮宿主。
 *
 * @module dsh-bsk-fetch
 */

import { resolveConfig } from './config.mjs'
import { getDefineTool } from './tools.mjs'
import { fetchPage, passOnly } from './fetch.mjs'
import { status as bskStatus, findBsk } from './bsk.mjs'
import { solveComplex } from './complex.mjs'

export const name = 'dsh-bsk-fetch'

// 本插件只主动请求 tools 服务；logger 用 ctx.get?.('logger')，其余只读。
export const inject = ['tools']

/** 把结构化结果压成统一文本块。 */
function render(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  return [{ type: 'text', text }]
}

/** 写动作的日志转发；宿主 logger 不存在时静默。 */
function makeLog(logger) {
  return (msg) => {
    try { logger?.info?.(`[bsk-fetch] ${msg}`) } catch { /* noop */ }
  }
}

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.get?.('logger') || { info() {}, warn() {}, error() {} }
  const log = makeLog(logger)

  // getDefineTool 是 async（动态 import 宿主工具定义 + 恒等兜底），必须先 await。
  const defineTool = await getDefineTool()

  ctx.inject(['tools'], (sctx) => {
    const pluginRoot = ctx.root?.toString?.() || process.cwd()

    const toolFetch = defineTool({
      name: 'bsk_fetch',
      description: '用 bsk 驱动真实浏览器打开带简单验证码（如 Cloudflare Turnstile 人机验证复选框）的网页，自动点过验证码后再抓取页面 HTML 与可读正文，并落盘保存。以 vcb-s.com 为例。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网址，必须以 http(s):// 开头' },
          outputDir: { type: 'string', description: '（可选）抓取结果落盘目录；留空则用插件内 data/fetched' },
          waitMs: { type: 'number', description: '（可选）过验证码单轮最长等待毫秒，默认 40000' },
          rounds: { type: 'number', description: '（可选）过验证码最大尝试轮数，默认 6' },
          maxBytes: { type: 'number', description: '（可选）HTML 截断字节数，0 表示不截断' },
          sessionId: { type: 'string', description: '（可选）复用已有 bsk 会话，不传则新建' },
        },
        required: ['url'],
      },
      async execute(args) {
        try {
          const r = await fetchPage({
            url: args.url,
            outputDir: args.outputDir ?? config.outputDir,
            pluginRoot,
            waitMs: args.waitMs ?? config.waitMs,
            rounds: args.rounds ?? config.rounds,
            maxBytes: args.maxBytes ?? 0,
            sessionId: args.sessionId ?? '',
            log,
          })
          return { content: render(r), output: { render: () => render(r) } }
        } catch (e) {
          logger.error?.(`bsk_fetch 失败: ${e?.stack || e}`)
          const out = render({ ok: false, error: String(e?.message || e) })
          return { content: out, output: { render: () => out } }
        }
      },
    })

    const toolPass = defineTool({
      name: 'bsk_pass_captcha',
      description: '只过当前页的验证码（不抓取内容）。需要先有一个 bsk 会话，传 sessionId。适用于「先自己导航/登录，再让插件点过验证码」的场景。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '已有 bsk 会话 id（必填）' },
          waitMs: { type: 'number', description: '（可选）单轮最长等待毫秒，默认 40000' },
          rounds: { type: 'number', description: '（可选）最大尝试轮数，默认 6' },
        },
        required: ['sessionId'],
      },
      async execute(args) {
        try {
          const r = await passOnly(args.sessionId, {
            waitMs: args.waitMs ?? config.waitMs,
            rounds: args.rounds ?? config.rounds,
            log,
          })
          return { content: render(r), output: { render: () => render(r) } }
        } catch (e) {
          logger.error?.(`bsk_pass_captcha 失败: ${e?.stack || e}`)
          const out = render({ ok: false, error: String(e?.message || e) })
          return { content: out, output: { render: () => out } }
        }
      },
    })

    const toolDoctor = defineTool({
      name: 'bsk_doctor',
      description: '环境体检：检查 bsk 可执行文件位置、daemon 状态、本机是否能连上浏览器。不采集任何隐私数据。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const out = { bskBin: findBsk(), bskAutoStart: '0', daemon: null }
        try {
          const st = await bskStatus()
          out.daemon = { ok: st.ok, raw: String(st.raw || '').slice(0, 500) }
        } catch (e) {
          out.daemon = { ok: false, error: String(e?.message || e) }
        }
        return { content: render(out), output: { render: () => render(out) } }
      },
    })

    const toolSolve = defineTool({
      name: 'bsk_solve_captcha',
      description: '解复杂验证码（自动视觉+拖拽）：先截图交给视觉后端（OpenAI 兼容多模态接口，需在插件配置里填 visionEndpoint/visionApiKey）理解挑战、给出要点的图块与提交按钮的像素坐标，再用 bsk 按坐标点击或拖拽滑块；无视觉后端或失败时自动退回 request-help 让真人完成。支持 hCaptcha 图片点选、reCAPTCHA 网格、滑块拼图。需要先有一个 bsk 会话，传 sessionId。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '已有 bsk 会话 id（必填）' },
          kind: { type: 'string', description: '（可选）强制验证码类型：image-select / slider；留空则自动检测' },
          rounds: { type: 'number', description: '（可选）最大尝试轮数，默认 6' },
          waitMs: { type: 'number', description: '（可选）单轮最长等待毫秒，默认 40000' },
          noHumanFallback: { type: 'boolean', description: '（可选）true 时禁止人工兜底，仅靠自动视觉' },
        },
        required: ['sessionId'],
      },
      async execute(args) {
        try {
          const vision = (config.visionEndpoint && config.visionApiKey)
            ? { endpoint: config.visionEndpoint, apiKey: config.visionApiKey, model: config.visionModel }
            : null
          if (!vision) log('未配置视觉后端，将直接走人工兜底（request-help）')
          const r = await solveComplex(args.sessionId, {
            vision,
            rounds: args.rounds ?? config.rounds,
            waitMs: args.waitMs ?? config.waitMs,
            humanFallback: args.noHumanFallback ? false : config.humanFallback,
            forceKind: args.kind || null,
            log,
          })
          return { content: render(r), output: { render: () => render(r) } }
        } catch (e) {
          logger.error?.(`bsk_solve_captcha 失败: ${e?.stack || e}`)
          const out = render({ ok: false, error: String(e?.message || e) })
          return { content: out, output: { render: () => out } }
        }
      },
    })

    sctx.set(toolFetch)
    sctx.set(toolPass)
    sctx.set(toolDoctor)
    sctx.set(toolSolve)
  })

  // 装载完成日志（未 await 的异步不拖宿主；这里同步即可）
  log('dsh-bsk-fetch 已装载：bsk_fetch / bsk_pass_captcha / bsk_doctor 已注册')
}

export default { name, inject, apply }
