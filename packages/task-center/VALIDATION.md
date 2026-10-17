# 验证记录

## DSH 0.2.1-rc.2（2026-10-17）

- 本机桌面版和内置 CLI 均为 `0.2.1-rc.2`，宿主 Cordis 为 `4.0.5`，Electron Node 为 `24.21.0`。
- 插件版本升为 `0.3.1`，DSH 开发与 peer 依赖固定到 `0.2.1-rc.2`，共享 catalog 与锁文件同步，运行代码无需修改。
- 新版类型检查、lint、格式、构建及原有19项测试通过；根检查连同飞书插件共43项测试通过。
- 新版 JSONL 持久化插件不再默认导出，宿主测试改为加载其模块对象。真实宿主检查通过：8个工具、技能、无 cwd 会话、转交、退出活动报告、归档暂停、计时器唤醒、JSONL消息读回、卸载和实例锁释放。
- 所有宿主测试使用临时 DSH_HOME 和无网络模型替身，未修改用户任务、历史 Session 或交易项目，未重启日常 DSH。
- 本次系统 Temp 对 Node 写入返回 EPERM，验证命令仅在自身进程内设置 TEMP/TMP 到 `.local-backups/validation-temp`，随后完整检查通过，未改全局环境或测试配置。

## Vitest 与提交检查（2026-10-11）

单元测试迁移为 TypeScript，直接通过 Vitest 测试源码；根目录递归执行各子包的测试命令，无需 Vitest 配置文件。保留原有 19 项测试，全部通过。类型检查、lint、格式检查、构建与真实桌面宿主集成检查通过。

根目录通过 simple-git-hooks 注册 `pre-commit`，提交前运行 `pnpm check`；`pnpm install` 的 prepare 自动安装钩子。普通工具和库使用 `^`，DSH 开发依赖保持固定版本，锁文件记录实际安装版本。

真实桌面宿主检查需先构建，再从本插件目录运行以下 PowerShell 命令（在独立 PowerShell 窗口运行，结束后关闭该窗口）：

```powershell
$desktopDir = "$env:LOCALAPPDATA/Programs/DeepSeek Harness"
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOST_MODULES = "$desktopDir/resources/app.asar/dsh/node_modules"
& "$desktopDir/DeepSeek Harness.exe" --expose-internals scripts/verify-host.mjs
```

该检查使用临时 DSH_HOME 与无网络模型替身，不修改日常任务库，不重启日常 DSH。

## pnpm monorepo 迁移（2026-10-11）

插件版本 0.3.0，从独立 JavaScript 项目迁移到 `dsh-plugins/packages/task-center`，采用 TypeScript、tsdown、Oxlint 与 Oxfmt。仅支持桌面版 DSH 0.2.0-rc.2。保留包名、插件 ID、v1 任务存储与会话绑定，原源码目录保留用于回退。旧网页版的绑定不修改。

- 原项目 19 项测试先通过，迁移后相同 19 项测试全部通过。
- 类型检查、Oxlint 类型感知检查、Oxfmt 格式检查通过。
- 使用已安装桌面版的 app.asar 宿主运行隔离集成检查：8 个工具、技能、跨会话转交、无 cwd 会话、退出活动检查、归档暂停、真实计时器唤醒、Session JSONL 持久化、卸载清理与锁释放通过。
- 测试使用临时 DSH_HOME，无模型调用。未修改交易项目文件，也未重启日常 DSH。
- 项目 Node 为 pnpm 管理的 24.21.0，系统 Node 保持原有 22.22.2。
- 桌面 profile 的依赖与符号链接均已指向新插件子目录；bundle 声明保持不变。原任务文件 SHA256 校验一致，数据副本加载后任务 ID、revision、规则、会话绑定与历史记录均保留。正在运行的桌面宿主未退出，新入口在下次重启加载。

以下保留旧项目历史记录，其中旧版兼容性说明不代表当前支持范围。

## 官方桌面版 0.2.0-rc.2（2026-09-30）

通过本机 DeepSeek Harness.exe 的 FileVersion、桌面版内置 CLI 的 `--version` 和 app.asar 内宿主包的 package.json 确认版本均为 0.2.0-rc.2。桌面宿主使用 Electron Node 24.18.1、内置 pnpm 11.7.0，运行独立的 `~/.dsh/profiles/desktop`。

原插件 0.1.1 的 8 个工具与定时消息投递通过新版宿主验证；主要缺口是三个 DSH 依赖仍为 0.1.7-rc.2、desktop profile 无插件关联，以及未参与新版桌面退出检查和会话归档停止协议。

插件版本提升为 0.2.0，三个直接 DSH 依赖与锁文件对齐 0.2.0-rc.2。接入 `workspace/session-activity` 的 schedule 类型与 `workspace/session-stop`：活动任务参与退出和归档检查，归档并停止会话会持久化暂停该会话任务；等待持久化预检中的投递会重新检查暂停状态。未来不继续维护旧网页版兼容。

验证：

- `pnpm test`：19 项通过，0 失败；新增归档暂停、revision、其他会话隔离及预检期间停止防止投递测试。
- `pnpm install --frozen-lockfile`：通过。
- 使用本机桌面版 Electron Node 模式直接加载 app.asar/dsh/node_modules 运行 scripts/verify-host.mjs：全部 8 个工具、技能、无 cwd 会话、跨会话转交、退出活动报告、归档停止/恢复、真实计时器投递、Session JSONL 持久化读回、卸载及锁释放通过。
- 使用桌面自带 `dsh.cmd plugin --profile desktop add link:C:/Users/cosine/Desktop/dsh-task-center` 完成关联，desktop package.json 的依赖及 bundles 均包含插件，node_modules 的符号链接指向桌面源码目录。桌面版禁止 CLI 直接启动或 dump 桌面 profile，因此未以该方式验证整棵配置树。

集成测试使用临时 DSH_HOME 与无网络 LLM 替身，不改用户任务数据或调用模型。desktop 原 package.json、cordis.patch.yml、pnpm-workspace.yaml 在 `.local-backups/desktop-before-0.2.0/` 留存备份。重启日常桌面应用后加载更新；未主动结束正在运行的用户会话。

## DSH 0.1.7-rc.2 兼容性修复（2026-09-28）

本机宿主的 dsh-agent、dsh-session、dsh-tools、dsh-agent-loop 等组件为 0.1.7-rc.2，web profile 仍以 link: 引用本桌面目录。插件原版本为 0.1.0，其三个直接 DSH 依赖固定在 0.1.5-rc.1。

使用本机新版宿主服务复现两处错误：

- 无 cwd 的会话使 task_center_sessions 返回 undefined 属性，新版 ToolRuntime 拒绝非无损 JSON 输出。
- 到期投递使用旧通用 plugin 来源，真实 Session v4 拒绝并报 `format v4 message requires a producer-owned source kind`。用户任务库也存在一条由同一错误导致暂停的任务。

已将来源改为 cosine-task-center，省略未定义 cwd，等待工具清理结束后关闭任务库；插件版本提升为 0.1.1。三个直接 DSH 依赖、锁文件和安装依赖均对齐 0.1.7-rc.2，不安装 DSH 启动器。

验证：

- `pnpm test`：18 项通过，0 失败。
- `pnpm install --frozen-lockfile`：通过。
- `DSH_HOST_MODULES=C:/Users/cosine/.dsh/profiles/node_modules pnpm test:host`：新版真实工具注册与全部 8 个工具调用、技能读取、无 cwd 会话、跨会话转交、暂停/删除、真实计时器投递、Session v4 JSONL 写入及读回、插件卸载清理与锁释放通过。

集成检查使用临时 DSH_HOME、两个真实根 Agent、无网络的 LLM 替身，不调用模型。测试结束销毁上下文并清理临时目录。保留用户任务、投递历史与暂停状态；日常 DSH 下次重启加载修复，原暂停任务需检查目标会话后恢复。

以下为旧版本历史记录。

日期：2026-09-10。平台：Windows，Node.js 22.22.2，DSH 0.1.5-rc.1。

## 自动化测试

`npm test`：15 项通过，0 失败。

覆盖：多窗口起点对齐、午休/周末排除、日期范围及例外日期、重叠窗口去重、固定间隔不漂移、cron 月末与精确边界、非法输入、夏令时缺失与重叠、跨会话转交、revision 冲突、等待持久化时转交或删除、忙碌等待、不恢复冷会话、暂停恢复、历史落盘、实例互斥、进程投递中断恢复、存储损坏保留、磁盘故障不自动重复投递、关闭清理。

## 真实 DSH 集成验证

在独立 DSH_HOME 和端口3087上验证，未使用用户凭据，未修改日常 profile 或会话。

1. 通过 `dsh plugin --profile web add <tgz>` 安装，自动注册 bundle，Web 启动通过。
2. 同时启用官方 dsh-schedule，创建两个真实根 Agent：新插件8个工具与官方 schedule_create 共存。
3. 官方 skills 服务成功读取插件的 dsh-task-center 手册。
4. 在会话B创建任务，会话A查看并接管，随后从B暂停、从A删除，通过。
5. 创建约0.7秒后触发的一次性任务：真实调度器执行 followup，投递记录与会话事件均持久化，通过。仅验证投递，不将模型业务执行成功作为本测试结论。
6. 通过 `dsh plugin remove` 卸载，重新启动后官方 Schedule 仍可用，插件工具与技能均不存在。
7. 最终打包文件重新安装并重复集成验证通过；测试插件再次卸载，测试进程关闭，3087不再监听。

## 限制

未对外部网络任务、实际交易或长时间持续运行进行验收。首次使用建议安排一个简单提醒验证你的日常会话工作流。后续已将源码移动到桌面，并通过 link: 关联到日常 web profile；未启动日常 DSH。此前安装包仅用于集成测试，现已删除。

## 本地源码关联修复

已补全 package.json 中三个直接使用的 DSH 依赖，采用 pnpm 11.22.0 和 pnpm-lock.yaml，删除 npm 锁文件及宿主路径解析补丁。pnpm test 15项通过，普通 Node 直接导入源码通过；通过 link: 关联桌面目录的真实 DSH 工具、转交与投递集成验证通过。
