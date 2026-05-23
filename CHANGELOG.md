# Changelog

All notable changes to this project will be documented in this file.

This project follows a lightweight Keep a Changelog style and uses semantic
versioning once public releases begin.

## [Unreleased]

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
