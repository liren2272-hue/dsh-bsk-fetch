import { SEARCH_TYPES, buildSearchArgs, buildDownloadArgs, buildBatchArgs, buildVerifyArgs, buildDoctorArgs } from './args.mjs'
import { renderRun } from './py.mjs'

/**
 * 六个知网工具：检索 / 单篇下载 / 批量下载 / 魔数复核 / 环境体检 / 批量进度。
 * 工具实现全部在 <plugin>/python/run.py；这里只做参数装配与子进程调度。
 */
export function buildCnkiTools({ defineTool, config, logger, runPy, jobs }) {
  const cfg = config || {}
  const makeOutput = (withJobId) => ({
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        ...(withJobId ? { jobId: { type: 'string' } } : {}),
        text: { type: 'string' },
      },
    },
    render(_args, value) {
      return [{ type: 'text', text: value.text }]
    },
  })

  // 统一把 runPy 结果渲染成宿主工具返回值（与原 dsh-cnki-dl 一致）
  const invoke = (label, argv, opts = {}) => runPy(argv, {
    pythonExe: cfg.pythonExe, timeoutMs: cfg.timeoutMs, ...opts,
  }).then(r => ({ ok: r.code === 0 && !r.timedOut, text: renderRun(label, r) }))

  const tools = [
    defineTool({
      name: 'cnki_search',
      description: '在知网（CNKI）检索文献，结果已按下载量降序。返回标题、作者、来源、年份、被引/下载量与详情页 URL。type=all 会切到期刊库（同时含学位论文）；thesis 只学位论文。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词；空格分隔表示 AND' },
          type: { type: 'string', description: '库类型：all（默认）/ journal / thesis', enum: SEARCH_TYPES },
          top: { type: 'number', description: '每页条数，默认 20' },
          pages: { type: 'number', description: '翻页数，默认 1' },
        },
        required: ['query'],
      },
      output: makeOutput(false),
      async execute(args) {
        const label = `知网检索：${args.query}`
        return invoke(label, buildSearchArgs({
          query: args.query, type: args.type, top: args.top, pages: args.pages
        }))
      },
    }),
    defineTool({
      name: 'cnki_download',
      description: '按详情页 URL 下载单篇文献。默认要 PDF；只有 CAJ 时才降级（可用 want 指定）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '知网详情页 URL' },
          outputDir: { type: 'string', description: '下载落点目录；省略则用配置里的 outputDir' },
          want: { type: 'string', description: '要的格式：pdf（默认）/ caj', enum: ['pdf', 'caj'] },
        },
        required: ['url'],
      },
      output: makeOutput(false),
      async execute(args) {
        return invoke('知网单篇下载', buildDownloadArgs({
          url: args.url,
          outputDir: args.outputDir || cfg.outputDir,
          wantFormat: args.want || cfg.wantFormat
        }))
      },
    }),
    defineTool({
      name: 'cnki_batch',
      description: '批量下载：给 URL 清单文件（每行 URL 或「标题<TAB>URL」）连续下载，或直接给检索词按下载量取前 N 篇。这是长任务，立即返回 jobId，用 cnki_task_status 查进度。',
      parameters: {
        type: 'object',
        properties: {
          listPath: { type: 'string', description: 'URL 清单文件路径（与 query 二选一）' },
          query: { type: 'string', description: '检索词（与 listPath 二选一）' },
          type: { type: 'string', description: '检索库类型：all / journal / thesis', enum: SEARCH_TYPES },
          top: { type: 'number', description: '检索时取前 N 篇' },
          limit: { type: 'number', description: '最多下载几篇' },
          outputDir: { type: 'string', description: '下载落点目录' },
          want: { type: 'string', description: '要的格式：pdf（默认）/ caj', enum: ['pdf', 'caj'] },
        },
      },
      output: makeOutput(true),
      async execute(args = {}) {
        const jobId = 'cnki-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        const argv = buildBatchArgs({
          listPath: args.listPath,
          query: args.query,
          type: args.type,
          top: args.top,
          limit: args.limit,
          outputDir: args.outputDir || cfg.outputDir,
          wantFormat: args.want || cfg.wantFormat
        })
        const job = { jobId, state: 'running', text: '已启动批量任务', argv, lines: [] }
        jobs.set(jobId, job)
        Promise.resolve().then(() => runPy(argv, { timeoutMs: 0, pythonExe: cfg.pythonExe })).then(r => {
          job.state = r.code === 0 && !r.timedOut ? 'done' : 'failed'
          job.text = renderRun('cnki_batch', r)
          logger?.info?.(`[dsh-bsk-fetch] batch ${jobId} ${job.state}`)
        }).catch(err => {
          job.state = 'failed'
          job.text = `批量任务失败：${err?.message || err}`
        })
        return { ok: true, jobId, text: `[cnki_batch] jobId=${jobId}\n${job.text}` }
      },
    }),
    defineTool({
      name: 'cnki_verify',
      description: '按文件魔数复核一个目录里的下载结果：真 PDF（%PDF-）、伪 PDF（其实是 CAJ）、空文件分别列出。',
      parameters: { type: 'object', properties: { outputDir: { type: 'string', description: '要复核的目录；省略则用配置里的 outputDir' } } },
      output: makeOutput(false),
      async execute(args) {
        return invoke('知网批量复核', buildVerifyArgs({ outputDir: args.outputDir || cfg.outputDir }))
      },
    }),
    defineTool({
      name: 'cnki_doctor',
      description: '环境体检：python / bsk 路径、输出目录可写、下载器扩展冲突、验证码识别链路。',
      parameters: { type: 'object', properties: { outputDir: { type: 'string', description: '顺带检查这个目录可写' } } },
      output: makeOutput(false),
      async execute(args) {
        return invoke('知网环境体检', buildDoctorArgs({ outputDir: args.outputDir || cfg.outputDir }))
      },
    }),
    defineTool({
      name: 'cnki_task_status',
      description: '查 cnki_batch 的后台进度。省略 jobId 则列出全部任务。',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'cnki_batch 返回的 jobId' },
          tail: { type: 'number', description: '只回最后 N 行日志，默认 30' },
        },
      },
      output: makeOutput(false),
      async execute(args = {}) {
        const tail = Number.isFinite(args.tail) ? args.tail : 30
        let text
        if (args.jobId) {
          const job = jobs.get(args.jobId)
          text = job
            ? `[${job.state}] ${args.jobId}\n${job.text}`
            : `未知 jobId: ${args.jobId}`
        } else {
          text = jobs.size
            ? [...jobs.values()].map(j => `[${j.state}] ${j.jobId} ${j.lines.length} 行`).join('\n')
            : '当前无批量任务'
        }
        return { ok: true, text: `[cnki_task_status]\n${text}` }
      },
    }),
  ]
  return tools
}
