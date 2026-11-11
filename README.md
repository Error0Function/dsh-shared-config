---
description: Share plugin settings across DSH profiles that use the same home directory.
kind: package-bundle
---

# dsh-shared-config

English | [简体中文](README.zh.md)

Save plugin settings once and share them across DSH profiles. The plugin uses DSH's existing settings interface and writes overrides to `$DSH_HOME/cordis.patch.yml`. Each profile keeps its own installed plugins, enabled state, and inherited defaults.

## Install

Requires Node.js 24.9 or later. Install from npm into each profile that should share settings:

```sh
dsh plugin --profile web add dsh-shared-config
dsh plugin --profile headless add dsh-shared-config
```

To install a specific version, use `dsh-shared-config@0.1.0` as the package name. In Desktop, open **Plugins → Add plugin**, enter the package name, install it, and choose **Enable now**.

You can also download `dsh-shared-config.tgz` from [GitHub Releases](https://github.com/Error0Function/dsh-shared-config/releases). Release archives include `SHA256SUMS` for checksum verification. Install the downloaded archive into each profile:

```sh
dsh plugin --profile web add ./dsh-shared-config.tgz
dsh plugin --profile headless add ./dsh-shared-config.tgz
```

For a Desktop archive installation, enter the archive's absolute path in **Add plugin**. Use the same `DSH_HOME` for profiles that should share settings. Run the CLI commands with your profile name for other non-Desktop profiles. Restart DSH when it asks you to.

### Git source

To install the repository's default branch or a specific tag or commit, use a Git source URL:

```sh
dsh plugin --profile web add "git+https://github.com/Error0Function/dsh-shared-config.git"
dsh plugin --profile web add "git+https://github.com/Error0Function/dsh-shared-config.git#<tag-or-commit>"
```

Git installs run the package's `prepare` script to build `lib/` locally. pnpm may block this build until you approve it. The CLI passes pnpm's terminal interaction and diagnostics through; follow the instructions it prints. In the plugin manager UI, review the listed scripts and use the approval-and-retry action when offered. If the UI cannot identify a pending script, follow the pnpm diagnostic: add its exact `allowBuilds` key to the target profile's `pnpm-workspace.yaml`, then retry the same install. Keep approval in that profile and use the exact key rather than a global or wildcard rule.

### Remove

To remove the plugin from a profile:

```sh
dsh plugin --profile web remove dsh-shared-config
```

In Desktop, uninstall from **Plugins**. Removal leaves the shared settings file in place.

## Shared settings

Save settings through DSH as usual. The plugin shares configuration overrides for entries with the same Loader id, so an id must refer to the same plugin in every profile. Plugin installation and enablement remain separate for each profile.

Resetting an entry removes its shared override. Each profile then uses its own inherited settings. Profiles read changes through DSH's reload mechanism; this plugin does not synchronize settings across machines.

Before saving, the plugin evaluates `!!js` expressions and validates the resulting configuration. Writes use a file lock and atomic writes, preserving unrelated YAML content. The plugin rejects a save when a command-line overlay would override the requested change.

If reload after a save fails, the plugin restores the previous file and profile state. If that recovery also fails, the reported error includes both failures so you can inspect and repair the current state.

Warning: The shared file may contain credentials; keep it private.

<details>
<summary>Lock timeout</summary>

The file lock serializes saves from profiles and processes using the same shared file, so one save does not overwrite another's changes. Saving starts immediately when the lock is available. `lockWaitMs` is the maximum time a save waits for that lock; it defaults to `30000` milliseconds (30 seconds). If the wait expires, the save fails without acquiring the lock. It does not limit how long the save or reload takes after acquisition. To change the wait, add this entry to the profile's `cordis.patch.yml`:

```yaml
- id: shared-config-editor
  config:
    lockWaitMs: 30000
```

</details>

## Agent guidance

Installing the plugin adds a short guidance section to the root composition. `presetIds` selects the Agent presets that receive it and defaults to `['cordis']`. `cordis` is DSH's built-in Creator mode preset ID. To include a custom preset, add this entry to the profile's `cordis.patch.yml`:

```yaml
- id: shared-config-agent-prompt
  config:
    presetIds: ['cordis', 'my-preset']
```

Use `presetIds: []` to disable the guidance. Each ID must be a string containing a non-whitespace character, matching DSH's preset ID rules. IDs match the live Agent preset identity exactly, without trimming. The shared editor remains available to all presets.

When an Agent changes a plugin setting meant for multiple profiles using the same `$DSH_HOME`, the guidance directs it to the shared editor when the setting is supported. Installation, enablement, and profile-specific settings stay in the requested profile's local configuration. If the editor cannot handle a shared setting or is unavailable, the Agent keeps it local and continues.

## Compatibility

Requires DSH `0.2.2-rc.1` or later. Tested with DSH `0.2.2-rc.1`.

## Build from source

Use Node.js 24.9 or later and the pnpm version specified in `package.json`. In the source directory, run:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The compiled files are written to `lib/`.

## License

[MIT](LICENSE).
