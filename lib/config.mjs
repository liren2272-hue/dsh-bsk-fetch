/**
 * 配置读取：只认 profile 里 `config:` 段，键都有默认值，坏值不抛。
 *
 * @module dsh-bsk-fetch/config
 */

/** 默认配置。 */
export const DEFAULTS = {
  /** 每次动作最多等待的毫秒数。 */
  waitMs: 40000,
  /** 浏览器动作失败后的重试轮数。 */
  rounds: 6,
  /** 页面“静默”多久算可以取数。 */
  silentMs: 16000,
  /** 截图/下载默认落点目录；空串表示当前工作目录。 */
  outputDir: '',
  /** 视觉后端 OpenAI-compatible 端点；空串表示不用视觉。 */
  visionEndpoint: '',
  visionApiKey: '',
  visionModel: 'gpt-4o',
  /** 无视觉后端或调用失败时，是否退回人工兜底 request-help。 */
  humanFallback: true,
  /** cnki 下载器使用的 Python 解释器；留空用 PATH 里的 python。 */
  pythonExe: 'python',
  /** 单次 python 子进程超时毫秒；批量任务在代码里显式传 0（不超时）。 */
  timeoutMs: 120000,
  /** cnki 下载默认要的格式：pdf（默认）/ caj。 */
  wantFormat: 'pdf',
}

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : d
}
function str(v, d) {
  return typeof v === 'string' ? v : d
}
function bool(v, d) {
  return typeof v === 'boolean' ? v : d
}

export function resolveConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    waitMs: num(c.waitMs, DEFAULTS.waitMs),
    rounds: num(c.rounds, DEFAULTS.rounds),
    silentMs: num(c.silentMs, DEFAULTS.silentMs),
    outputDir: str(c.outputDir, DEFAULTS.outputDir).trim(),
    visionEndpoint: str(c.visionEndpoint, DEFAULTS.visionEndpoint),
    visionApiKey: str(c.visionApiKey, DEFAULTS.visionApiKey),
    visionModel: str(c.visionModel, DEFAULTS.visionModel),
    humanFallback: bool(c.humanFallback, DEFAULTS.humanFallback),
    pythonExe: str(c.pythonExe, DEFAULTS.pythonExe),
    timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs),
    wantFormat: str(c.wantFormat, DEFAULTS.wantFormat),
  }
}
