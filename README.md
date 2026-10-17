# DSH 插件集合

为个人工作流定制的 DeepSeek Harness 桌面版插件集合。

## 插件

| 插件                                          | 功能                                                |
| --------------------------------------------- | --------------------------------------------------- |
| [Task Center](packages/task-center/README.md) | 持久化定时任务、时间规则预览与跨会话任务转交        |
| [飞书通道](packages/feishu/README.md)         | 飞书文字与确认卡片、长连接收事件和唯一 Session 订阅 |

当前适配桌面版 DSH `0.2.1-rc.2`，通过本地目录链接安装。

## 安装

在仓库根目录安装依赖并构建，然后关联所需插件的子目录。以 Task Center 为例：

```powershell
pnpm install --frozen-lockfile
pnpm build
$pluginPath = (Resolve-Path ./packages/task-center).Path
& "$env:LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add "link:$pluginPath"
```

从托盘退出 DSH 后重新打开，加载插件。更新源码后重新安装依赖、构建并重启 DSH。

各插件的使用方法、配置及行为边界见对应插件的 README。
