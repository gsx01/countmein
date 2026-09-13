import { VAPID_PUBLIC_KEY } from './vapid';
import { subscribePush, unsubscribePush } from './api-client';

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// iOS Safari exposes the Push API only once the app is added to the Home Screen,
// so a plain-Safari visit needs an install hint instead of an enable button.
export function iosNeedsInstall(): boolean {
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (!isIos) return false;
  const standalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return !standalone;
}

// applicationServerKey must be the raw key bytes, not the base64url string.
function urlBase64ToBytes(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return buffer;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js');
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Registers the SW, requests permission, subscribes, and stores the row. Returns
// null if the user did not grant permission.
export async function enablePush(): Promise<PushSubscription | null> {
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(VAPID_PUBLIC_KEY),
    });
  }

  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) throw new Error('subscription missing keys');
  await subscribePush({ endpoint: sub.endpoint, keys: { p256dh, auth } });
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await unsubscribePush(endpoint);
}
