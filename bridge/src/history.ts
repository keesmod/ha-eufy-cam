import { type Station, type DatabaseQueryByDate, type DatabaseCountByDate } from 'eufy-security-client';

const LIMITS = [100, 500, 2000, 10000];

/** Pinned SDK compatibility: expose its existing, hardware-verified count field.
 * The SDK hardcodes 100 and ignores continuation metadata. No new protocol fields.
 * The temporary wrapper lives only for the synchronous SDK command construction.
 */
export function issueCalendarQuery(station: Station, start: Date, end: Date, count: number): void {
  type Command = { value: string };
  type Session = { sendCommandWithStringPayload(command: Command, ...args: unknown[]): void };
  const session = (station as unknown as { p2pSession: Session }).p2pSession;
  const send = session.sendCommandWithStringPayload;
  session.sendCommandWithStringPayload = function(command, ...args) {
    const message = JSON.parse(command.value);
    if (message.payload?.cmd === 10006) {
      message.payload.payload.count = count;
      command = { ...command, value: JSON.stringify(message) };
    }
    return send.call(this, command, ...args);
  };
  try { station.databaseQueryByDate([], start, end); }
  finally { session.sendCommandWithStringPayload = send; }
}

function response<T>(station: Station, event: 'database query by date' | 'database count by date', issue: () => void, signal: AbortSignal): Promise<T[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); station.off(event, received); signal.removeEventListener('abort', cancelled); };
    const cancelled = () => { clean(); reject(new Error('History request cancelled or timed out')); };
    const received = (_station: Station, code: number, data: unknown) => {
      clean();
      if (code !== 0 || !Array.isArray(data) || data.length > 10000) reject(new Error('History response rejected'));
      else resolve(data as T[]);
    };
    const timer = setTimeout(cancelled, 15000);
    station.on(event, received); signal.addEventListener('abort', cancelled, { once: true });
    try { issue(); } catch { cancelled(); }
  });
}

/** Expand a verified prefix until it is shorter than the requested limit.
 * Increasing count is verified on HB3; start_time and flag are NOT cursors there.
 * Never silently truncate at a guard or accept a shrinking/changing prefix.
 */
export async function completeDay(station: Station, start: Date, end: Date, signal: AbortSignal, sent = () => {}): Promise<DatabaseQueryByDate[]> {
  let previous = new Set<number>();
  for (const limit of LIMITS) {
    const rows = await response<DatabaseQueryByDate>(station, 'database query by date', () => { sent(); issueCalendarQuery(station, start, end, limit); }, signal);
    if (rows.length > limit || rows.some(r => !Number.isSafeInteger(r.record_id))) throw new Error('Invalid history page');
    const ids = new Set(rows.map(r => r.record_id));
    if (ids.size !== rows.length || [...previous].some(id => !ids.has(id))) throw new Error('History changed; retry the date');
    // An unchanged full prefix after increasing the limit may be a firmware cap.
    if (previous.size && ids.size === previous.size) throw new Error('HomeBase history limit; completeness unconfirmed');
    if (rows.length < limit) return rows;
    previous = ids;
  }
  throw new Error('HomeBase history exceeds the verified safety limit');
}

/** Firmware returns recording-day presence, not a total number of recordings. */
export async function recordingDays(station: Station, start: Date, end: Date, signal: AbortSignal): Promise<string[]> {
  const rows = await response<DatabaseCountByDate>(station, 'database count by date', () => station.databaseCountByDate(start, end), signal);
  return rows.filter(row => row.count > 0).map(row => {
    // SDK converts YYYYMMDD into a Date in the bridge timezone.
    const date = row.day;
    if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) throw new Error('Invalid recording day');
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  });
}
