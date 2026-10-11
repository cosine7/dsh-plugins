# DSH Task Center

为 DeepSeek Harness 增加通用时间规则与跨会话任务管理。包名 `@cosine/dsh-task-center`，插件版本 `0.3.0`，当前适配官方桌面版 DSH `0.2.0-rc.2`。后续以桌面版为适配目标。独立于官方 `@deepseek-ai/dsh-schedule`，不修改官方文件。

## 能力

- 一次性、固定间隔、五字段 cron、指定星期内多个窗口各自按间隔执行。
- 显式 IANA 时区、窗口起止日期及排除日期、触发时间预览。
- 全局持久化任务；任意活动根会话管理，每个任务只有一个可转交的执行会话。
- 暂停、恢复、删除；revision 防止并发覆盖；最近 500 条投递记录。
- 随插件注册模型操作手册，无需复制到用户技能目录。

## 本地开发与安装

本插件位于 monorepo 的 `packages/task-center`。在仓库根目录安装依赖并构建，然后关联具体插件目录：

```powershell
pnpm install --frozen-lockfile
pnpm check
& "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add link:C:/Users/cosine/Desktop/dsh-plugins/packages/task-center
```

路径按实际位置调整。源码为 TypeScript，由 tsdown 构建到 `dist`；DSH 通过包入口加载 `dist/index.js`。修改后执行 `pnpm build`，或用 `pnpm dev` 持续构建，然后在合适的时候从托盘退出 DSH 并重新打开。关闭窗口通常仅隐藏窗口，不等于重启后台宿主。

解除关联可执行：

```powershell
& "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop remove @cosine/dsh-task-center
```

解除关联保留源码与任务数据。插件不注册系统后台服务，随 DSH 插件生命周期启动和卸载；Windows 登录后是否启动 DSH 由桌面应用自身设置决定。当前仅支持桌面版，不再兼容旧网页版。

## 使用

向模型说：

- “每周一到周五，上午9:31至11:30、下午13:01至15:00，每20分钟检查项目状态。”
- “每个月最后一天晚上8点整理总结，上海时区。”
- “列出任务中心全部任务，把周报任务转到当前会话。”
- “暂停这个任务 / 改成每30分钟 / 删除这个任务。”

详见 [模型操作手册](skills/dsh-task-center/SKILL.md)。工具以 `task_center_` 开头，官方 `schedule_*` 保持原行为。没有额外网页管理面板。

## 会话与逾期语义

仅向活动根 Agent 投递，不主动恢复历史会话。会话在侧边栏可见不代表 Agent 活动。会话忙时参考官方 Schedule 等待空闲；周期规则仅投递最近一次逾期事件，一次性任务保留直到可投递。DSH 没运行期间不执行；恢复后也按此逾期策略处理。暂停后主动恢复则从现在重新计算。

切换只影响尚未投递的工作；已交给旧会话的工作不撤回。每个目标会话通过 runMaintenance 接入，followup 发起处理。不存在“投递成功=业务完成”的保证。

## 数据与可靠性

本次工程迁移保留包名、插件 ID、存储格式与路径，不修改任务 ID、revision 或会话绑定。任务保存在 `$DSH_HOME/storages/cosine-task-center/tasks.json`（DSH_HOME 默认 `~/.dsh`）。卸载保留任务数据，重新安装可继续使用；需要彻底删除时，在所有 DSH 实例停止后删除此插件专属目录。不可把它与官方 storages 总目录混淆。

独占 owner.lock 防止两个 DSH 实例同时调度同一任务库。原子替换 JSON 并 fsync 文件；损坏文件不重置覆盖。投递前记录意图，进程异常退出后对不确定任务暂停，需人工检查目标会话再恢复。跨任务库与 DSH 会话存储没有分布式事务，不声称严格 exactly-once。记录最多1000任务和500条投递历史。

## 边界

- 仅适配桌面版 DSH 0.2.0-rc.2，升级后重新验证。
- 无自动交易日历、无后台会话恢复、无自定义脚本调度。
- windows 仅支持同一天窗口，搜索范围最多3661天；夏令时空缺跳过、重复时间取较早一次。
- 运行时依赖 cron-parser 5.10.2 / luxon 3.7.2；DSH 共享依赖声明为 peerDependencies，并通过 devDependencies 引用根 catalog 供开发使用，版本对齐桌面宿主 0.2.0-rc.2。构建时保持外部依赖，不内嵌宿主组件，也不安装 DSH 启动器。

## 桌面版 0.2.0-rc.2 兼容性

已接入宿主的 `workspace/session-activity`，以 `schedule` 类型报告未完成且启用的任务，使桌面版退出检查和会话归档检查识别本插件的任务。用户选择归档并停止工作时，通过 `workspace/session-stop` 持久化暂停该会话的任务并提升 revision。取消归档操作不会暂停；解除归档后不会自动恢复已暂停任务，需手动恢复。已投递的消息不会撤回。

会话格式 v4 不再接受通用 `source.kind = "plugin"`；任务消息使用插件自己的 `cosine-task-center` 来源。无工作目录的活动会话省略 `cwd` 字段，满足新版工具输出的无损 JSON 校验。

升级前因来源错误自动暂停的任务仍保留。重启 DSH 后，在目标会话中让模型列出任务、检查目标会话并恢复；恢复会从当前时间重新计算，不补跑暂停期间的任务。

可以使用桌面版实际打包的宿主组件运行隔离集成检查（临时 DSH_HOME，无模型请求）。Electron Node 模式支持读取 app.asar 内的组件；普通 Node 无法读取这些虚拟路径：

先在仓库根执行 `pnpm build`，然后进入本插件目录执行：

```powershell
$previousMode = $env:ELECTRON_RUN_AS_NODE
$previousModules = $env:DSH_HOST_MODULES
try {
  $env:DSH_HOST_MODULES = "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules"
  $env:ELECTRON_RUN_AS_NODE = '1'
  & "$env:LOCALAPPDATA/Programs/DeepSeek Harness/DeepSeek Harness.exe" --expose-internals scripts/verify-host.mjs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw '宿主集成验证失败' }
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousMode
  $env:DSH_HOST_MODULES = $previousModules
}
```

## 本地时间显示修复

once/interval 支持可选 timezone；缺省保留输入的时区偏移，内部 at/anchor 仍为 UTC。无 timezone 的历史任务按宿主本地时区展示。此调整不改变触发时刻。
