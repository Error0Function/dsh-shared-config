# 发布 dsh-shared-config

分发物为 GitHub Release 的 `dsh-shared-config.tgz` 和 `SHA256SUMS`。源码仓库不依赖个人目录或 DSH checkout，npm 发布不在当前流程内。

## 首次公开

1. 在 GitHub 创建空的公开仓库，将其添加为当前本地仓库的 `origin`。本地开发和开源发布使用同一个仓库。
2. 确认源码、`lib/`、锁文件、许可证和 `.github/workflows/` 均已提交。不提交 `node_modules/`、`dist/`、共享配置文件或旧运行记录。
3. 推送默认分支，确认 Ubuntu 和 Windows 的 CI 都通过。工作流使用仓库内置 `GITHUB_TOKEN`，不需要额外 secret。

项目采用 MIT 许可证。若需要其他许可证，在首次公开前修改 `LICENSE` 和 `package.json` 的 `license`。

## 生成候选安装包

```sh
pnpm install --frozen-lockfile
pnpm run check
node scripts/release-metadata.mjs v0.1.2
```

最后一条命令对应当前 `package.json` 的版本。修改版本号时，同时修改该命令的 tag 参数；不一致会失败。产物位于 `dist/dsh-shared-config.tgz` 与 `dist/SHA256SUMS`，校验和基于最终 tarball 的字节计算。

类型、源码测试和打包测试都必须通过。安装包检查包含清单校验、干净消费者安装、公共 SDK 下的实际 bundle 冷启动和原生配置编辑。开发者额外修改 DSH 兼容版本时，应同步更新 peer/dev 依赖和 `engines.dsh`，并重新生成锁文件。

## 触发发布

维护者自行选择版本并更新 `package.json`。当前版本保留为 `0.1.2`；本次改造没有自动递增版本。

在已验证的提交上创建并推送对应 tag。此步骤会对外发布，不属于本地检查：

```sh
git tag v0.1.2
git push origin v0.1.2
```

Release 工作流先复用 Ubuntu/Windows 的 CI，再重新打包和验证。tag 必须等于 `v${package.json.version}`。若版本包含预发布后缀，例如 `0.1.3-alpha.1`，工作流创建 prerelease 且不会设置为 latest；稳定版使用普通 GitHub Release。

只有最终发布 job 获得 `contents: write`。它通过 GitHub CLI 创建 Release、生成 release notes 并上传 tarball 和 SHA-256 文件。若仓库或组织禁用了 GitHub Actions 的写权限，维护者需在 GitHub 设置中允许该 job 的 `contents: write`。

工作流不会覆盖已有 Release。发布失败时先查看 Actions 日志与对应 tag 的 Release 状态；修复后重新运行失败 job。若 Release 已存在，检查已上传文件后再决定如何处理，不重复推送 tag。

## 验证和撤回

从 Release 下载 tarball，核对 `SHA256SUMS`，在独立 DSH home 中执行 README 的安装命令，再用原生设置保存一项配置。核对共享 home 文件，并确认另一个使用相同 home 的 profile 可读到该覆盖。

CI 自动覆盖的是公共 SDK 下的 Loader 与编辑行为，不会启动完整 Desktop/Web 应用。发布维护者负责需要的完整客户端验收。

若发布后发现故障，停止推荐该版本，并让使用者安装上一份已验证 tarball。卸载本插件保留共享配置文件；不要通过删除用户共享文件来回退。
