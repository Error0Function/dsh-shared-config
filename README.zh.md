---
description: 在使用同一 home 目录的 DSH profile 之间共享插件设置。
kind: package-bundle
---

# dsh-shared-config

[English](README.md) | 简体中文

保存一次插件设置，多个 DSH profile 共用。插件沿用 DSH 现有的设置界面，将配置覆盖写入 `$DSH_HOME/cordis.patch.yml`。各 profile 保留自己的插件安装、启用状态和继承默认值。

## 安装

需要 Node.js 24.9 或以上版本。从 [GitHub Releases](https://github.com/Error0Function/dsh-shared-config/releases) 下载 `dsh-shared-config.tgz`，或[从源码构建](#开发)。Release 安装包附带 `SHA256SUMS`，可用于核对校验和。

在每个需要共享设置的 profile 中安装：

```sh
dsh plugin --profile desktop add ./dsh-shared-config.tgz
dsh plugin --profile web add ./dsh-shared-config.tgz
```

这些 profile 需要使用同一 `DSH_HOME`。其他 profile（如 `headless`）只需替换命令中的 profile 名称。如果 DSH 提示重启，按提示操作。

从某个 profile 卸载：

```sh
dsh plugin --profile desktop remove dsh-shared-config
```

卸载会保留共享设置文件。

## 共享设置

照常在 DSH 中保存设置即可。插件按 Loader 条目 id 共享配置覆盖，因此同一 id 在各 profile 中必须指向同一个插件。插件安装和启用状态仍由各 profile 分别管理。

重置某个条目会移除它的共享覆盖，各 profile 随后使用各自的继承设置。其他 profile 通过 DSH 的重载机制读取变化；本插件不提供跨机器同步。

保存时会校验插件配置，保留无关 YAML 内容，并使用文件锁和原子写入。如果命令行 overlay 会覆盖本次修改，保存会被拒绝。共享文件可能含有凭据，请妥善保管。

<details>
<summary>文件锁等待时间</summary>

`lockWaitMs` 默认为 `30000` 毫秒。在 profile 的 `cordis.patch.yml` 中添加以下条目即可修改：

```yaml
- id: shared-config-editor
  config:
    lockWaitMs: 30000
```

</details>

## 兼容性

允许安装的范围为 `>=0.2.2-alpha.2 <0.3.0-0`，包含后续 0.2 预发布版本。测试目前使用 DSH `0.2.2-alpha.2`。范围内的后续版本无需仅为放行安装而更新插件版本；如果 DSH 改动了插件使用的 API，仍可能需要适配。

## 开发

使用 `package.json` 声明的 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` 执行类型检查、测试和构建，再将安装包安装到临时项目中，使用固定版本的 DSH SDK 测试配置保存与重置。产物为 `dist/dsh-shared-config.tgz`。安装包测试需要访问 registry，并使用 `tar`。

GitHub Actions 在 Ubuntu 和 Windows 上运行检查。发布安装包的步骤见[发布流程](docs/RELEASING.md)。

## 许可证

[MIT](LICENSE)。
