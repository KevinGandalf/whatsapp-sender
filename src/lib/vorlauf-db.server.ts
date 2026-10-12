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
} from "@/lib/vorlauf";
import { readEwsCalendar, readGraphCalendar, readOutlookCalendar, sendWhatsAppMessage } from "@/lib/vorlauf-io.server";

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
    values (${userId}, ${role}, ${people[0]?.name || "Konto"}, '')
    on conflict (user_id) do nothing`;
  const again = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
  return again[0]?.role === "admin" ? "admin" : "user";
}

async function requireAdmin(sql: Sql, userId: string): Promise<void> {
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
      name: row.name,
      phone: normalizePhone(row.phone, country),
    })),
    colleagues: colleagues.map((row) => ({
      id: row.user_id,
      name: row.display_name || "Konto",
      phone: normalizePhone(row.phone, country),
    })),
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
    rows[0] ?? {
      phone_number_id: "",
      access_token: "",
      country_code: "49",
      time_zone: "Europe/Berlin",
    }
  );
}

function publicOrg(row: { phone_number_id: string; access_token: string; country_code: string; time_zone: string }) {
  const token = row.access_token.trim();
  return {
    phoneNumberId: row.phone_number_id,
    countryCode: row.country_code,
    timeZone: row.time_zone,
    configured: token.length >= 20 && row.phone_number_id.trim().length > 0,
    tokenHint: token ? `••••${token.slice(-4)}` : "",
  };
}

export async function bootstrap(userId: string) {
  const sql = await getSql();
  const role = await ensureProfile(sql, userId);
  const me = await sql<{ display_name: string; phone: string; email: string }>`
    select p.display_name, p.phone, u.email
    from profiles p join "user" u on u.id = p.user_id
    where p.user_id = ${userId}`;
  const settings = await org(sql);
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
    displayName: me[0]?.display_name ?? "",
    email: me[0]?.email ?? "",
    phone: me[0]?.phone ?? "",
    contacts: contactRows.filter((row) => row.active || role === "admin" || row.created_by === userId),
    colleagues: book.colleagues,
    routines: routineRows.map(presentRoutine),
    jobs: jobRows.map(presentJob),
    rules: ruleRows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      titleContains: row.title_contains,
      minutes: row.minutes,
      anchor: row.anchor === "end" ? "end" : "start",
      recipients: parseRecipients(row.recipients),
      template: row.template,
    })),
    org: publicOrg(settings),
    source: {
      source: source?.source ?? "demo",
      graphCalendarId: source?.graph_calendar_id ?? "",
      ewsUrl: source?.ews_url ?? "https://outlook.office365.com/EWS/Exchange.asmx",
      ewsUser: source?.ews_user ?? "",
      ewsAuth: source?.ews_auth === "bearer" ? "bearer" : "basic",
      horizonDays: source?.horizon_days ?? 14,
      hasGraphToken: Boolean(source?.graph_token),
      hasEwsSecret: Boolean(source?.ews_secret),
    },
    accounts: accounts.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role === "admin" ? "admin" : "user",
      phone: row.phone ?? "",
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

function presentRoutine(row: RoutineRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    body: row.body,
    frequency: (row.frequency === "weekly" || row.frequency === "monthly" ? row.frequency : "daily") as Frequency,
    weekdays: row.weekdays.split(",").map(Number).filter((n) => n >= 1 && n <= 7),
    monthDay: row.month_day,
    timeLocal: row.time_local,
    timeZone: row.time_zone,
    recipients: parseRecipients(row.recipients),
    enabled: row.enabled,
    nextRun: iso(row.next_run),
  };
}

function presentJob(row: JobRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    routineId: row.routine_id,
    title: row.title,
    phone: row.phone,
    contactName: row.contact_name,
    body: row.body,
    sendAt: iso(row.send_at) ?? new Date(0).toISOString(),
    status: row.status,
    error: row.error,
    sentAt: iso(row.sent_at),
  };
}

export async function savePhone(userId: string, phone: string) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const settings = await org(sql);
  const normalized = phone.trim() ? normalizePhone(phone, settings.country_code) : "";
  if (normalized && !isE164(normalized)) throw new Error("Telefonnummer prüfen.");
  await sql`update profiles set phone = ${normalized} where user_id = ${userId}`;
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
    await sql`update contacts set name = ${input.name.trim()}, phone = ${phone}, note = ${input.note.trim()} where id = ${id}`;
  } else if (existing[0]) {
    await sql`update contacts set name = ${input.name.trim()}, phone = ${phone}, note = ${input.note.trim()} where id = ${id}`;
  } else {
    await sql`insert into contacts (id, name, phone, note, created_by) values (${id}, ${input.name.trim()}, ${phone}, ${input.note.trim()}, ${userId})`;
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
  const recipients = JSON.stringify(input.recipients.slice(0, 40));
  if (existing[0]) {
    await sql`update routines set title = ${input.title.trim()}, body = ${input.body.trim()},
      frequency = ${input.frequency}, weekdays = ${weekdays}, month_day = ${Math.min(28, Math.max(1, input.monthDay || 1))},
      time_local = ${input.timeLocal}, time_zone = ${settings.time_zone}, recipients = ${recipients},
      enabled = ${input.enabled}, next_run = ${next.toISOString()}
      where id = ${id}`;
  } else {
    await sql`insert into routines (id, owner_id, title, body, frequency, weekdays, month_day, time_local, time_zone, recipients, enabled, next_run)
      values (${id}, ${owner}, ${input.title.trim()}, ${input.body.trim()}, ${input.frequency}, ${weekdays},
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
      values (${id}, ${userId}, ${"Manuell"}, ${person.phone}, ${person.name}, ${input.body.trim()}, ${when.toISOString()}, 'queued', ${id})`;
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
  const routines = await sql<RoutineRow>`select id, owner_id, title, body, frequency, weekdays, month_day, time_local, time_zone, recipients, enabled, next_run from routines where enabled = true`;
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
          values (${id}, ${routine.owner_id}, ${routine.id}, ${routine.title}, ${person.phone}, ${person.name}, ${routine.body}, ${next.toISOString()}, 'queued', ${key})
          on conflict (dedupe_key) do nothing`;
      }
      next = nextOccurrence({ ...spec, after: next });
      guard += 1;
    }
    await sql`update routines set next_run = ${next.toISOString()} where id = ${routine.id}`;
  }
}

async function dispatchDue(sql: Sql, now: Date): Promise<{ sent: number; failed: number; warning: string | null }> {
  const settings = await org(sql);
  const configured = settings.access_token.trim().length >= 20 && settings.phone_number_id.trim().length > 0;
  if (!configured) return { sent: 0, failed: 0, warning: "WhatsApp ist noch nicht verbunden." };
  let sent = 0;
  let failed = 0;
  const due = await sql<{ id: string; phone: string; body: string }>`
    select id, phone, body from jobs
    where status = 'queued' and send_at <= ${now.toISOString()}
    order by send_at asc limit 3`;
  for (const job of due) {
    const locked = await sql<{ id: string }>`
      update jobs set status = 'sending' where id = ${job.id} and status = 'queued' returning id`;
    if (!locked[0]) continue;
    const result = await sendWhatsAppMessage({
      phoneNumberId: settings.phone_number_id,
      accessToken: settings.access_token,
      to: job.phone,
      body: job.body,
    });
    if (result.ok) {
      sent += 1;
      await sql`update jobs set status = 'sent', sent_at = ${new Date().toISOString()}, error = null where id = ${job.id}`;
    } else {
      failed += 1;
      await sql`update jobs set status = 'failed', error = ${result.error} where id = ${job.id}`;
    }
  }
  return { sent, failed, warning: null };
}

export function pulseConfigured(): boolean {
  return Boolean(process.env.VORLAUF_PULSE_SECRET?.trim());
}

export function pulseAuthorized(header: string | null): boolean {
  const secret = process.env.VORLAUF_PULSE_SECRET?.trim();
  const match = /^Bearer\s+(\S+)$/.exec(header ?? "");
  if (!secret || !match) return false;
  const given = Buffer.from(match[1]);
  const want = Buffer.from(secret);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

export async function systemPulse() {
  const sql = await getSql();
  const now = new Date();
  await expandRoutines(sql, now);
  const result = await dispatchDue(sql, now);
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
  await sql`update org_settings set phone_number_id = ${input.phoneNumberId.trim()}, access_token = ${token},
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
    values (${input.id}, ${input.role}, ${people[0].name}, ${phone})
    on conflict (user_id) do update set role = ${input.role}, phone = ${phone}`;
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
  const recipients = JSON.stringify(input.recipients.slice(0, 40));
  const minutes = Math.max(0, Math.min(10080, input.minutes || 0));
  const template = input.template.trim() || DEFAULT_TEMPLATE;
  if (existing[0]) {
    await sql`update calendar_rules set name = ${input.name.trim()}, enabled = ${input.enabled}, title_contains = ${input.titleContains.trim()},
      minutes = ${minutes}, anchor = ${input.anchor}, recipients = ${recipients}, template = ${template} where id = ${id} and owner_id = ${userId}`;
  } else {
    await sql`insert into calendar_rules (id, owner_id, name, enabled, title_contains, minutes, anchor, recipients, template)
      values (${id}, ${userId}, ${input.name.trim()}, ${input.enabled}, ${input.titleContains.trim()}, ${minutes}, ${input.anchor}, ${recipients}, ${template})`;
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
  const rules = await sql<RuleRow>`select id, name, enabled, title_contains, minutes, anchor, recipients, template from calendar_rules where owner_id = ${userId} and enabled = true`;
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
          values (${id}, ${userId}, ${event.title || rule.name}, ${person.phone}, ${person.name}, ${body}, ${when.toISOString()}, 'queued', ${key})
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
    ewsAuth: "basic" | "bearer";
    horizonDays: number;
  },
) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const current = await sql<SourceRow>`select graph_token, ews_secret from user_sources where user_id = ${userId}`;
  const graphToken = input.graphToken.trim() && !input.graphToken.includes("••••") ? input.graphToken.trim() : current[0]?.graph_token ?? "";
  const ewsSecret = input.ewsSecret.trim() && !input.ewsSecret.includes("••••") ? input.ewsSecret.trim() : current[0]?.ews_secret ?? "";
  const source = ["demo", "outlook", "graph", "ews"].includes(input.source) ? input.source : "demo";
  const days = Math.min(60, Math.max(1, input.horizonDays || 14));
  await sql`insert into user_sources (user_id, source, graph_token, graph_calendar_id, ews_url, ews_user, ews_secret, ews_auth, horizon_days)
    values (${userId}, ${source}, ${graphToken}, ${input.graphCalendarId.trim()}, ${input.ewsUrl.trim()}, ${input.ewsUser.trim()}, ${ewsSecret}, ${input.ewsAuth}, ${days})
    on conflict (user_id) do update set source = ${source}, graph_token = ${graphToken}, graph_calendar_id = ${input.graphCalendarId.trim()},
      ews_url = ${input.ewsUrl.trim()}, ews_user = ${input.ewsUser.trim()}, ews_secret = ${ewsSecret}, ews_auth = ${input.ewsAuth}, horizon_days = ${days}`;
  return bootstrap(userId);
}

export async function loadCalendar(userId: string) {
  const sql = await getSql();
  await ensureProfile(sql, userId);
  const rows = await sql<SourceRow>`select source, graph_calendar_id, ews_url, ews_user, ews_auth, horizon_days, graph_token, ews_secret from user_sources where user_id = ${userId}`;
  const source = rows[0];
  const kind = source?.source ?? "demo";
  const range = rangeFor(new Date(), source?.horizon_days ?? 14);
  if (kind === "demo") return { ok: true as const, events: demoEvents(), error: undefined };
  if (kind === "outlook") return readOutlookCalendar(range);
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
    auth: source?.ews_auth === "bearer" ? "bearer" : "basic",
    ...range,
  });
}
