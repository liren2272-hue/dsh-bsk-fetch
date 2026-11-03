/**
 * 简单验证码（以 Cloudflare Turnstile「Verify you are human」复选框为例）的
 * 自动通过逻辑。全部通过 bsk 只读 snapshot + 一次性的 click 完成，不依赖任何
 * OCR / OpenCV。
 *
 * 设计要点（来自 bsk-cli-cooperate-fallback 技能铁律）：
 *  - 页面状态一律用 `bsk snapshot` / `evaluate` 读，不消费协作 context；
 *  - 只有「点击」这一个写动作才走 cooperate（先 getContext 取 context_id 再带 --context）；
 *  - 一个 context 只能用一次，所以每次点击前都重新 getContext；
 *  - 反复 `shared page control or observation changed` 时调用方会 `session stop --all` 后重试。
 *
 * @module dsh-bsk-fetch/lib/captcha
 */

import { snapshot, evaluate, click } from './bsk.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 候选可点击选择器：优先 Turnstile 复选框/iframe，其次通用提交按钮。 */
const CLICK_CANDIDATES = [
  '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  '#cf-challenge-running',
  '.cf-challenge-container .checkbox',
  'button[type=submit]',
  '.pow-button',
  '#challenge-stage',
]

/**
 * 读取页面状态，判断是否在验证码/质询页上。
 * @returns {Promise<{title,url,challenge,cfClearance:boolean,cfCookie:boolean}>}
 */
export async function readState(sessionId) {
  const info = await evaluate(sessionId, `(() => {
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
  })()`).catch(() => ({ t: '', u: '', cf: false, titleChallenge: false, urlChallenge: false, challenge: false, cookie: false }))

  const j = typeof info === 'object' ? info : {}
  // snapshot 作为兜底：有些挑战页没有可访问的 JS 上下文（比如 about:blank 过渡）
  let snapChallenge = false
  try {
    const snap = await snapshot(sessionId)
    snapChallenge = /just a moment|verify you are human|安全验证|checking your browser|ray id:/i.test(snap || '')
  } catch { /* noop */ }
  return {
    title: j.t || '',
    url: j.u || '',
    challenge: Boolean(j.challenge) || snapChallenge,
    cfClearance: Boolean(j.cookie),
  }
}

/**
 * 尝试点击一次验证码复选框。依次尝试候选选择器，哪个不报错用哪个。
 * @returns {Promise<boolean>} 是否成功发出了一次点击
 */
export async function tryClick(sessionId) {
  for (const sel of CLICK_CANDIDATES) {
    try {
      await click(sessionId, { selector: sel })
      return true
    } catch (e) {
      // 该选择器不存在或不可点，换下一个；都失败就返回 false
      continue
    }
  }
  return false
}

/**
 * 自动通过当前页验证码。轮询检测挑战页 → 点击复选框 → 轮询直到离开挑战页或拿到
 * cf_clearance。
 *
 * @param {object} opts
 * @param {number} opts.waitMs   单轮最长等待（毫秒）
 * @param {number} opts.rounds   最大尝试轮数
 * @param {(msg:string)=>void} [opts.log]  可选进度回调
 * @returns {Promise<{passed:boolean,leftChallenge:boolean,hasClearance:boolean,rounds:number,reason:string,state:object}>}
 */
export async function passCaptcha(sessionId, { waitMs = 40000, rounds = 6, log = () => {} } = {}) {
  const start = Date.now()
  let lastState = null

  // 先等一小段，很多 Turnstile 会自动放行（低风险流量无需点击）
  await sleep(Math.min(2500, Math.max(800, Math.floor(waitMs / 16))))
  for (let i = 1; i <= rounds; i++) {
    const st = await readState(sessionId)
    lastState = st
    log(`[轮 ${i}/${rounds}] 挑战页=${st.challenge} cf_clearance=${st.cfClearance} title=${JSON.stringify(st.title).slice(0, 40)}`)

    if (!st.challenge) {
      return { passed: true, leftChallenge: true, hasClearance: st.cfClearance, rounds: i, reason: '页面已离开挑战页', state: st }
    }
    if (st.cfClearance) {
      // 有 clearance 但 snapshot 仍判为挑战（少见），再核一次真实页
      await sleep(1200)
      const st2 = await readState(sessionId)
      if (!st2.challenge) return { passed: true, leftChallenge: true, hasClearance: true, rounds: i, reason: '已获得 cf_clearance 且离开挑战页', state: st2 }
    }

    // 还在挑战页：尝试点一次复选框
    const clicked = await tryClick(sessionId)
    log(clicked ? `[轮 ${i}] 已点击验证码复选框，等待放行…` : `[轮 ${i}] 未找到可点击的验证码元素，仅等待自动放行…`)

    // 本轮回合内轮询等待放行
    const deadline = Date.now() + Math.max(3000, waitMs)
    let left = false
    while (Date.now() < deadline) {
      await sleep(1500)
      const s2 = await readState(sessionId)
      if (!s2.challenge || s2.cfClearance) { left = true; lastState = s2; break }
    }
    if (left) {
      const s3 = await readState(sessionId)
      return { passed: true, leftChallenge: !s3.challenge, hasClearance: s3.cfClearance, rounds: i, reason: '点击后已离开挑战页', state: s3 }
    }
    if (Date.now() - start > waitMs * rounds) break
  }

  const final = await readState(sessionId)
  return {
    passed: !final.challenge,
    leftChallenge: !final.challenge,
    hasClearance: final.cfClearance,
    rounds,
    reason: final.challenge ? '超过最大轮数仍在挑战页' : '已离开挑战页',
    state: final,
  }
}
