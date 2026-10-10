// "I'm leaving" taps waiting to reach the server. The tap is stored before any
// network call, so it survives no connection and the OS killing the app; the
// page flushes it later with the original tap time. Entries carry the token they
// were tapped under, so a second person's link on the same phone never sends or
// drops the first person's tap.

export interface LeaveEntry {
  tripId: number;
  tripDate: string;
  leftAt: string;
}

interface StoredEntry extends LeaveEntry {
  token: string;
}

export interface QueueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const QUEUE_KEY = 'leave-queue';

const isEntry = (e: unknown): e is StoredEntry => {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.token === 'string' &&
    typeof o.tripId === 'number' &&
    typeof o.tripDate === 'string' &&
    typeof o.leftAt === 'string'
  );
};

function readAll(store: QueueStore): StoredEntry[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeAll(store: QueueStore, entries: StoredEntry[]): void {
  try {
    store.setItem(QUEUE_KEY, JSON.stringify(entries));
  } catch {
    // storage unavailable or full; the tap is then only as durable as the page
  }
}

const strip = ({ tripId, tripDate, leftAt }: StoredEntry): LeaveEntry => ({
  tripId,
  tripDate,
  leftAt,
});

export function createLeaveQueue(store: QueueStore, token: string) {
  const mine = (e: StoredEntry) => e.token === token;
  return {
    entries: (): LeaveEntry[] => readAll(store).filter(mine).map(strip),

    pending: (tripId: number): LeaveEntry | null => {
      const hit = readAll(store).find((e) => mine(e) && e.tripId === tripId);
      return hit ? strip(hit) : null;
    },

    // A repeat tap for a queued trip keeps the first tap's time.
    enqueue: (entry: LeaveEntry): void => {
      const all = readAll(store);
      if (all.some((e) => mine(e) && e.tripId === entry.tripId)) return;
      writeAll(store, [...all, { ...entry, token }]);
    },

    remove: (tripId: number): void => {
      writeAll(store, readAll(store).filter((e) => !(mine(e) && e.tripId === tripId)));
    },

    // The server rejects a departure off the trip's date, so a past day's entry
    // can never land. Applies to every token's entries.
    prune: (today: string): void => {
      const all = readAll(store);
      const kept = all.filter((e) => e.tripDate >= today);
      if (kept.length !== all.length) writeAll(store, kept);
    },
  };
}

export type LeaveQueue = ReturnType<typeof createLeaveQueue>;

export type LeaveOutcome = 'done' | 'drop' | 'retry';

// What a failed send means for the queued entry. "already left" is the server's
// one-shot guard, so an earlier attempt landed. Other 4xx answers will never
// succeed on retry. Status 0 is the client's network error.
export function classify(status: number, message: string): LeaveOutcome {
  if (status === 409 && message === 'already left') return 'done';
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retry';
  return 'drop';
}
