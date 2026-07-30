# Release process

This document prepares a release; it does not authorize one. Publishing,
creating or moving a tag, pushing a release commit, and dispatching a release
workflow require explicit maintainer approval.

## One-time repository gates

Before the first proprietary release:

1. Create or select the canonical repository.
2. Add `repository`, `homepage`, and `bugs` metadata to `package.json`.
3. Enable and test private vulnerability reporting, then replace the temporary
   instructions in `SECURITY.md` with its exact URL.
4. Keep registry publishing disabled while tiajs is proprietary. The root
   package is marked `private` and `UNLICENSED` on purpose.
5. Confirm that release-candidate artifacts remain restricted to authorized
   users and are not uploaded to a public package registry.

Do not invent repository metadata before those choices exist.

## Candidate checklist

1. Choose the version and move the relevant `Unreleased` changelog entries
   under a dated version heading.
2. Start from a clean checkout of the exact candidate commit.
3. Run:

   ```sh
   npm ci
   TIA_FRESH=1 npm run release:check
   ```

4. Require the full CI, compatibility, cross-platform, shard/aggregate, and
   non-publishing release-candidate workflows at that exact commit.
5. Inspect `npm pack --dry-run` and install the generated tarball in the real
   package-install fixture.
6. Review `npm audit --omit=dev`, Publint, and Are The Types Wrong output.
7. Optionally compare `npm run benchmark:parallel`; a regression needs
   investigation but benchmark variance alone does not override correctness.
8. Verify the candidate has no `.tia`, coverage, execution logs, credentials,
   test fixtures, or development-only files in its tarball.

## Publication policy

Public registry publication is not part of the proprietary release process.
Changing that policy requires separate approval, a deliberate license and
package-metadata update, and a fresh release verification.
