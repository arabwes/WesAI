import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateToastHourlySales } from '../workers/notifications/src/index.js';

test('Toast sales aggregation uses store-local hours and eligible paid checks', () => {
  const rows = aggregateToastHourlySales('2026-09-05', [
    {
      openedDate: '2026-09-05T04:15:00.000+0000',
      checks: [
        { paymentStatus: 'PAID', amount: 12.34 },
        { paymentStatus: 'OPEN', amount: 99 },
        { paymentStatus: 'CLOSED', amount: 4.66, voided: true }
      ]
    },
    {
      openedDate: '2026-09-05T04:45:00.000Z',
      checks: [{ paymentStatus: 'CLOSED', amount: 7.66 }]
    },
    {
      openedDate: '2026-09-05T05:00:00.000Z',
      voided: true,
      checks: [{ paymentStatus: 'PAID', amount: 50 }]
    }
  ], 'America/New_York');

  assert.deepEqual(rows, [{
    businessDate: '2026-09-05', hour: 0, netSalesCents: 2000, orderCount: 2
  }]);
});
