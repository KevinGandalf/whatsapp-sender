import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { Button, Field, TextInput } from "@/components/ui";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "up"
          ? await authClient.signUp.email({ email, password, name: name.trim() || email })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message || "Anmeldung fehlgeschlagen.");
        return;
      }
      await navigate({ to: "/" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Anmeldung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-screen max-w-md place-items-center px-4 py-10">
      <div className="w-full rounded-3xl border border-line bg-surface p-5">
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">Leitstand</p>
        <h1 className="font-display text-4xl text-fg">Vorlauf</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Das erste Konto wird Admin und legt Empfänger, WhatsApp und weitere Konten an.
        </p>
        {authEnabled ? (
          <form
            className="mt-5 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === "up" ? (
              <Field label="Name">
                <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
            ) : null}
            <Field label="E-Mail">
              <TextInput type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Field>
            <Field label="Passwort" hint="Mindestens 8 Zeichen.">
              <TextInput
                type="password"
                autoComplete={mode === "up" ? "new-password" : "current-password"}
                value={password}
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Einen Moment…" : mode === "up" ? "Konto anlegen" : "Anmelden"}
            </Button>
            <button
              type="button"
              className="min-h-11 text-sm text-muted"
              onClick={() => setMode(mode === "up" ? "in" : "up")}
            >
              {mode === "up" ? "Ich habe schon ein Konto" : "Neues Konto anlegen"}
            </button>
            <div className="grid gap-2">
              {GROK_PROVIDERS.map((provider) => (
                <Button key={provider.providerId} variant="ghost" onClick={() => signIn(provider.providerId, { callbackURL: "/" })}>
                  Weiter mit {provider.label}
                </Button>
              ))}
            </div>
          </form>
        ) : (
          <p className="mt-4 text-sm text-muted">Anmeldung ist aus.</p>
        )}
      </div>
    </main>
  );
}
