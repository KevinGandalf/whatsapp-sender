import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pulse")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { pulseAuthorized, pulseConfigured, systemPulse } = await import("@/lib/vorlauf-db.server");
        if (!pulseConfigured()) return new Response(null, { status: 404 });
        if (!pulseAuthorized(request.headers.get("authorization"))) {
          return new Response(null, { status: 401 });
        }
        const result = await systemPulse();
        return Response.json(result);
      },
    },
  },
});
