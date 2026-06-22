// Facebook content script — posts to the logged-in personal profile
// Injected on facebook.com, listens for post commands from background

const MSG_POST = 'pms:post';
const MSG_RESULT = 'pms:post:result';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG_POST) return;
  postToFacebook(message).then(sendResponse);
  return true;
});

async function postToFacebook({ caption, mediaUrl, mediaBase64 }) {
  try {
    // Step 1: Open composer
    const composerBtn = findButton(/what.s on your mind/i);
    if (!composerBtn) return { ok: false, error: 'Could not find "What\'s on your mind" button' };
    composerBtn.click();
    await wait(2500);

    // Step 2: Upload media if provided
    if (mediaUrl || mediaBase64) {
      const photoBtn = findButton(/photo|video/i);
      if (!photoBtn) return { ok: false, error: 'Could not find Photo/Video button' };
      photoBtn.click();
      await wait(2000);

      // Find the file input (may be hidden or in a dialog)
      let fileInput = document.querySelector('input[type="file"]');
      if (!fileInput) {
        // Facebook may create the input dynamically — wait
        await wait(2000);
        fileInput = document.querySelector('input[type="file"]');
      }

      if (fileInput && mediaBase64) {
        const blob = base64ToBlob(mediaBase64.data, mediaBase64.mimeType);
        const file = new File([blob], mediaBase64.filename || 'media.mp4', { type: mediaBase64.mimeType });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(5000);
      } else if (fileInput && mediaUrl) {
        // Can't set file input from URL in content script — would need background fetch
        return { ok: false, error: 'File upload from URL not supported yet — use mediaBase64' };
      } else if (!fileInput) {
        // No file input — try drag and drop
        return { ok: false, error: 'No file input found on Facebook. UI may have changed.' };
      }
    }

    // Step 3: Fill caption
    // Wait for editor to appear in the dialog
    let editor = null;
    for (let i = 0; i < 10; i++) {
      editor = findEditor();
      if (editor) break;
      await wait(500);
    }
    if (!editor) return { ok: false, error: 'Could not find caption editor after 5s' };
    editor.focus();
    await wait(300);
    // Use execCommand for contenteditable
    document.execCommand('insertText', false, caption);
    await wait(1500);

    // Step 4: Click Post
    const postBtn = findButton(/^Post$/i);
    if (!postBtn) return { ok: false, error: 'Could not find Post button' };
    if (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: 'Post button is disabled — media may not have uploaded' };
    }
    postBtn.click();
    await wait(5000);

    return {
      ok: true,
      link: 'https://www.facebook.com/profile.php?id=61578071257103',
      platform: 'facebook',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function findButton(pattern) {
  const buttons = document.querySelectorAll('[role="button"]');
  for (const btn of buttons) {
    const text = btn.textContent || btn.getAttribute('aria-label') || '';
    if (pattern.test(text)) return btn;
  }
  return null;
}

function findEditor() {
  // Try specific first, then broader
  let editors = document.querySelectorAll('[contenteditable="true"][role="textbox"]');
  if (editors.length === 0) editors = document.querySelectorAll('[contenteditable="true"][data-lexical-editor="true"]');
  if (editors.length === 0) editors = document.querySelectorAll('[role="dialog"] [contenteditable="true"]');
  if (editors.length === 0) editors = document.querySelectorAll('[contenteditable="true"]');
  // Return the last visible one
  for (let i = editors.length - 1; i >= 0; i--) {
    if (editors[i].offsetParent !== null) return editors[i];
  }
  return editors[editors.length - 1] || null;
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

console.log('[PMS] Facebook content script loaded');
