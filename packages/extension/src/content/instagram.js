// Instagram content script — stub (Instagram uses API, not browser posting)
// Kept for future use if browser posting needed

const MSG_POST = 'pms:post';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG_POST) return;
  sendResponse({
    ok: false,
    error: 'Instagram posting uses Graph API, not browser extension. Use post-to-instagram-api.js instead.',
    platform: 'instagram',
  });
  return true;
});

console.log('[PMS] Instagram content script loaded (API-only mode)');
