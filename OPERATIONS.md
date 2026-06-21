# Nabo MCP Lite 操作指引

## 1. 工作原理

```text
Agent（Claude / Codex / 其他 MCP 客户端）
          │ MCP stdio
          ▼
server/single-session-server.cjs
          │ WebSocket 127.0.0.1:9876
          ▼
Chrome 扩展
          │ Chrome API / CDP
          ▼
网页标签页
```

`single-session-server.cjs` 是 MCP 服务端，也是 Agent 与 Chrome 扩展之间的桥接程序。扩展不能单独接受 Agent 调用，服务端也不能在没有扩展连接时操作网页。

## 2. 环境要求

- Windows
- Node.js 18 或更高版本
- pnpm
- Google Chrome
- 项目目录：`D:\claude\bower\nabo-mcp-lite`

## 3. 安装依赖和构建

```powershell
cd D:\claude\bower\nabo-mcp-lite
pnpm install
pnpm test
pnpm type-check
pnpm build
```

构建结果位于：

```text
D:\claude\bower\nabo-mcp-lite\dist
```

## 4. 在 Chrome 中加载扩展

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `D:\claude\bower\nabo-mcp-lite\dist`。
5. 确认扩展名称是 `Nabo MCP Lite`。

每次重新执行 `pnpm build` 后，都要回到 `chrome://extensions`，点击该扩展卡片上的刷新按钮。仅刷新普通网页不会重新加载扩展 Service Worker。

## 5. 配置 MCP 客户端

### Claude Desktop

Claude Desktop 常见配置文件：

```text
%APPDATA%\Claude\claude_desktop_config.json
```

加入：

```json
{
  "mcpServers": {
    "nanobrowser": {
      "command": "node",
      "args": [
        "D:\\claude\\bower\\nabo-mcp-lite\\server\\single-session-server.cjs"
      ]
    }
  }
}
```

如果配置文件已有其他内容，只合并 `mcpServers.nanobrowser`，不要覆盖整个文件。保存后彻底退出并重新启动 Claude Desktop。

### Claude Code

可使用命令：

```powershell
claude mcp add nanobrowser -- node D:\claude\bower\nabo-mcp-lite\server\single-session-server.cjs
```

不同版本的 Claude Code 配置位置可能不同，可用下面命令确认：

```powershell
claude mcp list
```

### 其他 MCP 客户端

只要客户端支持 stdio MCP，都可以使用同样的启动配置：

```text
command: node
args: D:\claude\bower\nabo-mcp-lite\server\single-session-server.cjs
```

它并非只能供 Claude 使用。

## 6. 启动和连接

正常情况下不需要手动运行服务端。MCP 客户端启动时会自动运行：

```powershell
node D:\claude\bower\nabo-mcp-lite\server\single-session-server.cjs
```

服务端启动后监听：

```text
ws://127.0.0.1:9876
```

扩展会自动连接。首次连接或扩展重载后，通常等待 1 到 3 秒即可。

## 7. 手动测试

先退出会自动占用 9876 端口的 Claude/Codex MCP 会话，然后运行：

```powershell
cd D:\claude\bower\nabo-mcp-lite
$env:IDLE_WAIT_MS = "2000"
node scripts/runtime-test.cjs
```

成功结果必须包含：

```text
FIRST_CALL_OK
DOM_OK
PAGE_TEXT_OK
SECOND_CALL_OK
RUNTIME_TEST_OK
```

如果扩展未连接，测试会失败，不再把“仅服务端正常”当成成功。

## 8. 如何关闭

### 关闭服务端

通常关闭对应的 Claude、Codex 或其他 MCP 客户端即可。

手动查找占用 9876 的进程：

```powershell
Get-NetTCPConnection -LocalPort 9876 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

确认 PID 后关闭：

```powershell
Stop-Process -Id <PID>
```

不要在未确认 PID 的情况下强制结束全部 Node 进程。

### 关闭扩展

打开 `chrome://extensions`，关闭 `Nabo MCP Lite` 的开关，或者点击“移除”。

## 9. 多 Session 和冲突

当前服务端是单 Session 设计：

- 一个服务端进程只维护一个扩展连接。
- 同一时间只能有一个进程监听 9876。
- Claude Desktop、Claude Code、Codex 如果同时各自启动服务端，会发生端口冲突。
- 新 Session 不能直接接管旧 Session 已启动的 stdio 服务端。

切换 Agent Session 时，建议：

1. 关闭旧 Session 或退出旧 MCP 客户端。
2. 确认 9876 已释放。
3. 启动新 Session。
4. 等待扩展自动重连。

不需要重新加载扩展；只有重新构建扩展、Service Worker 异常或长时间未重连时才需要点击扩展刷新。

## 10. 常见问题

### `EADDRINUSE 127.0.0.1:9876`

已有服务端占用端口。关闭旧 MCP 会话或对应 Node 进程。

### `Extension not connected`

依次检查：

1. Chrome 是否正在运行。
2. `Nabo MCP Lite` 是否启用。
3. 加载路径是否是 `D:\claude\bower\nabo-mcp-lite\dist`。
4. 是否在构建后点击了扩展刷新。
5. 服务端是否监听 9876。

### 工具调用超时

先运行：

```powershell
Get-NetTCPConnection -LocalPort 9876 -ErrorAction SilentlyContinue
```

如果没有 `ESTABLISHED` 连接，刷新扩展。若存在连接，运行 `scripts/runtime-test.cjs` 判断是 MCP 客户端问题还是扩展工具问题。

### Agent 读取网页后突然停止

优先使用 `get_dom` 获取可交互元素。`get_page_text` 已限制为最多 50,000 字符，但复杂页面仍可能占用较多上下文。

### Chrome 内部页面无法操作

`chrome://settings`、`chrome://extensions` 等 Chrome 内部页面受浏览器安全策略限制。普通网页工具不保证能读取或执行脚本。
