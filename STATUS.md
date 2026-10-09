# Nabo MCP Lite 状态

> 最后更新：2026-10-09

## 当前状态

项目已经完成精简版 Chrome 扩展和共享 Hub MCP 服务端：

- Chrome 扩展从 `dist/` 加载。
- 扩展通过 `ws://127.0.0.1:9876` 连接共享 Hub。
- Claude、Codex 等支持 MCP 的 Agent 启动 `server/nabo-client.cjs`，多个 client 可同时连接 `ws://127.0.0.1:9877`。
- 21 个 MCP 工具已在真实站点端到端验证。

## 2026-09/10 更新（当前版本）

工具从 14 个扩到 21 个，并完成一轮性能与稳定性改造：

- **新工具**：`click_at`（坐标点击，canvas/地图/图表可用）、`upload_file`（CDP setFileInputFiles）、`browser_stats`（缓存/点击统计）、`reload_extension`（重载扩展），以及小红书三件套 `xhs_check_login` / `xhs_search` / `xhs_detail`。
- **点击提速**：`click_element` 由 2747ms 降到 ~15ms——改用 bounding-rect 中心点 + CDP 真实鼠标事件（trusted），弃用会因窗口遮挡而超时的 IntersectionObserver 可见性判断。
- **页面级 DOM 缓存**：按 (tabId, URL) 复用扫描结果，重访页面 16~300ms（原 1.1~1.3s）；`click_element` / `input_text` 复用 `get_dom` 的 selectorMap。
- **截图三参数**：`scale`（默认 0.5，2560→1280px）、`quality`、`save`（JPEG 落盘只回路径，省 90%+ token）。
- **稳定性**：坏 iframe 不再拖垮整页扫描；窗口最小化时扫描不再静默返回空（扫描期间临时施加设备度量覆盖）；点击前身份校验 + 唯一匹配重定位防误点；file input 直接拒绝并引导 `upload_file`。
- **诊断**：空扫描自动附 `scanDiagnostics`；`get_dom` 返回 `pageHints`（canvas/iframe/视口尺寸）。
- **并发**：Hub 全局 FIFO——多个 Agent 会话共享同一 Chrome 不互相踩坏页面（`scripts/concurrency-test.cjs` 实测串行）。

## 2026-07-24 共享 Hub 改造

旧版每个 Agent 都启动一个会监听 9876 的服务端，导致第一个 Agent 占用端口后，其他 Agent 无法连接。

现在：

- `server/nabo-hub.cjs` 只启动一次，监听扩展端口 9876 和 client 端口 9877。
- `server/nabo-client.cjs` 是 Claude Desktop、Claude Code、Codex 的统一 stdio MCP 入口。
- 多个 client 同时连接 Hub 时，Chrome、登录态、标签页共享，工具调用由 Hub 串行转发给扩展。
- `server/single-session-server.cjs` 保留为兼容入口，内部转到 `nabo-client.cjs`。
- 新增 `scripts/hub-runtime-test.cjs`，验证两个 stdio MCP client 共享同一个 Hub。

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
cd D:\all_code\tools\localbower
pnpm test
pnpm type-check
pnpm build
$env:IDLE_WAIT_MS = "2000"
node scripts/runtime-test.cjs
```

运行端到端测试前，需要满足：

1. Chrome 已从 `D:\all_code\tools\localbower\dist` 加载扩展。
2. 构建后已在 `chrome://extensions` 点击扩展的刷新按钮。
3. 9876 端口没有被另一个 MCP 服务占用。

共享 Hub 模式下，若 9876 被 `nabo-hub.cjs` 占用是正常状态；冲突通常说明还有旧入口或手动 Hub 进程在运行。

完整操作见 [OPERATIONS.md](./OPERATIONS.md)。

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
