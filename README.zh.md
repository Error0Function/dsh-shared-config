---
description: 在使用同一 home 目录的 DSH profile 之间共享插件设置。
kind: package-bundle
---

# dsh-shared-config

[English](README.md) | 简体中文

保存一次插件设置，多个 DSH profile 共用。插件沿用 DSH 现有的设置界面，将配置覆盖写入 `$DSH_HOME/cordis.patch.yml`。各 profile 保留自己的插件安装、启用状态和继承默认值。

## 安装

需要 Node.js 24.9 或以上版本。在每个需要共享设置的 profile 中从 npm 安装：

```sh
dsh plugin --profile web add dsh-shared-config
dsh plugin --profile headless add dsh-shared-config
```

如需安装指定版本，将包名替换为 `dsh-shared-config@0.1.0`。Desktop 用户请在应用中打开“插件 → 添加插件”，输入包名，安装后选择立即启用。

也可以从 [GitHub Releases](https://github.com/Error0Function/dsh-shared-config/releases) 下载 `dsh-shared-config.tgz`。发布包附带 `SHA256SUMS`，可用于验证校验和。在每个 profile 中安装下载的安装包：

```sh
dsh plugin --profile web add ./dsh-shared-config.tgz
dsh plugin --profile headless add ./dsh-shared-config.tgz
```

Desktop 安装本地安装包时，在“添加插件”中输入安装包的绝对路径。需要共享设置的 profile 应使用同一 `DSH_HOME`。其他非 Desktop profile 只需替换命令中的 profile 名称。DSH 要求重启时，请按提示操作。

### Git 源码

使用 Git 源地址安装仓库默认分支、指定 tag 或 commit：

```sh
dsh plugin --profile web add "git+https://github.com/Error0Function/dsh-shared-config.git"
dsh plugin --profile web add "git+https://github.com/Error0Function/dsh-shared-config.git#<tag-or-commit>"
```

Git 安装会执行包的 `prepare` 脚本，在本机构建 `lib/`。pnpm 可能在获得批准前阻止构建。CLI 会透传 pnpm 的终端交互和诊断，请按输出操作。插件管理界面提供批准并重试操作时，先审阅列出的脚本，再批准。如果界面无法识别待批准的脚本，请查看 pnpm 诊断。在目标 profile 的 `pnpm-workspace.yaml` 中加入诊断列出的精确 `allowBuilds` 键，再重试同一安装。授权保留在该 profile 内，使用精确键，不要改为全局或通配规则。

### 卸载

从某个 profile 卸载：

```sh
dsh plugin --profile web remove dsh-shared-config
```

Desktop 用户从应用的“插件”页面卸载。卸载会保留共享设置文件。

## 共享设置

照常在 DSH 中保存设置即可。插件按 Loader 条目 id 共享配置覆盖，因此同一 id 在各 profile 中必须指向同一个插件。插件安装和启用状态仍由各 profile 分别管理。

重置某个条目会移除该条目的共享覆盖。各 profile 随后使用各自的继承设置。其他 profile 通过 DSH 的重载机制读取变化；本插件不提供跨机器同步。

保存前，插件会求值 `!!js` 表达式并检查所得配置。写入使用文件锁和原子写入，并保留无关 YAML 内容。命令行 overlay 会覆盖本次修改时，插件拒绝保存。

写入后重载失败时，插件会恢复之前的文件和 profile 状态。如果恢复也失败，错误报告会同时包含重载和恢复错误，便于检查并修复当前状态。

警告：共享文件可能含有凭据，请妥善保管。

<details>
<summary>文件锁等待时间</summary>

文件锁让使用同一共享文件的 profile 和进程依次保存，避免覆盖彼此的修改。锁空闲时立即开始保存。`lockWaitMs` 是一次保存等待取得该锁的最长时间，默认为 `30000` 毫秒（30 秒）。等待超时后，本次保存失败，不会取得锁；取得锁后的保存和重载耗时不受该参数限制。在 profile 的 `cordis.patch.yml` 中加入下列条目即可修改等待时间：

```yaml
- id: shared-config-editor
  config:
    lockWaitMs: 30000
```

</details>

## Agent 提示

安装插件后，根组合会注册一段简短提示。`presetIds` 指定接收提示的 Agent preset，默认为 `['cordis']`。`cordis` 是 DSH 官方创造模式的 preset ID。在 profile 的 `cordis.patch.yml` 中加入下列条目即可加入自定义 preset：

```yaml
- id: shared-config-agent-prompt
  config:
    presetIds: ['cordis', 'my-preset']
```

设置 `presetIds: []` 可关闭提示。每个 ID 必须是包含非空白字符的字符串，与 DSH 的 preset ID 规则一致。ID 与 Agent 当前的 preset 身份精确匹配，不会去除首尾空白。共享编辑器仍可供所有 preset 使用。

插件设置需要在同一 `$DSH_HOME` 的多个 profile 之间共享时，提示会引导 Agent 使用共享编辑器。共享编辑器须支持该设置。安装、启用和 profile 专属设置仍保留在用户指定 profile 的本地配置中。共享编辑器不支持或暂时不可用时，Agent 使用本地配置继续完成任务。

## 兼容性

需要 DSH `0.2.2-rc.1` 或以上版本。已在 DSH `0.2.2-rc.1` 上测试。

## 从源码构建

使用 Node.js 24.9 或以上版本，以及 `package.json` 指定的 pnpm 版本。在源码目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
```

构建产物写入 `lib/`。

## 许可证

[MIT](LICENSE)。
