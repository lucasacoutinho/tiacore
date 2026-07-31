# Security policy

## Supported versions

Security fixes target the latest minor release in the `1.x` line. Development
snapshots and older major versions are not supported.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the canonical
repository's private vulnerability-reporting channel once that repository is
configured. Before the public repository exists, report through the same private
maintainer channel by which you received the source.

Include the affected version or commit, runner and operating system, a minimal
reproduction, impact, and any suggested mitigation. Please avoid accessing data
that is not yours and do not publish exploit details before a fix and
coordinated disclosure are available.

The canonical repository URL and a tested private reporting path are release
gates documented in `docs/releasing.md`.
