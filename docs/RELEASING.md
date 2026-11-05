# Release dsh-shared-config

GitHub Releases distributes `dsh-shared-config.tgz` and `SHA256SUMS`. The workflow does not publish to npm.

## Prepare

Choose a version in `package.json`, then run:

```sh
pnpm install --frozen-lockfile
pnpm run check
node scripts/release-metadata.mjs v0.1.2
```

Use the tag for the chosen version in the last command. It rejects a tag that differs from `v${package.json.version}` and computes the checksum of the final archive.

Keep development SDK versions pinned so the test baseline is reproducible. Installation ranges in `engines.dsh` and `peerDependencies` are separate from this baseline. Change them when API compatibility requires it, rather than for each DSH release. After updating the baseline, refresh the lockfile and run the checks again.

## Publish

Commit the source, build output, and lockfile. Push the default branch and confirm that CI passes on Ubuntu and Windows. Create and push a tag on the checked commit:

```sh
git tag v0.1.2
git push origin v0.1.2
```

The `v*` tag starts the release workflow. It reruns CI, builds and tests the archive, verifies the tag, and creates a GitHub Release with the archive and checksum file. Versions with a prerelease suffix produce a GitHub prerelease. The release job uses the repository's `GITHUB_TOKEN` with `contents: write`.

If a job fails, inspect its log and the Release status before rerunning it. The workflow does not overwrite an existing Release.

## Verify a release

Download the archive, verify its checksum, and install it in a separate DSH home using the README instructions. Save a setting and check that another profile using the same home reads it. Automated package tests cover the Loader and editor behavior; complete Desktop/Web acceptance requires running those applications.

If a release fails in use, direct users to the previous working archive. Removing the plugin preserves the shared configuration file.
