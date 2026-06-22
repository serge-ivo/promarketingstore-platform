// HTTP bridge — allows external agents to send posting commands to the extension
// The extension listens for connections and the agent sends requests
//
// Usage from agent/script:
//   POST http://localhost:19876/post
//   { "platform": "facebook", "caption": "Hello world", "mediaBase64": { "data": "...", "mimeType": "video/mp4", "filename": "clip.mp4" } }
//
// Response:
//   { "ok": true, "link": "https://facebook.com/...", "platform": "facebook" }
//
// This runs as a simple HTTP server inside the service worker using fetch event handling.
// Since MV3 service workers can't run persistent servers, we use a different approach:
// The agent communicates via chrome.runtime.sendMessage from an externally_connectable page,
// or via native messaging host.
//
// For now, the simplest bridge: a tiny Node.js server that forwards to the extension.

// This file documents the protocol. The actual bridge lives at:
// ~/.openclaw/mcp-servers/social-poster/scripts/extension-bridge.js
