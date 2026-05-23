# chatbot-qq v0.2.3｜file archive observability

This release continues the production-hardening pass by separating group file upload handling from the main OneBot proxy and adding health visibility for the archive pipeline.

中文关键词：QQ 文件上传、群文件归档、OneBot 代理、健康检查、文件解析、cc-connect QQ。

## Highlights

- Adds `scripts/lib/proxy-files.js` for group upload download requests, archive saving, sidecar metadata, extracted text, and archive notices.
- Exposes file-processing counters in `/healthz` under `files`.
- Keeps the main proxy focused on routing and response handling instead of file-storage details.
- Adds unit checks for group upload download requests and text-file archive extraction.

## Verify

```powershell
$env:GOPROXY="https://goproxy.cn,direct"
npm test
git diff --check
```

Expected:

- Go package checks pass when dependencies are reachable.
- Node syntax checks pass.
- OneBot proxy unit checks pass, including file archive checks.
- PowerShell parser checks pass.
- Sensitive local-data scan passes.

## Deployment Notes

- The proxy health response now includes file counters such as `group_uploads`, `archived`, `parse_success`, and `parse_failed`.
- Real QQ group IDs, private user IDs, API keys, and NapCat tokens must stay in ignored local files or `/etc/chatbot-qq.env`.

## Full Changelog

See `CHANGELOG.md`.
