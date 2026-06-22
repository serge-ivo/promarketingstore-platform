# PMS Social Poster Chrome Extension

Chrome extension that posts content to social media platforms from inside the page. Bypasses CDP/Playwright limitations by running as a proper browser extension.

## Why

- LinkedIn removed `<input type="file">` — puppeteer/Playwright can't upload media anymore
- CDP `Browser.setDownloadBehavior` broken with Chrome 149 + Playwright
- Content scripts run inside the page with full DOM access — no CDP needed

## Architecture

```
Agent (OpenClaw/script)
  → HTTP bridge (localhost:19876)
    → chrome.runtime.sendMessage
      → Background service worker (routes by platform)
        → Content script (facebook.js / x.js / tiktok.js)
          → Fills composer, uploads media, clicks Post
            → Returns { ok, link, error }
```

## Platforms

| Platform | Method | Content Script | Status |
|----------|--------|---------------|--------|
| Facebook | Extension (content script) | `facebook.js` | Ready to test |
| X | Extension (content script) | `x.js` | Ready to test |
| TikTok | Extension (content script) | `tiktok.js` | Ready to test |
| Instagram | API (Graph API) | stub | Uses API, not extension |
| LinkedIn | Extension (content script) | TODO | Needs investigation of new upload UI |

## Install (Development)

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this `extension/` folder
4. Note the extension ID (needed for external messaging)

## Media Format

The extension receives media as base64:

```json
{
  "platform": "facebook",
  "caption": "Hello world #ai",
  "mediaBase64": {
    "data": "<base64 encoded file>",
    "mimeType": "video/mp4",
    "filename": "clip.mp4"
  }
}
```

For text-only posts, omit `mediaBase64`.

## Files

```
extension/
├── manifest.json               MV3 manifest
├── src/
│   ├── background/
│   │   ├── service-worker.js   Routes commands to content scripts
│   │   └── http-bridge.js      Protocol docs for agent bridge
│   ├── content/
│   │   ├── facebook.js         Facebook posting (personal profile)
│   │   ├── x.js                X posting
│   │   ├── tiktok.js           TikTok posting
│   │   └── instagram.js        Stub (API only)
│   └── shared/
│       └── types.js            Message types + constants
└── icons/                      Extension icons (TODO)
```

## Next Steps

1. Test on Facebook, X, TikTok (NOT LinkedIn yet)
2. Build HTTP bridge server for agent integration
3. Add LinkedIn content script once upload UI is understood
4. Add native messaging host for direct agent → extension communication
