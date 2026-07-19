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

## 2026-07-19 CDP execute_script 改造记录

背景：考试页在整卷模式下 DOM 已渲染 80 个 `.question_box`，Codex/DevTools 类自动化能直接读到；旧 `execute_script` 使用 `chrome.scripting.executeScript + new Function(code)`，会被目标站点 CSP 拦截，典型错误为 `unsafe-eval` / `Refused to execute inline script`。

已改造：

- `extension/src/tools.ts`
  - `execute_script` 改为 `chrome.debugger` + CDP `Runtime.evaluate`。
  - 使用 `Page.getFrameTree` + `Page.createIsolatedWorld` 创建页面执行上下文。
  - 返回 `{ result, mode: "cdp" }`，用于确认不是旧注入路径。
  - 针对同一个 tab 缓存 CDP attachment 和 `executionContextId`，避免连续调用时上下文漂移。
  - 遇到 `Another debugger is already attached` 时尝试复用已有 debugger session。

验证过的现象：

- 构建后未重新加载扩展时，实际 MCP 调用仍会报 CSP `unsafe-eval`，说明 Chrome 仍运行旧后台。
- 重新加载扩展后，`execute_script` 调用 `1 + 1` 返回 `{ "result": 2, "mode": "cdp" }`，说明 CDP 路径已生效。
- 考试页曾验证 `typeof document` 返回 `{ "result": "object", "mode": "cdp" }`。
- 在最后一次缓存修复前，连续调用 `document.querySelectorAll('.question_box').length` 仍出现过间歇性 `document is not defined`；当前修复方向是复用同一 tab 的 CDP execution context。

最新自动验证命令：

```powershell
pnpm.cmd test
pnpm.cmd type-check
pnpm.cmd build
```

最近一次结果：

- `pnpm.cmd test`：20 tests passed。
- `pnpm.cmd type-check`：passed。
- `pnpm.cmd build`：passed，仍有 Vite 对 `chromium-bidi` 的 `crypto` browser compatibility warning，但退出码为 0。

后续如果考试页还能打开，手动重新加载扩展后，优先运行下面的实际验证：

```js
1 + 1
typeof document
document.querySelectorAll('.question_box').length
document.querySelectorAll('.question_box')[17]?.innerText.slice(0,120)
document.querySelectorAll('.question_box')[79]?.innerText.slice(0,120)
```

目标结果：

- `1 + 1` 返回 `2` 且 `mode` 为 `cdp`。
- `typeof document` 返回 `object`。
- `.question_box` 数量应返回 `80`。
- 第 18 题、第 80 题应能返回文本片段。
