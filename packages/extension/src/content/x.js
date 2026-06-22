// X (Twitter) content script — posts to the logged-in account
// Injected on x.com, listens for post commands from background

const MSG_POST = 'pms:post';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG_POST) return;
  postToX(message).then(sendResponse);
  return true;
});

async function postToX({ caption, mediaBase64 }) {
  try {
    // Navigate to compose if not already there
    if (!window.location.pathname.includes('/compose')) {
      window.location.href = 'https://x.com/compose/post';
      await wait(3000);
    }
    await wait(2000);

    // Upload media if provided
    if (mediaBase64) {
      const fileInput = document.querySelector('input[type="file"], input[data-testid="fileInput"]');
      if (fileInput) {
        const blob = base64ToBlob(mediaBase64.data, mediaBase64.mimeType);
        const file = new File([blob], mediaBase64.filename || 'media.mp4', { type: mediaBase64.mimeType });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(5000);

        // Verify media attached
        const preview = document.querySelector('[data-testid="attachments"]');
        if (!preview) {
          return { ok: false, error: 'Media upload not confirmed — no preview found' };
        }
      } else {
        return { ok: false, error: 'No file input found on X compose page' };
      }
    }

    // Fill caption
    const editor = document.querySelector('[data-testid="tweetTextarea_0"]')
      || document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, error: 'Could not find tweet editor' };
    editor.focus();
    await wait(300);
    // Type character by character for X (they detect paste)
    for (const char of caption) {
      const keyDown = new KeyboardEvent('keydown', { key: char, bubbles: true });
      const keyPress = new KeyboardEvent('keypress', { key: char, bubbles: true });
      const input = new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true });
      const keyUp = new KeyboardEvent('keyup', { key: char, bubbles: true });
      editor.dispatchEvent(keyDown);
      editor.dispatchEvent(keyPress);
      document.execCommand('insertText', false, char);
      editor.dispatchEvent(input);
      editor.dispatchEvent(keyUp);
      await wait(15 + Math.random() * 25);
    }
    await wait(1500);

    // Click Post
    const postBtn = document.querySelector('[data-testid="tweetButton"]');
    if (!postBtn) return { ok: false, error: 'Could not find Post button' };
    postBtn.click();
    await wait(5000);

    // Try to get post URL (X redirects after posting)
    const url = window.location.href;
    const link = url.includes('/status/') ? url : 'https://x.com';

    return { ok: true, link, platform: 'x' };
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

console.log('[PMS] X content script loaded');
