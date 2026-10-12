import { useEffect, useMemo, useState } from "react";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import {
  deleteContact,
  deleteRoutine,
  deleteRule,
  dropJob,
  enqueueMessage,
  fetchCalendar,
  loadDesk,
  materializeRules,
  requeueJob,
  runPulse,
  saveAccount,
  saveCalendarSource,
  saveOrgSettings,
  updateMyPhone,
  upsertContact,
  upsertRoutine,
  upsertRule,
} from "@/lib/vorlauf-actions";
import {
  DEFAULT_TEMPLATE,
  dayKey,
  formatClock,
  formatDay,
  formatWhen,
  toDatetimeLocalValue,
  zonedLocalToUtc,
  type CalEvent,
  type Frequency,
  type RecipientRef,
} from "@/lib/vorlauf";
import { Button, Field, Panel, TextArea, TextInput } from "@/components/ui";
import { Chats } from "@/components/wa-chats";
import { startWhatsApp, stopWhatsApp, whatsAppStatus } from "@/lib/vorlauf-actions";

type DeskData = Awaited<ReturnType<typeof loadDesk>>;
type ViewId = "chats" | "kalender" | "regeln" | "termine" | "ausgang" | "empfaenger" | "konten" | "anbindung";

const WEEKDAYS = [
  [1, "Mo"],
  [2, "Di"],
  [3, "Mi"],
  [4, "Do"],
  [5, "Fr"],
  [6, "Sa"],
  [7, "So"],
] as const;

export function VorlaufApp() {
  const user = useCurrentUser();
  const [data, setData] = useState<DeskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("chats");

  const refresh = async () => {
    const next = await loadDesk();
    setData(next);
    setError(null);
    return next;
  };

  useEffect(() => {
    if (!user?.id) return;
    let stop = false;
    const boot = () => {
      void loadDesk()
        .then((next) => {
          if (!stop) setData(next);
        })
        .catch((caught: unknown) => {
          if (!stop) setError(caught instanceof Error ? caught.message : "Daten nicht geladen.");
        });
    };
    boot();
    const timer = window.setInterval(() => {
      void runPulse()
        .then((pulse) => {
          if (stop) return;
          setData((current) => (current ? { ...current, jobs: pulse.jobs, routines: pulse.routines } : current));
        })
        .catch(() => undefined);
    }, 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [user?.id]);

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="font-display text-4xl text-fg">WASender</h1>
        <p className="mt-3 text-sm text-muted">{error ?? "Leitstand wird geladen."}</p>
      </main>
    );
  }

  const admin = data.role === "admin";
  const views: { id: ViewId; label: string }[] = [
    { id: "chats", label: "Chats" },
    { id: "termine", label: "Regeltermine" },
    { id: "kalender", label: "Kalender" },
    { id: "regeln", label: "Regeln" },
    { id: "ausgang", label: "Ausgang" },
    { id: "empfaenger", label: "Empfänger" },
    ...(admin
      ? [
          { id: "konten" as const, label: "Konten" },
          { id: "anbindung" as const, label: "Anbindung" },
        ]
      : []),
  ];
  const next = data.jobs.filter((job) => job.status === "queued").sort((a, b) => a.sendAt.localeCompare(b.sendAt))[0];

  return (
    <div className="mx-auto grid min-h-screen w-full min-w-0 max-w-6xl gap-6 overflow-x-clip px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-8">
      <aside className="flex min-w-0 flex-col gap-6">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">{admin ? "Admin" : "Nutzer"}</p>
          <h1 className="font-display text-4xl leading-none text-fg">WASender</h1>
          <p className="mt-3 text-sm leading-6 text-muted">{data.displayName}</p>
        </div>
        <nav className="flex w-full min-w-0 gap-2 overflow-x-auto lg:flex-col" aria-label="Bereiche">
          {views.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={
                view === item.id
                  ? "min-h-11 shrink-0 rounded-lg bg-accent px-4 text-left text-sm font-medium text-accent-fg lg:w-full"
                  : "min-h-11 shrink-0 rounded-lg border border-line px-4 text-left text-sm text-fg hover:bg-surface-2 lg:w-full"
              }
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="rounded-3xl border border-line bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-subtle uppercase">Nächste Sendung</p>
          <p className="mt-2 font-display text-3xl tabular-nums text-fg">
            {next ? formatClock(next.sendAt, data.org.timeZone) : "—"}
          </p>
          <p className="mt-3 text-xs leading-5 text-subtle">
            {data.org.linked
              ? `WhatsApp ${data.org.linkName || "ist verbunden"}. Versand läuft auf dem Server, auch ohne Anmeldung.`
              : data.org.configured
                ? "Versand läuft auf dem Server über die Cloud API, auch ohne Anmeldung."
                : "WhatsApp verbindet der Admin. Danach geht der Versand ohne Anmeldung raus."}
          </p>
          <div className="mt-3">
            <UserButton />
          </div>
        </div>
      </aside>
      <main className="grid min-w-0 gap-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {view === "chats" ? <Chats timeZone={data.org.timeZone} linked={data.org.linked} /> : null}
        {view === "termine" ? <Routines data={data} onChange={setData} onError={setError} /> : null}
        {view === "kalender" ? <Calendar data={data} onChange={setData} onError={setError} /> : null}
        {view === "regeln" ? <Rules data={data} onChange={setData} onError={setError} /> : null}
        {view === "ausgang" ? <Queue data={data} onChange={setData} onError={setError} /> : null}
        {view === "empfaenger" ? <People data={data} onChange={setData} onError={setError} /> : null}
        {view === "konten" && admin ? <Accounts data={data} onChange={setData} onError={setError} /> : null}
        {view === "anbindung" && admin ? <Org data={data} onChange={setData} onError={setError} /> : null}
      </main>
    </div>
  );
}

function optionsOf(data: DeskData) {
  return [
    ...data.colleagues.map((person) => ({ kind: "user" as const, id: person.id, name: person.name, phone: person.phone })),
    ...data.contacts.filter((person) => person.active).map((person) => ({ kind: "contact" as const, id: person.id, name: person.name, phone: person.phone })),
  ];
}

function Picker({
  data,
  selected,
  onChange,
}: {
  data: DeskData;
  selected: RecipientRef[];
  onChange: (next: RecipientRef[]) => void;
}) {
  const options = optionsOf(data);
  if (options.length === 0) {
    return <p className="text-sm text-muted">Noch keine Empfänger. Unter Empfänger anlegen oder im Konto eine Nummer hinterlegen.</p>;
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const on = selected.some((item) => item.kind === option.kind && item.id === option.id);
        return (
          <li key={`${option.kind}:${option.id}`}>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3 text-sm">
              <input
                type="checkbox"
                checked={on}
                onChange={() =>
                  onChange(
                    on
                      ? selected.filter((item) => !(item.kind === option.kind && item.id === option.id))
                      : [...selected, { kind: option.kind, id: option.id }],
                  )
                }
              />
              <span className="min-w-0">
                <span className="block truncate text-fg">{option.name}</span>
                <span className="block truncate text-xs tabular-nums text-subtle">
                  {option.kind === "user" ? "Konto" : "Kontakt"} · {option.phone}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

async function commit(run: () => Promise<DeskData>, onChange: (data: DeskData) => void, onError: (message: string | null) => void) {
  try {
    onError(null);
    onChange(await run());
  } catch (caught) {
    onError(caught instanceof Error ? caught.message : "Das hat nicht geklappt.");
  }
}

function Routines({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  const [draft, setDraft] = useState({
    title: "",
    body: "Kurze Erinnerung aus WASender.",
    frequency: "weekly" as Frequency,
    weekdays: [1, 2, 3, 4, 5],
    monthDay: 1,
    timeLocal: "09:00",
    recipients: [] as RecipientRef[],
  });
  return (
    <div className="grid gap-4">
      <Panel kicker="Wiederkehrend" title="Regeltermine">
        <p className="mb-4 text-sm leading-6 text-muted">
          Täglich, an Wochentagen oder monatlich. Empfänger sind Konten mit Nummer oder Kontakte aus der Liste.
        </p>
        <ul className="grid gap-3">
          {data.routines.length === 0 ? <li className="text-sm text-muted">Noch kein Regeltermin.</li> : null}
          {data.routines.map((routine) => (
            <li key={routine.id} className="rounded-2xl border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-fg">{routine.title}</p>
                  <p className="text-xs text-subtle">
                    {routine.frequency === "daily" ? "Täglich" : routine.frequency === "weekly" ? "Wöchentlich" : `Monatlich am ${routine.monthDay}.`}
                    {" · "}
                    {routine.timeLocal}
                    {routine.nextRun ? ` · nächster Lauf ${formatWhen(routine.nextRun, routine.timeZone)}` : ""}
                  </p>
                </div>
                <Button variant="danger" onClick={() => void commit(() => deleteRoutine({ data: { id: routine.id } }), onChange, onError)}>
                  Entfernen
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel kicker="Neu" title="Termin anlegen">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(() => upsertRoutine({ data: { ...draft, enabled: true } }), onChange, onError);
          }}
        >
          <Field label="Bezeichnung">
            <TextInput value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rhythmus">
              <select
                className="min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-sm"
                value={draft.frequency}
                onChange={(event) => setDraft({ ...draft, frequency: event.target.value as Frequency })}
              >
                <option value="daily">Täglich</option>
                <option value="weekly">Wöchentlich</option>
                <option value="monthly">Monatlich</option>
              </select>
            </Field>
            <Field label="Uhrzeit">
              <TextInput type="time" value={draft.timeLocal} onChange={(event) => setDraft({ ...draft, timeLocal: event.target.value })} required />
            </Field>
          </div>
          {draft.frequency === "weekly" ? (
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map(([day, label]) => {
                const on = draft.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={on ? "min-h-11 rounded-lg bg-accent px-3 text-sm text-accent-fg" : "min-h-11 rounded-lg border border-line px-3 text-sm"}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        weekdays: on ? draft.weekdays.filter((item) => item !== day) : [...draft.weekdays, day],
                      })
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {draft.frequency === "monthly" ? (
            <Field label="Tag im Monat" hint="1 bis 28, damit jeder Monat einen Lauf hat.">
              <TextInput
                type="number"
                min={1}
                max={28}
                value={draft.monthDay}
                onChange={(event) => setDraft({ ...draft, monthDay: Number(event.target.value) })}
              />
            </Field>
          ) : null}
          <Field label="Empfänger">
            <Picker data={data} selected={draft.recipients} onChange={(recipients) => setDraft({ ...draft, recipients })} />
          </Field>
          <Field label="Text">
            <TextArea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
          </Field>
          <Button type="submit">Regeltermin speichern</Button>
        </form>
      </Panel>
    </div>
  );
}

function People({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [own, setOwn] = useState(data.phone);
  return (
    <div className="grid gap-4">
      <Panel kicker="Auswahl" title="Empfänger">
        <form
          className="mb-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(() => updateMyPhone({ data: { phone: own } }), onChange, onError);
          }}
        >
          <Field label="Meine Nummer" hint="Damit andere dich als Empfänger auswählen können.">
            <TextInput value={own} onChange={(event) => setOwn(event.target.value)} />
          </Field>
          <Button type="submit" variant="ghost">Nummer speichern</Button>
        </form>
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {data.contacts.length === 0 ? <li className="p-3 text-sm text-muted">Keine Kontakte.</li> : null}
          {data.contacts.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div>
                <p className="text-sm font-medium text-fg">{contact.name}</p>
                <p className="text-xs tabular-nums text-subtle">{contact.phone}{contact.note ? ` · ${contact.note}` : ""}</p>
              </div>
              <Button variant="danger" onClick={() => void commit(() => deleteContact({ data: { id: contact.id } }), onChange, onError)}>
                Entfernen
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel kicker="Neu" title="Kontakt">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(() => upsertContact({ data: { name, phone, note } }), onChange, onError).then(() => {
              setName("");
              setPhone("");
              setNote("");
            });
          }}
        >
          <Field label="Name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Telefon">
            <TextInput value={phone} onChange={(event) => setPhone(event.target.value)} required />
          </Field>
          <Field label="Notiz">
            <TextInput value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Button type="submit">Kontakt speichern</Button>
        </form>
      </Panel>
    </div>
  );
}

function Queue({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  const [recipients, setRecipients] = useState<RecipientRef[]>([]);
  const [body, setBody] = useState("");
  const [whenLocal, setWhenLocal] = useState("");
  return (
    <div className="grid gap-4">
      <Panel kicker="Einzeln" title="Nachricht planen">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const sendAt = zonedLocalToUtc(whenLocal, data.org.timeZone).toISOString();
            void commit(() => enqueueMessage({ data: { recipients, body, sendAt } }), onChange, onError);
          }}
        >
          <Picker data={data} selected={recipients} onChange={setRecipients} />
          <Field label="Senden um" hint={data.org.timeZone}>
            <TextInput type="datetime-local" value={whenLocal} onChange={(event) => setWhenLocal(event.target.value)} required />
          </Field>
          <Field label="Text">
            <TextArea value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>
          <Button type="submit">Einplanen</Button>
        </form>
      </Panel>
      <Panel kicker={data.role === "admin" ? "Alle Konten" : "Deine Sendungen"} title="Ausgang">
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {data.jobs.length === 0 ? <li className="p-3 text-sm text-muted">Nichts in der Warteschlange.</li> : null}
          {data.jobs.map((job) => (
            <li key={job.id} className="grid gap-2 p-3">
              <div className="flex flex-wrap justify-between gap-2">
                <p className="text-sm font-medium text-fg">{job.title}</p>
                <p className="text-xs tabular-nums text-subtle">
                  {job.status} · {formatWhen(job.sendAt, data.org.timeZone)}
                </p>
              </div>
              <p className="text-sm whitespace-pre-wrap text-muted">{job.body}</p>
              <p className="text-xs text-subtle">an {job.contactName} · {job.phone}</p>
              {job.error ? <p className="text-sm text-danger">{job.error}</p> : null}
              <div className="flex gap-2">
                {job.status === "queued" ? (
                  <Button variant="ghost" onClick={() => void commit(() => dropJob({ data: { id: job.id } }), onChange, onError)}>Verwerfen</Button>
                ) : null}
                {job.status === "failed" ? (
                  <Button variant="ghost" onClick={() => void commit(() => requeueJob({ data: { id: job.id } }), onChange, onError)}>Erneut</Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Rules({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  const [draft, setDraft] = useState({
    name: "15 Minuten vorher",
    titleContains: "",
    minutes: 15,
    anchor: "start" as "start" | "end",
    recipients: [] as RecipientRef[],
    template: DEFAULT_TEMPLATE,
  });
  return (
    <div className="grid gap-4">
      <Panel kicker="Aus dem Kalender" title="Regeln">
        <ul className="grid gap-3">
          {data.rules.length === 0 ? <li className="text-sm text-muted">Keine Kalenderregel.</li> : null}
          {data.rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-3">
              <div>
                <p className="text-sm font-medium text-fg">{rule.name}</p>
                <p className="text-xs text-subtle">{rule.minutes} Min. vor {rule.anchor === "start" ? "Beginn" : "Ende"} · {rule.enabled ? "aktiv" : "aus"}</p>
              </div>
              <Button variant="danger" onClick={() => void commit(() => deleteRule({ data: { id: rule.id } }), onChange, onError)}>Entfernen</Button>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel kicker="Neu" title="Regel">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(() => upsertRule({ data: { ...draft, enabled: true } }), onChange, onError);
          }}
        >
          <Field label="Name">
            <TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
          </Field>
          <Field label="Titel enthält">
            <TextInput value={draft.titleContains} onChange={(event) => setDraft({ ...draft, titleContains: event.target.value })} />
          </Field>
          <Field label="Minuten vorher">
            <TextInput type="number" min={0} value={draft.minutes} onChange={(event) => setDraft({ ...draft, minutes: Number(event.target.value) })} />
          </Field>
          <Field label="Empfänger">
            <Picker data={data} selected={draft.recipients} onChange={(recipients) => setDraft({ ...draft, recipients })} />
          </Field>
          <Field label="Text">
            <TextArea value={draft.template} onChange={(event) => setDraft({ ...draft, template: event.target.value })} />
          </Field>
          <Button type="submit">Regel speichern</Button>
        </form>
      </Panel>
    </div>
  );
}

function Calendar({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [source, setSource] = useState(data.source.source === "outlook" ? "ews" : data.source.source);
  const [graphToken, setGraphToken] = useState("");
  const [graphCalendarId, setGraphCalendarId] = useState(data.source.graphCalendarId);
  const [ewsUrl, setEwsUrl] = useState(data.source.ewsUrl);
  const [ewsUser, setEwsUser] = useState(data.source.ewsUser);
  const [ewsSecret, setEwsSecret] = useState("");
  const [ewsAuth, setEwsAuth] = useState<"basic" | "bearer" | "ntlm">(data.source.ewsAuth);
  const groups = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
      const key = dayKey(event.start, data.org.timeZone);
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return [...map.entries()];
  }, [events, data.org.timeZone]);

  const load = async () => {
    setNote(null);
    try {
      await saveCalendarSource({
        data: { source, graphToken, graphCalendarId, ewsUrl, ewsUser, ewsSecret, ewsAuth, horizonDays: data.source.horizonDays },
      });
      const result = await fetchCalendar();
      if (!result.ok) throw new Error(result.error || "Kalender nicht geladen.");
      setEvents(result.events);
      setNote(result.events.length === 0 ? "Keine Termine im Zeitraum." : `${result.events.length} Termine geladen.`);
      onChange(await loadDesk());
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Kalender nicht geladen.");
    }
  };

  return (
    <Panel
      kicker="Quelle"
      title="Kalender"
      action={<Button onClick={() => void load()}>Termine laden</Button>}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ["demo", "Beispiel"],
            ["ews", "Exchange EWS"],
            ["graph", "Microsoft 365"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSource(id)}
            className={source === id ? "min-h-11 rounded-lg bg-accent px-3 text-sm text-accent-fg" : "min-h-11 rounded-lg border border-line px-3 text-sm"}
          >
            {label}
          </button>
        ))}
      </div>
      {source === "graph" ? (
        <div className="mb-4 grid gap-3">
          <Field label="Graph-Token" hint={data.source.hasGraphToken ? "Gespeichert. Leer lassen, um es zu behalten." : "Calendars.Read"}>
            <TextInput type="password" value={graphToken} onChange={(event) => setGraphToken(event.target.value)} />
          </Field>
          <Field label="Kalender-ID">
            <TextInput value={graphCalendarId} onChange={(event) => setGraphCalendarId(event.target.value)} />
          </Field>
        </div>
      ) : null}
      {source === "ews" ? (
        <div className="mb-4 grid gap-3">
          <Field label="EWS-Adresse" hint="Lokal zum Beispiel https://exchange.firma.local/EWS/Exchange.asmx">
            <TextInput value={ewsUrl} onChange={(event) => setEwsUrl(event.target.value)} />
          </Field>
          <Field label="Anmeldung">
            <select
              className="min-h-11 rounded-lg border border-line bg-bg px-3 text-sm text-fg"
              value={ewsAuth}
              onChange={(event) => setEwsAuth(event.target.value === "basic" || event.target.value === "bearer" ? event.target.value : "ntlm")}
            >
              <option value="ntlm">NTLM, lokaler Exchange</option>
              <option value="basic">Basic</option>
              <option value="bearer">Bearer</option>
            </select>
          </Field>
          <Field label="Benutzer" hint={ewsAuth === "ntlm" ? "DOMÄNE\\benutzer oder benutzer@firma.local" : "Postfach"}>
            <TextInput value={ewsUser} onChange={(event) => setEwsUser(event.target.value)} />
          </Field>
          <Field label={ewsAuth === "bearer" ? "Bearer-Token" : "Kennwort"}>
            <TextInput type="password" value={ewsSecret} onChange={(event) => setEwsSecret(event.target.value)} />
          </Field>
        </div>
      ) : null}
      {note ? <p className="mb-3 text-sm text-ok">{note}</p> : null}
      <div className="mb-4">
        <Button
          variant="ghost"
          onClick={() =>
            void materializeRules({ data: { events } })
              .then((result) => {
                setNote(`${result.created} Nachrichten aus Regeln eingeplant.`);
                return loadDesk();
              })
              .then(onChange)
              .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : "Regeln nicht angewendet."))
          }
        >
          Regeln auf diese Termine anwenden
        </Button>
      </div>
      {groups.map(([key, list]) => (
        <div key={key} className="mb-4">
          <h3 className="mb-2 text-sm text-muted">{formatDay(list[0].start, data.org.timeZone)}</h3>
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {list.map((event) => (
              <li key={event.id} className="grid gap-2 p-3 sm:grid-cols-[5rem_minmax(0,1fr)]">
                <p className="text-sm tabular-nums">{formatClock(event.start, data.org.timeZone)}</p>
                <div>
                  <p className="text-sm font-medium">{event.title}</p>
                  <p className="text-xs text-subtle">{event.location || "ohne Ort"}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {events.length === 0 ? <p className="text-sm text-muted">Noch nichts geladen.</p> : null}
      <p className="sr-only">{toDatetimeLocalValue(new Date().toISOString(), data.org.timeZone)}</p>
    </Panel>
  );
}

function Accounts({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  return (
    <Panel kicker="Mehrere Konten" title="Konten">
      <p className="mb-4 text-sm leading-6 text-muted">
        Neue Personen legen selbst ein Konto an. Hier stellst du die Rolle um und trägst die Nummer ein, unter der sie als Empfänger wählbar sind.
      </p>
      <ul className="grid gap-3">
        {data.accounts.map((account) => (
          <AccountRow key={account.id} account={account} onChange={onChange} onError={onError} />
        ))}
      </ul>
    </Panel>
  );
}

function AccountRow({
  account,
  onChange,
  onError,
}: {
  account: DeskData["accounts"][number];
  onChange: (data: DeskData) => void;
  onError: (message: string | null) => void;
}) {
  const [role, setRole] = useState(account.role);
  const [phone, setPhone] = useState(account.phone);
  return (
    <li className="grid gap-3 rounded-2xl border border-line p-3 sm:grid-cols-[minmax(0,1fr)_8rem_10rem_auto] sm:items-end">
      <div>
        <p className="text-sm font-medium text-fg">{account.name}</p>
        <p className="text-xs text-subtle">{account.email}</p>
      </div>
      <label className="grid gap-1 text-xs text-subtle">
        Rolle
        <select className="min-h-11 rounded-lg border border-line bg-bg px-2 text-sm text-fg" value={role} onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}>
          <option value="user">Nutzer</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-subtle">
        Telefon
        <TextInput value={phone} onChange={(event) => setPhone(event.target.value)} />
      </label>
      <Button onClick={() => void commit(() => saveAccount({ data: { id: account.id, role, phone } }), onChange, onError)}>Speichern</Button>
    </li>
  );
}

function Org({ data, onChange, onError }: { data: DeskData; onChange: (data: DeskData) => void; onError: (message: string | null) => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState(data.org.phoneNumberId);
  const [accessToken, setAccessToken] = useState("");
  const [countryCode, setCountryCode] = useState(data.org.countryCode);
  const [timeZone, setTimeZone] = useState(data.org.timeZone);
  const [link, setLink] = useState<{ phase: string; qrDataUrl: string | null; name: string; error: string | null; linked: boolean } | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      void whatsAppStatus()
        .then((next) => {
          if (!stop) setLink(next);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2500);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="grid gap-4">
      <Panel kicker="WhatsApp Web" title="Gerät verknüpfen">
        <div className="grid gap-4">
          <p className="text-sm leading-6 text-muted">
            Auf dem Telefon: WhatsApp, verknüpfte Geräte, Gerät hinzufügen. Der Code gilt nur für diesen Server. Die Sitzung bleibt
            liegen, auch wenn niemand die Seite offen hat.
          </p>
          {link?.linked ? (
            <p className="text-sm text-fg">Verbunden als {link.name || "WhatsApp"}.</p>
          ) : link?.qrDataUrl ? (
            <img src={link.qrDataUrl} alt="QR-Code zum Verknüpfen" className="h-56 w-56 rounded-2xl bg-white p-2" />
          ) : (
            <p className="text-sm text-subtle">{link?.phase === "connecting" ? "Verbindung wird aufgebaut." : "Noch nicht verknüpft."}</p>
          )}
          {link?.error ? <p className="text-sm text-danger">{link.error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                void startWhatsApp()
                  .then(setLink)
                  .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : "Verknüpfen fehlgeschlagen."));
              }}
            >
              {link?.qrDataUrl ? "Code erneuern" : "Code anzeigen"}
            </Button>
            {link?.linked ? (
              <Button
                variant="danger"
                onClick={() => {
                  void stopWhatsApp()
                    .then(setLink)
                    .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : "Abmelden fehlgeschlagen."));
                }}
              >
                Gerät abmelden
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>
      <Panel kicker="Optional" title="Cloud API">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void commit(
            () => saveOrgSettings({ data: { phoneNumberId, accessToken, countryCode, timeZone } }),
            onChange,
            onError,
          );
        }}
      >
        <p className="text-sm leading-6 text-muted">
          Nur als Ersatz, wenn keine Geräte-Sitzung verbunden ist. Geplante Nachrichten gehen sonst über das verknüpfte Telefon.
          {data.org.tokenHint ? ` Token ${data.org.tokenHint}.` : ""}
        </p>
        <Field label="Phone Number ID">
          <TextInput value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} />
        </Field>
        <Field label="Zugriffstoken" hint="Leer lassen, um das gespeicherte Token zu behalten.">
          <TextInput type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Landesvorwahl">
            <TextInput value={countryCode} onChange={(event) => setCountryCode(event.target.value)} />
          </Field>
          <Field label="Zeitzone">
            <TextInput value={timeZone} onChange={(event) => setTimeZone(event.target.value)} />
          </Field>
        </div>
        <Button type="submit">Speichern</Button>
      </form>
    </Panel>
    </div>
  );
}
