import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, availabilityWindow, minutesBetween, normalizeDate, normalizeTime, weekStartFor } from '../functions/_lib/http.js';

test('weekStartFor uses Monday through Sunday weeks', () => {
  assert.equal(weekStartFor('2026-08-24'), '2026-08-24');
  assert.equal(weekStartFor('2026-08-30'), '2026-08-24');
  assert.equal(weekStartFor('2026-08-31'), '2026-08-31');
});

test('plain date arithmetic is stable across month and daylight-saving boundaries', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2026-10-31', 2), '2026-11-02');
});

test('shift duration subtracts breaks', () => {
  assert.equal(minutesBetween('08:00', '16:00', 30), 450);
  assert.throws(() => minutesBetween('16:00', '08:00', 0), /invalid_shift_duration/);
  assert.equal(minutesBetween('16:00', '00:00', 0, true), 480);
  assert.equal(minutesBetween('22:15', '02:00', 15, true), 210);
  assert.throws(() => minutesBetween('08:00', '08:00', 0, true), /invalid_shift_duration/);
  assert.throws(() => minutesBetween('08:00', '08:15', 30), /invalid_shift_duration/);
});

test('date and time validation rejects impossible values', () => {
  assert.equal(normalizeDate('2026-08-24'), '2026-08-24');
  assert.equal(normalizeTime('23:59'), '23:59');
  assert.throws(() => normalizeDate('2026-02-30'), /invalid_date/);
  assert.throws(() => normalizeTime('24:00'), /invalid_time/);
});

test('availability uses quarter-hour boundaries and accepts midnight at either edge', () => {
  assert.deepEqual(availabilityWindow('00:00', '08:15'), {
    startTime: '00:00', endTime: '08:15', startMinutes: 0, endMinutes: 495
  });
  assert.deepEqual(availabilityWindow('20:00', '00:00'), {
    startTime: '20:00', endTime: '00:00', startMinutes: 1200, endMinutes: 1440
  });
  assert.deepEqual(availabilityWindow('00:00', '00:00'), {
    startTime: '00:00', endTime: '00:00', startMinutes: 0, endMinutes: 1440
  });
  assert.throws(() => availabilityWindow('09:10', '17:00'), /invalid_availability_time_interval/);
  assert.throws(() => availabilityWindow('17:00', '09:00'), /invalid_shift_duration/);
});
