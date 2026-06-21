# Nabo MCP Lite 状态

> 最后更新：2026-06-21

## 当前状态

项目已经完成精简版 Chrome 扩展和单 Session MCP 服务端：

- Chrome 扩展从 `dist/` 加载。
- 扩展通过 `ws://127.0.0.1:9876` 连接 MCP 服务端。
- 服务端通过 stdio 向 Claude、Codex 等支持 MCP 的 Agent 暴露 14 个网页工具。
- `list_tabs`、`switch_tab`、`get_page_text`、`get_dom` 已通过真实 Chrome 端到端调用。

## 本次修复

### 1. 运行测试端口错误

旧版 `scripts/runtime-test.cjs` 固定启动在 9986，但扩展固定连接 9876，造成测试只能验证服务端，不能验证扩展。

现在：

- 默认使用 9876。
- 可通过 `MCP_WS_PORT` 覆盖端口。
- 扩展没有连接时测试直接失败。
- 不再输出 `RUNTIME_TEST_OK (server only)` 这种假成功结果。

### 2. 网页内容返回过大

`get_page_text` 原来会返回整个 HTML。复杂页面可能超过十几万字符，使 Agent 上下文迅速膨胀甚至中断。

现在最多返回 50,000 字符，并附带：

```json
{
  "content": "...",
  "truncated": true,
  "originalLength": 158000
}
```

## 常用验证命令

```powershell
cd D:\claude\bower\nabo-mcp-lite
pnpm test
pnpm type-check
pnpm build
$env:IDLE_WAIT_MS = "2000"
node scripts/runtime-test.cjs
```

运行端到端测试前，需要满足：

1. Chrome 已从 `D:\claude\bower\nabo-mcp-lite\dist` 加载扩展。
2. 构建后已在 `chrome://extensions` 点击扩展的刷新按钮。
3. 9876 端口没有被另一个 MCP 服务占用。

完整操作见 [OPERATIONS.md](OPERATIONS.md)。
