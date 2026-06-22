// Background service worker — routes posting commands to content scripts
// Receives messages from: external (agents via HTTP), popup, or native messaging
// Routes to: content scripts on the target platform tab

// Inline constants (avoid ES module import issues in Chrome service workers)
const PLATFORMS = ['facebook', 'x', 'instagram', 'tiktok', 'linkedin'];
const MSG = { POST: 'pms:post', POST_RESULT: 'pms:post:result', STATUS: 'pms:status', STATUS_RESULT: 'pms:status:result' };

// Listen for external messages (from agents/localhost)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handlePostRequest(message).then(sendResponse);
  return true; // async
});

// Listen for internal messages (from popup or other extension pages)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MSG.STATUS) {
    getStatus().then(sendResponse);
    return true;
  }
  if (message.type === MSG.POST) {
    handlePostRequest(message).then(sendResponse);
    return true;
  }
});

async function handlePostRequest(message) {
  const { platform, caption, mediaUrl, mediaBase64 } = message;

  if (!platform || !PLATFORMS.includes(platform)) {
    return { ok: false, error: `Invalid platform: ${platform}. Use: ${PLATFORMS.join(', ')}` };
  }
  if (!caption) {
    return { ok: false, error: 'Caption is required' };
  }

  // Find or create the platform tab
  const tab = await findOrCreateTab(platform);
  if (!tab) {
    return { ok: false, error: `Could not open ${platform} tab` };
  }

  // Wait for tab to load
  await waitForTabReady(tab.id);

  // Send post command to content script
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.POST,
      caption,
      mediaUrl,
      mediaBase64,
    });
    return result || { ok: false, error: 'No response from content script' };
  } catch (err) {
    return { ok: false, error: `Content script error: ${err.message}` };
  }
}

async function findOrCreateTab(platform) {
  const urls = {
    facebook: 'https://www.facebook.com/',
    x: 'https://x.com/compose/post',
    instagram: 'https://www.instagram.com/',
    tiktok: 'https://www.tiktok.com/upload',
    linkedin: 'https://www.linkedin.com/feed/',
  };

  // Look for existing tab
  const tabs = await chrome.tabs.query({ url: `${urls[platform]}*` });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: false }); // don't focus
    return tabs[0];
  }

  // Create new tab (not focused)
  return chrome.tabs.create({ url: urls[platform], active: false });
}

async function waitForTabReady(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function getStatus() {
  const results = {};
  for (const platform of PLATFORMS) {
    const urls = {
      facebook: 'https://www.facebook.com/*',
      x: 'https://x.com/*',
      instagram: 'https://www.instagram.com/*',
      tiktok: 'https://www.tiktok.com/*',
      linkedin: 'https://www.linkedin.com/*',
    };
    const tabs = await chrome.tabs.query({ url: urls[platform] });
    results[platform] = { hasTab: tabs.length > 0, tabCount: tabs.length };
  }
  return { ok: true, platforms: results };
}
