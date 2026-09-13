import type { Env } from './index';
import { ensureTrips } from './trips';
import { sendReminders } from './reminder';
import { localHour } from './time';

// The Amsterdam-local hour the evening-before reminder fires. The two daily crons
// run at 18:00 and 19:00 UTC; exactly one maps to this local hour in each DST
// season, so the gate ensures the reminder pass runs once per evening.
const REMINDER_HOUR = 20;

export async function handleScheduled(env: Env): Promise<void> {
  const now = new Date();
  await ensureTrips(env.DB, now);
  if (localHour(now) === REMINDER_HOUR) {
    await sendReminders(env, now);
  }
}
