/**
 * dsh-bsk-fetch 宿主插件入口（Cordis 风格）。
 *
 * 关键安全约束（来自 dsh-cordis-inject-service-safety 经验）：
 *  - 禁止 `ctx.服务名` 裸读；只读 `ctx.get?.('logger')` 与 `ctx.inject(['tools'], …)`。
 *  - inject 数组只声明本插件请求的服务；未声明的服务一律用 ctx.get?.('x') 取。
 *  - 未 await 的异步调用必须挂 .catch()，避免未处理 rejection 拖垮宿主。
 *
 * 工具一览：
 *  - bsk_fetch            抓取（自动过简单验证码）
 *  - bsk_pass_captcha     只过当前页简单验证码
 *  - bsk_doctor           环境体检
 *  - bsk_solve_captcha    复杂验证码一键自动解（需视觉后端）
 *  - bsk_captcha_inspect  复杂验证码「第一步」：导出挑战图为 PNG，交给 agent 自己看
 *  - bsk_captcha_pick     复杂验证码「第二步」：按 agent 给出的坐标点选 / 人工兜底
 *
 * @module dsh-bsk-fetch
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from './config.mjs'
import { getDefineTool } from './tools.mjs'
import { fetchPage, passOnly } from './fetch.mjs'
import { status as bskStatus, findBsk } from './bsk.mjs'
import { solveComplex, inspectChallenge, pickPoints } from './complex.mjs'

export const name = 'dsh-bsk-fetch'

// 本插件只主动请求 tools 服务；logger 用 ctx.get?.('logger')，其余只读。
export const inject = ['tools']

/** 插件自身目录（落盘回退用）；不依赖 ctx 的任何服务。 */
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

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
    const pluginRoot = PLUGIN_ROOT

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
          silentMs: { type: 'number', description: '（可选）点完 Cloudflare 复选框后静默等待毫秒，默认 16000；期间不读页面以免打断验证' },
          fetchPath: { type: 'string', description: '（可选）过验证码后要抓的同源二进制路径（如 /doi/pdf/xxx）。走页内同源 fetch + base64，绕开新窗口下载归因失败' },
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
            silentMs: args.silentMs ?? config.silentMs,
            fetchPath: args.fetchPath ?? '',
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
      description: '只过当前页的简单验证码（Cloudflare Turnstile 复选框，不抓取内容）。需要先有一个 bsk 会话，传 sessionId。适用于「先自己导航/登录，再让插件点过验证码」的场景。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '已有 bsk 会话 id（必填）' },
          waitMs: { type: 'number', description: '（可选）单轮最长等待毫秒，默认 40000' },
          rounds: { type: 'number', description: '（可选）最大尝试轮数，默认 6' },
          silentMs: { type: 'number', description: '（可选）点完复选框后静默等待毫秒，默认 16000' },
        },
        required: ['sessionId'],
      },
      async execute(args) {
        try {
          const r = await passOnly(args.sessionId, {
            waitMs: args.waitMs ?? config.waitMs,
            rounds: args.rounds ?? config.rounds,
            silentMs: args.silentMs ?? config.silentMs,
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
      description: '一键自动解复杂验证码（图片点选 / 滑块）。同源 canvas 验证码走「取图 → 视觉后端给坐标 → 合成点击」全自动；跨域 iframe 的 hCaptcha/reCAPTCHA 无法自动点击，会自动退回 request-help 人工兜底。若插件未配置 visionEndpoint/visionApiKey，则直接走人工兜底；此时建议改用 bsk_captcha_inspect + bsk_captcha_pick 两段式（由 agent 自己看图）。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '已有 bsk 会话 id（必填）' },
          kind: { type: 'string', description: '（可选）强制类型：image-select / slider / canvas；留空自动检测' },
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

    // 「agent 当视觉」第一步：导出挑战图，返回 PNG 路径，由调用方自己看图。
    const toolInspect = defineTool({
      name: 'bsk_captcha_inspect',
      description: '复杂验证码两段式的第一步：把当前页的验证码图导出成 PNG 并返回绝对路径（同源 canvas 直接取像素，最清晰；没有 canvas 时退回整屏截图）。拿到路径后用 read_image 自己看图，判断该点哪些位置，再把坐标交给 bsk_captcha_pick。返回里的 coordSpace 说明坐标系（canvas=位图坐标，viewport=视口像素），blocked=true 表示挑战在跨域 iframe 内、无法按坐标点击。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '已有 bsk 会话 id（必填）' },
          outDir: { type: 'string', description: '（可选）PNG 落盘目录；留空用系统临时目录' },
        },
        required: ['sessionId'],
      },
      async execute(args) {
        try {
          const r = await inspectChallenge(args.sessionId, {
            log,
            outDir: args.outDir || undefined,
          })
          return { content: render(r), output: { render: () => render(r) } }
        } catch (e) {
          logger.error?.(`bsk_captcha_inspect 失败: ${e?.stack || e}`)
          const out = render({ ok: false, error: String(e?.message || e) })
          return { content: out, output: { render: () => out } }
        }
      },
    })

    // 「agent 当视觉」第二步：按调用方给的坐标点选，或 human=true 走人工兜底。
    const toolPick = defineTool({
      name: 'bsk_captcha_pick',
      description: '复杂验证码两段式的第二步：按你（agent）看图得出的坐标点选验证码，然后自动判定是否通过。points 是坐标数组，坐标系与 bsk_captcha_inspect 返回的 coordSpace 一致（默认 canvas 位图坐标）。若挑战在跨域 iframe 内（inspect 返回 blocked=true）或你不想自己点，传 human=true 让真人完成。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '已有 bsk 会话 id（必填）' },
          points: {
            type: 'array',
            description: '要点击的坐标数组，每项 [x,y]（坐标系由 coordSpace 决定）',
            items: {
              type: 'array',
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2,
            },
          },
          coordSpace: { type: 'string', description: '（可选）坐标系：canvas（默认，位图坐标）/ viewport（视口像素，当前版本不可用）' },
          human: { type: 'boolean', description: '（可选）true 时不做坐标点击，直接 request-help 让真人完成验证码' },
          waitMs: { type: 'number', description: '（可选）点完后等待多久再判定通过，默认 2500' },
        },
        required: ['sessionId'],
      },
      async execute(args) {
        try {
          const r = await pickPoints(args.sessionId, {
            points: Array.isArray(args.points) ? args.points : [],
            coordSpace: args.coordSpace || 'canvas',
            human: Boolean(args.human),
            waitMs: typeof args.waitMs === 'number' ? args.waitMs : 2500,
            log,
          })
          return { content: render(r), output: { render: () => render(r) } }
        } catch (e) {
          logger.error?.(`bsk_captcha_pick 失败: ${e?.stack || e}`)
          const out = render({ ok: false, error: String(e?.message || e) })
          return { content: out, output: { render: () => out } }
        }
      },
    })

    sctx.set(toolFetch)
    sctx.set(toolPass)
    sctx.set(toolDoctor)
    sctx.set(toolSolve)
    sctx.set(toolInspect)
    sctx.set(toolPick)
  })

  log('dsh-bsk-fetch 已装载：bsk_fetch / bsk_pass_captcha / bsk_doctor / bsk_solve_captcha / bsk_captcha_inspect / bsk_captcha_pick 已注册')
}

export default { name, inject, apply }
