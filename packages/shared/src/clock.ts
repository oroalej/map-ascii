/** Cached IANA-zone calendar parts, shared by event timing and the renderer's city clock. */
const formats = new Map<string, Intl.DateTimeFormat>();
export function localDateParts(date: Date, timezone: string) {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formats.set(timezone, format);
  }
  const parts = format.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    date: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}
