import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkdayPingService } from '../workday-ping.service.js';

// 2026-11-16 is a Monday; dates are built in local time, as the service reads them.
const monday = (hours: number, minutes = 0) => new Date(2026, 10, 16, hours, minutes);
const saturday = (hours: number) => new Date(2026, 10, 21, hours, 0);

function setup(start: Date) {
  const store = new Map<string, string>();
  const sent: string[] = [];
  let current = start;
  let fail = false;
  const service = createWorkdayPingService({
    config: { get: (key) => store.get(key) ?? null, set: (key, value) => { store.set(key, value); } },
    sendPing: async (prompt) => { sent.push(prompt); if (fail) throw new Error('offline'); return 'Hi!\n'; },
    now: () => current,
  });
  return { service, sent, setNow: (date: Date) => { current = date; }, setFail: (value: boolean) => { fail = value; } };
}

test('stays quiet until enabled', async () => {
  const { service, sent } = setup(monday(7, 5));
  assert.equal(await service.tick(), false);
  assert.deepEqual(sent, []);
});

test('sends "hi" once on a workday after the set time and records the reply', async () => {
  const { service, sent, setNow } = setup(monday(6, 59));
  service.setConfig({ enabled: true, time: '07:00' });
  assert.equal(await service.tick(), false);
  setNow(monday(7, 0));
  assert.equal(await service.tick(), true);
  setNow(monday(7, 30));
  assert.equal(await service.tick(), false);
  assert.deepEqual(sent, ['hi']);
  const status = service.getStatus();
  assert.equal(status.lastDate, '2026-11-16');
  assert.equal(status.lastResult?.ok, true);
  assert.equal(status.lastResult?.detail, 'Hi!');
});

test('skips weekends and anything more than an hour late', async () => {
  const { service, sent, setNow } = setup(saturday(7));
  service.setConfig({ enabled: true, time: '07:00' });
  assert.equal(await service.tick(), false);
  setNow(monday(8, 1));
  assert.equal(await service.tick(), false);
  assert.deepEqual(sent, []);
});

test('a failure is recorded and not retried the same day', async () => {
  const { service, sent, setNow, setFail } = setup(monday(7, 1));
  setFail(true);
  service.setConfig({ enabled: true, time: '07:00' });
  assert.equal(await service.tick(), true);
  assert.equal(service.getStatus().lastResult?.ok, false);
  assert.equal(service.getStatus().lastResult?.detail, 'offline');
  setNow(monday(7, 2));
  assert.equal(await service.tick(), false);
  assert.equal(sent.length, 1);
});

test('moving the time later on a day that already pinged pings again at the new time', async () => {
  const { service, sent, setNow } = setup(monday(7, 0));
  service.setConfig({ enabled: true, time: '07:00' });
  await service.tick();
  service.setConfig({ enabled: true, time: '09:00' });
  setNow(monday(9, 0));
  assert.equal(await service.tick(), true);
  assert.equal(sent.length, 2);
});

test('rejects a malformed time', () => {
  const { service } = setup(monday(7));
  assert.throws(() => service.setConfig({ enabled: true, time: '7am' }), /HH:MM/);
});
