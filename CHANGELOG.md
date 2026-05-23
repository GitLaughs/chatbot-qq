# Changelog

All notable changes to this project will be documented in this file.

This project follows a lightweight Keep a Changelog style and uses semantic
versioning once public releases begin.

## [Unreleased]

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
