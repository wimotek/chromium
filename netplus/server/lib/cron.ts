function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  const parts = field.split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) return null;

    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const rangePart = stepMatch[1];
      const step = parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) return null;

      let start = min;
      let end = max;
      if (rangePart !== '*') {
        if (rangePart.includes('-')) {
          const [s, e] = rangePart.split('-').map((n) => parseInt(n, 10));
          if (Number.isNaN(s) || Number.isNaN(e) || s < min || e > max || s > e) return null;
          start = s;
          end = e;
        } else {
          const s = parseInt(rangePart, 10);
          if (Number.isNaN(s) || s < min || s > max) return null;
          start = s;
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    if (part.includes('-')) {
      const [s, e] = part.split('-').map((n) => parseInt(n, 10));
      if (Number.isNaN(s) || Number.isNaN(e) || s < min || e > max || s > e) return null;
      for (let i = s; i <= e; i++) values.add(i);
      continue;
    }

    const single = parseInt(part, 10);
    if (Number.isNaN(single) || single < min || single > max) return null;
    values.add(single);
  }
  return values.size > 0 ? values : null;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

export function parseCronExpression(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeek = parseCronField(fields[4], 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export function isValidCronExpression(expr: string): boolean {
  return parseCronExpression(expr) !== null;
}

export function matchesCronDate(parsed: ParsedCron, date: Date): boolean {
  return (
    parsed.minutes.has(date.getMinutes()) &&
    parsed.hours.has(date.getHours()) &&
    parsed.daysOfMonth.has(date.getDate()) &&
    parsed.months.has(date.getMonth() + 1) &&
    parsed.daysOfWeek.has(date.getDay())
  );
}

export function computeNextCronRun(expr: string, fromDate = new Date()): string | undefined {
  const parsed = parseCronExpression(expr);
  if (!parsed) return undefined;

  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Scan up to 31 days ahead in 1-minute increments (bounded to 44,640 checks)
  const limit = 44640;
  for (let i = 0; i < limit; i++) {
    if (matchesCronDate(parsed, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}
