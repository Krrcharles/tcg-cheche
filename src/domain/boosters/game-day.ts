export interface GameDay {
  date: string;
  nextDate: string;
  timezone: string;
}

export function gameDay(now: Date, timezone: string): GameDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { date, nextDate: next.toISOString().slice(0, 10), timezone };
}
