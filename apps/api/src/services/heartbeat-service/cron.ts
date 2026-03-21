export function isHeartbeatDue(cronExpression: string, lastRunAt: Date | null, now: Date) {
  const normalizedNow = truncateToMinute(now);
  if (!matchesCronExpression(cronExpression, normalizedNow)) {
    return false;
  }
  if (!lastRunAt) {
    return true;
  }
  return truncateToMinute(lastRunAt).getTime() !== normalizedNow.getTime();
}

function truncateToMinute(date: Date) {
  const clone = new Date(date);
  clone.setSeconds(0, 0);
  return clone;
}

function matchesCronExpression(expression: string, date: Date) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  return (
    matchesCronField(minute, date.getMinutes(), 0, 59) &&
    matchesCronField(hour, date.getHours(), 0, 23) &&
    matchesCronField(dayOfMonth, date.getDate(), 1, 31) &&
    matchesCronField(month, date.getMonth() + 1, 1, 12) &&
    matchesCronField(dayOfWeek, date.getDay(), 0, 6)
  );
}

function matchesCronField(field: string, value: number, min: number, max: number) {
  return field.split(",").some((part) => matchesCronPart(part.trim(), value, min, max));
}

function matchesCronPart(part: string, value: number, min: number, max: number): boolean {
  if (part === "*") {
    return true;
  }

  const stepMatch = part.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    return Number.isInteger(step) && step > 0 ? (value - min) % step === 0 : false;
  }

  const rangeMatch = part.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    return start <= value && value <= end;
  }

  const exact = Number(part);
  return Number.isInteger(exact) && exact >= min && exact <= max && exact === value;
}
