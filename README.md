# DSH 插件集合

按个人工作流定制并持续维护的 DeepSeek Harness 桌面版插件，使用 pnpm workspace 管理。文档使用中文，目前通过本地目录安装，不发布到 npm。

## 插件

| 目录                   | 包名                      | 功能                                               |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `packages/task-center` | `@cosine/dsh-task-center` | 全局定时任务、时间规则预览、跨会话转交与持久化投递 |

当前仅适配桌面版 DSH `0.2.0-rc.2`，不兼容旧网页版。飞书通道尚未实现，后续作为独立插件加入。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm check
```

根目录统一维护 TypeScript、tsdown、Oxlint、Oxfmt 与 Node 类型。DSH 开发依赖版本集中在 `pnpm-workspace.yaml` 的 catalog 中，与目标桌面宿主对齐；每个插件在自己的 `package.json` 声明实际依赖。插件专属运行时依赖放在子包中。

`packageManager` 固定 pnpm 版本。`engines.node` 声明 Node >=24，`devEngines.runtime` 让 pnpm 为项目下载并使用 Node 24；锁文件固定实际安装版本。通过 pnpm 启动的项目脚本使用项目运行时，直接在终端执行 `node` 仍使用终端原有版本，不覆盖系统 Node。

| 命令             | 用途                                            |
| ---------------- | ----------------------------------------------- |
| `pnpm build`     | 构建所有插件的 JavaScript、类型声明和 sourcemap |
| `pnpm dev`       | 持续构建插件；DSH 仍需重新加载才能使用变更      |
| `pnpm typecheck` | 独立进行 TypeScript 类型检查                    |
| `pnpm lint`      | Oxlint 检查，包含类型感知规则                   |
| `pnpm fmt`       | Oxfmt 格式化                                    |
| `pnpm test`      | 先构建，再运行插件测试                          |
| `pnpm check`     | 类型、lint、格式与测试完整检查                  |

## 安装到桌面版 DSH

先安装依赖并构建，再关联具体插件目录，不能把 monorepo 根目录作为插件目录。

```powershell
pnpm install --frozen-lockfile
pnpm build
& "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add link:C:/Users/cosine/Desktop/dsh-plugins/packages/task-center
```

路径按实际克隆位置调整。插件的 `main`、`exports` 指向 `dist/index.js`，DSH 加载构建产物；`dist` 和 `node_modules` 不提交到 Git。更新源码或拉取提交后重新安装依赖、构建，并在合适的时候从托盘退出 DSH 后重新打开。关闭窗口通常只是隐藏窗口，不等于重启后台宿主。

Task Center 的包名、插件 ID 和数据目录均延续旧项目。任务数据仍在 `$DSH_HOME/storages/cosine-task-center/tasks.json`，默认是 `~/.dsh/storages/cosine-task-center/tasks.json`；迁移仓库不迁移或重建任务数据。原桌面 `dsh-task-center` 目录可暂留用于回退，但今后开发应在本仓库进行。

详细功能、真实宿主验证方法与可靠性边界见 [Task Center 说明](packages/task-center/README.md) 和 [验证记录](packages/task-center/VALIDATION.md)。
