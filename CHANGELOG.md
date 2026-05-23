# Changelog

All notable changes to this project will be documented in this file.

This project follows a lightweight Keep a Changelog style and uses semantic
versioning once public releases begin.

## [Unreleased]

## [0.2.10] - 2026-05-23

### Changed

- Operations health reports now refresh server-side integrity and permission checks before reading status files.
- Permission audits run with repair enabled during health report refresh so minor permission drift is corrected before reporting.

## [0.2.9] - 2026-05-23

### Added

- Added Linux permission audit and repair for deployed code and config paths.
- Added permission audit status to the operations health report and server check summary.

### Changed

- Deployment now tightens code/config permissions after extracting Windows-built archives.
- Operations reports now fail when permission audit status is missing or reports writable critical paths.

## [0.2.8] - 2026-05-23

### Added

- Added machine-readable Linux integrity status at `/var/lib/chatbot-qq-integrity/status.json`.
- Added integrity status to the operations health report and server check summary.

### Changed

- Operations reports now fail when the integrity check reports drift or the status file is missing.

## [0.2.7] - 2026-05-23

### Added

- Added scheduled daily health report installation and retention support.
- Added health report JSON output files with `LATEST.json` for the latest report.

### Changed

- Redacted QQ numeric identifiers from health report output by default.
- Updated server checks to summarize the latest health report instead of printing the full JSON by default.

## [0.2.6] - 2026-05-23

### Added

- Added a machine-readable operations report script that summarizes server services, timers, proxy health, metrics preview, recent maintenance logs, and local backup status.
- Documented the operations report command in server deployment notes.

## [0.2.5] - 2026-05-23

### Added

- Added a local backup health checker that validates backup freshness, archive existence, byte count, SHA256, and Windows scheduled task state.
- Documented the backup health check in server deployment notes.

### Changed

- Updated server checks to run the backup health checker instead of only printing raw backup status JSON.

## [0.2.4] - 2026-05-23

### Added

- Added a Prometheus-style `/metrics` endpoint for QQ proxy health counters.
- Added `LATEST.json` backup status output for local server backup runs.
- Added local backup status output to the server check script.

### Fixed

- Limited cleanup log pruning to top-level QQ log files under `/var/log` to avoid sandbox permission noise from unrelated system log directories.

## [0.2.3] - 2026-05-23

### Added

- Added a dedicated OneBot proxy file-archive module for group upload handling.
- Added file-processing counters to the proxy health snapshot.
- Added unit coverage for group upload download requests and text-file archive extraction.

### Changed

- Moved group file save, sidecar archive, extracted text, and archive notice logic out of the main proxy entrypoint.

## [0.2.2] - 2026-05-23

### Added

- Added reusable OneBot proxy command, health, and persistent-state modules.
- Added unit checks for @-only group routing and protected mode switching.
- Added Linux integrity-check and cleanup timers for deployed QQ runtime files.
- Added Windows daily server backup, restore, and dry-run restore scripts.

### Changed

- Changed the second example group to @-only routing and removed its passive listen port.
- Updated cc-connect QQ systemd startup to wait for ports from `ONEBOT_PROXY_PORTS`.
- Updated public deployment notes and examples for multi-private-user routing.

### Fixed

- Silenced cc-connect idle/session rollover status messages at the proxy layer.
- Improved group file-upload handling so uploads are archived by the proxy instead of being treated as ordinary chat prompts.
- Added outbound retry tracking for OneBot send actions.

### Security

- Hardened QQ systemd units with read-only system paths, reduced capabilities, kernel/control-group protections, and restricted address families.
- Added log masking for numeric QQ identifiers in proxy logs.
- Kept release examples sanitized with placeholder IDs only.

## [0.2.1] - 2026-05-23

### Fixed

- Added `go.sum` so GitHub Actions can run Go validation without missing module checksum annotations.

## [0.2.0] - 2026-05-23

### Added

- Windows beginner installer for NapCat / OneBot cc-connect setup.
- Linux beginner installer for isolated systemd deployment.
- Chinese Windows and Linux installation guides.
- GitHub release configuration, issue templates, pull request template, badges, and public repository metadata.
- Public documentation keywords for QQ bot, NapCat, OneBot, cc-connect, group workspace, private chat routing, `/dream`, and image generation workflows.

### Changed

- README now follows a more GitHub-friendly structure with badges, quick start, requirements, architecture context, and security boundaries.
- Public config examples now use placeholder group and private user IDs.
- Deployment packaging excludes local group workspaces and private user workspaces.

### Security

- Release validation scans private user IDs in addition to group IDs and placeholder keys.

## [0.1.0] - 2026-05-23

### Added

- Initial QQ adapter workspace for cc-connect.
- NapCat / OneBot v11 route with per-group proxying, @ routing, passive listen gating, and reply routing.
- Optional `/dream` workspace maintenance command for group workspaces.
- Optional QQ image generation helper for `/画图`, `/生图`, and `/img`.
- Official QQ Bot Go adapter experiment for gateway, token, and message forwarding.
- Windows local start/check scripts and Linux systemd deployment templates.
- Server deployment notes that keep QQ cc-connect state isolated from existing Feishu deployments.
- Release validation script and GitHub Actions CI.

### Security

- Local logs, QR codes, NapCat binaries, backups, sandbox workspaces, member files, and chat memories are ignored by git.
- Public examples use placeholders for QQ group IDs, tokens, app IDs, and app secrets.
