# 架构与开发

## 处理流程

微信轮询 → 持久化收件 → 命令解析与目标绑定 → 按线程调度 → T3 执行 → 回复分段与持久化发送进度。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| src/bridge.mjs | 登录、运行循环、磁盘保存、进程锁与健康状态 |
| src/supervisor.mjs | 登录启动、T3 就绪检查、进程接管与退出重试 |
| src/api.mjs | 微信协议、请求超时及消息 ID 精度 |
| src/core.mjs | 命令解析、收件去重、恢复及回复格式 |
| src/command-policy.mjs | 指定目标、引用和排队策略的唯一来源 |
| src/commands.mjs | 命令执行、目标校验及业务回执 |
| src/scheduler.mjs | 跨线程并发、同线程顺序及发送重试 |
| src/backend.mjs | T3 CLI 适配及后台任务等待 |
| src/task-tracking.mjs | 服务进程探测、可取消等待及持久化跟踪状态 |
| src/t3-control.mjs | T3 本机控制、写入授权与凭据撤销 |
| src/projects.mjs / thread-labels.mjs | 项目选择及稳定线程编号 |
| src/models.mjs / questions.mjs | 模型设置与待答问题 |
| src/quotes.mjs / typing.mjs | 引用路由及输入状态 |
| src/skills.mjs | 本地技能发现与任务指令准备 |
| src/html-attachments.mjs | HTML 结果附件提取 |
| src/usage.mjs / t3-usage.mjs | 用量格式与本机数据读取 |

## 关键约束

- 收件快照保存成功后才发布新游标。
- 任务只提交一次；线程、任务编号及等待阶段保存后，桥接重启只恢复查询。未确认提交的任务仍须人工核对。
- 正常运行不设总时长上限；连接重试和每次请求有独立时限。跟踪失败不表示任务失败，不得因此重发原任务。
- 指定目标和引用目标都必须重新校验，不能回退到其他线程执行。
- 发送失败保留任务与发送进度，允许后续回复继续发送；重试成功的旧回复可能晚于新回复到达。
- 调用 T3 控制工具须经过允许列表及相应授权；临时凭据不落盘。
- 状态目录与源代码分离；Windows 安装目录的程序副本通过 upgrade.ps1 更新。

## 验证

`npm test` 运行全部 test/*.test.mjs。echo.mjs、fake-t3.mjs 和 launch-shape.mjs 是测试实际引用的子进程替身，不是废弃脚本。
CI 验证 Node.js 22/24 下的自动化测试；安装、自启动、扫码和真实收发仍需 Windows 实机验证。
