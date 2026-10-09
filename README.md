# Nabo MCP Lite

一个精简的本地 MCP 浏览器控制桥接项目。它保留 Nanobrowser 操作 Chrome 网页所需的核心能力，移除了模型、Agent 编排、语音、界面和遥测等非必要模块。

## 架构

```text
MCP Client（Claude / Codex / 其他客户端）
                 │ stdio MCP
                 ▼
server/nabo-client.cjs
                 │ WebSocket 127.0.0.1:9877
                 ▼
server/nabo-hub.cjs
                 │ WebSocket 127.0.0.1:9876
                 ▼
Nabo MCP Lite Chrome Extension
                 │ Chrome API / CDP
                 ▼
Chrome 网页标签页
```

## 功能

提供 14 个 MCP 工具：

- 标签页：`list_tabs`、`switch_tab`、`open_tab`、`close_tab`
- 导航：`navigate`
- 页面读取：`get_dom`、`get_page_text`、`screenshot`
- 页面操作：`click_element`、`input_text`、`select_option`
- 键盘和滚动：`send_keys`、`scroll`
- 脚本执行：`execute_script`

`get_page_text` 最多返回 50,000 字符，并提供 `truncated` 和 `originalLength`，避免大型网页占满 Agent 上下文。

## 环境要求

- Node.js 18+
- pnpm
- Google Chrome
- 支持 stdio MCP 的客户端

## 安装与构建

```powershell
git clone https://github.com/kaleburannengsha-hue/nabo-mcp-lite.git
cd nabo-mcp-lite
pnpm install
pnpm test
pnpm type-check
pnpm build
```

构建产物位于 `dist/`。

## 加载 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目的 `dist` 目录。
5. 每次重新构建后，点击扩展卡片上的刷新按钮。

## MCP 配置

Claude Desktop 示例见：

```text
config/claude-desktop.example.json
```

核心配置：

```json
{
  "mcpServers": {
    "nanobrowser": {
      "command": "node",
      "args": [
        "D:\\path\\to\\nabo-mcp-lite\\server\\nabo-client.cjs"
      ],
      "env": {
        "MCP_WS_PORT": "9876",
        "MCP_HUB_PORT": "9877"
      }
    }
  }
}
```

Claude Code：

```powershell
claude mcp add nanobrowser -e MCP_WS_PORT=9876 -e MCP_HUB_PORT=9877 -- node D:\path\to\nabo-mcp-lite\server\nabo-client.cjs
```

其他客户端可参考 `config/mcp-stdio.example.json`。

## 测试真实连接

确保 Chrome 已加载并刷新扩展：

```powershell
$env:IDLE_WAIT_MS = "2000"
node scripts/runtime-test.cjs
```

成功输出应包含：

```text
FIRST_CALL_OK
DOM_OK
PAGE_TEXT_OK
SECOND_CALL_OK
RUNTIME_TEST_OK
```

## 使用限制

- 当前为共享 Hub 模式：只有 `nabo-hub.cjs` 监听 9876，多个 `nabo-client.cjs` 可同时连接 Hub。
- Chrome、登录态、标签页仍共享；多个 Agent 同时操作同一浏览器时，Hub 会按请求顺序转发。
- `chrome://` 内部页面受 Chrome 安全策略限制。
- `execute_script` 可以执行网页脚本，只应连接可信的本地 MCP 客户端。

## 文档

- [完整操作指引](./OPERATIONS.md)
- [当前项目状态](./STATUS.md)
- [配置示例](config)

## 来源与许可证

浏览器控制层基于 [Nanobrowser](https://github.com/nanobrowser/nanobrowser) 精简和修改。

项目按 Apache License 2.0 发布，详见 `LICENSE` 和 `NOTICE`。
