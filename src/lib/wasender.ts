export type CalendarSource = "demo" | "outlook" | "graph" | "ews";

export type CalEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string;
  preview: string;
  source: CalendarSource;
};

export type RuleAnchor = "start" | "end";

export type Frequency = "daily" | "weekly" | "monthly";

export type RecipientRef = { kind: "user" | "contact"; id: string };

export const DEFAULT_TEMPLATE = "Erinnerung: {{titel}}\n{{datum}}, {{uhrzeit}}\n{{ort}}";

export function normalizePhone(raw: string, countryCode: string): string {
  let digits = raw.trim().replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  const cc = countryCode.replace(/\D/g, "") || "49";
  if (digits.startsWith("0")) digits = cc + digits.slice(1);
  return digits;
}

export function isE164(digits: string): boolean {
  return /^\d{8,15}$/.test(digits);
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInZone(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

export function zonedLocalToUtc(localDateTime: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localDateTime);
  if (!match) return new Date(NaN);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const seen = partsInZone(utcGuess, timeZone);
  const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return new Date(utcGuess.getTime() - (asUtc - utcGuess.getTime()));
}

export function formatWhen(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("de-DE", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatDay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("de-DE", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

export function dayKey(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = partsInZone(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function toDatetimeLocalValue(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = partsInZone(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function renderTemplate(
  template: string,
  event: Pick<CalEvent, "title" | "start" | "end" | "location">,
  timeZone: string,
): string {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const date = new Intl.DateTimeFormat("de-DE", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(start);
  const clock = new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(start);
  const endClock = new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(end);
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const map: Record<string, string> = {
    titel: event.title || "Termin",
    ort: event.location || "ohne Ort",
    datum: date,
    uhrzeit: clock,
    start: clock,
    ende: endClock,
    dauer: `${minutes} Min.`,
  };
  return template.replace(/\{\{\s*(titel|ort|datum|uhrzeit|start|ende|dauer)\s*\}\}/gi, (_, key: string) => {
    return map[key.toLowerCase()] ?? "";
  });
}

export function sendInstant(anchorIso: string, minutes: number): Date {
  const anchor = new Date(anchorIso);
  return new Date(anchor.getTime() - minutes * 60_000);
}

export function demoEvents(now = new Date()): CalEvent[] {
  const at = (offsetMin: number, durationMin: number) => {
    const start = new Date(now.getTime() + offsetMin * 60_000);
    start.setSeconds(0, 0);
    const end = new Date(start.getTime() + durationMin * 60_000);
    return { start: start.toISOString(), end: end.toISOString() };
  };
  const wall = (dayOffset: number, hour: number, minute: number, durationMin: number) => {
    const start = new Date(now);
    start.setDate(start.getDate() + dayOffset);
    start.setHours(hour, minute, 0, 0);
    if (start.getTime() < now.getTime() + 30 * 60_000) start.setDate(start.getDate() + 1);
    const end = new Date(start.getTime() + durationMin * 60_000);
    return { start: start.toISOString(), end: end.toISOString() };
  };
  const rows = [
    { key: "stand", title: "Projektstand", location: "Raum 2", preview: "Kurzer Abgleich.", ...at(40, 30) },
    { key: "kunde", title: "Kundentermin Müller", location: "Video", preview: "Angebot durchgehen.", ...at(180, 60) },
    { key: "daily", title: "Daily", location: "Werkstatt", preview: "Was heute blockiert.", ...wall(1, 9, 0, 20) },
    { key: "lieferung", title: "Lieferung Hof", location: "Rampe", preview: "Spedition am Nachmittag.", ...wall(1, 13, 30, 45) },
  ];
  return rows.map((row) => ({
    id: `demo:${row.key}:${row.start}`,
    title: row.title,
    start: row.start,
    end: row.end,
    location: row.location,
    preview: row.preview,
    source: "demo" as const,
  }));
}

export function rangeFor(now: Date, horizonDays: number): { start: string; end: string } {
  const start = new Date(now.getTime() - 60 * 60_000);
  const end = new Date(now.getTime() + horizonDays * 24 * 60 * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function weekdayIndex(date: Date, timeZone: string): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[label] ?? 1;
}

function shiftYmd(year: number, month: number, day: number, add: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + add));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function nextOccurrence(input: {
  frequency: Frequency;
  weekdays: number[];
  monthDay: number;
  timeLocal: string;
  timeZone: string;
  after: Date;
}): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(input.timeLocal);
  const hour = match ? Number(match[1]) : 9;
  const minute = match ? Number(match[2]) : 0;
  const timeZone = input.timeZone || "Europe/Berlin";
  const start = partsInZone(input.after, timeZone);
  const days = input.weekdays.length > 0 ? input.weekdays : [1, 2, 3, 4, 5];
  const monthDay = Math.min(28, Math.max(1, input.monthDay || 1));
  for (let i = 0; i < 400; i++) {
    const ymd = shiftYmd(start.year, start.month, start.day, i);
    const local = `${ymd.year}-${String(ymd.month).padStart(2, "0")}-${String(ymd.day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const instant = zonedLocalToUtc(local, timeZone);
    if (Number.isNaN(instant.getTime()) || instant.getTime() <= input.after.getTime()) continue;
    if (input.frequency === "daily") return instant;
    if (input.frequency === "weekly" && days.includes(weekdayIndex(instant, timeZone))) return instant;
    if (input.frequency === "monthly" && partsInZone(instant, timeZone).day === monthDay) return instant;
  }
  return new Date(input.after.getTime() + 24 * 60 * 60_000);
}
