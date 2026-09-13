import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  AdminUser,
  AdminWriteResponse,
  AppState,
  NotifyCategory,
  PickupSpot,
  Trip,
} from '../src/types';
import {
  ApiError,
  createTrip,
  createUser,
  getState,
  getUsers,
  hasToken,
  rotateUserToken,
  setCancelled,
  setDestination,
  setDriver,
  setEtd,
  setLeaving,
  setParticipation,
  setRiderNote,
  setSuggestion,
  setTripNote,
  updatePrefs,
  updateUser,
  type UserPatch,
} from './api-client';
import { TIMEZONE } from '../src/constants';
import { GOOGLE_MAPS_MAP_ID } from './config';
import { mapsLibrary, markerLibrary, navigateUrl, placesLibrary, type PickedPlace } from './maps';
import {
  addSeconds,
  computeEta,
  departureAt,
  fmtDuration,
  routePoints,
  type RoutePoints,
  type RouteResult,
} from './route';
import {
  currentSubscription,
  disablePush,
  enablePush,
  iosNeedsInstall,
  pushSupported,
} from './push-client';

const NOTE_MAX = 280;

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

const formatDate = (isoDate: string) => dateFmt.format(new Date(`${isoDate}T00:00:00Z`));

// Amsterdam-local date (YYYY-MM-DD) now, to pick out "today's" trip regardless of
// the browser's own timezone. en-CA yields the ISO date shape.
const todayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });
const localToday = () => todayFmt.format(new Date());

// Amsterdam-local wall-clock HH:MM of an ISO instant (for the "Left HH:MM" stamp).
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const formatTime = (iso: string) => timeFmt.format(new Date(iso));

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [authError, setAuthError] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await getState());
      setAuthError(false);
      setBanner(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthError(true);
      else setBanner(err instanceof Error ? err.message : 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Any write returns fresh full state; apply it (true), or surface the error
  // (false) so a caller can keep its form open on failure.
  const apply = useCallback(async (op: () => Promise<AppState>) => {
    try {
      setState(await op());
      setBanner(null);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthError(true);
      else setBanner(err instanceof Error ? err.message : 'error');
      return false;
    }
  }, []);

  useEffect(() => {
    if (!hasToken()) {
      setAuthError(true);
      setLoading(false);
      return;
    }
    void load();
  }, [load]);

  if (authError) {
    return (
      <div class="centered">
        <h1>Count me in</h1>
        <p>This link isn't valid. Ask your carpool admin for your personal link.</p>
      </div>
    );
  }

  if (loading || !state) {
    return <div class="centered">Loading...</div>;
  }

  return (
    <main>
      <header class="app">
        <h1>Count me in</h1>
        <span class="who">
          {state.me.name}
          {state.me.is_admin ? ' - admin' : ''}
          <PushToggle />
        </span>
      </header>

      {banner && (
        <div class="banner">
          <span>{banner}</span>
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}

      {state.trips.length === 0 ? (
        <p class="centered">No upcoming trips.</p>
      ) : (
        state.trips.map((trip) => (
          <TripCard key={trip.id} trip={trip} me={state.me} spots={state.spots} apply={apply} />
        ))
      )}

      <AddTrip apply={apply} />

      <NotifySettings me={state.me} apply={apply} />

      {state.me.is_admin && <AdminPanel onState={setState} />}
    </main>
  );
}

function AddTrip({ apply }: { apply: (op: () => Promise<AppState>) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [etd, setEtd] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button class="link add-trip" onClick={() => setOpen(true)}>
        Add a one-off trip
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    const ok = await apply(() => createTrip(date, etd));
    setBusy(false);
    // Keep the form (and the entered date/ETD) on failure - e.g. a duplicate or
    // past date - so the error is fixable rather than lost.
    if (ok) {
      setOpen(false);
      setDate('');
      setEtd('');
    }
  };

  return (
    <section class="card add-trip-form">
      <div class="row">
        <label>Date</label>
        <div class="field">
          <input
            type="date"
            value={date}
            disabled={busy}
            onInput={(e) => setDate((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="row">
        <label>Leaves</label>
        <div class="field">
          <input
            type="time"
            value={etd}
            disabled={busy}
            onInput={(e) => setEtd((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="field">
        <button
          class="primary"
          disabled={busy || date === '' || etd === ''}
          onClick={() => void submit()}
        >
          Add trip
        </button>
        <button disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

// An admin write returns fresh app state plus the full user list; `run` applies
// both and reports success so a form can stay open on error.
type Run = (op: () => Promise<AdminWriteResponse>) => Promise<boolean>;

function AdminPanel({ onState }: { onState: (s: AppState) => void }) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || users !== null) return;
    getUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e instanceof Error ? e.message : 'error'));
  }, [open, users]);

  const run = useCallback<Run>(
    async (op) => {
      setBusy(true);
      setError(null);
      try {
        const res = await op();
        onState(res.state);
        setUsers(res.users);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onState],
  );

  if (!open) {
    return (
      <button class="link add-trip" onClick={() => setOpen(true)}>
        Manage users
      </button>
    );
  }

  return (
    <section class="card admin">
      <div class="admin-head">
        <h2>Users</h2>
        <button class="link" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {error && <p class="admin-error">{error}</p>}
      {users === null ? (
        <p class="admin-loading">Loading...</p>
      ) : (
        <>
          <ul class="admin-users">
            {users.map((u) => (
              <UserRow key={u.id} user={u} busy={busy} run={run} />
            ))}
          </ul>
          <AddUser busy={busy} run={run} />
        </>
      )}
    </section>
  );
}

function UserRow({ user, busy, run }: { user: AdminUser; busy: boolean; run: Run }) {
  const [name, setName] = useState(user.name);
  const [label, setLabel] = useState(user.pickup_label ?? '');
  const [emoji, setEmoji] = useState(user.emoji ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => setName(user.name), [user.name]);
  useEffect(() => setLabel(user.pickup_label ?? ''), [user.pickup_label]);
  useEffect(() => setEmoji(user.emoji ?? ''), [user.emoji]);

  const link = `${location.origin}/?t=${user.token}`;
  const trimmedName = name.trim();
  const trimmedLabel = label.trim();
  const trimmedEmoji = emoji.trim();
  const changed =
    trimmedName !== user.name ||
    trimmedLabel !== (user.pickup_label ?? '') ||
    trimmedEmoji !== (user.emoji ?? '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; the field is selectable as a fallback
    }
  };

  const save = () => {
    const patch: UserPatch = {};
    if (trimmedName !== user.name) patch.name = trimmedName;
    if (trimmedLabel !== (user.pickup_label ?? '')) patch.pickup_label = trimmedLabel;
    if (trimmedEmoji !== (user.emoji ?? '')) patch.emoji = trimmedEmoji === '' ? null : trimmedEmoji;
    return updateUser(user.id, patch);
  };

  return (
    <li class={`admin-user${user.enabled ? '' : ' disabled'}`}>
      <div class="row">
        <label>Name</label>
        <div class="field">
          <input
            type="text"
            value={name}
            disabled={busy}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="row">
        <label>Pickup</label>
        <div class="field">
          <input
            type="text"
            value={label}
            disabled={busy}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
          <button
            class="primary"
            disabled={busy || !changed || trimmedName === '' || trimmedLabel === ''}
            onClick={() => void run(save)}
          >
            Save
          </button>
        </div>
      </div>
      <div class="row">
        <label>Pin emoji</label>
        <div class="field">
          <input
            type="text"
            class="emoji-input"
            value={emoji}
            disabled={busy}
            placeholder="none"
            onInput={(e) => setEmoji((e.target as HTMLInputElement).value)}
          />
          <span class="muted">used on the map pin</span>
        </div>
      </div>
      <div class="row">
        <label>Home</label>
        <div class="field">
          <span class="dest-current">{user.formatted_address ?? 'no address set'}</span>
          {user.formatted_address && (
            <button disabled={busy} onClick={() => void run(() => updateUser(user.id, { address: null }))}>
              Clear
            </button>
          )}
        </div>
      </div>
      <div class="row">
        <label>Set home</label>
        <div class="field">
          <AddressAutocomplete
            onPick={(p) =>
              void run(() =>
                updateUser(user.id, {
                  address: {
                    formatted_address: p.formatted_address,
                    lat: p.lat,
                    lng: p.lng,
                    place_id: p.place_id,
                  },
                }),
              )
            }
          />
        </div>
      </div>
      <div class="row">
        <label>Link</label>
        <div class="field">
          <input
            class="note-input"
            type="text"
            readOnly
            value={link}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
          />
          <button disabled={busy} onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button disabled={busy} onClick={() => void run(() => rotateUserToken(user.id))}>
            Rotate
          </button>
        </div>
      </div>
      <div class="admin-toggles">
        <button
          disabled={busy}
          onClick={() => void run(() => updateUser(user.id, { enabled: !user.enabled }))}
        >
          {user.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          disabled={busy}
          onClick={() => void run(() => updateUser(user.id, { is_admin: !user.is_admin }))}
        >
          {user.is_admin ? 'Remove admin' : 'Make admin'}
        </button>
      </div>
    </li>
  );
}

function AddUser({ busy, run }: { busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [emoji, setEmoji] = useState('');
  const [admin, setAdmin] = useState(false);

  if (!open) {
    return (
      <button class="link add-trip" onClick={() => setOpen(true)}>
        Add a user
      </button>
    );
  }

  const submit = async () => {
    if (await run(() => createUser(name.trim(), label.trim(), admin, emoji.trim()))) {
      setOpen(false);
      setName('');
      setLabel('');
      setEmoji('');
      setAdmin(false);
    }
  };

  return (
    <div class="add-user-form">
      <div class="row">
        <label>Name</label>
        <div class="field">
          <input
            type="text"
            value={name}
            disabled={busy}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="row">
        <label>Pickup</label>
        <div class="field">
          <input
            type="text"
            value={label}
            disabled={busy}
            placeholder="@Name"
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="row">
        <label>Pin emoji</label>
        <div class="field">
          <input
            type="text"
            class="emoji-input"
            value={emoji}
            disabled={busy}
            placeholder="optional"
            onInput={(e) => setEmoji((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="row">
        <label>Admin</label>
        <div class="field">
          <input
            type="checkbox"
            checked={admin}
            disabled={busy}
            onChange={(e) => setAdmin((e.target as HTMLInputElement).checked)}
          />
        </div>
      </div>
      <div class="field">
        <button
          class="primary"
          disabled={busy || name.trim() === '' || label.trim() === ''}
          onClick={() => void submit()}
        >
          Add user
        </button>
        <button disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// The six notification categories in display order, with their user-facing labels.
const PREF_ROWS: { key: NotifyCategory; label: string }[] = [
  { key: 'evening_reminder', label: 'Evening reminder before a trip' },
  { key: 'driver_leaving', label: 'Driver is leaving' },
  { key: 'driver_updates', label: 'Driver updates (time, cancel, note)' },
  { key: 'driver_assignment', label: 'Driver assignment' },
  { key: 'rider_responses', label: 'Rider responses (when you drive)' },
  { key: 'rider_notes', label: 'Rider notes & suggestions (when you drive)' },
];

// Self-service notification preferences. Distinct from PushToggle (which gates
// whether this device receives anything): these gate which kinds the user wants.
function NotifySettings({
  me,
  apply,
}: {
  me: AppState['me'];
  apply: (op: () => Promise<AppState>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button class="link add-trip" onClick={() => setOpen(true)}>
        Notification settings
      </button>
    );
  }

  const toggle = async (key: NotifyCategory, value: boolean) => {
    setBusy(true);
    await apply(() => updatePrefs({ [key]: value }));
    setBusy(false);
  };

  return (
    <div class="prefs">
      <h2>Notification settings</h2>
      {PREF_ROWS.map(({ key, label }) => (
        <label key={key} class="pref-row">
          <input
            type="checkbox"
            checked={me.prefs[key]}
            disabled={busy}
            onChange={(e) => void toggle(key, (e.target as HTMLInputElement).checked)}
          />
          <span>{label}</span>
        </label>
      ))}
      <button class="link" onClick={() => setOpen(false)}>
        Done
      </button>
    </div>
  );
}

function PushToggle() {
  const [supported] = useState(pushSupported);
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then((sub) => setSubscribed(sub !== null));
  }, [supported]);

  if (!supported) {
    return (
      <span class="push muted">
        {iosNeedsInstall() ? 'Add to Home Screen for alerts' : 'Notifications unsupported'}
      </span>
    );
  }
  if (permission === 'denied') return <span class="push muted">Notifications blocked</span>;

  const enable = async () => {
    setBusy(true);
    setErr(false);
    try {
      const sub = await enablePush();
      setPermission(Notification.permission);
      setSubscribed(sub !== null);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setErr(false);
    try {
      await disablePush();
      setSubscribed(false);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      class="push link"
      disabled={busy}
      onClick={() => void (subscribed ? disable() : enable())}
    >
      {err
        ? 'Try again'
        : busy
          ? '...'
          : subscribed
            ? 'Disable alerts'
            : 'Enable alerts'}
    </button>
  );
}

interface CardProps {
  trip: Trip;
  me: AppState['me'];
  spots: PickupSpot[];
  apply: (op: () => Promise<AppState>) => Promise<boolean>;
}

function TripCard({ trip, me, spots, apply }: CardProps) {
  const cancelled = trip.status === 'cancelled';
  const iAmDriver = trip.driver?.id === me.id;
  return (
    <section class={`card${cancelled ? ' cancelled' : ''}`}>
      <div class="top">
        <span class="date">{formatDate(trip.trip_date)}</span>
        <span class="badges">
          {trip.source === 'manual' && <span class="badge oneoff">One-off</span>}
          {cancelled && <span class="badge cancelled">Cancelled</span>}
          {!cancelled && trip.locked && <span class="badge locked">Locked</span>}
        </span>
      </div>
      <div class="etd">Leaves {trip.etd}</div>

      <div class="driver">
        <span>Driver: {trip.driver ? trip.driver.name : 'no driver yet'}</span>
        {!trip.locked && !iAmDriver && (
          <button class="link" onClick={() => void apply(() => setDriver(trip.id, me.id))}>
            I'll drive
          </button>
        )}
        {!trip.locked && iAmDriver && (
          <button class="link" onClick={() => void apply(() => setDriver(trip.id, null))}>
            Not me
          </button>
        )}
      </div>

      {/* The driver's departure signal: the one write that survives the lock, so
          it lives outside DriverControls (which only render while unlocked). */}
      {iAmDriver && !cancelled && trip.left_at && (
        <div class="leaving">Left {formatTime(trip.left_at)}</div>
      )}
      {iAmDriver && !cancelled && !trip.left_at && trip.trip_date === localToday() && (
        <button class="leaving" onClick={() => void apply(() => setLeaving(trip.id))}>
          I'm leaving
        </button>
      )}

      {trip.note && !(iAmDriver && !trip.locked) && <p class="trip-note">{trip.note}</p>}

      <ul class="roster">
        {trip.riders.map((r) => {
          const suggestion = r.suggested_etd;
          return (
            <li key={r.id}>
              <span>{r.name}</span>
              <span class="rider-meta">
                <span class={`status ${r.response}`}>
                  {r.response === 'in'
                    ? `in - ${r.pickup_spot}`
                    : r.response === 'out'
                      ? 'not coming'
                      : 'no reply'}
                </span>
                {suggestion && (
                  <span class="suggestion">
                    suggests {suggestion}
                    {iAmDriver && !trip.locked && suggestion !== trip.etd && (
                      <button
                        class="link"
                        onClick={() => void apply(() => setEtd(trip.id, suggestion))}
                      >
                        Apply
                      </button>
                    )}
                  </span>
                )}
                {r.note && <span class="rider-note">"{r.note}"</span>}
                {!trip.locked && r.id !== me.id && (
                  <button class="link" onClick={() => void apply(() => setDriver(trip.id, r.id))}>
                    Make driver
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {!cancelled && <TripRoute trip={trip} spots={spots} />}

      {!trip.locked && !iAmDriver && !cancelled && (
        <RiderControls trip={trip} me={me} spots={spots} apply={apply} />
      )}
      {!trip.locked && iAmDriver && <DriverControls trip={trip} apply={apply} />}
    </section>
  );
}

function RiderControls({ trip, me, spots, apply }: CardProps) {
  const mine = trip.riders.find((r) => r.id === me.id);
  const response = mine?.response ?? 'pending';
  const [spot, setSpot] = useState(mine?.pickup_spot ?? '');
  const [suggested, setSuggested] = useState(mine?.suggested_etd ?? '');
  const [note, setNote] = useState(mine?.note ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSuggested(mine?.suggested_etd ?? '');
  }, [mine?.suggested_etd]);
  useEffect(() => {
    setNote(mine?.note ?? '');
  }, [mine?.note]);

  const run = async (op: () => Promise<AppState>) => {
    setBusy(true);
    await apply(op);
    setBusy(false);
  };

  const suggestionChanged = suggested !== (mine?.suggested_etd ?? '');
  const noteChanged = note.trim() !== (mine?.note ?? '');

  return (
    <div class="controls">
      <div class="row">
        <label>Pickup</label>
        <div class="field">
          <select
            value={spot}
            disabled={busy}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setSpot(v);
              // Already in? Changing the spot re-submits immediately.
              if (response === 'in' && v !== '') void run(() => setParticipation(trip.id, 'in', v));
            }}
          >
            <option value="">Pick a spot...</option>
            {spots.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
          {response !== 'in' && (
            <button
              class="primary"
              disabled={busy || spot === ''}
              onClick={() => void run(() => setParticipation(trip.id, 'in', spot))}
            >
              I'm in
            </button>
          )}
          {response !== 'out' && (
            <button
              disabled={busy}
              onClick={() => void run(() => setParticipation(trip.id, 'out', null))}
            >
              I'm out
            </button>
          )}
        </div>
      </div>

      <div class="row">
        <label>Suggest time</label>
        <div class="field">
          <input
            type="time"
            value={suggested}
            disabled={busy}
            onInput={(e) => setSuggested((e.target as HTMLInputElement).value)}
          />
          <button
            class="primary"
            disabled={busy || suggested === '' || !suggestionChanged}
            onClick={() => void run(() => setSuggestion(trip.id, suggested))}
          >
            Suggest
          </button>
          {mine?.suggested_etd && (
            <button disabled={busy} onClick={() => void run(() => setSuggestion(trip.id, null))}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div class="row">
        <label>Your note</label>
        <div class="field">
          <input
            type="text"
            class="note-input"
            value={note}
            maxLength={NOTE_MAX}
            disabled={busy}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <button
            class="primary"
            disabled={busy || !noteChanged}
            onClick={() => void run(() => setRiderNote(trip.id, note.trim() === '' ? null : note.trim()))}
          >
            Save note
          </button>
        </div>
      </div>
    </div>
  );
}

function DriverControls({ trip, apply }: { trip: Trip; apply: CardProps['apply'] }) {
  const [etd, setEtdValue] = useState(trip.etd);
  const [note, setNote] = useState(trip.note ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEtdValue(trip.etd);
  }, [trip.etd]);
  useEffect(() => {
    setNote(trip.note ?? '');
  }, [trip.note]);

  const run = async (op: () => Promise<AppState>) => {
    setBusy(true);
    await apply(op);
    setBusy(false);
  };

  const etdChanged = etd !== trip.etd;
  const noteChanged = note.trim() !== (trip.note ?? '');
  const cancelled = trip.status === 'cancelled';

  return (
    <div class="controls">
      <div class="row">
        <label>Leaves</label>
        <div class="field">
          <input
            type="time"
            value={etd}
            disabled={busy}
            onInput={(e) => setEtdValue((e.target as HTMLInputElement).value)}
          />
          <button
            class="primary"
            disabled={busy || !etdChanged || etd === ''}
            onClick={() => void run(() => setEtd(trip.id, etd))}
          >
            Save
          </button>
          <button disabled={busy} onClick={() => void run(() => setCancelled(trip.id, !cancelled))}>
            {cancelled ? 'Uncancel' : 'Cancel'}
          </button>
        </div>
      </div>

      <div class="row">
        <label>Trip note</label>
        <div class="field">
          <input
            type="text"
            class="note-input"
            value={note}
            maxLength={NOTE_MAX}
            disabled={busy}
            placeholder="Visible to everyone"
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <button
            class="primary"
            disabled={busy || !noteChanged}
            onClick={() => void run(() => setTripNote(trip.id, note.trim() === '' ? null : note.trim()))}
          >
            Save note
          </button>
        </div>
      </div>

      <div class="row">
        <label>Destination</label>
        <div class="field">
          <span class="dest-current">
            {trip.destination.label}
            {!trip.dest_custom && <span class="muted"> (office default)</span>}
          </span>
          {trip.dest_custom && (
            <button disabled={busy} onClick={() => void run(() => setDestination(trip.id, null))}>
              Use office
            </button>
          )}
        </div>
      </div>
      <div class="row">
        <label>Change</label>
        <div class="field">
          <AddressAutocomplete
            onPick={(p) =>
              void run(() =>
                setDestination(trip.id, {
                  label: p.formatted_address,
                  lat: p.lat,
                  lng: p.lng,
                  place_id: p.place_id,
                }),
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

// A Places Autocomplete input (Places API New). The new PlaceAutocompleteElement
// is a web component with its own session-token handling, so it is created
// imperatively and mounted into a host div. On selection it fetches only the
// three fields we store, so no separate Geocoding call is made.
function AddressAutocomplete({ onPick }: { onPick: (p: PickedPlace) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef(onPick);
  const [error, setError] = useState(false);

  useEffect(() => {
    pickRef.current = onPick;
  });

  useEffect(() => {
    let el: HTMLElement | null = null;
    let cancelled = false;

    async function handleSelect(event: Event): Promise<void> {
      const detail = event as unknown as {
        placePrediction?: { toPlace(): google.maps.places.Place };
        place?: google.maps.places.Place;
      };
      const place = detail.placePrediction ? detail.placePrediction.toPlace() : detail.place;
      if (!place) return;
      await place.fetchFields({ fields: ['formattedAddress', 'location', 'id'] });
      const loc = place.location;
      if (!loc || !place.formattedAddress || !place.id) return;
      pickRef.current({
        formatted_address: place.formattedAddress,
        lat: loc.lat(),
        lng: loc.lng(),
        place_id: place.id,
      });
    }

    placesLibrary()
      .then(({ PlaceAutocompleteElement }) => {
        if (cancelled || !hostRef.current) return;
        const ac = new PlaceAutocompleteElement();
        el = ac as unknown as HTMLElement;
        hostRef.current.append(el);
        ac.addEventListener('gmp-select', ((event: Event) => void handleSelect(event)) as EventListener);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
      el?.remove();
    };
  }, []);

  if (error) return <span class="muted">Address search unavailable</span>;
  return <div class="autocomplete" ref={hostRef} />;
}

// A styled map pin: a role color plus a glyph that is either the user/office
// emoji or a role fallback (driver initial, pickup order number, destination flag).
interface MapPin {
  lat: number;
  lng: number;
  label: string;
  glyph: string;
  isEmoji: boolean;
  color: string;
}

const PIN_DRIVER = '#1a7f37';
const PIN_PICKUP = '#1a73e8';
const PIN_DEST = '#d93025';
const ROUTE_STROKE = '#1a73e8';

// Driver first, then the pickups in route order, then the destination - each with
// its color and glyph. The destination flag fallback keeps a custom (non-office)
// destination pinned even though only the office carries an emoji.
function buildPins(points: RoutePoints): MapPin[] {
  const pins: MapPin[] = [];
  if (points.driver) {
    const d = points.driver;
    pins.push({
      lat: d.lat,
      lng: d.lng,
      label: d.label,
      glyph: d.emoji ?? d.label.slice(0, 1).toUpperCase(),
      isEmoji: d.emoji !== null,
      color: PIN_DRIVER,
    });
  }
  points.pickups.forEach((p, i) => {
    pins.push({
      lat: p.lat,
      lng: p.lng,
      label: p.label,
      glyph: p.emoji ?? String(i + 1),
      isEmoji: p.emoji !== null,
      color: PIN_PICKUP,
    });
  });
  if (points.destination) {
    const d = points.destination;
    pins.push({
      lat: d.lat,
      lng: d.lng,
      label: d.label,
      glyph: d.emoji ?? '\u{1F3C1}',
      isEmoji: true,
      color: PIN_DEST,
    });
  }
  return pins;
}

// An emoji reads best on a light pin with a colored rim; a text fallback (number
// or initial) reads best as white on a solid colored pin.
function makePin(PinElement: typeof google.maps.marker.PinElement, pin: MapPin): HTMLElement {
  if (pin.isEmoji) {
    const glyph = document.createElement('span');
    glyph.textContent = pin.glyph;
    glyph.style.fontSize = '15px';
    glyph.style.lineHeight = '1';
    return new PinElement({ glyph, background: '#ffffff', borderColor: pin.color }).element;
  }
  return new PinElement({
    glyph: pin.glyph,
    glyphColor: '#ffffff',
    background: pin.color,
    borderColor: pin.color,
  }).element;
}

// The embedded map + in-app ETA + Navigate deep link for one trip. On demand: the
// SDK loads and the map/ETA compute only after the user taps "Show route", so a
// card the user never opens costs no map loads or Directions calls (quota).
function TripRoute({ trip, spots }: { trip: Trip; spots: PickupSpot[] }) {
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  // The pin set the map was last fitted to, so the ETA/polyline arriving (which
  // redraws but does not change the pins) does not re-fit and reset a user's pan.
  const fitKeyRef = useRef<string>('');
  // `shown` latches true on first open so the map/ETA compute once; `open` only
  // toggles visibility, so closing and reopening never recomputes the route.
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const [eta, setEta] = useState<RouteResult | null>(null);
  const [error, setError] = useState(false);

  const points = useMemo(() => routePoints(trip, spots), [trip, spots]);
  const pins = useMemo(() => buildPins(points), [points]);

  // Draw the pins and (once the ETA resolves) the road polyline. Depends on `eta`
  // so the route line appears when the Directions result arrives; markers clear and
  // redraw each run. The map instance is created once and reused, and the view is
  // fitted only when the pins themselves change (see fitKeyRef), so the polyline
  // arriving does not yank a user's pan/zoom back.
  useEffect(() => {
    if (!shown || pins.length === 0) return;
    let cancelled = false;
    Promise.all([mapsLibrary(), markerLibrary()])
      .then(([{ Map }, { AdvancedMarkerElement, PinElement }]) => {
        if (cancelled || !mapElRef.current) return;
        if (!mapRef.current) {
          mapRef.current = new Map(mapElRef.current, {
            mapId: GOOGLE_MAPS_MAP_ID,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            clickableIcons: false,
          });
        }
        const map = mapRef.current;
        for (const marker of markersRef.current) marker.map = null;
        markersRef.current = [];
        const bounds = new google.maps.LatLngBounds();
        for (const p of pins) {
          const position = { lat: p.lat, lng: p.lng };
          markersRef.current.push(
            new AdvancedMarkerElement({ position, map, title: p.label, content: makePin(PinElement, p) }),
          );
          bounds.extend(position);
        }

        polylineRef.current?.setMap(null);
        polylineRef.current = null;
        if (eta && eta.path.length > 0) {
          polylineRef.current = new google.maps.Polyline({
            path: eta.path,
            map,
            strokeColor: ROUTE_STROKE,
            strokeOpacity: 0.85,
            strokeWeight: 5,
          });
          for (const pt of eta.path) bounds.extend(pt);
        }

        const fitKey = pins.map((p) => `${p.lat},${p.lng}`).join('|');
        if (fitKeyRef.current !== fitKey) {
          fitKeyRef.current = fitKey;
          if (pins.length === 1) {
            map.setCenter(bounds.getCenter());
            map.setZoom(14);
          } else {
            map.fitBounds(bounds, 40);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [shown, pins, eta]);

  // Detach map objects on unmount so Advanced Markers / the polyline do not retain
  // the destroyed map. (Runs once, on unmount.)
  useEffect(
    () => () => {
      for (const marker of markersRef.current) marker.map = null;
      markersRef.current = [];
      polylineRef.current?.setMap(null);
      polylineRef.current = null;
      mapRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!shown || !points.driver || !points.destination) {
      setEta(null);
      return;
    }
    let cancelled = false;
    computeEta(points, departureAt(trip))
      .then((r) => {
        if (!cancelled) setEta(r);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [shown, points, trip.trip_date, trip.etd]);

  const nav =
    points.driver && points.destination
      ? navigateUrl(points.driver, points.pickups, points.destination)
      : null;

  if (pins.length === 0) {
    return <p class="route-hint muted">Set home addresses (Manage users) to see the route.</p>;
  }

  return (
    <div class="route">
      <button
        class="link"
        onClick={() => {
          setShown(true);
          setOpen((o) => !o);
        }}
      >
        {open ? 'Hide route & ETA' : 'Show route & ETA'}
      </button>
      {shown && (
        <div hidden={!open}>
          <div class="route-map" ref={mapElRef} />
          {error && <p class="route-hint muted">Map unavailable right now.</p>}
          {eta && (
            <div class="route-eta">
              <div class="route-total">
                Drive ~{fmtDuration(eta.totalSeconds)}, arrive ~{addSeconds(trip.etd, eta.totalSeconds)}
                {eta.traffic ? '' : <span class="muted"> (typical, no traffic)</span>}
              </div>
              {eta.stops.length > 0 && (
                <ul class="route-stops">
                  {eta.stops.map((s) => (
                    <li key={s.label}>
                      {s.label} - pickup ~{addSeconds(trip.etd, s.cumulativeSeconds)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {nav && (
            <a class="nav-button" href={nav} target="_blank" rel="noopener noreferrer">
              Navigate
            </a>
          )}
        </div>
      )}
    </div>
  );
}
