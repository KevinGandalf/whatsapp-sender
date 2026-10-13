const marker = globalThis as { __wasenderAlwaysOn?: boolean };

export function startAlwaysOn() {
  if (marker.__wasenderAlwaysOn) return;
  if (process.env.WASENDER_DISABLE_TICK === "true") return;
  marker.__wasenderAlwaysOn = true;
  const tick = () => {
    void import("./wasender-db.server")
      .then((mod) => mod.systemPulse())
      .catch((err: unknown) => {
        console.error("[wasender] Versand fehlgeschlagen:", err instanceof Error ? err.message : err);
      });
  };
  setTimeout(tick, 4_000);
  setInterval(tick, 15_000);
}
