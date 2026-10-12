import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

const Recipient = z.object({
  kind: z.enum(["user", "contact"]),
  id: z.string().min(1).max(80),
});

const RoutineInput = z.object({
  id: z.string().max(80).optional(),
  title: z.string().max(120),
  body: z.string().max(2000),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  weekdays: z.array(z.number()).max(7),
  monthDay: z.number(),
  timeLocal: z.string().max(8),
  recipients: z.array(Recipient).max(40),
  enabled: z.boolean(),
});

async function db() {
  return import("./vorlauf-db.server");
}

export const loadDesk = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => (await db()).bootstrap(context.userId));

export const runPulse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => (await db()).pulse(context.userId));

export const updateMyPhone = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ phone: z.string().max(30) }).parse(input))
  .handler(async ({ context, data }) => (await db()).savePhone(context.userId, data.phone));

export const upsertContact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ id: z.string().max(80).optional(), name: z.string().max(80), phone: z.string().max(30), note: z.string().max(200) }).parse(input),
  )
  .handler(async ({ context, data }) => (await db()).saveContact(context.userId, data));

export const deleteContact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => (await db()).removeContact(context.userId, data.id));

export const upsertRoutine = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => RoutineInput.parse(input))
  .handler(async ({ context, data }) => (await db()).saveRoutine(context.userId, data));

export const deleteRoutine = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => (await db()).removeRoutine(context.userId, data.id));

export const enqueueMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ recipients: z.array(Recipient).max(40), body: z.string().max(2000), sendAt: z.string().max(40) }).parse(input),
  )
  .handler(async ({ context, data }) => (await db()).queueManual(context.userId, data));

export const dropJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => (await db()).cancelJob(context.userId, data.id));

export const requeueJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => (await db()).retryJob(context.userId, data.id));

export const saveOrgSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        phoneNumberId: z.string().max(40),
        accessToken: z.string().max(8000),
        countryCode: z.string().max(6),
        timeZone: z.string().max(80),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => (await db()).saveOrg(context.userId, data));

export const saveAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ id: z.string().min(1).max(80), role: z.enum(["admin", "user"]), phone: z.string().max(30) }).parse(input),
  )
  .handler(async ({ context, data }) => (await db()).setAccount(context.userId, data));

export const upsertRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().max(80).optional(),
        name: z.string().max(80),
        enabled: z.boolean(),
        titleContains: z.string().max(80),
        minutes: z.number(),
        anchor: z.enum(["start", "end"]),
        recipients: z.array(Recipient).max(40),
        template: z.string().max(2000),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => (await db()).saveRule(context.userId, data));

export const deleteRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => (await db()).removeRule(context.userId, data.id));

const EventInput = z.object({
  id: z.string().max(200),
  title: z.string().max(200),
  start: z.string().max(40),
  end: z.string().max(40),
  location: z.string().max(200),
  preview: z.string().max(300),
  source: z.enum(["demo", "outlook", "graph", "ews"]),
});

export const materializeRules = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ events: z.array(EventInput).max(200) }).parse(input))
  .handler(async ({ context, data }) => (await db()).applyRules(context.userId, data.events));

export const saveCalendarSource = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        source: z.string().max(20),
        graphToken: z.string().max(8000),
        graphCalendarId: z.string().max(400),
        ewsUrl: z.string().max(300),
        ewsUser: z.string().max(200),
        ewsSecret: z.string().max(8000),
        ewsAuth: z.enum(["basic", "bearer"]),
        horizonDays: z.number(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => (await db()).saveSource(context.userId, data));

export const fetchCalendar = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => (await db()).loadCalendar(context.userId));
