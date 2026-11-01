## 本机安装

需要已运行的 T3 桌面端、T3 CLI 和 Node.js 22 或更新版本。

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
.\install.ps1 -ThreadId <已有的T3会话ID>
```

脚本安装到 `%LOCALAPPDATA%\WeChatT3Bridge`，生成本人及 SYSTEM 可访问的目录，并在当前用户的启动文件夹添加 `WeChatT3Bridge.vbs`。初始选中传入的已有线程；只有 `/new <request>` 会创建新线程。

扫码绑定：

```powershell
node "$env:LOCALAPPDATA\WeChatT3Bridge\src\bridge.mjs" connect
```

二维码保存在 `%LOCALAPPDATA%\WeChatT3Bridge\data\login.html` 和 `login-qr.png`。请生成后立即使用手机微信扫码并确认，服务端提示过期时重新生成。若微信要求验证码，将验证码通过私密输入交给配置助手，或在本机写入 `data\verify-code.txt`；程序读后删除。请勿将验证码或 `data\account.json` 内容发到聊天中。

启动和状态：

```powershell
wscript.exe "$env:LOCALAPPDATA\WeChatT3Bridge\Start.vbs"
node "$env:LOCALAPPDATA\WeChatT3Bridge\src\bridge.mjs" status
node "$env:LOCALAPPDATA\WeChatT3Bridge\src\bridge.mjs" check
```

电脑需保持开机联网。登录 Windows 后，`Start.vbs` 启动守护进程：T3 未运行时启动桌面端，连接未就绪时每隔 5–30 秒重试，就绪后启动桥接；已有桥接会被接管，退出后会自动拉起。无需依赖两个程序的启动顺序，登录前不提供服务。微信登录失效后仍需重新扫码。Agent 要求补充信息时，微信显示问题及选项，回复 `/answer 2` 或文字即可。含 `/` 开头的答案请用 `/answer <完整答案>`。如果当前线程的问题尚未显示，先用 `/questions` 查看。权限确认卡仍在 T3 桌面端处理。

`data\supervisor-status.json` 记录启动和守护状态，微信连接状态继续查看 `data\status.json`。守护不重新提交任务，重启前结果不确定的任务仍需在 T3 核对后决定如何继续。重新运行 `Start.vbs` 不会重复启动已有守护或桥接。

答案按线程和请求 ID 保存，多题收集完成后一次提交到原请求，继续等待原任务结果；不会把答案作为新任务发送。切换线程后回答对应线程的问题。问题已失效或被其他客户端回答时，旧答案不会转交给新问题。已经排队、早于问题产生的消息不会被当成答案。问题显示后，直接回复文字与 `/task <文字>` 都会回答该问题；若要执行其他任务，可用 `/new` 新建线程。提交结果不确定时不会自动重试；用 `/questions` 读取当前状态后可明确重新回答。
