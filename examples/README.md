# 示例与联调脚本

这三个文件是我做真机验证时用的，留在仓库里方便你复现。

## mock-captcha.html

同源 canvas 验证码测试页：画若干圆形/方形/三角形，点对了 `window.__captchaMeta().solved` 变 true。

```bash
node serve-mock.mjs          # 起在 http://127.0.0.1:8731/
```

## agent-vision-e2e.mjs

完整走一遍两段式：`inspectChallenge` → 调多模态 API 看图 → `pickPoints` → 断言 `solved`。

它从 `~/.dsh/.credentials.yaml` 读 `TONGJI_API_KEY`，不硬编码密钥：

```bash
node agent-vision-e2e.mjs <sessionId>
```

## 为什么留这两个

`--capture` 坐标点击那条路在 bsk 0.4.1 上是死的（见主 README 的「技术发现」），
所以插件改用 `canvas.toDataURL()` + 合成事件。这两个文件就是证明这条路能走通的证据。
