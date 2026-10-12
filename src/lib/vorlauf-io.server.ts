import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { XMLParser } from "fast-xml-parser";
import httpntlm from "httpntlm";
import type { CalEvent } from "./vorlauf.ts";

const GRAPH_HOSTS = new Set(["graph.microsoft.com", "graph.microsoft.us"]);

export type IoResult = {
  ok: boolean;
  events: CalEvent[];
  error?: string;
  loginRequired?: boolean;
  loginUrl?: string;
  pending?: boolean;
};

function privateEwsAllowed(): boolean {
  return process.env.VORLAUF_ALLOW_PRIVATE_EWS !== "false";
}

function insecureEwsTls(): boolean {
  return process.env.VORLAUF_EWS_INSECURE_TLS === "true";
}

function isMetadataHost(host: string): boolean {
  return host === "metadata.google.internal" || host === "metadata.google.com";
}

function isPrivateHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal")) {
    return true;
  }
  const kind = isIP(value);
  if (kind === 4) {
    const [a, b] = value.split(".").map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) return value === "::1" || value.startsWith("fc") || value.startsWith("fd");
  return false;
}

function blockedAddress(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isMetadataHost(value)) return true;
  const kind = isIP(value);
  if (kind === 4) {
    const [a, b] = value.split(".").map(Number);
    if (a === 169 && b === 254) return true;
    if (privateEwsAllowed()) return false;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    if (value.startsWith("fe80")) return true;
    if (privateEwsAllowed()) return false;
    return value === "::1" || value.startsWith("fc") || value.startsWith("fd");
  }
  if (privateEwsAllowed()) return false;
  return isPrivateHost(value);
}

async function assertEwsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Die Adresse ist ungültig.");
  }
  const local = isPrivateHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && privateEwsAllowed())) {
    throw new Error("EWS braucht HTTPS. Im eigenen Netz ist HTTP nur für private Namen erlaubt.");
  }
  if (url.username || url.password) throw new Error("Zugangsdaten nicht in die URL schreiben.");
  if (blockedAddress(url.hostname)) {
    throw new Error("Diese Adresse wird nicht aufgerufen.");
  }
  if (isIP(url.hostname)) return url;
  try {
    const resolved = await lookup(url.hostname);
    if (blockedAddress(resolved.address)) {
      throw new Error("Die Adresse zeigt auf ein gesperrtes Netz und wird nicht aufgerufen.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Die Adresse")) throw error;
    throw new Error("Der Exchange-Name konnte nicht aufgelöst werden. DNS vom Server prüfen.");
  }
  return url;
}

async function readLimited(res: Response, max = 1_000_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    chunks.push(step.value);
  }
  await reader.cancel().catch(() => undefined);
  const text = new TextDecoder().decode(
    chunks.reduce((acc, chunk) => {
      const next = new Uint8Array(acc.length + chunk.length);
      next.set(acc);
      next.set(chunk, acc.length);
      return next;
    }, new Uint8Array()),
  );
  return text.slice(0, max);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return asText((value as { "#text": unknown })["#text"]);
  }
  return "";
}

function graphInstant(dateTime: string, timeZone: string): string {
  if (!dateTime) return "";
  if (dateTime.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dateTime)) {
    return new Date(dateTime).toISOString();
  }
  if (!timeZone || timeZone.toUpperCase() === "UTC") {
    return new Date(`${dateTime}Z`).toISOString();
  }
  return new Date(dateTime).toISOString();
}

export async function readGraphCalendar(input: {
  token: string;
  calendarId: string;
  start: string;
  end: string;
}): Promise<IoResult> {
  const token = input.token.trim();
  if (token.length < 20) return { ok: false, events: [], error: "Graph-Zugriffstoken fehlt." };
  let path = "/v1.0/me/calendarView";
  if (input.calendarId.trim()) {
    if (!/^[A-Za-z0-9_+=\/.-]{1,400}$/.test(input.calendarId.trim())) {
      return { ok: false, events: [], error: "Kalender-ID hat ein unerwartetes Format." };
    }
    path = `/v1.0/me/calendars/${encodeURIComponent(input.calendarId.trim())}/calendarView`;
  }
  const url = new URL(`https://graph.microsoft.com${path}`);
  url.searchParams.set("startDateTime", input.start);
  url.searchParams.set("endDateTime", input.end);
  url.searchParams.set("$top", "100");
  url.searchParams.set("$select", "id,subject,start,end,location,bodyPreview,isCancelled");
  url.searchParams.set("$orderby", "start/dateTime");

  const events: CalEvent[] = [];
  let next: string | null = url.toString();
  let pages = 0;
  while (next && pages < 5) {
    const host = new URL(next).hostname;
    if (!GRAPH_HOSTS.has(host)) {
      return { ok: false, events: [], error: "Unerwartete Graph-Adresse." };
    }
    pages += 1;
    const res = await fetch(next, {
      headers: {
        authorization: `Bearer ${token}`,
        prefer: 'outlook.timezone="UTC"',
      },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    const text = await readLimited(res);
    if (!res.ok) {
      let message = `Microsoft Graph hat mit ${res.status} geantwortet.`;
      try {
        const body = JSON.parse(text) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message.slice(0, 280);
      } catch {
        /* keep status */
      }
      return { ok: false, events: [], error: message };
    }
    const body = JSON.parse(text) as {
      value?: Array<{
        id?: string;
        subject?: string;
        isCancelled?: boolean;
        bodyPreview?: string;
        location?: { displayName?: string };
        start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string };
      }>;
      "@odata.nextLink"?: string;
    };
    for (const item of body.value ?? []) {
      if (item.isCancelled) continue;
      const start = graphInstant(item.start?.dateTime ?? "", item.start?.timeZone ?? "UTC");
      const end = graphInstant(item.end?.dateTime ?? "", item.end?.timeZone ?? "UTC");
      if (!start) continue;
      events.push({
        id: item.id || `graph:${start}:${item.subject ?? ""}`,
        title: item.subject?.trim() || "Ohne Titel",
        start,
        end: end || start,
        location: item.location?.displayName?.trim() || "",
        preview: item.bodyPreview?.trim().slice(0, 240) || "",
        source: "graph",
      });
    }
    next = body["@odata.nextLink"] ?? null;
  }
  return { ok: true, events };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&" + "amp;")
    .replaceAll("<", "&" + "lt;")
    .replaceAll(">", "&" + "gt;")
    .replaceAll('"', "&" + "quot;");
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

function collectItems(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const entry of node) collectItems(entry, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if ("Subject" in obj && ("Start" in obj || "End" in obj)) out.push(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") collectItems(value, out);
  }
}

function faultText(node: unknown): string {
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.MessageText === "string") texts.push(obj.MessageText);
    if (typeof obj.faultstring === "string") texts.push(obj.faultstring);
    for (const child of Object.values(obj)) walk(child);
  };
  walk(node);
  return texts.join(" ").slice(0, 280);
}

function postXml(url: URL, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        rejectUnauthorized: !insecureEwsTls(),
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8").slice(0, 1_000_000),
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Exchange hat nicht rechtzeitig geantwortet.")));
    req.write(body);
    req.end();
  });
}

function splitNtlmUser(user: string): { domain: string; username: string } {
  const slash = user.indexOf("\\");
  if (slash > 0) return { domain: user.slice(0, slash), username: user.slice(slash + 1) };
  return { domain: "", username: user };
}

function postNtlm(
  url: URL,
  user: string,
  password: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  const account = splitNtlmUser(user);
  const agent =
    url.protocol === "https:"
      ? new https.Agent({ keepAlive: true, rejectUnauthorized: !insecureEwsTls() })
      : new http.Agent({ keepAlive: true });
  return new Promise((resolve, reject) => {
    httpntlm.post(
      {
        url: url.toString(),
        username: account.username,
        password,
        domain: account.domain,
        workstation: "",
        headers,
        body,
        agent,
        timeout: 20_000,
      },
      (err, res) => {
        if (err || !res) {
          reject(err ?? new Error("NTLM-Anmeldung fehlgeschlagen."));
          return;
        }
        const raw = res.body;
        const text = typeof raw === "string" ? raw : raw ? Buffer.from(raw).toString("utf8") : "";
        resolve({ status: res.statusCode ?? 0, text: text.slice(0, 1_000_000) });
      },
    );
  });
}

export async function readEwsCalendar(input: {
  url: string;
  user: string;
  secret: string;
  auth: "basic" | "bearer" | "ntlm";
  start: string;
  end: string;
}): Promise<IoResult> {
  let url: URL;
  try {
    url = await assertEwsUrl(input.url.trim());
  } catch (error) {
    return {
      ok: false,
      events: [],
      error: error instanceof Error ? error.message : "EWS-Adresse abgelehnt.",
    };
  }
  if (!/ews|exchange\.asmx/i.test(url.pathname)) {
    return { ok: false, events: [], error: "Die URL muss auf den EWS-Endpunkt zeigen (…/EWS/Exchange.asmx)." };
  }
  const secret = input.secret.trim();
  if (secret.length < 4) return { ok: false, events: [], error: "EWS-Geheimnis fehlt." };
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, events: [], error: "Zeitraum ungültig." };
  }
  const headers: Record<string, string> = {
    "content-type": "text/xml; charset=utf-8",
    accept: "text/xml",
  };
  if (input.auth === "bearer") {
    headers.authorization = `Bearer ${secret}`;
  } else if (input.auth !== "ntlm") {
    if (!input.user.trim()) return { ok: false, events: [], error: "EWS-Benutzer fehlt." };
    headers.authorization = `Basic ${Buffer.from(`${input.user.trim()}:${secret}`).toString("base64")}`;
  } else if (!input.user.trim()) {
    return { ok: false, events: [], error: "EWS-Benutzer fehlt." };
  }
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
 xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
 xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013_SP1"/>
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:Location"/>
          <t:FieldURI FieldURI="item:TextBody"/>
          <t:FieldURI FieldURI="item:IsCancelled"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView MaxEntriesReturned="200" StartDate="${xmlEscape(start.toISOString())}" EndDate="${xmlEscape(end.toISOString())}"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

  let status = 0;
  let text = "";
  try {
    const posted = input.auth === "ntlm" ? await postNtlm(url, input.user.trim(), secret, headers, soap) : await postXml(url, headers, soap);
    status = posted.status;
    text = posted.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : "EWS nicht erreichbar.";
    return { ok: false, events: [], error: message.slice(0, 280) };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      events: [],
      error:
        input.auth === "ntlm"
          ? "Exchange hat die NTLM-Anmeldung abgelehnt. Benutzer als DOMÄNE\\name oder name@firma.local prüfen."
          : "Exchange hat die Anmeldung abgelehnt. Bei lokalem Exchange NTLM statt Basic versuchen.",
    };
  }
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(text);
  } catch {
    return { ok: false, events: [], error: `Exchange antwortete nicht als XML (${status}).` };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      events: [],
      error: faultText(parsed) || `Exchange antwortete mit ${status}.`,
    };
  }
  const items: Record<string, unknown>[] = [];
  collectItems(parsed, items);
  if (items.length === 0) {
    const fault = faultText(parsed);
    if (/error/i.test(fault)) return { ok: false, events: [], error: fault };
  }
  const events: CalEvent[] = [];
  for (const item of items) {
    const cancelled = asText(item.IsCancelled).toLowerCase() === "true";
    if (cancelled) continue;
    const startAt = asText(item.Start);
    const endAt = asText(item.End);
    if (!startAt) continue;
    const title = asText(item.Subject) || "Ohne Titel";
    const startIso = new Date(startAt).toISOString();
    events.push({
      id: `ews:${startIso}:${title}`,
      title,
      start: startIso,
      end: endAt ? new Date(endAt).toISOString() : startIso,
      location: asText(item.Location),
      preview: asText(item.TextBody).slice(0, 240),
      source: "ews",
    });
  }
  return { ok: true, events };
}

function unwrapToolData(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (entry && typeof entry === "object" && "text" in entry) {
          return String((entry as { text: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return data;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      const dateTime = nested.dateTime ?? nested.date_time ?? nested.date;
      const timeZone = nested.timeZone ?? nested.time_zone;
      if (typeof dateTime === "string") {
        return graphInstant(dateTime, typeof timeZone === "string" ? timeZone : "UTC");
      }
      const display = nested.displayName ?? nested.display_name ?? nested.name;
      if (typeof display === "string") return display.trim();
    }
  }
  return "";
}

function collectOutlook(node: unknown, out: CalEvent[]): void {
  if (!node) return;
  if (typeof node === "string") {
    try {
      collectOutlook(JSON.parse(node), out);
    } catch {
      /* ignore */
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => collectOutlook(entry, out));
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const title = pickString(obj, ["subject", "summary", "title", "name"]);
  const start = pickString(obj, ["start", "startTime", "start_time", "time_min", "begin"]);
  const end = pickString(obj, ["end", "endTime", "end_time", "time_max"]);
  const looksDated = Boolean(start && !Number.isNaN(new Date(start).getTime()));
  if (title && looksDated) {
    const location = pickString(obj, ["location", "where"]);
    out.push({
      id: pickString(obj, ["id", "eventId", "event_id"]) || `outlook:${start}:${title}`,
      title,
      start: new Date(start).toISOString(),
      end: end && !Number.isNaN(new Date(end).getTime()) ? new Date(end).toISOString() : new Date(start).toISOString(),
      location,
      preview: pickString(obj, ["bodyPreview", "body_preview", "preview", "description", "body"]).slice(0, 240),
      source: "outlook",
    });
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") collectOutlook(value, out);
  }
}

export async function readOutlookCalendar(input: { start: string; end: string }): Promise<IoResult> {
  const { callTool } = await import("@/lib/app-data/client.server");
  const { ConnectorType } = await import("@/lib/app-data/types");
  const attempts: Array<{ name: string; args: Record<string, unknown> }> = [
    {
      name: "outlook_calendar_search",
      args: { query: "", time_min: input.start, time_max: input.end },
    },
    {
      name: "outlook_calendar_search",
      args: { start: input.start, end: input.end, query: "" },
    },
    {
      name: "outlook_calendar_list_events",
      args: { start: input.start, end: input.end },
    },
  ];
  let lastError = "Outlook-Kalender hat keine Termine geliefert.";
  let loginRequired = false;
  let loginUrl: string | undefined;
  let pending = false;
  for (const attempt of attempts) {
    const result = await callTool(attempt.name, attempt.args, {
      connectorType: ConnectorType.OutlookCalendar,
    });
    if (result.pending) {
      pending = true;
      lastError = result.errorMessage ?? lastError;
      break;
    }
    if (result.loginRequired) {
      loginRequired = true;
      loginUrl = result.loginUrl;
      lastError = result.errorMessage ?? "Anmeldung erforderlich.";
      break;
    }
    if (!result.ok) {
      lastError = result.errorMessage ?? lastError;
      const unknown = /unknown|not found|no such|unrecognized|invalid tool/i.test(lastError);
      if (unknown) continue;
      break;
    }
    const events: CalEvent[] = [];
    collectOutlook(unwrapToolData(result.data), events);
    const unique = new Map<string, CalEvent>();
    for (const event of events) unique.set(event.id, event);
    return { ok: true, events: [...unique.values()] };
  }
  return {
    ok: false,
    events: [],
    error: lastError.slice(0, 320),
    loginRequired,
    loginUrl,
    pending,
  };
}

export async function sendWhatsAppMessage(input: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const phoneNumberId = input.phoneNumberId.trim();
  if (!/^\d{6,25}$/.test(phoneNumberId)) {
    return { ok: false, error: "Phone Number ID ist ungültig." };
  }
  const to = input.to.trim();
  if (!/^\d{8,15}$/.test(to)) {
    return { ok: false, error: "Empfängernummer ist ungültig." };
  }
  const body = input.body.trim();
  if (!body || body.length > 4096) {
    return { ok: false, error: "Nachricht fehlt oder ist zu lang." };
  }
  const token = input.accessToken.trim();
  if (token.length < 20) return { ok: false, error: "WhatsApp-Token fehlt." };

  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp nicht erreichbar.";
    return { ok: false, error: message.slice(0, 240) };
  }
  const text = await readLimited(res, 100_000);
  let parsed: {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, error: `WhatsApp antwortete nicht als JSON (${res.status}).` };
  }
  if (!res.ok || parsed.error) {
    const message = parsed.error?.message || `WhatsApp antwortete mit ${res.status}.`;
    return { ok: false, error: message.replace(token, "•••").slice(0, 280) };
  }
  return { ok: true, id: parsed.messages?.[0]?.id || "gesendet" };
}
