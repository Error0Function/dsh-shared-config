---
description: 为使用同一 DSH home 的多个 profile 共享原生插件配置。
kind: package-bundle
---

# dsh-shared-config

## 简介

通过 DSH 原生设置入口，将插件配置保存到共同的 `$DSH_HOME/cordis.patch.yml`。不同 profile 保留各自的安装、启用状态和继承默认值，共用用户配置覆盖。本插件替换原生配置编辑器，不增加客户端界面，也不负责启动或连接 Host。

## 目录

- [安装与卸载](#安装与卸载)
- [配置范围与保存规则](#配置范围与保存规则)
- [开发与验证](#开发与验证)
- [发布](#发布)
- [实现与限制](#实现与限制)

## 安装与卸载

兼容目标为 **DSH `0.2.2-alpha.2`**，要求 Node.js **24.9 或以上**。DSH 和 Cordis 依赖使用精确版本；其他版本需要先完成兼容验证。构建依赖来自公共 npm registry，不需要 DSH 源码仓库。

从本仓库的 GitHub Release 下载 `dsh-shared-config.tgz` 和 `SHA256SUMS`，核对 SHA-256 后，在文件所在目录安装：

```sh
dsh plugin --profile desktop add ./dsh-shared-config.tgz
dsh plugin --profile web add ./dsh-shared-config.tgz
dsh plugin --profile headless add ./dsh-shared-config.tgz
```

只对需要的 profile 执行安装命令。这些 profile 必须使用同一 `DSH_HOME`；未设置时，DSH 使用自己的默认 home。对运行中的 Host，按 DSH 返回的重启提示操作。Desktop 与浏览器连接同一 Host 时，只需在该 Host 的 profile 安装一次。

安装后，bundle 禁用 `config-editor` 并插入 `shared-config-editor`。在原生设置中保存配置后，共享 home 的 `cordis.patch.yml` 会出现对应条目。备份既有共享文件，再首次启用插件；安装过程不复制或删除各 profile 的旧配置。

卸载只移除 profile 中的插件和 bundle 层，共享配置文件保留：

```sh
dsh plugin --profile desktop remove dsh-shared-config
```

## 配置范围与保存规则

支持由原生 ConfigEditor 暴露的插件配置，包括以后安装的插件。配置按 Loader 条目 id 关联；不同 profile 中使用同一 id 的插件必须具有相同身份。插件不共享安装列表、插件私有文件、localStorage 或快捷键，也不注入压缩器默认值。

配置顺序由 DSH 决定：bundle 与 profile 配置、共享 home 覆盖、命令行 overlay。保存前会校验插件 Schema；若命令行 overlay 会覆盖本次修改，则拒绝保存。重置会移除对应共享配置覆盖，使当前 profile 回到它自己的继承值。

共享编辑使用文件锁和原子写入，保留无关 YAML 条目、注释、表达式和启用信息。保存后通过 DSH 原生重载路径应用；应用失败会尝试恢复文件和原配置。其他进程读取共享文件的时间由 DSH 的重载机制决定；插件不提供额外轮询或跨机器同步。

唯一可调参数为 `lockWaitMs`，默认 `30000` 毫秒。可在 profile 的 `cordis.patch.yml` 中设置：

```yaml
- id: shared-config-editor
  config:
    lockWaitMs: 30000
```

## 开发与验证

使用 `package.json` 声明的 pnpm 版本。安装和检查：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` 依次运行类型检查、行为测试、构建和安装包测试。构建输出 ESM Host 入口与 TypeScript 声明，不生成快捷键客户端 bundle。

安装包测试会检查文件清单，把 `.tgz` 安装到临时消费者目录，并使用精确版本的公共 DSH SDK 冷启动实际 bundle，执行配置保存、无效值拒绝、跨 profile 读取和重置。测试无需 API key，不访问真实的 DSH home。消费测试需要访问公共 registry，并需要系统 `tar`；Windows 和 GitHub Ubuntu runner 均提供该命令。

GitHub CI 在 push、pull request 和手动触发时，对 Ubuntu 和 Windows 执行同一检查。CI 不使用本机 SDK 链接，不安装到运行中的 profile。

## 发布

推荐分发 GitHub Release 中经过验证的 `.tgz`。发布流程由 `v*` tag 触发，要求 tag 严格等于 `v` 加 `package.json` 的版本号；带预发布后缀的版本会标为 GitHub prerelease。

完整步骤、权限和版本选择见 [发布说明](docs/RELEASING.md)。工作流不发布 npm 包，也不需要 npm token。

## 实现与限制

<details>
<summary>实现说明</summary>

[Bundle 补丁](cordis.patch.yml) 只替换配置编辑器。[共享编辑器](src/index.ts) 继承 DSH 原生 ConfigEditor，沿用现有设置消费者；[YAML 编辑](src/document.ts) 只修改目标条目的配置。依赖保留为外部包，使运行时使用 DSH 提供的 Cordis 与服务实例。

</details>

插件不产生模型可见消息或额外工具调用。配置本身的效果由对应插件负责。

共享文件可能包含凭据，不应放进公开仓库。配置条目必须能由当前 profile 的原生编辑器寻址；不同 profile 的同名 id 不能指向不同插件。移除共享覆盖会影响使用该覆盖的其他 profile；它们各自的继承默认值可能不同。

## 许可证

[MIT](LICENSE)。
