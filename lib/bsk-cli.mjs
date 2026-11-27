#!/usr/bin/env node
/**
 * bsk CLI JSON-lines 桥：Python 下载器通过本进程复用 lib/bsk.mjs 唯一底座。
 * 每行一条请求 {id, op, args, opts}，回一行 {id, ok, value|error}。
 * 进程常驻，stderr 保持安静，避免污染 stdout 协议。
 * @module dsh-bsk-fetch/bsk-cli
 */
import readline from 'node:readline'
import { run as bskRun, status as bskStatus, findBsk } from './bsk.mjs'

const BOUND = new Map()
const POLICY = process.env.CNKI_BSK_POLICY || 'strict'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function topJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { /* 尝试截取 */ }
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)) } catch { /* noop */ } }
  return null
}

function grab(pat, text) {
  const m = new RegExp(pat).exec(text || '')
  return m ? m[1] : null
}

/** 兼容 Python 旧语义的 cooperate sync：首次 strict 绑定，之后只用 context。 */
async function syncPair(sid, waitMs = 5000, tries = 2) {
  const logs = []
  let last = ''
  for (let i = 0; i < tries; i++) {
    await bskRun(['cooperate', 'wait', '--session', sid, '--timeout-ms', String(waitMs)], { timeoutMs: 25000 })
    const args = ['cooperate', 'sync', '--session', sid, '--json']
    if (POLICY && !BOUND.get(sid)) args.push('--policy', POLICY)
    const r = await bskRun(args, { timeoutMs: 40000 })
    last = ((r.stdout || '') + (r.stderr || '')).trim()
    const j = topJson(last)
    let c = j && typeof j.context_id === 'string' ? j.context_id : null
    if (!c) c = grab('"context_id"\\s*:\\s*"([^"]+)"', last)
    if (c) {
      BOUND.set(sid, true)
      let o = j && typeof j.observation_id === 'string' ? j.observation_id : null
      if (!o) o = grab('"observation_id"\\s*:\\s*"([^"]+)"', last)
      return { contextId: c, observationId: o || null, logs }
    }
    if (last.includes('fixed for this session') || last.includes('invalid_params')) {
      BOUND.set(sid, true)
      logs.push(`  [bsk] 会话 ${sid} 策略已固定，改用其既有策略`)
    }
    logs.push(`  [bsk] sync 未取得 context: ${last.slice(0, 120).replace(/\n/g, ' ')}`)
    await sleep(1000)
  }
  return { contextId: null, observationId: null, logs }
}

const OPS = {
  ping: () => ({ pong: true, pid: process.pid, bsk: findBsk() }),
  findBsk: () => ({ path: findBsk() }),
  async run({ args, timeout = 120, timeoutMs }) {
    const r = await bskRun(args, { timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : timeout * 1000 })
    return {
      text: ((r.stdout || '') + (r.stderr || '')).trim(),
      code: r.code,
      timedOut: Boolean(r.timedOut),
    }
  },
  async status() {
    const s = await bskStatus()
    return { text: ((s.raw || '') + '').trim(), ok: Boolean(s.ok), json: s.json || null }
  },
  async syncPair({ sid, waitMs, tries }) {
    return syncPair(sid, waitMs, tries)
  },
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  void (async () => {
    let id = null
    try {
      const req = JSON.parse(line)
      id = req.id
      const op = OPS[req.op]
      if (typeof op !== 'function') throw new Error('unknown op: ' + String(req.op))
      const value = await op(req.args || {})
      process.stdout.write(JSON.stringify({ id, ok: true, value }) + '\n')
    } catch (error) {
      process.stdout.write(JSON.stringify({ id, ok: false, error: String(error?.message ?? error) }) + '\n')
    }
  })()
})
