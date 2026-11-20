import { CronExpressionParser } from "cron-parser";

export type CronSchedule =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "interval"; readonly milliseconds: number }
  | { readonly kind: "calendar"; readonly expression: string; readonly timezone: string };

export function parseCronSchedule(text: string, now: number): CronSchedule | null {
  const relative = /^(in|every) ([1-9]\d*)([smhd])$/.exec(text);
  if (relative) {
    const [, mode, amount, unit] = relative;
    const seconds = Number(amount) * (unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400);
    const milliseconds = seconds * 1000;
    if (!Number.isFinite(new Date(now + milliseconds).getTime()) || mode === "every" && seconds < 60) return null;
    return mode === "every" ? { kind: "interval", milliseconds } : { kind: "once", at: now + milliseconds };
  }
  if (text.startsWith("at ")) {
    const date = text.slice(3);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-]\d{2}:\d{2})$/.test(date)) return null;
    const day = date.slice(0, 10);
    const midnight = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(day)) return null;
    const at = Date.parse(date);
    return at > now ? { kind: "once", at } : null;
  }
  const fields = text.split(/\s+/);
  const zone = fields[0]?.startsWith("TZ=") ? fields.shift()?.slice(3) : undefined;
  if (fields.length !== 5 || zone === "" || fields.some(field => /\bH\b/i.test(field))) return null;
  try {
    const timezone = new Intl.DateTimeFormat(undefined, zone === undefined ? {} : { timeZone: zone }).resolvedOptions().timeZone;
    const schedule = { kind: "calendar", expression: fields.join(" "), timezone } as const;
    nextCronTime(schedule, now); // Reject expressions with no computable occurrence at registration.
    return schedule;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export function nextCronTime(schedule: CronSchedule, now: number): number {
  switch (schedule.kind) {
    case "once": return schedule.at;
    case "interval": return now + schedule.milliseconds;
    case "calendar": return CronExpressionParser.parse(schedule.expression, {
      currentDate: now, tz: schedule.timezone,
    }).next().getTime();
  }
}

export function describeCronSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "once": return `at ${new Date(schedule.at).toISOString()}`;
    case "interval": return `every ${schedule.milliseconds / 1000}s`;
    case "calendar": return `TZ=${schedule.timezone} ${schedule.expression}`;
  }
}
