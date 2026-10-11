# 仓库约定

本仓库维护个人定制的 DeepSeek Harness 桌面版插件，采用 pnpm monorepo。文档和面向用户的说明使用中文，Git 提交标题与正文使用英文。

## 提交规范

使用 Conventional Commits，格式为：

```text
type(scope): English description
```

- `type` 使用小写：`feat`（功能）、`fix`（修复）、`docs`（文档）、`refactor`（重构）、`test`（测试）、`build`（构建）、`ci`（持续集成）、`chore`（维护）、`perf`（性能）、`style`（纯格式调整）、`revert`（回退）。
- 必须提供 `scope`：单个插件使用 `packages/` 下的目录名，如 `task-center`、`feishu`；仓库级或跨插件变更使用 `repo`。
- 描述使用英文，简短、具体，表达本次变更的结果；同一提交保持主题集中。
- 破坏性变更使用 `type(scope)!: 描述`，并在正文说明 `BREAKING CHANGE:`。
- 已推送的历史默认不改写；用户明确要求改写时，核对远端后使用带明确预期提交的 `--force-with-lease`，不使用无条件强推。

示例：

```text
feat(feishu): deliver card action events to sessions
fix(task-center): prevent duplicate delivery during session transfer
test(repo): adopt Vitest for plugin tests
docs(repo): simplify repository introduction and installation guide
```

## 开发与验证

- 使用 TypeScript；根目录工具依赖直接声明版本，插件之间统一的 DSH 依赖使用 catalog，插件专属依赖在子包直接声明版本。
- 普通工具和库使用 `^` 版本范围，DSH 相关开发依赖固定版本；提交锁文件以保证安装可复现。
- 使用 Vitest 测试 TypeScript 源码；保留真实桌面宿主集成检查，验证构建产物的加载和会话投递。
- 根据变更运行必要检查。涉及测试框架、构建或运行时代码时执行 `pnpm check`；涉及宿主行为时再运行对应插件的真实宿主检查。
- `pnpm install` 自动安装 Git 钩子；每次提交前运行 `pnpm check`。格式检查失败时先修正再提交，不跳过钩子。
- 通过本地插件目录链接安装到 DSH，入口指向构建产物。
- 根 README 负责仓库简介、插件索引和简短安装指引；插件功能、配置与行为边界写在各子包 README，不堆积通用命令教程或迁移过程。
- 不提交凭据、用户任务与会话数据、`node_modules` 或构建产物。
