# Release process

This document prepares a release; it does not authorize one. Publishing,
creating or moving a tag, pushing a release commit, and dispatching a release
workflow require explicit maintainer approval.

## Repository and publication gates

Before publishing a release:

1. Confirm `repository`, `homepage`, and `bugs` in `package.json` point to
   `https://github.com/lucasacoutinho/tiacore`. npm trusted publishing requires
   `repository.url` to match the publishing repository exactly.
2. Confirm private vulnerability reporting is enabled for the repository, as
   `SECURITY.md` describes.
3. Confirm the `npm` GitHub Actions environment exists and the package's trusted
   publisher on npmjs.com names this repository and `publish.yml`.

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
   pytest SDK sdist and wheel under `sdks/python/dist`. A fresh runner may
   resolve the declared Python build backend before producing those artifacts.

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

## Publication

tiacore publishes to the public npm registry as `@lucasacoutinho/tiacore`.
`publishConfig.access` is `public`.

Releases publish from the `Publish package` workflow
(`.github/workflows/publish.yml`). It runs `TIA_FRESH=1 npm run release:check`
and then `npm publish` with npm trusted publishing: the workflow exchanges a
GitHub Actions OIDC token for a short-lived publish credential, so no npm token
is stored in the repository, and npm attaches provenance automatically. Trusted
publishing requires npm 11.5.1 or newer; the workflow installs a current npm 11.

npm can only attach a trusted publisher to a package that already exists. The
first version is therefore published manually by a maintainer with two-factor
authentication, from a clean checkout of the candidate commit:

```sh
npm ci
TIA_FRESH=1 npm run release:check
npm publish
```

Then link the workflow once with npm 11.15 or newer:

```sh
npm trust github @lucasacoutinho/tiacore --file publish.yml \
  --repo lucasacoutinho/tiacore --allow-publish
```

Later releases dispatch the workflow. Renaming `publish.yml` requires updating
the trusted publisher.
