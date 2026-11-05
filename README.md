---
description: Share plugin settings across DSH profiles that use the same home directory.
kind: package-bundle
---

# dsh-shared-config

English | [简体中文](README.zh.md)

Save plugin settings once and share them across DSH profiles. The plugin uses DSH's existing settings interface and writes overrides to `$DSH_HOME/cordis.patch.yml`. Each profile keeps its own installed plugins, enabled state, and inherited defaults.

## Install

Requires Node.js 24.9 or later. Download `dsh-shared-config.tgz` from [GitHub Releases](https://github.com/Error0Function/dsh-shared-config/releases), or [build it from source](#development). Release archives include `SHA256SUMS` for checksum verification.

Install into each profile that should share settings:

```sh
dsh plugin --profile desktop add ./dsh-shared-config.tgz
dsh plugin --profile web add ./dsh-shared-config.tgz
```

Use the same `DSH_HOME` for these profiles. Other profiles, such as `headless`, use the same command with their profile name. Follow any restart instructions DSH returns.

To remove the plugin from a profile:

```sh
dsh plugin --profile desktop remove dsh-shared-config
```

Removal leaves the shared settings file in place.

## Shared settings

Save settings through DSH as usual. The plugin shares configuration overrides for entries with the same Loader id, so an id must refer to the same plugin in every profile. Plugin installation and enablement remain separate for each profile.

Resetting an entry removes its shared override. Each profile then uses its own inherited settings. Profiles read changes through DSH's reload mechanism; this plugin does not synchronize settings across machines.

Saves validate the plugin's configuration, preserve unrelated YAML content, and use a file lock with atomic writes. A command-line overlay that overrides the requested change prevents the save. The shared file may contain credentials; keep it private.

<details>
<summary>Lock timeout</summary>

`lockWaitMs` defaults to `30000` milliseconds. To change it, add this entry to the profile's `cordis.patch.yml`:

```yaml
- id: shared-config-editor
  config:
    lockWaitMs: 30000
```

</details>

## Compatibility

The installation range is `>=0.2.2-alpha.2 <0.3.0-0`, including later 0.2 prereleases. Tests currently run against DSH `0.2.2-alpha.2`. Later releases within the range can install without a plugin version bump; changes to the DSH APIs used here may still require an update.

## Development

Use the pnpm version declared in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` runs type checking, tests, and a build, then installs the archive in a temporary project and exercises configuration saves and resets with the pinned DSH SDK. It produces `dist/dsh-shared-config.tgz`. Package tests require registry access and `tar`.

GitHub Actions runs the checks on Ubuntu and Windows. See the [release process](docs/RELEASING.md) for publishing an archive.

## License

[MIT](LICENSE).
