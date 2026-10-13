import { timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import {
  DEFAULT_TEMPLATE,
  demoEvents,
  isE164,
  nextOccurrence,
  normalizePhone,
  rangeFor,
  renderTemplate,
  sendInstant,
  type CalEvent,
  type Frequency,
  type RecipientRef,
} from "@/lib/wasender";
import { readEwsCalendar, readGraphCalendar, sendWhatsAppMessage } from "@/lib/wasender-io.server";
import { isSealed, openSecret, sealSecret } from "@/lib/field-crypto.server";
import { startAlwaysOn } from "./always-on.server";

type Role = "admin" | "user";

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseRecipients(raw: string): RecipientRef[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is RecipientRef =>
        !!item &&
        typeof item === "object" &&
        ((item as RecipientRef).kind === "user" || (item as RecipientRef).kind === "contact") &&
        typeof (item as RecipientRef).id === "string",
    );
  } catch {
    return [];
  }
}

async function ensureProfile(sql: Sql, userId: string): Promise<Role> {
  const found = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
  if (found[0]?.role === "admin" || found[0]?.role === "user") return found[0].role;
  const people = await sql<{ name: string }>`select name from "user" where id = ${userId}`;
  const count = await sql<{ n: number }>`select count(*)::int as n from profiles`;
  const role: Role = Number(count[0]?.n ?? 0) === 0 ? "admin" : "user";
  await sql`insert into profiles (user_id, role, display_name, phone)
    values (${userId}, ${role}, ${sealSecret(people[0]?.name || "Konto")}, '')
    on conflict (user_id) do nothing`;
  const again = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
  return again[0]?.role === "admin" ? "admin" : "user";
}

export async function requireAdmin(sql: Sql, userId: string): Promise<void> {
  const role = await ensureProfile(sql, userId);
  if (role !== "admin") throw new Error("Nur Admins dürfen das.");
}

type Person = { id: string; name: string; phone: string };

async function directory(sql: Sql, country: string): Promise<{ contacts: Person[]; colleagues: Person[] }> {
  const contacts = await sql<{ id: string; name: string; phone: string; active: boolean; note: string; created_by: string }>`
    select id, name, phone, active, note, created_by from contacts order by name`;
  const colleagues = await sql<{ user_id: string; display_name: string; phone: string }>`
    select user_id, display_name, phone from profiles where phone <> '' order by display_name`;
  return {
    contacts: contacts.filter((row) => row.active).map((row) => ({
      id: row.id,
      name: openSecret(row.name),
      phone: normalizePhone(openSecret(row.phone), country),
    })).sort((a, b) => a.name.localeCompare(b.name, "de")),
    colleagues: colleagues.map((row) => ({
      id: row.user_id,
      name: openSecret(row.display_name) || "Konto",
      phone: normalizePhone(openSecret(row.phone), country),
    })).sort((a, b) => a.name.localeCompare(b.name, "de")),
  };
}

function resolvePeople(refs: RecipientRef[], contacts: Person[], colleagues: Person[]): Person[] {
  const out: Person[] = [];
  for (const ref of refs) {
    const pool = ref.kind === "user" ? colleagues : contacts;
    const person = pool.find((item) => item.id === ref.id);
    if (person && isE164(person.phone)) out.push(person);
  }
  return out;
}

async function org(sql: Sql) {
  const rows = await sql<{
    phone_number_id: string;
    access_token: string;
    country_code: string;
    time_zone: string;
  }>`select phone_number_id, access_token, country_code, time_zone from org_settings where id = 'org'`;
  return (
    rows[0]
      ? { ...rows[0], access_token: openSecret(rows[0].access_token) }
      : {
          phone_number_id: "",
          access_token: "",
          country_code: "49",
          time_zone: "Europe/Berlin",
        }
  );
}

function publicOrg(
  row: { phone_number_id: string; access_token: string; country_code: string; time_zone: string },
  linked: boolean,
) {
  const token = row.access_token.trim();
  return {
    phoneNumberId: row.phone_number_id,
    countryCode: row.country_code,
    timeZone: row.time_zone,
    configured: linked || (token.length >= 20 && row.phone_number_id.trim().length > 0),
    linked,
    tokenHint: token ? `••••${token.slice(-4)}` : "",
  };
}

let protecting: Promise<void> | null = null;

function protectStoredSecrets(sql: Sql): Promise<void> {
  protecting ??= rewriteSecrets(sql).catch((err) => {
    protecting = null;
    throw err;
  });
  return protecting;
}

async function rewriteSecrets(sql: Sql) {
  const profiles = await sql<{ user_id: string; display_name: string; phone: string }>`
    select user_id, display_name, phone from profiles`;
  for (const row of profiles) {
    if (isSealed(row.display_name) && (!row.phone || isSealed(row.phone))) continue;
    await sql`update profiles set display_name = ${sealSecret(row.display_name)}, phone = ${sealSecret(row.phone)} where user_id = ${row.user_id}`;
  }
  const contacts = await sql<{ id: string; name: string; phone: string; note: string }>`select id, name, phone, note from contacts`;
  for (const row of contacts) {
    if (isSealed(row.name) && isSealed(row.phone) && (!row.note || isSealed(row.note))) continue;
    await sql`update contacts set name = ${sealSecret(row.name)}, phone = ${sealSecret(row.phone)}, note = ${sealSecret(row.note)} where id = ${row.id}`;
  }
  const routines = await sql<{ id: string; title: string; body: string; recipients: string }>`select id, title, body, recipients from routines`;
  for (const row of routines) {
    if (isSealed(row.title) && isSealed(row.body) && isSealed(row.recipients)) continue;
    await sql`update routines set title = ${sealSecret(row.title)}, body = ${sealSecret(row.body)}, recipients = ${sealSecret(row.recipients)} where id = ${row.id}`;
  }
  const jobs = await sql<{ id: string; title: string; phone: string; contact_name: string; body: string; error: string | null }>`
    select id, title, phone, contact_name, body, error from jobs`;
  for (const row of jobs) {
    if (isSealed(row.title) && isSealed(row.phone) && (!row.contact_name || isSealed(row.contact_name)) && isSealed(row.body) && (!row.error || isSealed(row.error))) continue;
    await sql`update jobs set title = ${sealSecret(row.title)}, phone = ${sealSecret(row.phone)}, contact_name = ${sealSecret(row.contact_name)},
      body = ${sealSecret(row.body)}, error = ${row.error ? sealSecret(row.error) : null} where id = ${row.id}`;
  }
  const rules = await sql<{ id: string; name: string; title_contains: string; recipients: string; template: string }>`
    select id, name, title_contains, recipients, template from calendar_rules`;
  for (const row of rules) {
    if (isSealed(row.name) && (!row.title_contains || isSealed(row.title_contains)) && isSealed(row.recipients) && isSealed(row.template)) continue;
    await sql`update calendar_rules set name = ${sealSecret(row.name)}, title_contains = ${sealSecret(row.title_contains)},
      recipients = ${sealSecret(row.recipients)}, template = ${sealSecret(row.template)} where id = ${row.id}`;
  }
  const orgRows = await sql<{ access_token: string }>`select access_token from org_settings where id = 'org'`;
  if (orgRows[0]?.access_token && !isSealed(orgRows[0].access_token)) {
    await sql`update org_settings set access_token = ${sealSecret(orgRows[0].access_token)} where id = 'org'`;
  }
  const sources = await sql<{ user_id: string; graph_token: string; ews_user: string; ews_secret: string }>`
    select user_id, graph_token, ews_user, ews_secret from user_sources`;
  for (const row of sources) {
    if ((!row.graph_token || isSealed(row.graph_token)) && (!row.ews_user || isSealed(row.ews_user)) && (!row.ews_secret || isSealed(row.ews_secret))) continue;
    await sql`update user_sources set graph_token = ${sealSecret(row.graph_token)}, ews_user = ${sealSecret(row.ews_user)}, ews_secret = ${sealSecret(row.ews_secret)} where user_id = ${row.user_id}`;
  }
  const chats = await sql<{ jid: string; name: string; preview: string }>`select jid, name, preview from wa_chats`;
  for (const row of chats) {
    if ((!row.name || isSealed(row.name)) && (!row.preview || isSealed(row.preview))) continue;
    await sql`update wa_chats set name = ${sealSecret(row.name)}, preview = ${sealSecret(row.preview)} where jid = ${row.jid}`;
  }
  const messages = await sql<{ id: string; sender: string; body: string }>`select id, sender, body from wa_messages`;
  for (const row of messages) {
    if ((!row.sender || isSealed(row.sender)) && isSealed(row.body)) continue;
    await sql`update wa_messages set sender = ${sealSecret(row.sender)}, body = ${sealSecret(row.body)} where id = ${row.id}`;
  }
}

export async function bootstrap(userId: string) {
  const sql = await getSql();
  await protectStoredSecrets(sql);
  const role = await ensureProfile(sql, userId);
  const me = await sql<{ display_name: string; phone: string; email: string }>`
    select p.display_name, p.phone, u.email
    from profiles p join "user" u on u.id = p.user_id
    where p.user_id = ${userId}`;
  const settings = await org(sql);
  const link = await import("./wa-session.server")
    .then((mod) => mod.linkSummary())
    .catch(() => ({ phase: "closed" as const, name: "", linked: false }));
  const book = await directory(sql, settings.country_code);
  const contactRows = await sql<{
    id: string;
    name: string;
    phone: string;
    note: string;
    active: boolean;
    created_by: string;
  }>`select id, name, phone, note, active, created_by from contacts order by name`;
  const routineRows = role === "admin"
    ? await sql<RoutineRow>`select id, owner_id, title, body, frequency, weekdays, month_day, time_local, time_zone, recipients, enabled, next_run from routines order by title`
    : await sql<RoutineRow>`select id, owner_id, title, body, frequency, weekdays, month_day, time_local, time_zone, recipients, enabled, next_run from routines where owner_id = ${userId} order by title`;
  const jobRows = role === "admin"
    ? await sql<JobRow>`select id, owner_id, routine_id, title, phone, contact_name, body, send_at, status, error, sent_at from jobs order by send_at desc limit 200`
    : await sql<JobRow>`select id, owner_id, routine_id, title, phone, contact_name, body, send_at, status, error, sent_at from jobs where owner_id = ${userId} order by send_at desc limit 200`;
  const ruleRows = await sql<RuleRow>`
    select id, name, enabled, title_contains, minutes, anchor, recipients, template
    from calendar_rules where owner_id = ${userId} order by name`;
  const sourceRows = await sql<SourceRow>`
    select source, graph_calendar_id, ews_url, ews_user, ews_auth, horizon_days,
           graph_token, ews_secret
    from user_sources where user_id = ${userId}`;
  const accounts = role === "admin"
    ? await sql<{ id: string; email: string; name: string; role: string | null; phone: string | null }>`
        select u.id, u.email, u.name, p.role, p.phone
        from "user" u
        left join profiles p on p.user_id = u.id
        order by u."createdAt"`
    : [];
  const source = sourceRows[0];
  return {
    role,
    displayName: openSecret(me[0]?.display_name ?? ""),
    email: me[0]?.email ?? "",
    phone: openSecret(me[0]?.phone ?? ""),
    contacts: contactRows
      .map((row) => ({ ...row, name: openSecret(row.name), phone: openSecret(row.phone), note: openSecret(row.note) }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .filter((row) => row.active || role === "admin" || row.created_by === userId),
    colleagues: book.colleagues,
    routines: routineRows.map(presentRoutine).sort((a, b) => a.title.localeCompare(b.title, "de")),
    jobs: jobRows.map(presentJob),
    rules: ruleRows.map((row) => revealRule(row)).map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      titleContains: row.title_contains,
      minutes: row.minutes,
      anchor: row.anchor === "end" ? "end" : "start",
      recipients: parseRecipients(row.recipients),
      template: row.template,
    })).sort((a, b) => a.name.localeCompare(b.name, "de")),
    org: { ...publicOrg(settings, link.linked), linkPhase: link.phase, linkName: link.name },
    source: {
      source: source?.source ?? "demo",
      graphCalendarId: source?.graph_calendar_id ?? "",
      ewsUrl: source?.ews_url || "https://exchange.local/EWS/Exchange.asmx",
      ewsUser: openSecret(source?.ews_user ?? ""),
      ewsAuth: (source?.ews_auth === "bearer" || source?.ews_auth === "basic" || source?.ews_auth === "ntlm" ? source.ews_auth : "ntlm") as "basic" | "bearer" | "ntlm",
      horizonDays: source?.horizon_days ?? 14,
      hasGraphToken: Boolean(openSecret(source?.graph_token ?? "")),
      hasEwsSecret: Boolean(openSecret(source?.ews_secret ?? "")),
    },
    accounts: accounts.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role === "admin" ? "admin" : "user",
      phone: openSecret(row.phone ?? ""),
    })),
  };
}

type RoutineRow = {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  frequency: string;
  weekdays: string;
  month_day: number;
  time_local: string;
  time_zone: string;
  recipients: string;
  enabled: boolean;
  next_run: unknown;
};

type JobRow = {
  id: string;
  owner_id: string;
  routine_id: string | null;
  title: string;
  phone: string;
  contact_name: string;
  body: string;
  send_at: unknown;
  status: string;
  error: string | null;
  sent_at: unknown;
};

type RuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  title_contains: string;
  minutes: number;
  anchor: string;
  recipients: string;
  template: string;
};

type SourceRow = {
  source: string;
  graph_calendar_id: string;
  ews_url: string;
  ews_user: string;
  ews_auth: string;
  horizon_days: number;
  graph_token: string;
  ews_secret: string;
};

function revealRoutine(row: RoutineRow): RoutineRow {
  return { ...row, title: openSecret(row.title), body: openSecret(row.body), recipients: openSecret(row.recipients) };
}

function revealRule(row: RuleRow): RuleRow {
  return {
    ...row,
    name: openSecret(row.name),
    title_contains: openSecret(row.title_contains),
    recipients: openSecret(row.recipients),
    template: openSecret(row.template),
  };
}

function presentRoutine(row: RoutineRow) {
  const plain = revealRoutine(row);
  return {
    id: plain.id,
    ownerId: plain.owner_id,
    title: plain.title,
    body: plain.body,
    frequency: (plain.frequency === "weekly" || plain.frequency === "monthly" ? plain.frequency : "daily") as Frequency,
    weekdays: plain.weekdays.split(",").map(Number).filter((n) => n >= 1 && n <= 7),
    monthDay: plain.month_day,
    timeLocal: plain.time_local,
    timeZone: plain.time_zone,
    recipients: parseRecipients(plain.recipients),
    enabled: plain.enabled,
    nextRun: iso(plain.next_run),
  };
}

function presentJob(row: JobRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    routineId: row.routine_id,
    title: openSecret(row.title),
    phone: openSecret(row.phone),
    contactName: openSecret(row.contact_name),
    body: openSecret(row.body),
    sendAt: iso(row.send_at) ?? new Date(0).toISOString(),
    status: row.status,
    error: row.error == null ? null : openSecret(row.error),
    sentAt: iso(row.sent_at),
  };
}

export async function savePhone(userId: string, phone: string) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const settings = await org(sql);
  const normalized = phone.trim() ? normalizePhone(phone, settings.country_code) : "";
  if (normalized && !isE164(normalized)) throw new Error("Telefonnummer prüfen.");
  await sql`update profiles set phone = ${sealSecret(normalized)} where user_id = ${userId}`;
  return bootstrap(userId);
}

export async function saveContact(userId: string, input: { id?: string; name: string; phone: string; note: string }) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const settings = await org(sql);
  const phone = normalizePhone(input.phone, settings.country_code);
  if (!input.name.trim()) throw new Error("Name fehlt.");
  if (!isE164(phone)) throw new Error("Telefonnummer prüfen.");
  const id = input.id?.trim() || crypto.randomUUID();
  const existing = await sql<{ created_by: string }>`select created_by from contacts where id = ${id}`;
  if (existing[0] && existing[0].created_by !== userId) {
    await requireAdmin(sql, userId);
    await sql`update contacts set name = ${sealSecret(input.name.trim())}, phone = ${sealSecret(phone)}, note = ${sealSecret(input.note.trim())} where id = ${id}`;
  } else if (existing[0]) {
    await sql`update contacts set name = ${sealSecret(input.name.trim())}, phone = ${sealSecret(phone)}, note = ${sealSecret(input.note.trim())} where id = ${id}`;
  } else {
    await sql`insert into contacts (id, name, phone, note, created_by) values (${id}, ${sealSecret(input.name.trim())}, ${sealSecret(phone)}, ${sealSecret(input.note.trim())}, ${userId})`;
  }
  return bootstrap(userId);
}

export async function removeContact(userId: string, id: string) {
  const sql = await getSql();
  const role = await ensureProfile(sql, userId);
  if (role === "admin") await sql`delete from contacts where id = ${id}`;
  else await sql`delete from contacts where id = ${id} and created_by = ${userId}`;
  return bootstrap(userId);
}

export async function saveRoutine(
  userId: string,
  input: {
    id?: string;
    title: string;
    body: string;
    frequency: Frequency;
    weekdays: number[];
    monthDay: number;
    timeLocal: string;
    recipients: RecipientRef[];
    enabled: boolean;
  },
) {
  const sql = await getSql();
  const role = await ensureProfile(sql, userId);
  const settings = await org(sql);
  if (!input.title.trim() || !input.body.trim()) throw new Error("Titel und Text brauchen einen Inhalt.");
  if (!/^\d{2}:\d{2}$/.test(input.timeLocal)) throw new Error("Uhrzeit fehlt.");
  if (input.recipients.length === 0) throw new Error("Mindestens einen Empfänger auswählen.");
  const id = input.id?.trim() || crypto.randomUUID();
  const existing = await sql<{ owner_id: string }>`select owner_id from routines where id = ${id}`;
  if (existing[0] && existing[0].owner_id !== userId && role !== "admin") throw new Error("Dieser Termin gehört jemand anderem.");
  const owner = existing[0]?.owner_id ?? userId;
  const next = nextOccurrence({
    frequency: input.frequency,
    weekdays: input.weekdays,
    monthDay: input.monthDay,
    timeLocal: input.timeLocal,
    timeZone: settings.time_zone,
    after: new Date(),
  });
  const weekdays = [...new Set(input.weekdays.filter((day) => day >= 1 && day <= 7))].sort().join(",");
  const recipients = sealSecret(JSON.stringify(input.recipients.slice(0, 40)));
  if (existing[0]) {
    await sql`update routines set title = ${sealSecret(input.title.trim())}, body = ${sealSecret(input.body.trim())},
      frequency = ${input.frequency}, weekdays = ${weekdays}, month_day = ${Math.min(28, Math.max(1, input.monthDay || 1))},
      time_local = ${input.timeLocal}, time_zone = ${settings.time_zone}, recipients = ${recipients},
      enabled = ${input.enabled}, next_run = ${next.toISOString()}
      where id = ${id}`;
  } else {
    await sql`insert into routines (id, owner_id, title, body, frequency, weekdays, month_day, time_local, time_zone, recipients, enabled, next_run)
      values (${id}, ${owner}, ${sealSecret(input.title.trim())}, ${sealSecret(input.body.trim())}, ${input.frequency}, ${weekdays},
        ${Math.min(28, Math.max(1, input.monthDay || 1))}, ${input.timeLocal}, ${settings.time_zone}, ${recipients},
        ${input.enabled}, ${next.toISOString()})`;
  }
  return bootstrap(userId);
}

export async function removeRoutine(userId: string, id: string) {
  const sql = await getSql();
  const role = await ensureProfile(sql, userId);
  if (role === "admin") {
    await sql`delete from routines where id = ${id}`;
    await sql`delete from jobs where routine_id = ${id} and status = 'queued'`;
  } else {
    await sql`delete from routines where id = ${id} and owner_id = ${userId}`;
    await sql`delete from jobs where routine_id = ${id} and status = 'queued' and owner_id = ${userId}`;
  }
  return bootstrap(userId);
}

export async function queueManual(userId: string, input: { recipients: RecipientRef[]; body: string; sendAt: string }) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const settings = await org(sql);
  const book = await directory(sql, settings.country_code);
  const people = resolvePeople(input.recipients, book.contacts, book.colleagues);
  if (people.length === 0) throw new Error("Keinen erreichbaren Empfänger ausgewählt.");
  if (!input.body.trim()) throw new Error("Text fehlt.");
  const when = new Date(input.sendAt);
  if (Number.isNaN(when.getTime())) throw new Error("Zeitpunkt fehlt.");
  for (const person of people) {
    const id = crypto.randomUUID();
    await sql`insert into jobs (id, owner_id, title, phone, contact_name, body, send_at, status, dedupe_key)
      values (${id}, ${userId}, ${sealSecret("Manuell")}, ${sealSecret(person.phone)}, ${sealSecret(person.name)}, ${sealSecret(input.body.trim())}, ${when.toISOString()}, 'queued', ${id})`;
  }
  return bootstrap(userId);
}

export async function cancelJob(userId: string, id: string) {
  const sql = await getSql();
  const role = await ensureProfile(sql, userId);
  if (role === "admin") await sql`delete from jobs where id = ${id} and status = 'queued'`;
  else await sql`delete from jobs where id = ${id} and status = 'queued' and owner_id = ${userId}`;
  return bootstrap(userId);
}

export async function retryJob(userId: string, id: string) {
  const sql = await getSql();
  const role = await ensureProfile(sql, userId);
  if (role === "admin") await sql`update jobs set status = 'queued', error = null where id = ${id} and status = 'failed'`;
  else await sql`update jobs set status = 'queued', error = null where id = ${id} and status = 'failed' and owner_id = ${userId}`;
  return bootstrap(userId);
}

async function expandRoutines(sql: Sql, now: Date) {
  const settings = await org(sql);
  const book = await directory(sql, settings.country_code);
  const routines = (await sql<RoutineRow>`select id, owner_id, title, body, frequency, weekdays, month_day, time_local, time_zone, recipients, enabled, next_run from routines where enabled = true`).map(revealRoutine);
  const horizon = now.getTime() + 36 * 60 * 60_000;
  for (const routine of routines) {
    const frequency: Frequency = routine.frequency === "weekly" || routine.frequency === "monthly" ? routine.frequency : "daily";
    const spec = {
      frequency,
      weekdays: routine.weekdays.split(",").map(Number).filter((n) => n >= 1 && n <= 7),
      monthDay: routine.month_day,
      timeLocal: routine.time_local,
      timeZone: routine.time_zone || settings.time_zone,
    };
    let next = iso(routine.next_run) ? new Date(iso(routine.next_run) as string) : nextOccurrence({ ...spec, after: new Date(now.getTime() - 1000) });
    if (next.getTime() < now.getTime() - 15 * 60_000) next = nextOccurrence({ ...spec, after: now });
    let guard = 0;
    while (next.getTime() <= horizon && guard < 40) {
      const people = resolvePeople(parseRecipients(routine.recipients), book.contacts, book.colleagues);
      for (const person of people) {
        const key = `${routine.id}:${person.id}:${next.toISOString().slice(0, 16)}`;
        const id = crypto.randomUUID();
        await sql`insert into jobs (id, owner_id, routine_id, title, phone, contact_name, body, send_at, status, dedupe_key)
          values (${id}, ${routine.owner_id}, ${routine.id}, ${sealSecret(routine.title)}, ${sealSecret(person.phone)}, ${sealSecret(person.name)}, ${sealSecret(routine.body)}, ${next.toISOString()}, 'queued', ${key})
          on conflict (dedupe_key) do nothing`;
      }
      next = nextOccurrence({ ...spec, after: next });
      guard += 1;
    }
    await sql`update routines set next_run = ${next.toISOString()} where id = ${routine.id}`;
  }
}

const dispatchGate = globalThis as { __wasenderDispatch?: boolean };
const calendarGate = globalThis as { __wasenderCalendarAt?: number; __wasenderCalendarBusy?: boolean };

function permanentSendError(error: string): boolean {
  const text = error.toLowerCase();
  return (
    text.includes("nicht bei whatsapp") ||
    text.includes("ungültig") ||
    text.includes("fehlt") ||
    text.includes("zu lang") ||
    text.includes("leer") ||
    text.includes("kann nicht beschrieben")
  );
}

function retryDelayMs(attempts: number): number {
  const minutes = [1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 180];
  return (minutes[Math.min(attempts, minutes.length - 1)] ?? 180) * 60_000;
}

async function dispatchDue(sql: Sql, now: Date): Promise<{ sent: number; failed: number; warning: string | null }> {
  if (dispatchGate.__wasenderDispatch) return { sent: 0, failed: 0, warning: null };
  dispatchGate.__wasenderDispatch = true;
  try {
    await sql`update jobs set status = 'queued' where status = 'sending'`;
    const settings = await org(sql);
    const session = await import("./wa-session.server").catch(() => null);
    const live = session?.sessionOpen() ?? false;
    const cloud = settings.access_token.trim().length >= 20 && settings.phone_number_id.trim().length > 0;
    if (!live && !cloud) return { sent: 0, failed: 0, warning: "WhatsApp ist noch nicht verbunden." };
    let sent = 0;
    let failed = 0;
    const due = await sql<{ id: string; phone: string; body: string; attempts: number }>`
      select id, phone, body, attempts from jobs
      where status = 'queued' and send_at <= ${now.toISOString()}
        and (retry_at is null or retry_at <= ${now.toISOString()})
      order by send_at asc limit 5`;
    for (const job of due) {
      const locked = await sql<{ id: string }>`
        update jobs set status = 'sending' where id = ${job.id} and status = 'queued' returning id`;
      if (!locked[0]) continue;
      const phone = openSecret(job.phone);
      const body = openSecret(job.body);
      const result = live && session
        ? await session.sendText(phone, body).catch((err: unknown) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : "Versand fehlgeschlagen.",
          }))
        : await sendWhatsAppMessage({
            phoneNumberId: settings.phone_number_id,
            accessToken: settings.access_token,
            to: phone,
            body,
          });
      if (result.ok) {
        sent += 1;
        await sql`update jobs set status = 'sent', sent_at = ${new Date().toISOString()}, error = null, retry_at = null where id = ${job.id}`;
        continue;
      }
      const attempts = Number(job.attempts ?? 0) + 1;
      if (permanentSendError(result.error) || attempts >= 12) {
        failed += 1;
        await sql`update jobs set status = 'failed', attempts = ${attempts}, error = ${sealSecret(result.error)}, retry_at = null where id = ${job.id}`;
      } else {
        const retryAt = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
        await sql`update jobs set status = 'queued', attempts = ${attempts}, error = ${sealSecret(result.error)}, retry_at = ${retryAt} where id = ${job.id}`;
      }
    }
    return { sent, failed, warning: null };
  } finally {
    dispatchGate.__wasenderDispatch = false;
  }
}

async function materializeCalendars(sql: Sql) {
  const last = calendarGate.__wasenderCalendarAt ?? 0;
  if (calendarGate.__wasenderCalendarBusy || Date.now() - last < 5 * 60_000) return;
  calendarGate.__wasenderCalendarBusy = true;
  calendarGate.__wasenderCalendarAt = Date.now();
  try {
    const owners = await sql<{ owner_id: string }>`
      select distinct r.owner_id
      from calendar_rules r
      join user_sources s on s.user_id = r.owner_id
      where r.enabled = true and s.source in ('graph', 'ews')`;
    for (const owner of owners) {
      try {
        const loaded = await loadCalendar(owner.owner_id);
        if (!loaded.ok || loaded.events.length === 0) continue;
        await applyRules(owner.owner_id, loaded.events);
      } catch (err) {
        console.error("[wasender] Kalender", owner.owner_id, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    calendarGate.__wasenderCalendarBusy = false;
  }
}

export function pulseConfigured(): boolean {
  return Boolean(process.env.WASENDER_PULSE_SECRET?.trim());
}

export function pulseAuthorized(header: string | null): boolean {
  const secret = process.env.WASENDER_PULSE_SECRET?.trim();
  const match = /^Bearer\s+(\S+)$/.exec(header ?? "");
  if (!secret || !match) return false;
  const given = Buffer.from(match[1]);
  const want = Buffer.from(secret);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

export async function systemPulse() {
  const sql = await getSql();
  await protectStoredSecrets(sql);
  await import("./wa-session.server").then((mod) => mod.keepAlive()).catch(() => undefined);
  const now = new Date();
  await expandRoutines(sql, now);
  const result = await dispatchDue(sql, now);
  await materializeCalendars(sql).catch((err: unknown) => {
    console.error("[wasender] Kalender", err instanceof Error ? err.message : err);
  });
  const pending = await sql<{ n: number }>`select count(*)::int as n from jobs where status = 'queued'`;
  return { ...result, queued: Number(pending[0]?.n ?? 0) };
}

export async function pulse(userId: string) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const now = new Date();
  await expandRoutines(sql, now);
  const result = await dispatchDue(sql, now);
  const state = await bootstrap(userId);
  return { sent: result.sent, warning: result.warning, jobs: state.jobs, routines: state.routines };
}

export async function saveOrg(
  userId: string,
  input: { phoneNumberId: string; accessToken: string; countryCode: string; timeZone: string },
) {
  const sql = await getSql();
  await requireAdmin(sql, userId);
  const current = await org(sql);
  const token = input.accessToken.trim() && !input.accessToken.includes("••••") ? input.accessToken.trim() : current.access_token;
  await sql`update org_settings set phone_number_id = ${input.phoneNumberId.trim()}, access_token = ${sealSecret(token)},
    country_code = ${input.countryCode.replace(/\D/g, "") || "49"}, time_zone = ${input.timeZone.trim() || "Europe/Berlin"}
    where id = 'org'`;
  return bootstrap(userId);
}

export async function setAccount(userId: string, input: { id: string; role: Role; phone: string }) {
  const sql = await getSql();
  await requireAdmin(sql, userId);
  if (input.role !== "admin" && input.role !== "user") throw new Error("Rolle ungültig.");
  if (input.id === userId && input.role !== "admin") {
    const admins = await sql<{ n: number }>`select count(*)::int as n from profiles where role = 'admin'`;
    if (Number(admins[0]?.n ?? 0) <= 1) throw new Error("Der letzte Admin kann sich nicht selbst herabstufen.");
  }
  const settings = await org(sql);
  const phone = input.phone.trim() ? normalizePhone(input.phone, settings.country_code) : "";
  if (phone && !isE164(phone)) throw new Error("Telefonnummer prüfen.");
  const people = await sql<{ name: string }>`select name from "user" where id = ${input.id}`;
  if (!people[0]) throw new Error("Konto nicht gefunden.");
  await sql`insert into profiles (user_id, role, display_name, phone)
    values (${input.id}, ${input.role}, ${sealSecret(people[0].name)}, ${sealSecret(phone)})
    on conflict (user_id) do update set role = ${input.role}, phone = ${sealSecret(phone)}`;
  return bootstrap(userId);
}

export async function saveRule(
  userId: string,
  input: {
    id?: string;
    name: string;
    enabled: boolean;
    titleContains: string;
    minutes: number;
    anchor: "start" | "end";
    recipients: RecipientRef[];
    template: string;
  },
) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  if (!input.name.trim()) throw new Error("Name fehlt.");
  if (input.recipients.length === 0) throw new Error("Empfänger auswählen.");
  const id = input.id?.trim() || crypto.randomUUID();
  const existing = await sql<{ owner_id: string }>`select owner_id from calendar_rules where id = ${id}`;
  if (existing[0] && existing[0].owner_id !== userId) throw new Error("Diese Regel gehört jemand anderem.");
  const recipients = sealSecret(JSON.stringify(input.recipients.slice(0, 40)));
  const minutes = Math.max(0, Math.min(10080, input.minutes || 0));
  const template = sealSecret(input.template.trim() || DEFAULT_TEMPLATE);
  if (existing[0]) {
    await sql`update calendar_rules set name = ${sealSecret(input.name.trim())}, enabled = ${input.enabled}, title_contains = ${sealSecret(input.titleContains.trim())},
      minutes = ${minutes}, anchor = ${input.anchor}, recipients = ${recipients}, template = ${template} where id = ${id} and owner_id = ${userId}`;
  } else {
    await sql`insert into calendar_rules (id, owner_id, name, enabled, title_contains, minutes, anchor, recipients, template)
      values (${id}, ${userId}, ${sealSecret(input.name.trim())}, ${input.enabled}, ${sealSecret(input.titleContains.trim())}, ${minutes}, ${input.anchor}, ${recipients}, ${template})`;
  }
  return bootstrap(userId);
}

export async function removeRule(userId: string, id: string) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  await sql`delete from calendar_rules where id = ${id} and owner_id = ${userId}`;
  return bootstrap(userId);
}

export async function applyRules(userId: string, events: CalEvent[]) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const settings = await org(sql);
  const book = await directory(sql, settings.country_code);
  const rules = (await sql<RuleRow>`select id, name, enabled, title_contains, minutes, anchor, recipients, template from calendar_rules where owner_id = ${userId} and enabled = true`).map(revealRule);
  const now = Date.now();
  let created = 0;
  for (const rule of rules) {
    const people = resolvePeople(parseRecipients(rule.recipients), book.contacts, book.colleagues);
    if (people.length === 0) continue;
    const needle = rule.title_contains.trim().toLowerCase();
    for (const event of events.slice(0, 200)) {
      if (needle && !`${event.title} ${event.location}`.toLowerCase().includes(needle)) continue;
      const anchor = rule.anchor === "end" ? event.end : event.start;
      const when = sendInstant(anchor, rule.minutes);
      if (Number.isNaN(when.getTime()) || when.getTime() < now - 2 * 60_000) continue;
      const body = renderTemplate(rule.template || DEFAULT_TEMPLATE, event, settings.time_zone).trim();
      for (const person of people) {
        const key = `${rule.id}:${event.id}:${person.id}:${when.toISOString().slice(0, 16)}`;
        const id = crypto.randomUUID();
        const inserted = await sql<{ id: string }>`insert into jobs (id, owner_id, title, phone, contact_name, body, send_at, status, dedupe_key)
          values (${id}, ${userId}, ${sealSecret(event.title || rule.name)}, ${sealSecret(person.phone)}, ${sealSecret(person.name)}, ${sealSecret(body)}, ${when.toISOString()}, 'queued', ${key})
          on conflict (dedupe_key) do nothing returning id`;
        if (inserted[0]) created += 1;
      }
    }
  }
  const state = await bootstrap(userId);
  return { created, jobs: state.jobs };
}

export async function saveSource(
  userId: string,
  input: {
    source: string;
    graphToken: string;
    graphCalendarId: string;
    ewsUrl: string;
    ewsUser: string;
    ewsSecret: string;
    ewsAuth: "basic" | "bearer" | "ntlm";
    horizonDays: number;
  },
) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const current = await sql<SourceRow>`select graph_token, ews_secret from user_sources where user_id = ${userId}`;
  const storedToken = openSecret(current[0]?.graph_token ?? "");
  const storedSecret = openSecret(current[0]?.ews_secret ?? "");
  const graphToken = input.graphToken.trim() && !input.graphToken.includes("••••") ? input.graphToken.trim() : storedToken;
  const ewsSecret = input.ewsSecret.trim() && !input.ewsSecret.includes("••••") ? input.ewsSecret.trim() : storedSecret;
  const source = ["demo", "outlook", "graph", "ews"].includes(input.source) ? input.source : "demo";
  const days = Math.min(60, Math.max(1, input.horizonDays || 14));
  await sql`insert into user_sources (user_id, source, graph_token, graph_calendar_id, ews_url, ews_user, ews_secret, ews_auth, horizon_days)
    values (${userId}, ${source}, ${sealSecret(graphToken)}, ${input.graphCalendarId.trim()}, ${input.ewsUrl.trim()}, ${sealSecret(input.ewsUser.trim())}, ${sealSecret(ewsSecret)}, ${input.ewsAuth}, ${days})
    on conflict (user_id) do update set source = ${source}, graph_token = ${sealSecret(graphToken)}, graph_calendar_id = ${input.graphCalendarId.trim()},
      ews_url = ${input.ewsUrl.trim()}, ews_user = ${sealSecret(input.ewsUser.trim())}, ews_secret = ${sealSecret(ewsSecret)}, ews_auth = ${input.ewsAuth}, horizon_days = ${days}`;
  return bootstrap(userId);
}

export async function loadCalendar(userId: string) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const rows = await sql<SourceRow>`select source, graph_calendar_id, ews_url, ews_user, ews_auth, horizon_days, graph_token, ews_secret from user_sources where user_id = ${userId}`;
  const source = rows[0]
    ? { ...rows[0], ews_user: openSecret(rows[0].ews_user), graph_token: openSecret(rows[0].graph_token), ews_secret: openSecret(rows[0].ews_secret) }
    : undefined;
  const kind = source?.source ?? "demo";
  const range = rangeFor(new Date(), source?.horizon_days ?? 14);
  if (kind === "demo") return { ok: true as const, events: demoEvents(), error: undefined };
  if (kind === "outlook") {
    return { ok: false as const, events: [], error: "Outlook über Grok ist entfernt. Kalender läuft über den lokalen Exchange per EWS." };
  }
  if (kind === "graph") {
    return readGraphCalendar({
      token: source?.graph_token ?? "",
      calendarId: source?.graph_calendar_id ?? "",
      ...range,
    });
  }
  return readEwsCalendar({
    url: source?.ews_url ?? "",
    user: source?.ews_user ?? "",
    secret: source?.ews_secret ?? "",
    auth: source?.ews_auth === "bearer" || source?.ews_auth === "basic" || source?.ews_auth === "ntlm" ? source.ews_auth : "ntlm",
    ...range,
  });
}

startAlwaysOn();

