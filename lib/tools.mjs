/**
 * 工具定义助手：优先用宿主的 `defineTool`，解析不到就退回恒等包装。
 *
 * 为什么不在文件顶部 static import `@deepseek-ai/dsh-tools`：它是宿主注入的
 * optional peer，解析失败时 static import 会让整个插件装载直接失败，连带
 * 所有工具一起消失。用 dynamic import + 恒等兜底，最坏情况只是少了宿主的
 * 类型校验，工具仍然可用。
 *
 * @module dsh-bsk-fetch/tools
 */

/** 恒等包装：宿主校验缺失时的兜底，形状与 defineTool 的入参一致。 */
function identity(spec) {
  return spec
}

let cached = null

/** 取一次 defineTool（结果缓存；解析失败也缓存，避免每次都试）。 */
export async function getDefineTool() {
  if (cached) return cached
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    cached = typeof mod?.defineTool === 'function' ? mod.defineTool : identity
  } catch {
    cached = identity
  }
  return cached
}
