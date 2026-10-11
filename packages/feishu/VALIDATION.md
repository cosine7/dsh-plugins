# 验证记录

2026-10-11，适配 DSH 桌面版 `0.2.0-rc.2`，官方 Node SDK `1.74.0`。

- 仓库 `pnpm check`：类型检查、Oxlint、Oxfmt、Vitest、构建通过。飞书插件24项测试、原 Task Center 的19项测试全部通过。
- 飞书插件测试覆盖唯一订阅、revision、转交时的持久化竞争、忙碌等待、冷会话、无人订阅不补投、授权校验、文字及按钮去重、业务有效期、卡片原地更新、崩溃恢复与 uncertain、单写者锁、损坏文件保护、SDK 消息请求和扫码凭据隔离。
- SDK 测试使用实际 Client 和 EventDispatcher，仅替换网络适配器。发送幂等、当前事件格式、按钮回调响应和消息 PATCH 已验证；不把模拟网络测试视为手机验收。
- 真实桌面宿主检查加载已安装 Electron `app.asar` 中的服务，使用临时 DSH_HOME、真实 credentials-local 和 JSONL 会话持久化。18个工具、技能、订阅转交、SDK事件回调、唯一投递、退出活动报告、归档解订阅及卸载清理通过。网络模拟，无模型调用，无交易 Agent。

宿主检查在构建后运行：

```powershell
$desktopDir = "$env:LOCALAPPDATA/Programs/DeepSeek Harness"
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOST_MODULES = "$desktopDir/resources/app.asar/dsh/node_modules"
& "$desktopDir/DeepSeek Harness.exe" --expose-internals packages/feishu/scripts/verify-host.mjs | Out-String
```

在独立 PowerShell 窗口中从仓库根目录运行；管道确保 PowerShell 等待 Windows GUI 可执行文件并收集输出。必须看到明确的 `DSH desktop host integration passed`，不能只根据退出码判断通过。

手机实测已完成：通过本插件 Setup 扫码复用现有应用，凭据直接写入真实 DSH credentials 服务，官方 Node SDK 长连接收到卡片点击及用户文字 `123`，分别投递并持久化到独立测试 Session，共2条 inbox 消息。测试卡片的最终状态 PATCH 成功，dirty=false；消息查询 API 对此 Card 2.0 返回兼容提示，不能用该读回结果确认视觉内容。测试结束解除订阅，保留启用通道供正式 Session 主动订阅。

已通过可选增量权限扫码取得修改应用信息权限，将原机器人改名为 DSH Bot 并发布应用版本1.0.3；机器人及应用信息接口均读回新名称。本地目录链接已安装到 desktop profile。

配置完成后，用真实桌面宿主服务加载最终构建入口，验证插件从现有 DSH 凭据和通道状态自动启动，无需重新扫码或手动连接：长连接 connected，机器人名称 DSH Bot，18个工具可用，没有订阅者。该检查没有重启日常桌面应用。

未进行长时间断网/休眠恢复压测。未修改交易脚本与策略文档、未订阅或唤醒交易 Session、未调用真实模型。测试 Session 使用临时存储并已清理，正式订阅需用户在目标 Session 中主动发起。
