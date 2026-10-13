import { useEffect, useState } from "react";
import { listWhatsAppChats, listWhatsAppMessages, sendWhatsAppChat } from "@/lib/wasender-actions";
import { formatClock, formatWhen } from "@/lib/wasender";
import { Button, TextArea } from "@/components/ui";

type Chat = Awaited<ReturnType<typeof listWhatsAppChats>>[number];
type Message = Awaited<ReturnType<typeof listWhatsAppMessages>>[number];

export function Chats({ timeZone, linked }: { timeZone: string; linked: boolean }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let stop = false;
    const load = () => {
      void listWhatsAppChats()
        .then((rows) => {
          if (!stop) setChats(rows);
        })
        .catch((caught: unknown) => {
          if (!stop) setError(caught instanceof Error ? caught.message : "Chats nicht geladen.");
        });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const load = () => {
      void listWhatsAppMessages({ data: { jid: active } })
        .then((rows) => {
          if (!stop) setMessages(rows);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active]);

  const selected = chats.find((chat) => chat.jid === active) ?? null;
  const visible = chats.filter((chat) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return chat.name.toLowerCase().includes(needle) || chat.preview.toLowerCase().includes(needle);
  });

  return (
    <section className="grid min-w-0 gap-3">
      <div>
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">WhatsApp</p>
        <h2 className="font-display text-3xl text-fg">Chats</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {linked
            ? "Die Sitzung läuft auf dem Server, wie ein verknüpftes WhatsApp Web."
            : "Noch keine Sitzung. Ein Admin verknüpft das Telefon unter Anbindung per QR-Code."}
        </p>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="grid min-h-[32rem] min-w-0 gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col rounded-3xl border border-line bg-surface">
          <div className="border-b border-line p-3">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Suchen"
              className="min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg"
            />
          </div>
          <ul className="max-h-[28rem] min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <li className="px-4 py-6 text-sm text-subtle">Noch keine Chats. Nach dem Scannen kommen die letzten Verläufe.</li>
            ) : null}
            {visible.map((chat) => (
              <li key={chat.jid}>
                <button
                  type="button"
                  onClick={() => setActive(chat.jid)}
                  className={
                    chat.jid === active
                      ? "grid w-full gap-1 border-b border-line bg-surface-2 px-4 py-3 text-left"
                      : "grid w-full gap-1 border-b border-line px-4 py-3 text-left hover:bg-surface-2"
                  }
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-fg">{chat.name}</span>
                    <span className="shrink-0 text-xs text-subtle">
                      {chat.lastAt ? formatClock(chat.lastAt, timeZone) : ""}
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted">{chat.preview || (chat.isGroup ? "Gruppe" : "Keine Vorschau")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-h-[28rem] min-w-0 flex-col rounded-3xl border border-line bg-surface">
          {selected ? (
            <>
              <div className="border-b border-line px-4 py-3">
                <p className="truncate text-sm font-medium text-fg">{selected.name}</p>
                <p className="truncate text-xs text-subtle">{selected.isGroup ? "Gruppe" : selected.jid.split("@")[0]}</p>
              </div>
              <ol className="flex max-h-[24rem] min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
                {messages.length === 0 ? <li className="text-sm text-subtle">In diesem Chat liegt noch kein Text.</li> : null}
                {messages.map((message) => (
                  <li key={message.id} className={message.fromMe ? "ml-auto max-w-[80%]" : "mr-auto max-w-[80%]"}>
                    <div className={message.fromMe ? "rounded-2xl bg-accent px-3 py-2 text-accent-fg" : "rounded-2xl bg-surface-2 px-3 py-2 text-fg"}>
                      {!message.fromMe && message.sender ? <p className="text-xs text-subtle">{message.sender}</p> : null}
                      <p className="text-sm leading-6 whitespace-pre-wrap">{message.body}</p>
                      <p className={message.fromMe ? "mt-1 text-right text-xs opacity-70" : "mt-1 text-right text-xs text-subtle"}>
                        {formatWhen(message.sentAt, timeZone)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <form
                className="grid gap-2 border-t border-line p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = draft.trim();
                  if (!body || !active) return;
                  void sendWhatsAppChat({ data: { jid: active, body } })
                    .then((result) => {
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      setDraft("");
                      setError(null);
                      return listWhatsAppMessages({ data: { jid: active } }).then(setMessages);
                    })
                    .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Senden fehlgeschlagen."));
                }}
              >
                <TextArea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} placeholder="Nachricht über die verknüpfte Sitzung" />
                <Button type="submit" disabled={!linked || !draft.trim()}>
                  Senden
                </Button>
              </form>
            </>
          ) : (
            <p className="px-4 py-6 text-sm text-subtle">Links einen Chat auswählen.</p>
          )}
        </div>
      </div>
    </section>
  );
}
