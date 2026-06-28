const IV_LENGTH = 12;

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptAesGcm(plaintext: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, encoded);
  return { ciphertext: uint8ToBase64(new Uint8Array(encrypted)), iv: uint8ToBase64(iv) };
}

export async function decryptAesGcm(ciphertext: string, iv: string, secret: string): Promise<string> {
  const key = await deriveAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToUint8(iv) as BufferSource },
    key,
    base64ToUint8(ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}
