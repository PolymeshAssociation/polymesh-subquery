import { expectedEvents, isClosing } from '../../scripts/lib/expectedRecords';

const events = [
  { section: 'system', method: 'ExtrinsicSuccess', extrinsic: 0 },
  { section: 'balances', method: 'Transfer', extrinsic: 1 },
  { section: 'system', method: 'NewAccount', extrinsic: 1 },
  { section: 'system', method: 'ExtrinsicSuccess', extrinsic: 1 },
  { section: 'beefy', method: 'Anything' },
];

describe('expectedEvents', () => {
  it('expects every event of a subscribed module, and only the subscribed system methods', () => {
    const filters = [{ module: 'balances' }, { module: 'system', method: 'NewAccount' }];

    expect([...expectedEvents(events, filters)]).toEqual([1, 2]);
  });

  it('expects nothing without a subscription', () => {
    expect(expectedEvents(events, []).size).toBe(0);
  });
});

describe('isClosing', () => {
  it('is an extrinsic outcome, and nothing else', () => {
    expect(isClosing(events[0])).toBe(true);
    expect(isClosing({ section: 'system', method: 'ExtrinsicFailed' })).toBe(true);
    expect(isClosing(events[2])).toBe(false);
  });
});
