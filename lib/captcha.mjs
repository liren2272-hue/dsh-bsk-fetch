/**
 * 简单验证码（Cloudflare Turnstile「Verify you are human」复选框）自动通过逻辑。
 *
 * v0.2.2 真机修正（2026-11-07，外文期刊补查实测，证据见会话 docs/）：
 *  旧实现每 1.5s 调一次 readState()（内部 evaluate → cooperate sync + evaluate），
 *  在 Cloudflare 托管质询「点完复选框正在验证」期间反复 synchronize / evaluate，
 *  会把挑战打断、不断重置，永远过不去（日志表现：Ray ID 反复出现、
 *  `shared page control or observation changed`、复选框点完又回到质询页）。
 *  真机验证有效（用户「反复点击肯定能通过」属实）的做法是：
 *   1) 判定「是否挑战页」与「找复选框 @eN」一律只用 bsk snapshot（aria 文本，
 *      只读、不消耗 context、不触发同步），绝不在此期间 evaluate；
 *   2) 点击前才取一次 cooperate sync 收据，把 @eN 作为【位置参数】传给 click，
 *      并同时带 --context 与【顶层】--observation；
 *   3) 点完后【静默等待约 16s】，期间绝不做任何 snapshot / sync / evaluate，
 *      让 CF 自己完成验证；
 *   4) 反复 2~4 轮，直到 snapshot 不再是挑战页。
 *
 * 为可离线确定性回归，核心流程拆成 passCaptchaWith(driver, ...) 工厂：
 *  driver = { snapshot, getSync, run, sleep }，selftest 注入假 driver 即可断言
 *  「静默窗口内没有任何页面读取动作」这一回归点（正是 v0.2.1 的 bug）。
 *
 * @module dsh-bsk-fetch/lib/captcha
 */

import { snapshot, evaluate, click, run, getSync } from './bsk.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Cloudflare / 出版社托管质询页的判定关键词（对 snapshot aria 文本）。 */
export const CHALLENGE_KEYS = [
  '请稍候', '正在进行安全验证', 'Just a moment', '请验证您是真人',
  'Are you a robot', 'Ray ID', 'cf_chl', 'Enable JavaScript and cookies',
  'Checking your browser', 'Verify you are human', '安全验证',
  'challenge-error-text', 'cf-turnstile', 'Reference number:',
]

/** 是否挑战页：纯函数，输入 snapshot 文本。正/负向均可离线断言。 */
export function isChallenge(text) {
  if (!text) return false
  const low = String(text).toLowerCase()
  return CHALLENGE_KEYS.some((k) => low.includes(String(k).toLowerCase()))
}

/** 从 snapshot 里找可点复选框的 @eN ref（纯函数）。 */
export function findCheckboxRef(text) {
  if (!text) return null
  for (const line of String(text).split('\n')) {
    const low = line.toLowerCase()
    const looksLikeBox = line.includes('checkbox') || line.includes('[unchecked]') ||
      low.includes('verify you are human') || line.includes('请验证您是真人')
    if (!looksLikeBox) continue
    const m = line.match(/(@e\d+)/)
    if (m) return m[1]
  }
  const m2 = String(text).match(/(@e\d+)\s+checkbox/i)
  return m2 ? m2[1] : null
}

/** 解包 bsk evaluate 的 {ok,tab_id,value} 信封。 */
export function unwrapEval(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && ('ok' in v || 'tab_id' in v)) {
    return v.value
  }
  return v
}

/** 候选可点击选择器：仅作无 snapshot-ref 时的 CSS 兜底。 */
const CLICK_CANDIDATES = [
  '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  '#cf-challenge-running',
  'button[type=submit]',
  '#challenge-stage',
]

/**
 * 读取页面状态（evaluate + snapshot），仅用于「验证已结束」后的最终上报。
 * 注意：挑战页进行【期间】禁止调用本函数——evaluate 会触发 cooperate sync，
 * 正是打断 Cloudflare 验证的元凶；判定挑战页请用 snapshot-only 的 isChallenge。
 */
export async function readState(sessionId) {
  const raw = await evaluate(sessionId, `(() => {
    try {
      const t = document.title || '';
      const u = location.href || '';
      const cf = !!(window._cf_chl_opt) ||
        !!document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        !!document.querySelector('.cf-turnstile');
      const titleChallenge = /just a moment|安全验证|verify you are human|checking your browser/i.test(t);
      const urlChallenge = /cf-mitigated|challenges\.cloudflare|__cf_chl_|cf-chl-/i.test(u);
      const ck = document.cookie || '';
      const cookie = /(?:^|;\s*)cf_clearance=/.test(ck);
      return { t, u, cf, titleChallenge, urlChallenge, challenge: titleChallenge || urlChallenge || cf, cookie };
    } catch (e) { return { t: '', u: '', cf: false, titleChallenge: false, urlChallenge: false, challenge: false, cookie: false, err: String(e) }; }
  })()`).catch(() => null)

  const j = unwrapEval(raw) || {}
  let snapChallenge = false
  try {
    const snap = await snapshot(sessionId)
    snapChallenge = isChallenge(snap)
  } catch { /* noop */ }
  return {
    title: j.t || '',
    url: j.u || '',
    challenge: Boolean(j.challenge) || snapChallenge,
    cfClearance: Boolean(j.cookie),
  }
}

/** CSS 兜底点击（旧接口保留）。依次尝试候选选择器，哪个不报错用哪个。 */
export async function tryClick(sessionId) {
  for (const sel of CLICK_CANDIDATES) {
    try {
      await click(sessionId, { selector: sel })
      return true
    } catch { /* 换下一个 */ }
  }
  return false
}

/** 生产 driver：把 bsk 原语注入可测试的流程工厂。 */
const realDriver = { snapshot, getSync, run, sleep }

/**
 * 可注入依赖的自动通过流程（selftest 用假 driver 做确定性回归）。
 *
 * 关键不变量：每次 click 之后的静默窗口内，driver.snapshot / driver.getSync /
 * driver.run 都【不得】被调用——否则会打断 CF 验证，这是 v0.2.1 的回归点。
 *
 * @param {object} driver  { snapshot(sid), getSync(sid,opts), run(args,opts), sleep(ms) }
 * @returns {Promise<{passed,leftChallenge,hasClearance,rounds,clicks,reason,state}>}
 */
export async function passCaptchaWith(driver, sessionId, opts = {}) {
  const { waitMs = 40000, rounds = 8, silentMs = 0, log = () => {} } = opts
  // 兼容旧 waitMs 配置：默认 40000 → 静默 16000；也可显式传 silentMs 覆盖。
  const quiet = silentMs > 0 ? silentMs : Math.max(10000, Math.min(16000, Math.round(waitMs / 2.5)))
  let clicks = 0

  // 低风险流量 Turnstile 常自动放行，先给一个短静默期。
  await driver.sleep(2500)

  for (let i = 1; i <= rounds; i++) {
    const snap = (await driver.snapshot(sessionId).catch(() => '')) || ''
    const challenge = isChallenge(snap)
    log(`[轮 ${i}/${rounds}] 挑战页=${challenge}（snapshot-only 判定）`)
    if (!challenge) {
      return { passed: true, leftChallenge: true, hasClearance: false, rounds: i, clicks,
        reason: 'snapshot 显示已离开挑战页', state: { challenge: false } }
    }
    const ref = findCheckboxRef(snap)
    if (!ref) {
      log(`[轮 ${i}] 未见复选框，静默等待 ${quiet}ms 让质询自行刷新…`)
      await driver.sleep(quiet)
      continue
    }
    try {
      // 点击前才取收据；ref 作为【位置参数】点击，带 context + 顶层 observation。
      const receipt = await driver.getSync(sessionId, { attempts: 3, waitMs: '1000' })
      const args = ['click', '--session', sessionId, '--context', receipt.contextId]
      if (receipt.observationId) args.push('--observation', receipt.observationId)
      args.push(ref)
      const r = await driver.run(args, { timeoutMs: 60000 })
      clicks++
      log(`[轮 ${i}] 已点 ${ref} → ${String(r.stdout || '').trim().slice(0, 100) || 'ok'}`)
    } catch (e) {
      log(`[轮 ${i}] 点击 ${ref} 失败：${String(e && e.message || e).slice(0, 120)}`)
    }
    // 【决定性】点完静默等待：期间绝不 snapshot / sync / evaluate，避免打断验证。
    log(`[轮 ${i}] 静默等待 ${quiet}ms（不做任何页面读取）…`)
    await driver.sleep(quiet)
  }

  const finalSnap = (await driver.snapshot(sessionId).catch(() => '')) || ''
  const cleared = !isChallenge(finalSnap)
  return {
    passed: cleared,
    leftChallenge: cleared,
    hasClearance: false,
    rounds, clicks,
    reason: cleared ? '轮数用尽后已离开挑战页' : '超过最大轮数仍在挑战页',
    state: { challenge: !cleared },
  }
}

/** 生产入口：跑真实 driver，结束后再读一次真实页状态（此时验证已毕，evaluate 不再打断 CF）。 */
export async function passCaptcha(sessionId, opts = {}) {
  const result = await passCaptchaWith(realDriver, sessionId, opts)
  try {
    const st = await readState(sessionId)
    result.hasClearance = st.cfClearance
    result.state = st
  } catch { /* noop */ }
  return result
}
