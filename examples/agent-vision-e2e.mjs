/**
 * 真机 e2e：agent-as-vision 两段式在 mock canvas 验证码上跑通。
 * 流程：建会话 → 导航 → inspectChallenge（导出 PNG）→ 调多模态接口看图给坐标
 *       → pickPoints（合成点击）→ 校验 __captchaMeta().solved
 *
 * 运行：node tmp/e2e_agentvision.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/DSH Workspace/sessions/2026-11-04_0234_57fab8/src/dsh-bsk-fetch'
const { sessionStart, sessionStop, navigate, evaluate } = await import(`file:///${ROOT}/lib/bsk.mjs`)
const { inspectChallenge, pickPoints, unwrapEval } = await import(`file:///${ROOT}/lib/complex.mjs`)
const { resolveConfig } = await import(`file:///${ROOT}/lib/config.mjs`)

const log = (m) => console.log(`[e2e] ${m}`)

/** 读 tongji 凭据（多模态看图用）。 */
function readKey() {
  const p = 'C:/Users/15940/.dsh/.credentials.yaml'
  const txt = fs.readFileSync(p, 'utf8')
  const m = txt.match(/TONGJI_API_KEY\s*:\s*(\S+)/)
  if (!m) throw new Error('凭据里没有 TONGJI_API_KEY')
  return m[1].replace(/^["']|["']$/g, '')
}

/** 调多模态接口，返回 {points:[[x,y]...], reason}。 */
async function askVision(pngPath, prompt) {
  const b64 = fs.readFileSync(pngPath).toString('base64')
  const body = {
    model: 'DeepSeek-V4.1-Flash',
    messages: [
      { role: 'system', content: '你是验证码点选助手。只输出 JSON，不要解释。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  }
  const r = await fetch('https://agi.tongji.edu.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readKey()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  })
  if (!r.ok) throw new Error(`vision HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const j = await r.json()
  let txt = j.choices?.[0]?.message?.content ?? ''
  txt = String(txt).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  return { parsed: JSON.parse(txt), usage: j.usage }
}

const out = { ok: false, steps: [] }
let sid = ''
try {
  /* 1) 建会话 */
  const s = await sessionStart({ name: 'e2e-agentvision', width: 1280, height: 900 })
  sid = typeof s === 'string' ? s : (s?.sessionId || s?.session_id || '')
  log(`会话 ${sid}`)
  out.steps.push({ step: 'session', sid })

  /* 2) 导航到 mock 页（先无 context 直连拉起扩展） */
  const nav = await navigate(sid, 'http://127.0.0.1:8731/', { waitUntil: 'load', timeout: '45s' })
  log(`导航 exit=${nav.code}`)
  out.steps.push({ step: 'navigate', code: nav.code })

  /* 3) 第一步：导出挑战图 */
  const insp = await inspectChallenge(sid, { log, outDir: 'D:/DSH Workspace/sessions/2026-11-04_0234_57fab8/data/e2e' })
  log(`inspect: ok=${insp.ok} source=${insp.source} coordSpace=${insp.coordSpace} ${insp.width}x${insp.height} prompt=${insp.prompt}`)
  out.steps.push({ step: 'inspect', insp })
  if (!insp.ok) throw new Error(`inspect 失败: ${JSON.stringify(insp)}`)

  /* 4) 看图给坐标 */
  const question = [
    `这是一个图形点选验证码，画布位图尺寸 ${insp.width}x${insp.height}。`,
    `题目要求：「${insp.prompt || '点击指定的图形'}」。`,
    '请找出所有符合题目要求的图形，给出每个图形中心的像素坐标（相对画布左上角，原点 0,0）。',
    '严格输出 JSON：{"points":[[x,y],...],"reason":"简短说明"}',
  ].join('\n')
  const vis = await askVision(insp.pngPath, question)
  log(`视觉返回: ${JSON.stringify(vis.parsed)} (image_tokens=${vis.usage?.prompt_tokens_details?.multimodal_tokens?.image ?? 'n/a'})`)
  out.steps.push({ step: 'vision', parsed: vis.parsed, usage: vis.usage })
  const points = Array.isArray(vis.parsed?.points) ? vis.parsed.points : []
  if (!points.length) throw new Error('视觉没给出坐标')

  /* 5) 第二步：按坐标点选 */
  const pick = await pickPoints(sid, { points, coordSpace: insp.coordSpace, waitMs: 2500, log })
  log(`pick: ${JSON.stringify(pick)}`)
  out.steps.push({ step: 'pick', pick })

  /* 6) 独立校验：直接读页面自报状态 */
  const meta = unwrapEval(await evaluate(sid, 'JSON.stringify(window.__captchaMeta ? window.__captchaMeta() : null)'))
  log(`页面自报: ${meta}`)
  out.steps.push({ step: 'meta', meta: typeof meta === 'string' ? JSON.parse(meta) : meta })

  out.ok = Boolean(pick?.solved) || Boolean((typeof meta === 'string' ? JSON.parse(meta) : meta)?.solved)
} catch (e) {
  out.error = String(e?.stack || e)
  log(`失败: ${e?.message || e}`)
} finally {
  if (sid) { try { await sessionStop(sid) } catch { /* noop */ } }
}

console.log('\n=== RESULT ===')
console.log(JSON.stringify(out, null, 2))
process.exit(out.ok ? 0 : 1)
