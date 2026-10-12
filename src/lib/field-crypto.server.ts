import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PREFIX = "enc1.";
const KEY_FILE = join(process.cwd(), "data", "data-key");

let cached: Buffer | null = null;

function decodeKey(raw: string): Buffer {
  const text = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (key.length !== 32) {
    throw new Error("VORLAUF_DATA_KEY muss 32 Byte sein, als Base64 oder Hex.");
  }
  return key;
}

function dataKey(): Buffer {
  if (cached) return cached;
  const fromEnv = process.env.VORLAUF_DATA_KEY?.trim();
  if (fromEnv) {
    cached = decodeKey(fromEnv);
    return cached;
  }
  if (existsSync(KEY_FILE)) {
    const key = readFileSync(KEY_FILE);
    if (key.length !== 32) throw new Error("data/data-key ist beschädigt. Den gesicherten Schlüssel wiederherstellen.");
    cached = key;
    return key;
  }
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  cached = key;
  return key;
}

export function isSealed(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypt a field. Empty stays empty so queries for missing values still work. */
export function sealSecret(value: string | null | undefined): string {
  const text = value ?? "";
  if (!text || isSealed(text)) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

/** Decrypt a field. Values from before encryption are returned unchanged. */
export function openSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!isSealed(value)) return value;
  const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (payload.length < 12 + 16 + 1) throw new Error("Ein gespeicherter Wert ist beschädigt.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Datenschlüssel passt nicht zu den gespeicherten Nachrichten. VORLAUF_DATA_KEY oder data/data-key prüfen.");
  }
}
