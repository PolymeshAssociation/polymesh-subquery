import {
  chainApprovals,
  chainStatuses,
  compareApprovals,
  compareClosed,
  holderKeyOf,
} from '../../scripts/lib/approvals';

const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');
const ACCOUNT = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const json = (value: unknown) => ({ toJSON: () => value } as never);

describe('holderKeyOf', () => {
  it.each([
    ['a v8 portfolio holder', { portfolio: { did: DID_A, kind: { user: 2 } } }, `${DID_A}/2`],
    [
      'a v8 default portfolio',
      { portfolio: { did: DID_A, kind: { default: null } } },
      `${DID_A}/0`,
    ],
    ['a v8 account holder', { account: ACCOUNT }, ACCOUNT],
    ['a pre-v8 PortfolioId', { did: DID_B, kind: 'Default' }, `${DID_B}/0`],
    ['a pre-v8 user portfolio', { did: DID_B, kind: { user: 3 } }, `${DID_B}/3`],
  ])('reads %s', (_what, value, key) => {
    expect(holderKeyOf(json(value))).toBe(key);
  });
});

describe('compareApprovals', () => {
  const instruction = { id: '0000000042', status: 'Created' };
  const holder = (key: string, status: string) => ({
    instructionId: '0000000042',
    holder: key,
    isMediator: false,
    status,
  });
  const mediator = (did: string, status: string) => ({
    instructionId: '0000000042',
    holder: did,
    isMediator: true,
    status,
  });

  it('reports nothing when every row matches the chain', () => {
    expect(
      compareApprovals(
        [instruction],
        [holder(`${DID_A}/0`, 'Affirmed'), holder(ACCOUNT, 'Pending'), mediator(DID_B, 'Affirmed')],
        new Map([
          [
            '0000000042',
            {
              status: 'Pending',
              affirmed: new Set([`${DID_A}/0`]),
              mediators: new Map([[DID_B, 'Affirmed']]),
            },
          ],
        ])
      )
    ).toEqual([]);
  });

  it('reports a holder pending here and affirmed on chain, and the reverse', () => {
    expect(
      compareApprovals(
        [instruction],
        [holder(`${DID_A}/0`, 'Pending'), holder(ACCOUNT, 'Affirmed')],
        new Map([
          [
            '0000000042',
            { status: 'Pending', affirmed: new Set([`${DID_A}/0`]), mediators: new Map() },
          ],
        ])
      )
    ).toEqual([
      {
        check: '9 holder approval',
        id: `0000000042/${DID_A}/0`,
        index: 'Pending',
        chain: 'Affirmed',
      },
      {
        check: '9 holder approval',
        id: `0000000042/${ACCOUNT}`,
        index: 'Affirmed',
        chain: 'Pending',
      },
    ]);
  });

  it('reports a holder the chain affirmed that has no row', () => {
    expect(
      compareApprovals(
        [instruction],
        [],
        new Map([
          [
            '0000000042',
            { status: 'Pending', affirmed: new Set([`${DID_A}/0`]), mediators: new Map() },
          ],
        ])
      )
    ).toEqual([
      {
        check: '9 affirmed holder has no row',
        id: `0000000042/${DID_A}/0`,
        index: 'none',
        chain: 'Affirmed',
      },
    ]);
  });

  it("reports a mediator's status, reading the chain's Unknown as pending", () => {
    expect(
      compareApprovals(
        [instruction],
        [mediator(DID_A, 'Affirmed'), mediator(DID_B, 'Pending')],
        new Map([
          [
            '0000000042',
            { status: 'Pending', affirmed: new Set(), mediators: new Map([[DID_A, 'Pending']]) },
          ],
        ])
      )
    ).toEqual([
      {
        check: '9 mediator approval',
        id: `0000000042/mediator/${DID_A}`,
        index: 'Affirmed',
        chain: 'Pending',
      },
    ]);
  });

  it('reports an instruction the index holds pending that the chain no longer does', () => {
    expect(
      compareApprovals(
        [instruction, { id: '0000000043', status: 'Locked' }],
        [],
        new Map([
          ['0000000042', { status: 'Rejected', affirmed: new Set(), mediators: new Map() }],
          [
            '0000000043',
            { status: 'LockedForExecution', affirmed: new Set(), mediators: new Map() },
          ],
        ])
      )
    ).toEqual([
      { check: '9 instruction status', id: '0000000042', index: 'Created', chain: 'Rejected' },
    ]);
  });
});

describe('chainApprovals', () => {
  const variant = (type: string) => ({ type, toJSON: () => type } as never);
  const doubleMap = (value: (id: number) => unknown, entries: [unknown, unknown][] = []) =>
    Object.assign(
      jest.fn(async (id: number) => value(id)),
      {
        entries: jest.fn(async () =>
          entries.map(([holder, status]) => [{ args: [json(42), json(holder)] }, status])
        ),
      }
    );

  it('reads an instruction status from instructionStatuses where the runtime has it', async () => {
    const at = {
      query: {
        settlement: {
          instructionStatuses: doubleMap(() => variant('Pending')),
          affirmsReceived: doubleMap(
            () => undefined,
            [[{ portfolio: { did: DID_A, kind: { default: null } } }, variant('Affirmed')]]
          ),
        },
      },
    };

    const result = await chainApprovals(at as never, ['0000000042']);

    expect(result.get('0000000042')).toEqual({
      status: 'Pending',
      affirmed: new Set([`${DID_A}/0`]),
      mediators: new Map(),
    });
  });

  it("reads it from the instruction's details before 6.0, which had no instructionStatuses", async () => {
    const at = {
      query: {
        settlement: {
          instructionDetails: doubleMap(() => ({ status: variant('Failed') })),
          affirmsReceived: doubleMap(
            () => undefined,
            [[{ did: DID_B, kind: 'Default' }, variant('Affirmed')]]
          ),
        },
      },
    };

    const result = await chainApprovals(at as never, ['0000000042']);

    expect(result.get('0000000042')).toEqual({
      status: 'Failed',
      affirmed: new Set([`${DID_B}/0`]),
      mediators: new Map(),
    });
  });
});

describe('compareClosed', () => {
  it('reports an instruction the index closed that the chain holds open or closed the other way', () => {
    expect(
      compareClosed(
        [
          { id: '0000000042', status: 'Rejected' },
          { id: '0000000043', status: 'Executed' },
          { id: '0000000044', status: 'Executed' },
          { id: '0000000045', status: 'Rejected' },
          { id: '0000000046', status: 'Rejected' },
          { id: '0000000047', status: 'Executed' },
          { id: '0000000048', status: 'Rejected' },
        ],
        new Map([
          ['0000000042', 'Pending'],
          ['0000000043', 'LockedForExecution'],
          ['0000000044', 'Success'],
          ['0000000045', 'Unknown'],
          ['0000000046', 'Rejected'],
          ['0000000047', 'Rejected'],
          ['0000000048', 'Success'],
        ])
      )
    ).toEqual([
      {
        check: '9 closed instruction status',
        id: '0000000042',
        index: 'Rejected',
        chain: 'Pending',
      },
      {
        check: '9 closed instruction status',
        id: '0000000043',
        index: 'Executed',
        chain: 'LockedForExecution',
      },
      {
        check: '9 closed instruction status',
        id: '0000000047',
        index: 'Executed',
        chain: 'Rejected',
      },
      {
        check: '9 closed instruction status',
        id: '0000000048',
        index: 'Rejected',
        chain: 'Success',
      },
    ]);
  });
});

/** A storage read that records how many calls are in flight at once */
const tracked = (value: unknown) => {
  let inFlight = 0;
  let peak = 0;
  const read = Object.assign(
    jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight -= 1;
      return value;
    }),
    { entries: jest.fn(async () => []) }
  );
  return { read, peak: () => peak };
};

const ids = (count: number) =>
  Array.from({ length: count }, (_, n) => String(n + 1).padStart(10, '0'));

describe('chainStatuses', () => {
  it('reads each status, from instructionStatuses or before 6.0 the details', async () => {
    const statuses = tracked({ type: 'Success' });
    const details = tracked({ status: { type: 'Unknown' } });

    const from6 = await chainStatuses(
      { query: { settlement: { instructionStatuses: statuses.read } } } as never,
      ['0000000042']
    );
    const before6 = await chainStatuses(
      { query: { settlement: { instructionDetails: details.read } } } as never,
      ['0000000042']
    );

    expect(from6).toEqual(new Map([['0000000042', 'Success']]));
    expect(before6).toEqual(new Map([['0000000042', 'Unknown']]));
  });

  it('reads 50 instructions at a time', async () => {
    const statuses = tracked({ type: 'Success' });

    const result = await chainStatuses(
      { query: { settlement: { instructionStatuses: statuses.read } } } as never,
      ids(120)
    );

    expect(result.size).toBe(120);
    expect(statuses.peak()).toBe(50);
  });
});

describe('chainApprovals in batches', () => {
  it('reads 50 instructions at a time', async () => {
    const statuses = tracked({ type: 'Pending' });
    const affirms = tracked(undefined);

    const result = await chainApprovals(
      {
        query: {
          settlement: { instructionStatuses: statuses.read, affirmsReceived: affirms.read },
        },
      } as never,
      ids(120)
    );

    expect(result.size).toBe(120);
    expect(statuses.peak()).toBe(50);
  });
});
