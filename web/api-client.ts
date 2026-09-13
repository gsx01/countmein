import type {
  Address,
  AdminWriteResponse,
  AppState,
  NotifyCategory,
  UserPatch,
  UsersResponse,
} from '../src/types';

// Re-exported so callers (app.tsx) keep importing these from the api client.
export type { Address, UserPatch };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'token';

const readStored = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

const writeStored = (value: string): void => {
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // storage unavailable (private mode / disabled); the URL token still works
  }
};

// The URL's ?t= is authoritative: use it and persist it when it differs from the
// stored one. With no URL token, fall back to the last persisted token.
function resolveToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    if (fromUrl !== readStored()) writeStored(fromUrl);
    return fromUrl;
  }
  return readStored();
}

const token = resolveToken();

export const hasToken = () => token !== null && token !== '';

async function call<T = AppState>(path: string, init?: RequestInit): Promise<T> {
  if (!token) throw new ApiError(401, 'missing token');
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-token': token, ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'network error');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // leave data null
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `error ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

// The push routes return 204 with no body, so they bypass the state-returning
// `call` helper.
async function callVoid(path: string, init: RequestInit): Promise<void> {
  if (!token) throw new ApiError(401, 'missing token');
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-token': token, ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'network error');
  }
  if (!res.ok) throw new ApiError(res.status, `error ${res.status}`);
}

export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export const subscribePush = (sub: PushSubscribeBody) =>
  callVoid('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });

export const unsubscribePush = (endpoint: string) =>
  callVoid('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });

export const getState = () => call('/state');

// Update the current user's own notification preferences (a partial set of
// category -> boolean). Returns fresh state so `me.prefs` reflects the change.
export const updatePrefs = (patch: Partial<Record<NotifyCategory, boolean>>) =>
  call('/prefs', { method: 'PATCH', body: JSON.stringify(patch) });

export const createTrip = (trip_date: string, etd: string) =>
  call('/trips', {
    method: 'POST',
    body: JSON.stringify({ trip_date, etd }),
  });

export const setParticipation = (
  tripId: number,
  response: 'in' | 'out',
  pickup_spot: string | null,
) =>
  call(`/trips/${tripId}/participation`, {
    method: 'POST',
    body: JSON.stringify({ response, pickup_spot }),
  });

export const setEtd = (tripId: number, etd: string) =>
  call(`/trips/${tripId}/etd`, {
    method: 'POST',
    body: JSON.stringify({ etd }),
  });

export const setSuggestion = (tripId: number, suggested_etd: string | null) =>
  call(`/trips/${tripId}/suggestion`, {
    method: 'POST',
    body: JSON.stringify({ suggested_etd }),
  });

export const setTripNote = (tripId: number, note: string | null) =>
  call(`/trips/${tripId}/trip-note`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });

export const setRiderNote = (tripId: number, note: string | null) =>
  call(`/trips/${tripId}/rider-note`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });

export const setCancelled = (tripId: number, cancelled: boolean) =>
  call(`/trips/${tripId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancelled }),
  });

export const setDriver = (tripId: number, driver_id: number | null) =>
  call(`/trips/${tripId}/driver`, {
    method: 'POST',
    body: JSON.stringify({ driver_id }),
  });

// The driver signals departure (one-shot per trip). Body-less; works even after
// the trip locks.
export const setLeaving = (tripId: number) =>
  call(`/trips/${tripId}/leaving`, { method: 'POST' });

export interface DestinationInput {
  label: string;
  lat: number;
  lng: number;
  place_id: string | null;
}

// Set a one-off trip destination, or null to fall back to the office default.
export const setDestination = (tripId: number, destination: DestinationInput | null) =>
  call(`/trips/${tripId}/destination`, {
    method: 'POST',
    body: JSON.stringify({ destination }),
  });

// Admin-only user management. GET returns just the user list; the writes return
// { state, users } so the roster and the admin panel refresh together.
export const getUsers = () => call<UsersResponse>('/users');

export const createUser = (name: string, pickup_label: string, is_admin: boolean, emoji: string) =>
  call<AdminWriteResponse>('/users', {
    method: 'POST',
    body: JSON.stringify({ name, pickup_label, is_admin, emoji }),
  });

export const updateUser = (id: number, patch: UserPatch) =>
  call<AdminWriteResponse>(`/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const rotateUserToken = (id: number) =>
  call<AdminWriteResponse>(`/users/${id}/rotate-token`, { method: 'POST' });
