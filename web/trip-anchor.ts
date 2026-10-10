// Push links end in #trip-<id> so a tap lands on that trip's card.

export const tripAnchor = (tripId: number) => `trip-${tripId}`;

export function tripIdFromHash(hash: string): number | null {
  const m = /^#trip-([1-9]\d*)$/.exec(hash);
  return m ? Number(m[1]) : null;
}
