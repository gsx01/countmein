import type { PickupSpot, Trip } from '../src/types';
import { orderStops, routesLibrary, type Coord } from './maps';

// Route/ETA math for a trip's map card, kept out of the view so it is unit-testable
// and reused by TripRoute. The Directions call (computeEta) is the only piece that
// touches the Google SDK; everything else is pure.

export interface RoutePoint {
  label: string;
  lat: number;
  lng: number;
  // Map-pin glyph: the user's emoji (driver/pickup) or the office emoji, or null
  // to fall back to a role default glyph.
  emoji: string | null;
}

export interface RouteStop {
  label: string;
  cumulativeSeconds: number;
}

export interface RouteResult {
  totalSeconds: number;
  stops: RouteStop[];
  traffic: boolean;
  // The road geometry to draw as a polyline (Directions overview_path).
  path: Coord[];
}

export interface RoutePoints {
  driver: RoutePoint | null;
  pickups: RoutePoint[];
  destination: RoutePoint | null;
  // The trip has a meetup: it is the only pickup (when it has coordinates) and
  // the trip's time is when the driver is there, not when they leave home.
  meetup: boolean;
}

// The map/route inputs for a trip: the driver's home (start), each distinct "in"
// rider's chosen pickup spot (the home of whoever owns that label), and the
// destination. A meetup is the one stop, even before anyone is in, since the
// trip's time is anchored there. Points whose coordinates are not set yet are
// dropped.
export function routePoints(trip: Trip, spots: PickupSpot[]): RoutePoints {
  const d = trip.driver;
  const driver =
    d && d.lat !== null && d.lng !== null
      ? { label: d.name, lat: d.lat, lng: d.lng, emoji: d.emoji }
      : null;

  // Truthy check: a state cached before the meetup feature has no such field.
  const meetup = trip.meetup_label || null;
  const labels = meetup
    ? [meetup]
    : trip.riders.flatMap((r) => (r.response === 'in' && r.pickup_spot ? [r.pickup_spot] : []));
  const byLabel = new Map(spots.map((s) => [s.label, s]));
  const pickups: RoutePoint[] = [];
  for (const label of new Set(labels)) {
    const s = byLabel.get(label);
    if (s && s.lat !== null && s.lng !== null) {
      pickups.push({ label, lat: s.lat, lng: s.lng, emoji: s.emoji });
    }
  }

  const dest = trip.destination;
  const destination =
    dest.lat !== null && dest.lng !== null
      ? { label: dest.label, lat: dest.lat, lng: dest.lng, emoji: dest.emoji }
      : null;

  // Best-effort geographic pickup order (haversine) when both route anchors are
  // known; without a driver start or destination end there is nothing to order
  // against, so the rider-response order stands.
  const ordered = driver && destination ? orderStops(driver, pickups, destination) : pickups;

  return { driver, pickups: ordered, destination, meetup: meetup !== null };
}

// The trip's time as a local Date (browser time - fine for NL colleagues), or
// null if unparseable. Passed to Directions for traffic-aware timing. With a
// meetup this is the meet time, so the drive there is sampled a little late; one
// Directions call is worth more than that accuracy on a commute.
export function departureAt(trip: Trip): Date | null {
  const [y, mo, d] = trip.trip_date.split('-').map(Number);
  const [h, mi] = trip.etd.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Session cache for computed ETAs, keyed by the exact set of coordinates plus the
// departure time, so a re-render (every write replaces state) never re-hits the
// Directions API unless the route or departure actually changed.
const etaCache = new Map<string, RouteResult>();

type PointFormat = (pt: RoutePoint) => string;
const coordOf: PointFormat = (pt) => `${pt.lat},${pt.lng}`;
const pinOf: PointFormat = (pt) => `${coordOf(pt)},${pt.label},${pt.emoji ?? ''}`;

function pointsSignature(p: RoutePoints, format: PointFormat): string {
  const c = (pt: RoutePoint | null) => (pt ? format(pt) : '');
  return `${c(p.driver)}|${p.pickups.map(c).join(';')}|${c(p.destination)}`;
}

// The ETA depends only on the coordinates, so a pin label/emoji edit stays a
// cache hit (no Directions call).
function etaSignature(p: RoutePoints, departure: Date | null): string {
  return `${pointsSignature(p, coordOf)}|${departure?.getTime() ?? 'none'}`;
}

// A content key for a trip's route: what the pins show plus the departure. Equal
// keys mean a refetched state can keep the previous `points`, so the map's marker
// and ETA effects don't re-run.
export function routeKey(p: RoutePoints, trip: Pick<Trip, 'trip_date' | 'etd'>): string {
  return `${pointsSignature(p, pinOf)}|${p.meetup}|${trip.trip_date}|${trip.etd}`;
}

// Directions rejects a past departureTime, so traffic-aware timing is used only
// when departure is in the future; otherwise it falls back to typical duration.
export async function computeEta(p: RoutePoints, departure: Date | null): Promise<RouteResult | null> {
  if (!p.driver || !p.destination) return null;
  const useTraffic = departure !== null && departure.getTime() > Date.now();
  const sig = etaSignature(p, useTraffic ? departure : null);
  const cached = etaCache.get(sig);
  if (cached) return cached;

  const { DirectionsService } = await routesLibrary();
  const result = await new DirectionsService().route({
    origin: { lat: p.driver.lat, lng: p.driver.lng },
    destination: { lat: p.destination.lat, lng: p.destination.lng },
    waypoints: p.pickups.map((pt) => ({ location: { lat: pt.lat, lng: pt.lng }, stopover: true })),
    travelMode: google.maps.TravelMode.DRIVING,
    ...(useTraffic
      ? { drivingOptions: { departureTime: departure, trafficModel: google.maps.TrafficModel.BEST_GUESS } }
      : {}),
  });

  // With a future departureTime Directions returns duration_in_traffic per leg;
  // prefer it, falling back to the typical duration.
  const legSeconds = (l: google.maps.DirectionsLeg) =>
    l.duration_in_traffic?.value ?? l.duration?.value ?? 0;
  const legs = result.routes[0]?.legs ?? [];
  let acc = 0;
  const stops: RouteStop[] = [];
  for (let i = 0; i < p.pickups.length; i++) {
    acc += legs[i] ? legSeconds(legs[i]) : 0;
    stops.push({ label: p.pickups[i].label, cumulativeSeconds: acc });
  }
  const totalSeconds = legs.reduce((sum, l) => sum + legSeconds(l), 0);
  const path = (result.routes[0]?.overview_path ?? []).map((pt) => ({ lat: pt.lat(), lng: pt.lng() }));
  const route = { totalSeconds, stops, traffic: useTraffic, path };
  etaCache.set(sig, route);
  return route;
}

export function fmtDuration(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// A clock time: the ETD plus the given drive seconds, which may be negative
// (same-day, wraps at midnight both ways).
export function addSeconds(etd: string, seconds: number): string {
  const [h, m] = etd.split(':').map(Number);
  const day = 24 * 60;
  const total = (((h * 60 + m + Math.round(seconds / 60)) % day) + day) % day;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface RouteTimes {
  leave: string;
  stops: { label: string; at: string }[];
  arrive: string;
}

// Clock times along the route, counted from where the trip's time applies: the
// meetup stop when there is one, else the driver's home. Null when the meetup has
// no coordinates, as nothing on the route can then be timed.
export function routeTimes(etd: string, meetup: boolean, route: RouteResult): RouteTimes | null {
  const anchor = meetup ? route.stops[0]?.cumulativeSeconds : 0;
  if (anchor === undefined) return null;
  const at = (seconds: number) => addSeconds(etd, seconds - anchor);
  return {
    leave: at(0),
    stops: route.stops.map((s) => ({ label: s.label, at: at(s.cumulativeSeconds) })),
    arrive: at(route.totalSeconds),
  };
}
