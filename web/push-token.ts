// Which token and endpoint this device last registered with the server. The
// browser's own subscription outlives a token rotation (which drops the server
// row) and a switch to another person's link, so "subscribed" alone would leave
// the button saying "Disable alerts" while nothing arrives.
const KEY = 'push-registration';

export function markRegistered(token: string, endpoint: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, endpoint }));
  } catch {
    // storage unavailable; the button then offers "Enable alerts" again
  }
}

export function clearRegistered(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable; nothing to clear
  }
}

export function isRegistered(token: string | null, endpoint: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || !token) return false;
    const entry = JSON.parse(raw) as { token?: unknown; endpoint?: unknown };
    return entry.token === token && entry.endpoint === endpoint;
  } catch {
    return false;
  }
}
