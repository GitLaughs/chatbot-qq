# chatbot-qq v0.2.17｜QQ group image and sticker recognition

This release fixes a OneBot/NapCat compatibility path where group images or sticker packages could arrive only as raw CQ message text and fail to reach the agent as visual segments.

中文关键词：QQ 群机器人、图片识别、表情包识别、OneBot、NapCat、CQ 码。

## Highlights

- Parses raw CQ `image`, `mface`, `marketface`, `bface`, and `face` segments when no structured message array is present.
- Converts image-like sticker packages with URLs into image segments so the agent can inspect them.
- Prefers usable image URLs for forwarded image file sources.
- Adds unit coverage for raw CQ image and sticker normalization.

## Verify

```powershell
npm test
git diff --check
```

Server-side validation:

- `node --check scripts/onebot-group-proxy.js`
- `node --check scripts/test-onebot-proxy-units.js`
- `npm test`
- Restart `onebot-group-proxy` and `cc-connect-qq`.
- Confirm the local health endpoint returns HTTP 200.

## Deployment Notes

- Deploy `scripts/onebot-group-proxy.js` and `scripts/test-onebot-proxy-units.js`.
- After production deployment, refresh the server integrity manifest for these two files and run the integrity check.
- Real server addresses, QQ IDs, and API keys must stay in ignored local files or operator-provided environment variables.
