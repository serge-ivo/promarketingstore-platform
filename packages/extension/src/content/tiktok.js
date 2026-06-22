// TikTok content script — posts video to the logged-in account
// Injected on tiktok.com/upload

const MSG_POST = 'pms:post';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG_POST) return;
  postToTikTok(message).then(sendResponse);
  return true;
});

async function postToTikTok({ caption, mediaBase64 }) {
  try {
    // Navigate to upload if not there
    if (!window.location.pathname.includes('/upload')) {
      window.location.href = 'https://www.tiktok.com/upload';
      await wait(3000);
    }
    await wait(2000);

    if (!mediaBase64) {
      return { ok: false, error: 'TikTok requires video media (mediaBase64)' };
    }

    // Find file input
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return { ok: false, error: 'No file input found on TikTok upload page' };

    const blob = base64ToBlob(mediaBase64.data, mediaBase64.mimeType);
    const file = new File([blob], mediaBase64.filename || 'video.mp4', { type: mediaBase64.mimeType });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(20000); // TikTok processing takes time

    // Dismiss overlays
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wait(500);

    // Fill caption
    const editor = document.querySelector('[contenteditable="true"][role="combobox"]')
      || document.querySelector('.public-DraftEditor-content[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, error: 'Could not find caption editor' };
    editor.focus();
    await wait(300);
    // Select all existing text and replace
    document.execCommand('selectAll');
    await wait(100);
    document.execCommand('insertText', false, caption);
    await wait(2000);

    // Click Post
    const postBtn = document.querySelector('[data-e2e="post_video_button"]');
    if (!postBtn) return { ok: false, error: 'Could not find Post button' };
    postBtn.click();
    await wait(10000);

    return { ok: true, link: 'https://www.tiktok.com', platform: 'tiktok' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function base64ToBlob(base64, mimeType) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

console.log('[PMS] TikTok content script loaded');
