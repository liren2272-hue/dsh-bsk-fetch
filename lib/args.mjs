/**
 * 把 cnki 工具参数翻译成 `run.py` 的 argv（源自 dsh-cnki-dl/args.mjs）。
 * 子命令永远是 argv[0]：历史 bug 是把它拼到了可执行文件名上。
 * @module dsh-bsk-fetch/args
 */

export const SEARCH_TYPES = ['all', 'journal', 'thesis']

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
function pushIf(out, flag, value) {
  if (value === undefined || value === null || value === '') return
  out.push(flag, String(value))
}
export function buildSearchArgs({ query, type, top, pages, jsonPath }) {
  const out = ['search', String(query ?? '').trim()]
  const kind = SEARCH_TYPES.includes(type) ? type : 'all'
  out.push('--type', kind)
  out.push('--top', String(clampInt(top, 1, 100, 20)))
  out.push('--pages', String(clampInt(pages, 1, 10, 1)))
  pushIf(out, '--json', jsonPath)
  return out
}
export function buildDownloadArgs({ url, outputDir, wantFormat }) {
  const out = ['download', String(url ?? '').trim()]
  pushIf(out, '--out', outputDir)
  pushIf(out, '--want', wantFormat)
  return out
}
export function buildBatchArgs({ listPath, outputDir, wantFormat }) {
  const out = ['batch']
  pushIf(out, '--list', listPath)
  pushIf(out, '--out', outputDir)
  pushIf(out, '--want', wantFormat)
  return out
}
export function buildVerifyArgs({ outputDir }) {
  return ['verify', String(outputDir ?? '').trim()]
}
export function buildDoctorArgs({ outputDir }) {
  const out = ['doctor']
  pushIf(out, '--out', outputDir)
  return out
}
