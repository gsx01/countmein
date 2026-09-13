export type TripStatus = 'scheduled' | 'cancelled';
export type TripSource = 'auto' | 'manual';
export type Response = 'pending' | 'in' | 'out';

export interface RiderState {
  id: number;
  name: string;
  response: Response;
  pickup_spot: string | null;
  suggested_etd: string | null;
  note: string | null;
}

// A pickup spot as offered by an enabled user: the label the rider picks, plus
// that user's home coordinates (Feature 4) so the client can place the pin and
// build the route. Coordinates are null until the admin sets the user's address.
export interface PickupSpot {
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  // The owning user's map-pin emoji (the office spot always carries OFFICE_EMOJI).
  emoji: string | null;
}

// A trip's destination (Feature 4), always resolved: the trip's own override, or
// the OFFICE_DESTINATION default when the trip sets none. `dest_custom` on Trip
// says which one it is.
export interface Destination {
  label: string;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  // The office default carries OFFICE_EMOJI; a custom destination has no emoji.
  emoji: string | null;
}

export interface Trip {
  id: number;
  trip_date: string;
  weekday: number;
  etd: string;
  status: TripStatus;
  source: TripSource;
  note: string | null;
  locked: boolean;
  driver: {
    id: number;
    name: string;
    address: string | null;
    lat: number | null;
    lng: number | null;
    emoji: string | null;
  } | null;
  destination: Destination;
  dest_custom: boolean;
  // ISO timestamp the driver tapped "I'm leaving", or null if not yet. Drives the
  // one-shot leaving ping and the "Left HH:MM" card stamp.
  left_at: string | null;
  riders: RiderState[];
}

// Per-user notification categories. Each backs one or more notification kinds
// (see notify.ts) and one `pref_<key>` column on users. A push to a user whose
// category flag is false is dropped before send.
export type NotifyCategory =
  | 'evening_reminder'
  | 'driver_leaving'
  | 'driver_updates'
  | 'driver_assignment'
  | 'rider_responses'
  | 'rider_notes';

export type NotifyPrefs = Record<NotifyCategory, boolean>;

export const NOTIFY_CATEGORIES: NotifyCategory[] = [
  'evening_reminder',
  'driver_leaving',
  'driver_updates',
  'driver_assignment',
  'rider_responses',
  'rider_notes',
];

export interface AppState {
  me: { id: number; name: string; is_admin: boolean; prefs: NotifyPrefs };
  spots: PickupSpot[];
  trips: Trip[];
}

// A user row as seen in the admin panel. Carries the token so the admin can copy
// each person's /?t=<token> link; admin-gated, never exposed via GET /api/state.
export interface AdminUser {
  id: number;
  name: string;
  enabled: boolean;
  is_admin: boolean;
  pickup_label: string | null;
  formatted_address: string | null;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  emoji: string | null;
  token: string;
}

// GET /api/users returns just the list; the writes (create/patch/rotate) also
// return fresh app state so the roster and spot list refresh in one round-trip.
export interface UsersResponse {
  users: AdminUser[];
}

// A home address from Places Autocomplete: the four fields are set together, or
// all cleared together (null). Shared by the admin user create/patch payloads on
// both the Worker (validation) and the web client (request bodies).
export interface Address {
  formatted_address: string;
  lat: number;
  lng: number;
  place_id: string;
}

// The editable fields of an admin user PATCH: all optional; an address of null
// clears the stored home.
export interface UserPatch {
  name?: string;
  enabled?: boolean;
  is_admin?: boolean;
  pickup_label?: string;
  address?: Address | null;
  // A user's map-pin emoji; null clears it back to the role default.
  emoji?: string | null;
}

export interface AdminWriteResponse {
  state: AppState;
  users: AdminUser[];
}
