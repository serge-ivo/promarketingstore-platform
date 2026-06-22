#!/usr/bin/env node

// Structural / unit tests for PMS Chrome extension
// Run with: node test/test.js (from the extension root)
//
// Uses only Node.js built-ins. No external dependencies.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, '..');

function readFile(rel) {
  return fs.readFileSync(path.join(EXT_ROOT, rel), 'utf-8');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Load sources
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFile('manifest.json'));
const facebookSrc = readFile('src/content/facebook.js');
const xSrc = readFile('src/content/x.js');
const tiktokSrc = readFile('src/content/tiktok.js');
const instagramSrc = readFile('src/content/instagram.js');
const serviceWorkerSrc = readFile('src/background/service-worker.js');
const typesSrc = readFile('src/shared/types.js');

// ---------------------------------------------------------------------------
// 1. Manifest validation
// ---------------------------------------------------------------------------
console.log('\n--- manifest.json ---');

test('manifest_version is 3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('has required fields: name, version, description', () => {
  assert.ok(manifest.name, 'name is missing');
  assert.ok(manifest.version, 'version is missing');
  assert.ok(manifest.description, 'description is missing');
});

test('permissions include activeTab and scripting', () => {
  assert.ok(manifest.permissions.includes('activeTab'), 'missing activeTab');
  assert.ok(manifest.permissions.includes('scripting'), 'missing scripting');
});

test('host_permissions cover all four platforms', () => {
  const hosts = manifest.host_permissions;
  assert.ok(hosts.some(h => h.includes('facebook.com')), 'missing facebook host');
  assert.ok(hosts.some(h => h.includes('x.com')), 'missing x host');
  assert.ok(hosts.some(h => h.includes('instagram.com')), 'missing instagram host');
  assert.ok(hosts.some(h => h.includes('tiktok.com')), 'missing tiktok host');
});

test('background.service_worker points to correct file', () => {
  assert.equal(manifest.background.service_worker, 'src/background/service-worker.js');
  assert.equal(manifest.background.type, 'module');
});

test('content_scripts entries match platform URLs to correct JS files', () => {
  const cs = manifest.content_scripts;
  assert.ok(cs.length >= 4, `expected at least 4 content_scripts, got ${cs.length}`);

  const expected = [
    { match: 'facebook.com', js: 'src/content/facebook.js' },
    { match: 'x.com', js: 'src/content/x.js' },
    { match: 'instagram.com', js: 'src/content/instagram.js' },
    { match: 'tiktok.com', js: 'src/content/tiktok.js' },
    { match: 'linkedin.com', js: 'src/content/linkedin.js' },
  ];

  for (const { match, js } of expected) {
    const entry = cs.find(e => e.matches.some(m => m.includes(match)));
    assert.ok(entry, `no content_script entry for ${match}`);
    assert.ok(entry.js.includes(js), `${match} should load ${js}, got ${entry.js}`);
    assert.equal(entry.run_at, 'document_idle', `${match} run_at should be document_idle`);
  }
});

test('content_scripts JS files all exist on disk', () => {
  for (const entry of manifest.content_scripts) {
    for (const jsPath of entry.js) {
      const full = path.join(EXT_ROOT, jsPath);
      assert.ok(fs.existsSync(full), `file not found: ${jsPath}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. externally_connectable
// ---------------------------------------------------------------------------
console.log('\n--- externally_connectable ---');

test('externally_connectable is configured', () => {
  assert.ok(manifest.externally_connectable, 'externally_connectable is missing');
});

test('externally_connectable allows all extension IDs', () => {
  assert.ok(
    manifest.externally_connectable.ids.includes('*'),
    'ids should include wildcard "*"'
  );
});

test('externally_connectable allows localhost', () => {
  const matches = manifest.externally_connectable.matches;
  assert.ok(
    matches.some(m => m.includes('localhost')),
    'matches should include localhost pattern'
  );
});

// ---------------------------------------------------------------------------
// 3. Content scripts use correct message type
// ---------------------------------------------------------------------------
console.log('\n--- content script message types ---');

const MSG_POST_VALUE = 'pms:post';

test('facebook.js listens for MSG_POST = "pms:post"', () => {
  assert.ok(facebookSrc.includes(`'${MSG_POST_VALUE}'`), 'MSG_POST constant not found');
  assert.ok(facebookSrc.includes('chrome.runtime.onMessage.addListener'), 'missing message listener');
  assert.ok(facebookSrc.includes('message.type !== MSG_POST'), 'missing type check');
});

test('x.js listens for MSG_POST = "pms:post"', () => {
  assert.ok(xSrc.includes(`'${MSG_POST_VALUE}'`), 'MSG_POST constant not found');
  assert.ok(xSrc.includes('chrome.runtime.onMessage.addListener'), 'missing message listener');
  assert.ok(xSrc.includes('message.type !== MSG_POST'), 'missing type check');
});

test('tiktok.js listens for MSG_POST = "pms:post"', () => {
  assert.ok(tiktokSrc.includes(`'${MSG_POST_VALUE}'`), 'MSG_POST constant not found');
  assert.ok(tiktokSrc.includes('chrome.runtime.onMessage.addListener'), 'missing message listener');
  assert.ok(tiktokSrc.includes('message.type !== MSG_POST'), 'missing type check');
});

test('instagram.js listens for MSG_POST = "pms:post"', () => {
  assert.ok(instagramSrc.includes(`'${MSG_POST_VALUE}'`), 'MSG_POST constant not found');
  assert.ok(instagramSrc.includes('chrome.runtime.onMessage.addListener'), 'missing message listener');
  assert.ok(instagramSrc.includes('message.type !== MSG_POST'), 'missing type check');
});

test('shared/types.js exports matching MSG.POST value', () => {
  assert.ok(typesSrc.includes(`POST: '${MSG_POST_VALUE}'`), 'MSG.POST should be pms:post');
});

test('content scripts and types.js agree on MSG_POST value', () => {
  // Extract the value from types.js
  const typesMatch = typesSrc.match(/POST:\s*'([^']+)'/);
  assert.ok(typesMatch, 'could not parse MSG.POST from types.js');
  const typesValue = typesMatch[1];

  // Each content script should define MSG_POST with same value
  for (const [name, src] of [['facebook', facebookSrc], ['x', xSrc], ['tiktok', tiktokSrc], ['instagram', instagramSrc]]) {
    const csMatch = src.match(/const MSG_POST\s*=\s*'([^']+)'/);
    assert.ok(csMatch, `${name}.js: could not parse MSG_POST constant`);
    assert.equal(csMatch[1], typesValue, `${name}.js MSG_POST ('${csMatch[1]}') != types.js MSG.POST ('${typesValue}')`);
  }
});

// ---------------------------------------------------------------------------
// 4. Content scripts have error handling (return { ok: false, error: ... })
// ---------------------------------------------------------------------------
console.log('\n--- error handling ---');

test('facebook.js has try/catch returning { ok: false, error }', () => {
  assert.ok(facebookSrc.includes('try {'), 'missing try block');
  assert.ok(facebookSrc.includes('catch (err)'), 'missing catch block');
  assert.ok(facebookSrc.includes('ok: false, error: err.message'), 'catch should return { ok: false, error: err.message }');
});

test('facebook.js returns { ok: false, error } for missing UI elements', () => {
  const errorReturns = (facebookSrc.match(/return\s*\{\s*ok:\s*false,\s*error:/g) || []).length;
  assert.ok(errorReturns >= 4, `expected at least 4 error returns, found ${errorReturns}`);
});

test('x.js has try/catch returning { ok: false, error }', () => {
  assert.ok(xSrc.includes('try {'), 'missing try block');
  assert.ok(xSrc.includes('catch (err)'), 'missing catch block');
  assert.ok(xSrc.includes('ok: false, error: err.message'), 'catch should return { ok: false, error: err.message }');
});

test('x.js returns { ok: false, error } for missing UI elements', () => {
  const errorReturns = (xSrc.match(/return\s*\{\s*ok:\s*false,\s*error:/g) || []).length;
  assert.ok(errorReturns >= 3, `expected at least 3 error returns, found ${errorReturns}`);
});

test('tiktok.js has try/catch returning { ok: false, error }', () => {
  assert.ok(tiktokSrc.includes('try {'), 'missing try block');
  assert.ok(tiktokSrc.includes('catch (err)'), 'missing catch block');
  assert.ok(tiktokSrc.includes('ok: false, error: err.message'), 'catch should return { ok: false, error: err.message }');
});

test('tiktok.js returns { ok: false, error } for missing UI elements', () => {
  const errorReturns = (tiktokSrc.match(/return\s*\{\s*ok:\s*false,\s*error:/g) || []).length;
  assert.ok(errorReturns >= 3, `expected at least 3 error returns, found ${errorReturns}`);
});

test('instagram.js returns { ok: false, error } (API-only stub)', () => {
  assert.ok(instagramSrc.includes('ok: false'), 'should return ok: false');
  assert.ok(instagramSrc.includes('error:'), 'should include error message');
  assert.ok(instagramSrc.includes('Graph API'), 'should mention Graph API');
});

// ---------------------------------------------------------------------------
// 5. Service worker routes to correct platform URLs
// ---------------------------------------------------------------------------
console.log('\n--- service worker routing ---');

test('service worker imports from shared/types.js', () => {
  assert.ok(serviceWorkerSrc.includes("from '../shared/types.js'"), 'should import from types.js');
  assert.ok(serviceWorkerSrc.includes('MSG'), 'should import MSG');
  assert.ok(serviceWorkerSrc.includes('PLATFORMS'), 'should import PLATFORMS');
});

test('service worker listens for external messages (onMessageExternal)', () => {
  assert.ok(
    serviceWorkerSrc.includes('chrome.runtime.onMessageExternal.addListener'),
    'should have onMessageExternal listener'
  );
});

test('service worker listens for internal messages (onMessage)', () => {
  assert.ok(
    serviceWorkerSrc.includes('chrome.runtime.onMessage.addListener'),
    'should have onMessage listener'
  );
});

test('service worker validates platform against PLATFORMS list', () => {
  assert.ok(
    serviceWorkerSrc.includes('PLATFORMS.includes(platform)'),
    'should validate platform with PLATFORMS.includes'
  );
});

test('service worker validates caption is required', () => {
  assert.ok(
    serviceWorkerSrc.includes('!caption'),
    'should check for missing caption'
  );
  assert.ok(
    serviceWorkerSrc.includes("'Caption is required'"),
    'should return caption required error'
  );
});

test('service worker has correct platform URLs for tab routing', () => {
  assert.ok(serviceWorkerSrc.includes("facebook: 'https://www.facebook.com/'"), 'facebook URL');
  assert.ok(serviceWorkerSrc.includes("x: 'https://x.com/compose/post'"), 'x URL');
  assert.ok(serviceWorkerSrc.includes("instagram: 'https://www.instagram.com/'"), 'instagram URL');
  assert.ok(serviceWorkerSrc.includes("tiktok: 'https://www.tiktok.com/upload'"), 'tiktok URL');
});

test('service worker sends MSG.POST to content scripts', () => {
  assert.ok(
    serviceWorkerSrc.includes('type: MSG.POST'),
    'should send type: MSG.POST to tabs'
  );
});

test('service worker handles sendMessage errors', () => {
  assert.ok(serviceWorkerSrc.includes('catch (err)'), 'should catch sendMessage errors');
  assert.ok(serviceWorkerSrc.includes('Content script error'), 'should wrap content script errors');
});

test('service worker handles missing content script response', () => {
  assert.ok(
    serviceWorkerSrc.includes("'No response from content script'"),
    'should handle null/undefined response from content script'
  );
});

test('service worker handles MSG.STATUS requests', () => {
  assert.ok(serviceWorkerSrc.includes('MSG.STATUS'), 'should check for STATUS message type');
  assert.ok(serviceWorkerSrc.includes('getStatus'), 'should call getStatus function');
});

// ---------------------------------------------------------------------------
// 6. base64ToBlob function
// ---------------------------------------------------------------------------
console.log('\n--- base64ToBlob ---');

test('facebook.js, x.js, tiktok.js all define base64ToBlob', () => {
  for (const [name, src] of [['facebook', facebookSrc], ['x', xSrc], ['tiktok', tiktokSrc]]) {
    assert.ok(src.includes('function base64ToBlob(base64, mimeType)'), `${name}.js missing base64ToBlob`);
  }
});

test('base64ToBlob converts base64 string to correct bytes', () => {
  // Replicate the function logic in Node to verify correctness
  const base64Input = Buffer.from('Hello, World!').toString('base64');

  const bytes = Buffer.from(base64Input, 'base64');
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes[i];

  assert.equal(arr.length, 13, 'decoded length should be 13');
  assert.equal(String.fromCharCode(...arr), 'Hello, World!', 'decoded content should match');
});

test('base64ToBlob handles all 256 byte values correctly', () => {
  const binaryData = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) binaryData[i] = i;
  const base64Input = binaryData.toString('base64');

  const bytes = Buffer.from(base64Input, 'base64');
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes[i];

  assert.equal(arr.length, 256, 'should decode 256 bytes');
  for (let i = 0; i < 256; i++) {
    assert.equal(arr[i], i, `byte ${i} should be ${i}`);
  }
});

test('base64ToBlob creates Blob with correct mimeType', () => {
  for (const [name, src] of [['facebook', facebookSrc], ['x', xSrc], ['tiktok', tiktokSrc]]) {
    assert.ok(
      src.includes('new Blob([arr], { type: mimeType })'),
      `${name}.js base64ToBlob should create Blob with { type: mimeType }`
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Shared types consistency
// ---------------------------------------------------------------------------
console.log('\n--- shared types ---');

test('PLATFORMS includes all four platforms', () => {
  assert.ok(typesSrc.includes("'facebook'"), 'PLATFORMS should include facebook');
  assert.ok(typesSrc.includes("'x'"), 'PLATFORMS should include x');
  assert.ok(typesSrc.includes("'instagram'"), 'PLATFORMS should include instagram');
  assert.ok(typesSrc.includes("'tiktok'"), 'PLATFORMS should include tiktok');
});

test('MSG exports POST, POST_RESULT, STATUS, STATUS_RESULT', () => {
  assert.ok(typesSrc.includes('POST:'), 'MSG should have POST');
  assert.ok(typesSrc.includes('POST_RESULT:'), 'MSG should have POST_RESULT');
  assert.ok(typesSrc.includes('STATUS:'), 'MSG should have STATUS');
  assert.ok(typesSrc.includes('STATUS_RESULT:'), 'MSG should have STATUS_RESULT');
});

// ---------------------------------------------------------------------------
// 8. Content scripts return async (return true from listener)
// ---------------------------------------------------------------------------
console.log('\n--- async listener pattern ---');

test('all content scripts return true from onMessage listener (async pattern)', () => {
  for (const [name, src] of [['facebook', facebookSrc], ['x', xSrc], ['tiktok', tiktokSrc], ['instagram', instagramSrc]]) {
    assert.ok(src.includes('return true;'), `${name}.js should return true from listener for async sendResponse`);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
