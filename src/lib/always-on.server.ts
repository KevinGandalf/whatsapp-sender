const marker = globalThis as { __vorlaufAlwaysOn?: boolean };

export function startAlwaysOn() {
  if (marker.__vorlaufAlwaysOn) return;
  if (process.env.VORLAUF_DISABLE_TICK === "true") return;
  marker.__vorlaufAlwaysOn = true;
  const tick = () => {
    void import("./vorlauf-db.server")
      .then((mod) => mod.systemPulse())
      .catch((err: unknown) => {
        console.error("[wasender] Versand fehlgeschlagen:", err instanceof Error ? err.message : err);
      });
  };
  setTimeout(tick, 4_000);
  setInterval(tick, 15_000);
}
