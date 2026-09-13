import type { Destination } from './types';

// Deployment config that must not be hardcoded per install. The office
// destination is where auto trips go (and the default a manual trip inherits);
// it is set per deployment via the OFFICE_DESTINATION Worker var (a JSON string
// in wrangler.toml, see wrangler.toml.example). The value below is a generic
// placeholder (Amsterdam Centraal) so local dev and tests work without config.
export const DEFAULT_OFFICE_DESTINATION: Destination = {
  label: '@Office',
  lat: 52.3791283,
  lng: 4.899431,
  place_id: null,
  // Office pin glyph (a building). Always shown for the office; never a user emoji.
  emoji: '\u{1F3E2}',
};

// Resolve the office destination from the Worker env, falling back to the
// placeholder default when the var is unset or malformed. Parsed per call (the
// payload is tiny); callers thread the resolved object into db/state helpers.
export function resolveOffice(env: { OFFICE_DESTINATION?: string }): Destination {
  const raw = env.OFFICE_DESTINATION;
  if (!raw) return DEFAULT_OFFICE_DESTINATION;
  try {
    const o = JSON.parse(raw) as Partial<Destination>;
    if (typeof o.label !== 'string' || typeof o.lat !== 'number' || typeof o.lng !== 'number') {
      return DEFAULT_OFFICE_DESTINATION;
    }
    return {
      label: o.label,
      lat: o.lat,
      lng: o.lng,
      place_id: o.place_id ?? null,
      emoji: o.emoji ?? null,
    };
  } catch {
    return DEFAULT_OFFICE_DESTINATION;
  }
}
