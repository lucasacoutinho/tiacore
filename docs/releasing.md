# Release process

This document prepares a release; it does not authorize one. Publishing,
creating or moving a tag, pushing a release commit, and dispatching a release
workflow require explicit maintainer approval.

## Repository and publication gates

Before publishing a proprietary release:

1. Confirm the canonical repository and its package metadata.
2. Confirm `repository`, `homepage`, and `bugs` metadata still point to it.
3. Enable and test private vulnerability reporting, then replace the temporary
   instructions in `SECURITY.md` with its exact URL.
4. Configure an access-controlled npm-compatible registry. The package remains
   `UNLICENSED`; package access does not grant a software license.
5. Confirm that release-candidate artifacts and registry packages remain
   restricted to authorized users.

Preparing and committing a candidate does not satisfy or bypass these external
publication gates.

## Candidate checklist

1. Choose the version and move the relevant `Unreleased` changelog entries under
   a dated version heading.
2. Start from a clean checkout of the exact candidate commit.
3. Run:

   ```sh
   npm ci
   TIA_FRESH=1 npm run release:check
   ```

   This requires `uv`; the gate runs the Python conformance suite and builds the
   pytest SDK sdist and wheel offline under `sdks/python/dist`.

4. Require the full CI, compatibility, cross-platform, shard/aggregate, and
   non-publishing release-candidate workflows at that exact commit. This
   includes native Node and Bun runs on Linux, Windows, and macOS plus the
   browser-installed Playwright job.
5. Inspect `npm pack --dry-run`, install the generated tarball in the real
   package-install fixture, and inspect the Python sdist and wheel.
6. Review `npm audit --omit=dev`, Publint, and Are The Types Wrong output.
7. Optionally compare `npm run benchmark:parallel`; a regression needs
   investigation but benchmark variance alone does not override correctness.
8. Verify the candidate has no `.tia`, coverage, execution logs, credentials,
   test fixtures, or development-only files in its tarball.

## Private publication

Publication is provider-neutral. Set `TIA_REGISTRY_URL` to an access-controlled
npm-compatible registry and expose its credential as `NODE_AUTH_TOKEN`:

```sh
TIA_REGISTRY_URL=https://packages.example.test/npm/ \
NODE_AUTH_TOKEN=... \
npm run publish:private
```

The command creates an ephemeral npm configuration, always requests restricted
access, and refuses the public npm registry. `--dry-run` verifies the package
without requiring a token. The GitHub Actions workflow is one deployment
adapter; GitLab, Artifactory, Verdaccio, and other npm-compatible registries can
invoke the same package command.

Public registry publication is not part of the proprietary release process.
Changing that policy requires separate approval, a deliberate license and
package-metadata update, and fresh release verification.
