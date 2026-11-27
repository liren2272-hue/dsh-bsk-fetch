/**
 * 调用合并插件内嵌 Python 下载器（<plugin>/python/run.py）。
 * DSH_NODE_BIN 把宿主 node 路径传给 Python 侧 bsk 桥客户端。
 * @module dsh-bsk-fetch/py
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = resolve(HERE, '..')
export const PYTHON_DIR = join(PLUGIN_DIR, 'python')
export const RUN_PY = join(PYTHON_DIR, 'run.py')
export const DEFAULT_PYTHON = 'python'

export function runPy(argv, { pythonExe = DEFAULT_PYTHON, timeoutMs = 120000, cwd = PYTHON_DIR, env } = {}) {
  const fullArgv = [RUN_PY, ...argv.map((a) => String(a))]
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(pythonExe, fullArgv, {
        cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', DSH_NODE_BIN: process.execPath, ...env },
      })
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false, argv: fullArgv })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { child.kill() } catch { /* 已退出 */ } }, timeoutMs)
      : null
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: stderr + String(error?.message ?? error), timedOut, argv: fullArgv })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut, argv: fullArgv })
    })
  })
}

export function renderRun(label, result) {
  const parts = []
  if (label) parts.push(label)
  const out = result.stdout.trim()
  const err = result.stderr.trim()
  if (out) parts.push(out)
  if (result.timedOut) parts.push('[超时] 已终止子进程')
  if (result.code !== 0) {
    parts.push(`[退出码 ${result.code}]`)
    if (err) parts.push(err)
  } else if (err) {
    parts.push(`[stderr] ${err}`)
  }
  return parts.join('\n')
}
