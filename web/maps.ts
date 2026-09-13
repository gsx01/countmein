import { GOOGLE_MAPS_API_KEY } from './config';

// Google Maps JS SDK access, loaded lazily. The SDK is fetched only when a map,
// autocomplete, or ETA is actually needed (never on a plain page load), and the
// script is injected once. Everything goes through the JS SDK (not the REST
// endpoints) so the browser sends a referrer and the referrer-restricted key is
// accepted.

let bootstrap: Promise<void> | null = null;

// Inject the base SDK script and resolve once google.maps.importLibrary exists.
// importLibrary then dynamically pulls each library ('maps', 'places', 'routes')
// on demand.
function ensureBootstrap(): Promise<void> {
  if (bootstrap) return bootstrap;
  bootstrap = new Promise<void>((resolve, reject) => {
    if (typeof google !== 'undefined' && typeof google.maps?.importLibrary === 'function') {
      resolve();
      return;
    }
    const cb = '__carpoolMapsReady';
    (window as unknown as Record<string, unknown>)[cb] = () => resolve();
    const params = new URLSearchParams({
      key: GOOGLE_MAPS_API_KEY,
      v: 'weekly',
      loading: 'async',
      callback: cb,
    });
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.append(script);
  });
  return bootstrap;
}

export async function mapsLibrary(): Promise<google.maps.MapsLibrary> {
  await ensureBootstrap();
  return google.maps.importLibrary('maps') as Promise<google.maps.MapsLibrary>;
}

export async function placesLibrary(): Promise<google.maps.PlacesLibrary> {
  await ensureBootstrap();
  return google.maps.importLibrary('places') as Promise<google.maps.PlacesLibrary>;
}

export async function routesLibrary(): Promise<google.maps.RoutesLibrary> {
  await ensureBootstrap();
  return google.maps.importLibrary('routes') as Promise<google.maps.RoutesLibrary>;
}

export async function markerLibrary(): Promise<google.maps.MarkerLibrary> {
  await ensureBootstrap();
  return google.maps.importLibrary('marker') as Promise<google.maps.MarkerLibrary>;
}

export interface Coord {
  lat: number;
  lng: number;
}

// A picked place from Places Autocomplete, shaped for our address/destination
// payloads (matches the worker's parseAddress / parseDestination).
export interface PickedPlace {
  formatted_address: string;
  lat: number;
  lng: number;
  place_id: string;
}

// Great-circle distance between two coordinates, in metres (haversine). Only the
// relative magnitude matters here (ordering), so the unit is incidental.
function haversine(a: Coord, b: Coord): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Above this many stops the exact search is skipped for the greedy fallback. A
// trip never has this many distinct pickups; the guard just bounds the worst case.
const EXACT_STOP_LIMIT = 8;

// Best-effort pickup order for a fixed driver start and destination end: the stop
// sequence with the least total great-circle distance. A free, offline stand-in
// for Google's paid waypoint optimisation - straight-line, not road distance, so
// "best effort": in a compact commute it matches the road-optimal order, but a
// river or motorway detour can make it differ. Exact (branch-and-bound) for the
// small counts a trip has, with a nearest-neighbour fallback for the rare large
// case.
export function orderStops<T extends Coord>(origin: Coord, stops: T[], destination: Coord): T[] {
  if (stops.length <= 1) return stops.slice();
  return stops.length <= EXACT_STOP_LIMIT
    ? orderExact(origin, stops, destination)
    : orderGreedy(origin, stops);
}

function orderExact<T extends Coord>(origin: Coord, stops: T[], destination: Coord): T[] {
  const n = stops.length;
  const used = new Array<boolean>(n).fill(false);
  const current: number[] = [];
  let best: number[] = [];
  let bestCost = Infinity;

  const visit = (pos: Coord, depth: number, cost: number) => {
    if (cost >= bestCost) return; // partial cost only grows, so this prunes safely
    if (depth === n) {
      const total = cost + haversine(pos, destination);
      if (total < bestCost) {
        bestCost = total;
        best = current.slice();
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(i);
      visit(stops[i], depth + 1, cost + haversine(pos, stops[i]));
      current.pop();
      used[i] = false;
    }
  };

  visit(origin, 0, 0);
  return best.map((i) => stops[i]);
}

function orderGreedy<T extends Coord>(origin: Coord, stops: T[]): T[] {
  const remaining = stops.slice();
  const order: T[] = [];
  let pos: Coord = origin;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(pos, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    pos = remaining[bestIdx];
    order.push(remaining.splice(bestIdx, 1)[0]);
  }
  return order;
}

// A free Google Maps directions deep link (no API key, no billing): driver start
// -> each pickup (fixed order) -> destination. Google does its own routing.
// Duplicate stops are dropped: a waypoint repeated, or one that coincides with the
// start or the destination, is a redundant stop and is removed (order preserved).
export function navigateUrl(origin: Coord, stops: Coord[], destination: Coord): string {
  const ll = (c: Coord) => `${c.lat},${c.lng}`;
  const seen = new Set([ll(origin), ll(destination)]);
  const waypoints: string[] = [];
  for (const s of stops) {
    const key = ll(s);
    if (seen.has(key)) continue;
    seen.add(key);
    waypoints.push(key);
  }
  const params = new URLSearchParams({
    api: '1',
    origin: ll(origin),
    destination: ll(destination),
    travelmode: 'driving',
  });
  if (waypoints.length > 0) params.set('waypoints', waypoints.join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}
