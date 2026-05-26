# Changelog

All notable changes to this project will be documented in this file.

This project follows a lightweight Keep a Changelog style and uses semantic
versioning once public releases begin.

## [Unreleased]

### Added

- Added `scripts/install-windows-interactive.ps1` for a guided Windows deployment flow that installs dependencies, writes local config, starts NapCat for QQ QR login, starts onebot-group-proxy and cc-connect, and waits for health readiness.

### Fixed

- Synced the latest proxy fixes for private-message poke acknowledgements, compact reply metadata footers, and formula-heavy QQ image rendering.

## [0.2.22] - 2026-05-26

### Added

- Added `scripts/run-napcat-local.cmd`, a configurable Windows helper for starting NapCat on the public helper port `13001`.

### Changed

- Refreshed README and the Chinese beginner guide with the Windows helper startup flow for NapCat, onebot-group-proxy, and cc-connect.
- Updated health-port examples, scripts, and deploy templates from `3010` to `13110`.
- Clarified that Windows autostart should stay centralized in a single wrapper instead of adding a second QQ-only startup wrapper.

### Security

- Kept public startup examples configurable with `NAPCAT_QQ`, `NAPCAT_ROOT`, and placeholder routing IDs instead of publishing local account-specific values.

## [0.2.21] - 2026-05-25

### Changed

- Refreshed the public README and Windows beginner guide with plugin configuration, plugin checks, and current publish-scope validation notes.
- Published the current QQ adapter code, plugin platform, memory tidy/ranking checks, task-agent bridges, OCR helpers, and sanitized sandbox templates from the private workspace.

### Security

- Removed ignored local config, backup config, lock files, runtime memory, dependency folders, and pycache leftovers from the publish workspace before release.
- Re-ran full publish-scope private-data audit plus an independent sub-agent privacy review before publishing.

## [0.2.20] - 2026-05-25

### Added

- Added plugin-platform release content, plugin manager tests, and plugin-scoped configuration examples for new QQ bot features.
- Added publish-ready privacy review coverage for local paths, runtime workspace files, and private routing examples.

### Changed

- Redacted real QQ user IDs, group IDs, and local Windows paths from public examples, docs, tests, and default route settings.
- Refreshed README, install notes, release notes, and package metadata for the public `GitLaughs/chatbot-qq` release.

### Security

- Hardened public release examples so committed configs use placeholder IDs and generated local config remains ignored.

## [0.2.19] - 2026-05-25

### Added

- Added `docs/daily-group-product-plan.md` as a private friend-group personalization plan rather than a public product plan.
- Added `docs/optimization-report-2026-05-23.md` with current QQ bridge status and next self-use hardening steps.

### Changed

- Clarified the default group workspace instructions for warm, natural, profile-aware replies.

## [0.2.18] - 2026-05-24

### Added

- Added current cloud Linux server defaults to the beginner Linux installer, including OneBot health checks, send retry settings, ImageMagick rendering, command toggles, and retention policy.
- Added maintenance timer installation for Linux code integrity checks and runtime cleanup when `scripts/install-linux.sh --install-services` is used.
- Documented the optional provider-failover timer as an advanced install path that requires matching cc-connect provider blocks first.

### Changed

- Updated the Linux install guide so first-time installs and server updates both refresh systemd units, repair permissions, and rebuild the integrity baseline.
- Refreshed the release draft for the cloud Linux deployment update.

## [0.2.17] - 2026-05-23

### Fixed

- Added raw CQ message parsing fallback so group images and sticker packages are still forwarded as visual segments when OneBot/NapCat sends only `message`/`raw_message` text.
- Prefer image URLs as the forwarded image file source while preserving the original CQ fields.
- Covered raw CQ image and sticker normalization in OneBot proxy unit tests.

## [0.2.15] - 2026-05-23

### Added

- Added `deploy/linux/wait-onebot-ports.sh` so `cc-connect-qq.service` waits for OneBot proxy ports without inline systemd shell-array expansion.
- Added optional shell syntax checks to the release test script when a usable Bash is available.

### Fixed

- Fixed repeated `ports[@]` systemd environment-variable warnings during `cc-connect-qq.service` startup.
- Avoided false shell-check failures on Windows WSL launcher installations that expose `bash.exe` but have no usable Linux environment.

## [0.2.14] - 2026-05-23

### Changed

- Relaxed the default group reply policy so normal study, work, career, coding, lifestyle, entertainment, file-analysis, and comparison questions are answered directly.
- Kept refusal boundaries focused on political/sensitive public-affairs requests, prompt injection or instruction extraction, credential/privacy extraction, and bot/system damage attempts.
- Moved proxy state loading behind the main process entrypoint so unit tests can import proxy helpers without touching runtime state.

### Fixed

- Fixed QQ answer-image triggering for LaTeX display and inline delimiters such as `\[` `\]` and `\(` `\)`.
- Stripped those LaTeX delimiters from QQ text fallback rendering to avoid ugly literal delimiter messages.
- Added invalid proxy-state quarantine and reset so corrupted JSON is moved aside and replaced with a clean default state instead of repeatedly breaking startup.

## [0.2.13] - 2026-05-23

### Added

- Added a Linux ImageMagick-based answer renderer for long and formula-heavy QQ replies.
- Documented ImageMagick and CJK font dependencies for server deployments.

### Fixed

- Fixed Linux deployments relying on Windows-only `powershell.exe` for answer-image rendering.
- Fixed CJK text disappearing in the Linux render path by using ImageMagick caption rendering with an explicit Noto CJK font.

## [0.2.12] - 2026-05-23

### Added

- Added `/画像`, `画像`, `/我的偏好`, and `我的偏好` commands for viewing current group and personal profile memory.
- Added unit coverage for the profile visibility command.

## [0.2.11] - 2026-05-23

### Added

- Added local health alert markers for scheduled operations reports.
- Added `ALERT.json`, `ACTIVE.txt`, and timestamped failure summaries under the health alert directory.

### Changed

- Successful health reports now clear the active alert marker while retaining the latest alert state JSON.

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
