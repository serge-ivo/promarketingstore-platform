// LinkedIn content script — posts to the logged-in account
// Injected on linkedin.com, listens for post commands from background
//
// LinkedIn removed visible <input type="file"> elements from their composer.
// Upload strategy (in priority order):
//   1. Find hidden/dynamic file inputs inside the composer dialog
//   2. Simulate drag-and-drop onto the composer area
//   3. Simulate paste event with file data

const MSG_POST = 'pms:post';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG_POST) return;
  postToLinkedIn(message).then(sendResponse);
  return true;
});

async function postToLinkedIn({ caption, mediaBase64 }) {
  try {
    // Step 1: Open the composer by clicking "Start a post"
    const startBtn = findStartPostButton();
    if (!startBtn) return { ok: false, error: 'Could not find "Start a post" button', platform: 'linkedin' };
    clickControl(startBtn);
    await wait(2500);

    // Wait for the composer dialog to appear
    const dialog = await waitForElement(() => findComposerDialog(), 5000);
    if (!dialog) return { ok: false, error: 'Composer dialog did not open', platform: 'linkedin' };

    // Step 2: Upload media if provided
    if (mediaBase64) {
      const blob = base64ToBlob(mediaBase64.data, mediaBase64.mimeType);
      const file = new File([blob], mediaBase64.filename || 'media.mp4', { type: mediaBase64.mimeType });

      // Click the media button in the toolbar to trigger file input creation
      const mediaBtn = findMediaButton(dialog);
      if (mediaBtn) {
        clickControl(mediaBtn);
        await wait(2000);
      }

      const attached = await attachMedia(file, dialog);
      if (!attached) {
        return { ok: false, error: 'Failed to attach media — no upload mechanism found', platform: 'linkedin' };
      }

      // Wait for media to finish processing — LinkedIn shows Next/Done buttons
      const mediaReady = await waitForMediaReady(dialog);
      if (!mediaReady) {
        return { ok: false, error: 'Media upload timed out or failed', platform: 'linkedin' };
      }
    }

    // Step 3: Fill caption
    const editor = findEditor(dialog);
    if (!editor) return { ok: false, error: 'Could not find text editor in composer', platform: 'linkedin' };
    editor.focus();
    await wait(500);
    document.execCommand('insertText', false, caption);
    await wait(1500);

    // Step 4: Click Post
    const postBtn = findPostButton(dialog);
    if (!postBtn) return { ok: false, error: 'Could not find Post button', platform: 'linkedin' };
    if (isDisabled(postBtn)) {
      // Wait a bit more — media may still be processing
      await wait(5000);
      if (isDisabled(postBtn)) {
        return { ok: false, error: 'Post button is disabled — media may not have uploaded', platform: 'linkedin' };
      }
    }
    clickControl(postBtn);
    await wait(5000);

    return {
      ok: true,
      link: 'https://www.linkedin.com/feed/',
      platform: 'linkedin',
    };
  } catch (err) {
    return { ok: false, error: err.message, platform: 'linkedin' };
  }
}

// --- Media attachment (three strategies) ---

async function attachMedia(file, dialog) {
  // Strategy A: Find a file input (may be hidden or dynamically created)
  const attached = tryFileInput(file, dialog);
  if (attached) return true;

  // Strategy B: Drag-and-drop onto the composer
  const dropped = tryDragDrop(file, dialog);
  if (dropped) {
    await wait(3000);
    return true;
  }

  // Strategy C: Paste event with file
  const pasted = tryPaste(file, dialog);
  if (pasted) {
    await wait(3000);
    return true;
  }

  return false;
}

function tryFileInput(file, root) {
  // Search for file inputs across the entire document (LinkedIn may place them outside the dialog)
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  // Also check inside the dialog
  const dialogInputs = Array.from(root.querySelectorAll('input[type="file"]'));

  // Merge and deduplicate
  const allInputs = [...new Set([...dialogInputs, ...inputs])];

  // Prefer inputs that accept media files
  const mediaInput = allInputs.find(input => {
    const accept = (input.getAttribute('accept') || '').toLowerCase();
    return !accept || accept.includes('image') || accept.includes('video');
  });

  if (!mediaInput) return false;

  const dt = new DataTransfer();
  dt.items.add(file);

  try {
    mediaInput.files = dt.files;
  } catch {
    // Fallback: defineProperty for stubborn inputs
    try {
      Object.defineProperty(mediaInput, 'files', { configurable: true, value: dt.files });
    } catch {
      return false;
    }
  }

  mediaInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  mediaInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return true;
}

function tryDragDrop(file, dialog) {
  const target = findEditor(dialog) || dialog;
  if (!target) return false;

  const dt = new DataTransfer();
  dt.items.add(file);

  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt,
  };

  target.dispatchEvent(new DragEvent('dragenter', eventInit));
  target.dispatchEvent(new DragEvent('dragover', eventInit));
  target.dispatchEvent(new DragEvent('drop', eventInit));
  return true;
}

function tryPaste(file, dialog) {
  const target = findEditor(dialog) || dialog;
  if (!target) return false;

  target.focus();

  const dt = new DataTransfer();
  dt.items.add(file);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clipboardData: dt,
  });

  target.dispatchEvent(pasteEvent);
  return true;
}

// --- LinkedIn DOM finders ---

function findStartPostButton() {
  const controls = document.querySelectorAll('button, [role="button"]');
  for (const el of controls) {
    const label = getLabel(el);
    if (label.includes('start a post')) return el;
  }
  return null;
}

function findComposerDialog() {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  for (const dialog of dialogs) {
    const rect = dialog.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    // LinkedIn composer dialog contains "what do you want to talk about" or a contenteditable
    const text = dialog.textContent.toLowerCase();
    if (text.includes('what do you want to talk about') || text.includes('create a post') ||
        dialog.querySelector('[contenteditable="true"]')) {
      return dialog;
    }
  }
  return null;
}

function findEditor(root) {
  // LinkedIn composer selectors in priority order
  const selectors = [
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][aria-label]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

function findMediaButton(dialog) {
  // Look for the photo/video/media button in the toolbar
  const controls = dialog.querySelectorAll('button, [role="button"]');
  for (const el of controls) {
    const label = getLabel(el);
    if (label.includes('add a photo') || label.includes('add a video') ||
        label.includes('add media') || label.includes('photo') ||
        label.includes('media') || label.includes('image')) {
      return el;
    }
  }
  // Also look for the toolbar icon buttons with aria-labels
  for (const el of controls) {
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('photo') || ariaLabel.includes('video') || ariaLabel.includes('media') ||
        ariaLabel.includes('image')) {
      return el;
    }
  }
  return null;
}

function findPostButton(root) {
  const controls = root.querySelectorAll('button, [role="button"]');
  for (const el of controls) {
    // LinkedIn uses class "share-actions__primary-action" on the Post button
    if (el.classList.contains('share-actions__primary-action')) return el;
    const label = getLabel(el);
    // Match "Post" exactly (not "Repost" or other variants)
    const trimmed = (el.textContent || '').trim();
    if (trimmed === 'Post' || label === 'post') return el;
  }
  return null;
}

async function waitForMediaReady(dialog) {
  const deadline = Date.now() + 60000; // 60s timeout for media processing

  while (Date.now() < deadline) {
    // Check if media is attached (presence of "Remove media" or "Edit media" controls)
    const indicator = findMediaAttachedIndicator(dialog);
    if (indicator) return true;

    // Click Next/Done buttons if the media editor shows them
    const nextBtn = findMediaNextButton();
    if (nextBtn) {
      clickControl(nextBtn);
      await wait(500);
      continue;
    }

    await wait(500);
  }

  // Final check
  return !!findMediaAttachedIndicator(dialog);
}

function findMediaAttachedIndicator(dialog) {
  const controls = dialog.querySelectorAll('button, [role="button"]');
  for (const el of controls) {
    const label = getLabel(el);
    if (label.includes('remove media') || label.includes('edit media preview') ||
        label.includes('delete') || label.includes('remove image')) {
      return el;
    }
  }
  // Also check for media preview thumbnails
  const previews = dialog.querySelectorAll('img[src*="media"], video, [class*="media-preview"], [class*="image-preview"]');
  if (previews.length > 0) return previews[0];
  return null;
}

function findMediaNextButton() {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const rect = dialog.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const controls = dialog.querySelectorAll('button, [role="button"]');
    for (const el of controls) {
      if (isDisabled(el)) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (text === 'next' || text === 'done' || ariaLabel === 'next' || ariaLabel === 'done') {
        return el;
      }
    }
  }
  return null;
}

// --- Utilities ---

function getLabel(el) {
  return [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent]
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

function isDisabled(el) {
  if (el instanceof HTMLButtonElement && el.disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (el.classList.contains('artdeco-button--disabled')) return true;
  return false;
}

function clickControl(el) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  el.click();
}

async function waitForElement(finder, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = finder();
    if (el) return el;
    await wait(300);
  }
  return null;
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

console.log('[PMS] LinkedIn content script loaded');
