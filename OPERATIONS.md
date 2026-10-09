# Nabo MCP Lite 操作指引

## 1. 工作原理

```text
Agent（Claude / Codex / 其他 MCP 客户端）
          │ MCP stdio
          ▼
server/nabo-client.cjs
          │ WebSocket 127.0.0.1:9877
          ▼
server/nabo-hub.cjs
          │ WebSocket 127.0.0.1:9876
          ▼
Chrome 扩展
          │ Chrome API / CDP
          ▼
网页标签页
```

`nabo-hub.cjs` 是共享 Hub，也是 Chrome 扩展唯一连接的桥接程序。`nabo-client.cjs` 是各个 Agent 启动的 stdio MCP 入口，多个 Agent 可以同时启动多个 client，并共享同一个 Hub、Chrome 和标签页。

## 2. 环境要求

- Windows
- Node.js 18 或更高版本
- pnpm
- Google Chrome
- 项目目录：`D:\all_code\tools\localbower`

## 3. 安装依赖和构建

```powershell
cd D:\all_code\tools\localbower
pnpm install
pnpm test
pnpm type-check
pnpm build
```

构建结果位于：

```text
D:\all_code\tools\localbower\dist
```

## 4. 在 Chrome 中加载扩展

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `D:\all_code\tools\localbower\dist`。
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
        "D:\\all_code\\tools\\localbower\\server\\nabo-client.cjs"
      ],
      "env": {
        "MCP_WS_PORT": "9876",
        "MCP_HUB_PORT": "9877"
      }
    }
  }
}
```

如果配置文件已有其他内容，只合并 `mcpServers.nanobrowser`，不要覆盖整个文件。保存后彻底退出并重新启动 Claude Desktop。

### Claude Code

可使用命令：

```powershell
claude mcp add nanobrowser -e MCP_WS_PORT=9876 -e MCP_HUB_PORT=9877 -- node D:\all_code\tools\localbower\server\nabo-client.cjs
```

不同版本的 Claude Code 配置位置可能不同，可用下面命令确认：

```powershell
claude mcp list
```

### 其他 MCP 客户端

只要客户端支持 stdio MCP，都可以使用同样的启动配置：

```text
command: node
args: D:\all_code\tools\localbower\server\nabo-client.cjs
```

它并非只能供 Claude 使用。

## 6. 启动和连接

正常情况下不需要手动运行 Hub。MCP 客户端启动时会自动运行：

```powershell
node D:\all_code\tools\localbower\server\nabo-client.cjs
```

如果 Hub 尚未运行，client 会自动拉起：

```text
Hub:       ws://127.0.0.1:9877
Extension: ws://127.0.0.1:9876
```

扩展会自动连接。首次连接或扩展重载后，通常等待 1 到 3 秒即可。

## 7. 手动测试

先退出会自动占用 9876 端口的 Claude/Codex MCP 会话，然后运行：

```powershell
cd D:\all_code\tools\localbower
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

### 关闭 Hub

通常关闭所有 Claude、Codex 或其他 MCP 客户端即可。若 client 自动拉起了后台 Hub，可手动查找并关闭 `nabo-hub.cjs` 对应 Node 进程。

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

当前服务端是共享 Hub 设计：

- 只有一个 Hub 进程监听 9876，供 Chrome 扩展连接。
- 多个 `nabo-client.cjs` 可以同时连接 Hub 的 9877 端口。
- Claude Desktop、Claude Code、Codex 可以同时配置同一个 `nabo-client.cjs`。
- Chrome、登录态、标签页共享；浏览器操作由 Hub 按请求顺序转发。

切换 Agent Session 时，建议：

1. 启动新 Session。
2. 等待 client 连接 Hub。
3. 如遇到 `Extension not connected`，刷新扩展或确认 Hub 正在监听 9876。

不需要重新加载扩展；只有重新构建扩展、Service Worker 异常或长时间未重连时才需要点击扩展刷新。

## 10. 常见问题

### `EADDRINUSE 127.0.0.1:9876`

已有 Hub 占用端口。正常情况下这是预期现象；请确认客户端配置指向 `nabo-client.cjs`，不要再直接启动 `nabo-hub.cjs` 或旧服务端入口。

### `Extension not connected`

依次检查：

1. Chrome 是否正在运行。
2. `Nabo MCP Lite` 是否启用。
3. 加载路径是否是 `D:\all_code\tools\localbower\dist`。
4. 是否在构建后点击了扩展刷新。
5. Hub 是否监听 9876，client 是否能连接 9877。

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
