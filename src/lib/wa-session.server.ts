import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Boom } from "@hapi/boom";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { getSql } from "@/lib/db";

const AUTH_DIR = join(process.cwd(), "data", "wa-auth");
const logger = pino({ level: "silent" });

type Phase = "idle" | "connecting" | "qr" | "open" | "closed";

type Loose = Record<string, unknown>;

let phase: Phase = "idle";
let qrDataUrl: string | null = null;
let accountLabel = "";
let lastError: string | null = null;
let sock: WASocket | null = null;
let generation = 0;
let reconnectDelay = 2000;
let connectTask: Promise<void> | null = null;
const names = new Map<string, string>();
let writes: Promise<unknown> = Promise.resolve();

function hasCreds(): boolean {
  return existsSync(join(AUTH_DIR, "creds.json"));
}

function keepJid(jid: string | null | undefined): jid is string {
  if (!jid) return false;
  if (jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@g.us") || jid.endsWith("@lid");
}

function phoneLabel(jid: string): string {
  const user = jid.split("@")[0]?.split(":")[0] ?? jid;
  if (jid.endsWith("@g.us")) return "Gruppe";
  return user.length >= 8 ? `+${user}` : user;
}

function stamp(value: unknown): string {
  let n = Date.now();
  if (typeof value === "number" || typeof value === "bigint") n = Number(value);
  else if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    n = Number(value.toNumber());
  }
  if (!Number.isFinite(n) || n <= 0) n = Date.now();
  if (n < 10_000_000_000) n *= 1000;
  return new Date(n).toISOString();
}

function unwrap(message: unknown): Loose | null {
  let current = message && typeof message === "object" ? (message as Loose) : null;
  for (let i = 0; i < 4 && current; i += 1) {
    const nested =
      (current.ephemeralMessage as Loose | undefined)?.message ??
      (current.viewOnceMessage as Loose | undefined)?.message ??
      (current.viewOnceMessageV2 as Loose | undefined)?.message ??
      (current.documentWithCaptionMessage as Loose | undefined)?.message ??
      (current.editedMessage as Loose | undefined)?.message;
    if (!nested || typeof nested !== "object") break;
    current = nested as Loose;
  }
  return current;
}

function describe(message: unknown): { body: string; kind: string } | null {
  const msg = unwrap(message);
  if (!msg || msg.protocolMessage || msg.reactionMessage) return null;
  if (typeof msg.conversation === "string" && msg.conversation.trim()) return { body: msg.conversation, kind: "text" };
  const extended = msg.extendedTextMessage as Loose | undefined;
  if (typeof extended?.text === "string" && extended.text.trim()) return { body: extended.text, kind: "text" };
  const image = msg.imageMessage as Loose | undefined;
  if (image) return { body: typeof image.caption === "string" && image.caption ? image.caption : "Bild", kind: "image" };
  const video = msg.videoMessage as Loose | undefined;
  if (video) return { body: typeof video.caption === "string" && video.caption ? video.caption : "Video", kind: "video" };
  if (msg.audioMessage) return { body: "Sprachnachricht", kind: "audio" };
  if (msg.stickerMessage) return { body: "Sticker", kind: "sticker" };
  const doc = msg.documentMessage as Loose | undefined;
  if (doc) return { body: typeof doc.fileName === "string" && doc.fileName ? doc.fileName : "Dokument", kind: "document" };
  const contact = msg.contactMessage as Loose | undefined;
  if (contact) return { body: typeof contact.displayName === "string" ? contact.displayName : "Kontakt", kind: "contact" };
  if (msg.locationMessage) return { body: "Standort", kind: "location" };
  return null;
}

function enqueue(task: () => Promise<void>) {
  writes = writes.then(task).catch((err: unknown) => {
    lastError = err instanceof Error ? err.message : "Chats konnten nicht gespeichert werden.";
  });
}

async function rememberNames(contacts: { id?: string | null; name?: string | null; notify?: string | null }[]) {
  const sql = await getSql();
  for (const contact of contacts) {
    if (!keepJid(contact.id)) continue;
    const name = contact.name?.trim() || contact.notify?.trim() || "";
    if (!name) continue;
    names.set(contact.id, name);
    await sql`update wa_chats set name = ${name} where jid = ${contact.id} and name = ''`;
  }
}

async function saveChats(
  chats: { id?: string | null; name?: string | null; conversationTimestamp?: unknown; unreadCount?: number | null }[],
) {
  const sql = await getSql();
  for (const chat of chats) {
    if (!keepJid(chat.id)) continue;
    const name = chat.name?.trim() || names.get(chat.id) || phoneLabel(chat.id);
    const lastAt = chat.conversationTimestamp == null ? null : stamp(chat.conversationTimestamp);
    const unread = chat.unreadCount == null ? null : Number(chat.unreadCount) || 0;
    const group = isJidGroup(chat.id);
    await sql`insert into wa_chats (jid, name, preview, last_at, unread, is_group)
      values (${chat.id}, ${name}, '', ${lastAt}, ${unread ?? 0}, ${group})
      on conflict (jid) do update set
        name = case
          when wa_chats.name <> '' and (excluded.name = '' or excluded.name = 'Gruppe' or left(excluded.name, 1) = '+') then wa_chats.name
          else excluded.name
        end,
        last_at = coalesce(excluded.last_at, wa_chats.last_at),
        unread = coalesce(${unread}, wa_chats.unread),
        is_group = excluded.is_group`;
  }
}

async function saveMessages(messages: WAMessage[], touchPreview: boolean) {
  const sql = await getSql();
  const seen = new Set<string>();
  for (const message of messages) {
    const jid = message.key.remoteJid;
    if (!keepJid(jid) || !message.key.id) continue;
    const described = describe(message.message);
    if (!described) continue;
    const id = `${jid}:${message.key.id}`;
    const sender = message.key.fromMe ? "" : message.pushName?.trim() || phoneLabel(message.key.participant || jid);
    const sentAt = stamp(message.messageTimestamp);
    await sql`insert into wa_messages (id, jid, from_me, sender, body, kind, sent_at)
      values (${id}, ${jid}, ${Boolean(message.key.fromMe)}, ${sender}, ${described.body.slice(0, 4000)}, ${described.kind}, ${sentAt})
      on conflict (id) do nothing`;
    if (touchPreview) {
      const name = names.get(jid) || phoneLabel(jid);
      await sql`insert into wa_chats (jid, name, preview, last_at, unread, is_group)
        values (${jid}, ${name}, ${described.body.slice(0, 180)}, ${sentAt}, 0, ${isJidGroup(jid)})
        on conflict (jid) do update set
          preview = excluded.preview,
          last_at = excluded.last_at,
          name = case when wa_chats.name = '' then excluded.name else wa_chats.name end`;
    }
    seen.add(jid);
  }
  if (seen.size === 0) return;
  await sql`delete from wa_messages where id in (
    select id from (
      select id, row_number() over (partition by jid order by sent_at desc) as n from wa_messages
    ) ranked where n > 200
  )`;
}

function accountName(socket: WASocket): string {
  const id = socket.user?.id?.split(":")[0]?.split("@")[0];
  return id ? `+${id}` : "";
}

async function connect(gen: number) {
  phase = "connecting";
  lastError = null;
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version: [number, number, number] | undefined;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {
    version = undefined;
  }
  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  if (gen !== generation) {
    socket.end(undefined);
    return;
  }
  sock = socket;
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", (update) => {
    if (gen !== generation) return;
    if (update.qr) {
      phase = "qr";
      void QRCode.toDataURL(update.qr, { margin: 1, width: 280 }).then((url) => {
        if (gen === generation) qrDataUrl = url;
      });
    }
    if (update.connection === "open") {
      phase = "open";
      qrDataUrl = null;
      accountLabel = accountName(socket);
      lastError = null;
      reconnectDelay = 2000;
    }
    if (update.connection === "close") {
      const code = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      phase = "closed";
      qrDataUrl = null;
      sock = null;
      lastError = loggedOut ? "Das Gerät wurde abgemeldet." : "Verbindung getrennt. Neuer Versuch folgt.";
      if (loggedOut) {
        void wipeAuth();
        return;
      }
      const wait = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      setTimeout(() => {
        if (gen === generation) void ensureConnected();
      }, wait);
    }
  });
  socket.ev.on("messaging-history.set", (payload) => {
    const messages = payload.messages.slice(0, 3000);
    enqueue(async () => {
      await rememberNames(payload.contacts);
      await saveChats(payload.chats);
      await saveMessages(messages, true);
    });
  });
  socket.ev.on("chats.upsert", (chats) => enqueue(() => saveChats(chats)));
  socket.ev.on("chats.update", (chats) => enqueue(() => saveChats(chats)));
  socket.ev.on("contacts.upsert", (contacts) => enqueue(() => rememberNames(contacts)));
  socket.ev.on("contacts.update", (contacts) => enqueue(() => rememberNames(contacts)));
  socket.ev.on("messages.upsert", ({ messages }) => enqueue(() => saveMessages(messages, true)));
}

export function ensureConnected(): Promise<void> {
  if (sock && (phase === "open" || phase === "qr" || phase === "connecting")) return Promise.resolve();
  if (connectTask) return connectTask;
  const gen = ++generation;
  const task = connect(gen).finally(() => {
    if (connectTask === task) connectTask = null;
  });
  connectTask = task;
  return task;
}

async function wipeAuth() {
  generation += 1;
  sock = null;
  phase = "idle";
  qrDataUrl = null;
  accountLabel = "";
  names.clear();
  await rm(AUTH_DIR, { recursive: true, force: true });
  const sql = await getSql();
  await sql`delete from wa_messages`;
  await sql`delete from wa_chats`;
}

export async function linkSummary() {
  if (hasCreds() && phase === "idle") void ensureConnected();
  return { phase, name: accountLabel, linked: phase === "open" };
}

export async function sessionStatus() {
  if (hasCreds() && phase === "idle") void ensureConnected();
  return { phase, qrDataUrl, name: accountLabel, error: lastError, linked: phase === "open" };
}

export async function beginLink() {
  if (phase === "open" && sock) return sessionStatus();
  generation += 1;
  sock?.end(undefined);
  sock = null;
  phase = "idle";
  connectTask = null;
  await ensureConnected();
  return sessionStatus();
}

export async function logoutSession() {
  const current = sock;
  generation += 1;
  sock = null;
  try {
    await current?.logout();
  } catch {
    // The files are removed either way.
  }
  await wipeAuth();
  return sessionStatus();
}

export function sessionOpen(): boolean {
  return phase === "open" && sock !== null;
}

export async function sendText(phone: string, body: string): Promise<{ ok: boolean; error: string }> {
  if (!sock || phase !== "open") return { ok: false, error: "WhatsApp ist nicht verbunden." };
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return { ok: false, error: "Telefonnummer fehlt." };
  const looked = await sock.onWhatsApp(digits);
  const target = looked?.find((row) => row.exists)?.jid;
  if (!target) return { ok: false, error: "Diese Nummer ist nicht bei WhatsApp." };
  await sock.sendMessage(target, { text: body });
  return { ok: true, error: "" };
}

export async function sendToChat(jid: string, body: string): Promise<{ ok: boolean; error: string }> {
  if (!keepJid(jid)) return { ok: false, error: "Dieser Chat kann nicht beschrieben werden." };
  if (!sock || phase !== "open") return { ok: false, error: "WhatsApp ist nicht verbunden." };
  const text = body.trim();
  if (!text) return { ok: false, error: "Nachricht ist leer." };
  await sock.sendMessage(jid, { text });
  return { ok: true, error: "" };
}

export async function listChats() {
  if (hasCreds() && phase === "idle") void ensureConnected();
  const sql = await getSql();
  const rows = await sql<{
    jid: string;
    name: string;
    preview: string;
    last_at: string | Date | null;
    unread: number;
    is_group: boolean;
  }>`select jid, name, preview, last_at, unread, is_group from wa_chats order by last_at desc nulls last limit 200`;
  return rows.map((row) => ({
    jid: row.jid,
    name: row.name || phoneLabel(row.jid),
    preview: row.preview,
    lastAt: row.last_at instanceof Date ? row.last_at.toISOString() : row.last_at,
    unread: Number(row.unread) || 0,
    isGroup: Boolean(row.is_group),
  }));
}

export async function listMessages(jid: string) {
  if (!keepJid(jid)) return [];
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    from_me: boolean;
    sender: string;
    body: string;
    kind: string;
    sent_at: string | Date;
  }>`select id, from_me, sender, body, kind, sent_at from wa_messages where jid = ${jid} order by sent_at asc limit 200`;
  return rows.map((row) => ({
    id: row.id,
    fromMe: Boolean(row.from_me),
    sender: row.sender,
    body: row.body,
    kind: row.kind,
    sentAt: row.sent_at instanceof Date ? row.sent_at.toISOString() : String(row.sent_at),
  }));
}
