# Security policy

## Supported versions

Until the first publication, the current development branch is the only
supported version. After publication, security fixes will target the latest
minor release in the `0.x` line; this table will be updated when that policy
changes.

| Version         | Supported |
| --------------- | --------- |
| Unreleased      | Yes       |
| Older snapshots | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the canonical
repository's private vulnerability-reporting channel once that repository is
configured. Before the public repository exists, report through the same
private maintainer channel by which you received the source.

Include the affected version or commit, runner and operating system, a minimal
reproduction, impact, and any suggested mitigation. Please avoid accessing
data that is not yours and do not publish exploit details before a fix and
coordinated disclosure are available.

The canonical repository URL and a tested private reporting path are release
gates documented in `docs/releasing.md`.
