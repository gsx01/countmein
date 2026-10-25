import type { BrowserContext, Page } from '@playwright/test';
import { localDatePlus, tripLabel } from '../src/time';
import { apiCall, as, expect, reset, test, USERS, type Who } from './fixtures';
import { BASE } from './env';
import type { PushService, ReceivedPush } from './push-service';

const T = 101;
const label = (etd: string) => tripLabel(localDatePlus(new Date(), 2), etd);

// The bundled headless shell denies notifications inside the service worker
// whatever is granted; the full Chromium build shows them.
test.use({ channel: process.env.PW_CHANNEL || 'chromium' });

test.beforeEach(({ pushService }) => {
  pushService.clear();
  reset({
    trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver' }],
    riders: [{ trip: T, who: 'rider', response: 'in', spot: USERS.rider.label }],
    subscriptions: ['driver', 'rider', 'pending'],
  });
});

const pushFor = (who: Who, title: string): ReceivedPush => ({
  to: who,
  payload: { title, body: USERS.driver.name, url: `/?t=${USERS[who].token}#trip-${T}`, tag: `trip-${T}` },
});

// Changes the ETD as the driver and returns what the push service received, by
// recipient. The sends run in waitUntil, after the response; a stray third one
// gets time to show.
async function changeEtd(pushService: PushService, etd: string): Promise<ReceivedPush[]> {
  pushService.clear();
  await apiCall('driver', 'PATCH', `/trips/${T}`, { etd });
  await expect.poll(() => pushService.received.length + pushService.rejected.length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(pushService.rejected).toEqual([]);
  return [...pushService.received].sort((a, b) => a.to.localeCompare(b.to));
}

// Hands a payload to the page's service worker as a real push event.
async function swPush(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  const registrations: { registrationId: string; isDeleted: boolean }[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => registrations.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => registrations.filter((r) => !r.isDeleted).length).toBeGreaterThan(0);
  const { registrationId } = registrations.filter((r) => !r.isDeleted)[0];
  return (push: ReceivedPush) =>
    cdp.send('ServiceWorker.deliverPushMessage', {
      origin: BASE,
      registrationId,
      data: JSON.stringify(push.payload),
    });
}

const notifications = (page: Page) =>
  page.evaluate(async () =>
    (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      url: (n.data as { url: string }).url,
    })),
  );

test('an ETD change reaches each rider and shows one notification per trip', async ({
  pushService,
  context,
  page,
}) => {
  const first = `${label('08:00')} - ETD now 09:00`;
  const sent = await changeEtd(pushService, '09:00');
  expect(sent).toEqual([pushFor('pending', first), pushFor('rider', first)]);

  await context.grantPermissions(['notifications']);
  await as(page, 'rider', T);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const deliver = await swPush(context, page);
  const toRider = (pushes: ReceivedPush[]) => pushes.find((p) => p.to === 'rider')!;
  const shown = (title: string) => ({
    title,
    body: USERS.driver.name,
    tag: `trip-${T}`,
    url: `/?t=${USERS.rider.token}#trip-${T}`,
  });

  await deliver(toRider(sent));
  await expect.poll(() => notifications(page)).toEqual([shown(first)]);

  // The same trip's tag: the newer push replaces the shown one.
  const second = `${label('09:00')} - ETD now 09:30`;
  const resent = await changeEtd(pushService, '09:30');
  expect(resent).toEqual([pushFor('pending', second), pushFor('rider', second)]);
  await deliver(toRider(resent));
  await expect.poll(() => notifications(page)).toEqual([shown(second)]);
});
