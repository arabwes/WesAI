import { CafeError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigestBuffer, rightDigestBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftDigest = new Uint8Array(leftDigestBuffer);
  const rightDigest = new Uint8Array(rightDigestBuffer);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftDigest.length; index += 1) difference |= leftDigest[index]! ^ rightDigest[index]!;
  return difference === 0;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(base64Key);
  } catch {
    throw new CafeError("INTERNAL_ERROR", "The encryption key is not valid base64.", 500);
  }
  if (raw.byteLength !== 32) {
    throw new CafeError("INTERNAL_ERROR", "The encryption key must decode to 32 bytes.", 500);
  }
  return crypto.subtle.importKey("raw", ownedBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
}

export async function encryptValue(
  plaintext: string,
  base64Key: string,
  associatedData: string,
  keyVersion = 1,
): Promise<EncryptedValue> {
  const key = await importAesKey(base64Key);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(associatedData), tagLength: 128 },
    key,
    encoder.encode(plaintext),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
    keyVersion,
  };
}

export async function decryptValue(
  encrypted: EncryptedValue,
  base64Key: string,
  associatedData: string,
): Promise<string> {
  const key = await importAesKey(base64Key);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(base64ToBytes(encrypted.nonce)),
        additionalData: encoder.encode(associatedData),
        tagLength: 128,
      },
      key,
      ownedBuffer(base64ToBytes(encrypted.ciphertext)),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new CafeError("INTERNAL_ERROR", "Encrypted data could not be decrypted.", 500);
  }
}

export async function hmacSha256Base64(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64(new Uint8Array(signature));
}

export async function signSessionToken(secret: string, token: string): Promise<string> {
  return hmacSha256Base64(secret, token);
}
