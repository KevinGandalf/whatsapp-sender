import { createFileRoute } from "@tanstack/react-router";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { WasenderApp } from "@/components/wasender-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">Leitstand</p>
        <h1 className="font-display text-4xl text-fg">WASender</h1>
        <p className="mt-3 text-sm text-muted">Anmeldung wird geprüft.</p>
      </main>
    );
  }
  if (!user) return <RedirectToSignIn />;
  return <WasenderApp />;
}
