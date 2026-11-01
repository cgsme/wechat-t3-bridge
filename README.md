# WeChat T3 Bridge

通过个人微信 ClawBot 向本机 T3 发送任务、管理线程和回答补充问题。直接使用微信 iLink 协议，无需 OpenClaw。

这是独立社区适配器，并非腾讯或 T3 官方插件。

## 环境要求

- Windows，已运行的 T3 桌面端及其 CLI。
- Node.js 22 或更新版本、npm。
- 可用的微信 ClawBot 绑定能力；以账号和服务端实际返回为准。

## 快速开始

在克隆后的项目目录执行：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd test
.\install.ps1 -ThreadId <已有的T3线程ID>
node "$env:LOCALAPPDATA\WeChatT3Bridge\src\bridge.mjs" connect
```

安装脚本会启用当前用户的登录自启动。扫码后，仅绑定者本人可以通过私聊使用；不支持群聊或多个微信用户共用。

## 常用命令

```text
/help
/threads
/new 检查项目中的问题
/to 2 /stop
/skills
/task --skills code-review 审查代码
```

普通文字会在当前线程执行。命令需带 `/`；权限确认仍需在 T3 桌面端处理。

## 文档

- [安装与绑定](docs/installation.md)
- [命令与技能](docs/commands.md)
- [运行维护与数据](docs/operations.md)
- [架构与开发](docs/development.md)
- [贡献指南](CONTRIBUTING.md)
- [安全说明](SECURITY.md)

## 开发

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd test
```

测试使用本地替身，不需要微信账号或运行中的 T3。跨线程并发、同线程顺序、重启恢复和控制调用均有回归测试。

## 协议来源

- [腾讯微信接入项目](https://github.com/Tencent/openclaw-weixin)
- [公开协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)
- [T3 Code](https://github.com/t3dotgg/t3code)

当前适配依赖 T3 CLI 和本机控制协议；上游更新可能需要同步调整。Windows 安装与真实收发需要单独验证。

## 许可证

[MIT](LICENSE)。第三方依赖保留各自许可证，见 [NOTICE](NOTICE)。
