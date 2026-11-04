// 极简静态服务器：把会话目录 tmp/ 与 data/ 暴露在 127.0.0.1，供 bsk 导航。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/DSH Workspace/sessions/2026-11-04_0234_57fab8'
const PORT = Number(process.argv[2] || 8731)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  const rel = url === '/' ? '/tmp/mock-captcha.html' : url
  const file = path.join(ROOT, rel)
  if (!file.startsWith(path.join(ROOT, ''))) { res.writeHead(403).end('forbidden'); return }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`))
