/**
 * 配置读取：只认 profile 里 `config:` 段，键都有默认值，坏值不抛。
 *
 * @module dsh-bsk-fetch/config
 */

/** 默认配置。 */
export const DEFAULTS = {
  /** 过验证码最多等待毫秒。 */
  waitMs: 40000,
  /** 最多尝试轮数。 */
  rounds: 6,
  /** 抓取结果落盘目录；空则用 `<plugin>/data/fetched`。 */
  outputDir: '',
  /** 视觉后端（自动点选/滑块用）：OpenAI 兼容多模态接口。 */
  visionEndpoint: '',
  visionApiKey: '',
  visionModel: 'gpt-4o',
  /** 无视觉后端或调用失败时，是否退回人工兜底 request-help。 */
  humanFallback: true,
}

/** 把外部配置归一成安全形状：只保留认识的键，类型不对就回落默认值。 */
export function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : d)
  const str = (v, d) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
  const bool = (v, d) => (typeof v === 'boolean' ? v : d)
  return {
    waitMs: num(c.waitMs, DEFAULTS.waitMs),
    rounds: num(c.rounds, DEFAULTS.rounds),
    outputDir: str(c.outputDir, DEFAULTS.outputDir),
    visionEndpoint: str(c.visionEndpoint, DEFAULTS.visionEndpoint),
    visionApiKey: str(c.visionApiKey, DEFAULTS.visionApiKey),
    visionModel: str(c.visionModel, DEFAULTS.visionModel),
    humanFallback: bool(c.humanFallback, DEFAULTS.humanFallback),
  }
}
