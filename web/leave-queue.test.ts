import { describe, it, expect } from 'vitest';
import { classify, createLeaveQueue, type QueueStore } from './leave-queue';

const memoryStore = (): QueueStore & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
  };
};

const tap = { tripId: 3, tripDate: '2026-10-10', leftAt: '2026-10-10T05:42:00.000Z' };

describe('leave queue', () => {
  it('holds an enqueued tap until removed', () => {
    const q = createLeaveQueue(memoryStore(), 'tok-a');
    q.enqueue(tap);
    expect(q.pending(3)).toEqual(tap);
    expect(q.entries()).toEqual([tap]);
    q.remove(3);
    expect(q.pending(3)).toBeNull();
    expect(q.entries()).toEqual([]);
  });

  it('keeps the first tap time on a repeat tap', () => {
    const q = createLeaveQueue(memoryStore(), 'tok-a');
    q.enqueue(tap);
    q.enqueue({ ...tap, leftAt: '2026-10-10T05:50:00.000Z' });
    expect(q.entries()).toEqual([tap]);
  });

  it('survives a new queue over the same storage', () => {
    const store = memoryStore();
    createLeaveQueue(store, 'tok-a').enqueue(tap);
    expect(createLeaveQueue(store, 'tok-a').pending(3)).toEqual(tap);
  });

  it("hides and keeps another token's entries", () => {
    const store = memoryStore();
    createLeaveQueue(store, 'tok-a').enqueue(tap);
    const other = createLeaveQueue(store, 'tok-b');
    expect(other.pending(3)).toBeNull();
    other.remove(3);
    expect(createLeaveQueue(store, 'tok-a').pending(3)).toEqual(tap);
  });

  it('prunes entries for past trip dates only', () => {
    const q = createLeaveQueue(memoryStore(), 'tok-a');
    q.enqueue({ ...tap, tripId: 1, tripDate: '2026-10-09' });
    q.enqueue(tap);
    q.prune('2026-10-10');
    expect(q.entries()).toEqual([tap]);
  });

  it('treats corrupt storage as empty', () => {
    const store = memoryStore();
    store.items.set('leave-queue', '{nope');
    const q = createLeaveQueue(store, 'tok-a');
    expect(q.entries()).toEqual([]);
    q.enqueue(tap);
    expect(q.entries()).toEqual([tap]);
  });

  it('works when storage throws', () => {
    const q = createLeaveQueue(
      {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
      'tok-a',
    );
    q.enqueue(tap);
    expect(q.entries()).toEqual([]);
  });
});

describe('classify', () => {
  it('counts an earlier landed send as done', () => {
    expect(classify(409, 'already left')).toBe('done');
  });

  it('drops answers a retry cannot fix', () => {
    expect(classify(409, 'trip cancelled')).toBe('drop');
    expect(classify(403, 'only the trip driver')).toBe('drop');
    expect(classify(400, 'left_at must be an ISO time on the trip date')).toBe('drop');
    expect(classify(404, 'trip not found')).toBe('drop');
    expect(classify(401, 'invalid token')).toBe('drop');
  });

  it('retries network and server errors', () => {
    expect(classify(0, 'network error')).toBe('retry');
    expect(classify(500, 'error 500')).toBe('retry');
    expect(classify(503, 'error 503')).toBe('retry');
    expect(classify(429, 'error 429')).toBe('retry');
  });
});
