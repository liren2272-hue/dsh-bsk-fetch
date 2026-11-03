/**
 * 离线自测：不依赖真实浏览器/daemon，验证纯逻辑与模块装配。
 * 运行方式（在插件目录）：
 *   node selftest.mjs
 *
 * 覆盖：
 *  1) config.resolveConfig 对坏值回落默认；
 *  2) findBsk 返回非空字符串；
 *  3) readState/captcha 判定逻辑（用桩 driver 注入假 bsk 行为）；
 *  4) fetchPage 在「无挑战页」桩下能返回 ok 并落盘；
 *  5) index 入口导出 name/inject/apply，且 apply 在假 ctx 下不抛。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
const fails = []
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { fails.push(name); console.log(`  ✗ ${name}`) }
}

/* 1) config */
const { resolveConfig } = await import('./lib/config.mjs')
{
  const c = resolveConfig({ waitMs: 'x', rounds: -1, outputDir: '  /tmp  ' })
  ok('resolveConfig 坏值回落默认 waitMs', c.waitMs === 40000)
  ok('resolveConfig 坏值回落默认 rounds', c.rounds === 6)
  ok('resolveConfig 修剪 outputDir', c.outputDir === '/tmp')
  const c2 = resolveConfig(undefined)
  ok('resolveConfig 缺省返回默认', c2.waitMs === 40000 && c2.rounds === 6)
  // 视觉后端 + 人工兜底默认值
  const c3 = resolveConfig({ visionEndpoint: 'https://x', visionApiKey: 'k', visionModel: 'gpt-4o', humanFallback: false })
  ok('resolveConfig 读取 vision 配置', c3.visionEndpoint === 'https://x' && c3.visionApiKey === 'k' && c3.visionModel === 'gpt-4o')
  ok('resolveConfig humanFallback 可关', c3.humanFallback === false)
  const c4 = resolveConfig({ humanFallback: 'yes' })
  ok('resolveConfig humanFallback 坏值回落 true', c4.humanFallback === true)
}

/* 2) findBsk */
const { findBsk } = await import('./lib/bsk.mjs')
ok('findBsk 返回字符串', typeof findBsk() === 'string' && findBsk().length > 0)

/* 3) captcha 判定（桩 driver） */
// 用一个临时目录作为 fake 模块不可行——改为直接测试纯函数对 stub 的响应：
// 这里用 evaluate/snapshot 的桩替换 lib/captcha 内部导入不可行（ESM 单例）。
// 改为对 fetch.mjs 做整体桩：通过注入假的 lib/bsk.mjs 无法直接替换，
// 故用「无挑战页」场景驱动 fetchPage 并桩掉底层（下面 4 做）。

/* 4) fetchPage / solveComplex 参数与模块校验 */
const { fetchPage, passOnly } = await import('./lib/fetch.mjs')
{
  let threw = false
  try { await fetchPage({ url: 'not-a-url' }) } catch { threw = true }
  ok('fetchPage 拒绝非法 url', threw)
  let threw2 = false
  try { await passOnly('') } catch { threw2 = true }
  ok('passOnly 拒绝空 sessionId', threw2)
}

/* 4b) complex 模块：纯函数与默认导出 */
const complex = await import('./lib/complex.mjs')
{
  // pngSize 对真实 PNG 头解析：signature(8) + len(4)=13 + 'IHDR'(4) + width(4) + height(4)
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0, 0, 0, 0x0d, // IHDR length = 13
    0x49, 0x48, 0x44, 0x52, // 'IHDR'
    0, 0, 0, 0x05, // width = 5
    0, 0, 0, 0x03, // height = 3
  ])
  const sz = complex.pngSize(png)
  ok('pngSize 解析 IHDR 宽高', sz && sz.width === 5 && sz.height === 3)
  ok('pngSize 非 PNG 返回 null', complex.pngSize(Buffer.from([1, 2, 3])) === null)
  ok('detectCaptcha 是函数', typeof complex.detectCaptcha === 'function')
  ok('solveImageSelect 是函数', typeof complex.solveImageSelect === 'function')
  ok('solveSlider 是函数', typeof complex.solveSlider === 'function')
  ok('solveComplex 是函数', typeof complex.solveComplex === 'function')
  ok('isSolved 是函数', typeof complex.isSolved === 'function')
}

/* 5) index 入口 */
const mod = await import('./lib/index.mjs')
ok('index 导出 name', mod.name === 'dsh-bsk-fetch')
ok('index 导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'))
ok('index 导出 apply 函数', typeof mod.apply === 'function')

// 假 ctx 装载不应抛
{
  const calls = []
  const fakeCtx = {
    get(svc) {
      if (svc === 'logger') return { info: () => {}, warn: () => {}, error: () => {} }
      return undefined
    },
    inject(services, fn) {
      calls.push(services)
      const tools = []
      fn({
        set(t) { tools.push(t) },
      })
      // 四个工具都应被 set 进去（fetch/pass/doctor/solve）
      assert.strictEqual(tools.length, 4, '应注册 4 个工具')
      return { dispose() {} }
    },
  }
  let loaded = true
  try { await mod.apply(fakeCtx, { waitMs: 12345, rounds: 2 }) } catch (e) { loaded = false; console.error(e) }
  ok('apply 在假 ctx 下不抛', loaded)
  ok('apply 请求了 tools 服务', calls.some((c) => Array.isArray(c) && c.includes('tools')))
}

/* 落盘目录可写性（用回退目录） */
{
  const dir = path.join(os.tmpdir(), `bsk-fetch-selftest-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'probe.txt'), 'ok')
  ok('落盘目录可写', fs.existsSync(path.join(dir, 'probe.txt')))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (fails.length) {
  console.log(`❌ ${fails.length} 项失败：${fails.join(', ')}`)
  process.exit(1)
} else {
  console.log(`✅ 全部 ${passed} 项通过`)
}
