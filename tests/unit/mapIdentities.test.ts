import { SubstrateEvent } from '@subql/types';
import { handleDidCreated } from '../../src/mappings/entities/identities/mapIdentities';

const DID = '0x43657eb6b86d817de407bb697eafa08d1cc28cfd91b2386a14262a11d620cb4d';
const ADDRESS = '5EHpPfLVndwpmjh1z82VbKoUEhFoRbhqH8LHsnMXbM98ukd4';
const PORTFOLIO_ID = `${DID}/0`;

const didCreated = (): SubstrateEvent =>
  ({
    idx: 5,
    event: {
      section: 'identity',
      method: 'DidCreated',
      data: [{ toString: () => DID }, { toString: () => ADDRESS }, []],
    },
    block: {
      timestamp: new Date('2026-11-06T12:00:00Z'),
      specVersion: 8001003,
      block: { header: { number: { toString: () => '26594857' } } },
    },
    extrinsic: { idx: 1, extrinsic: { method: { method: 'selfRegisterDid' } } },
  } as unknown as SubstrateEvent);

describe('handleDidCreated', () => {
  const rows = new Map<string, Record<string, unknown>>();

  const seed = (entity: string, id: string, row: Record<string, unknown>) =>
    rows.set(`${entity}/${id}`, row);

  beforeEach(() => {
    rows.clear();
    (globalThis as any).store = {
      get: jest.fn(async (entity: string, id: string) => rows.get(`${entity}/${id}`)),
      set: jest.fn(async (entity: string, id: string, row: Record<string, unknown>) => {
        seed(entity, id, row);
      }),
    };
    Object.assign((globalThis as any).api, { registry: { chainSS58: 42 } });
  });

  it('creates the default portfolio of an identity an ethTransact sender already created', async () => {
    seed('Identity', DID, { id: DID, did: DID, primaryAccount: ADDRESS });

    await handleDidCreated(didCreated());

    expect(rows.get(`Portfolio/${PORTFOLIO_ID}`)).toMatchObject({
      identityId: DID,
      number: 0,
      eventIdx: 5,
      createdBlockId: '0026594857',
      createdEventId: '0026594857/0000000005',
    });
  });

  it('keeps an existing default portfolio, marking it updated', async () => {
    seed('Identity', DID, { id: DID, did: DID, primaryAccount: '' });
    seed('Portfolio', PORTFOLIO_ID, {
      id: PORTFOLIO_ID,
      identityId: DID,
      number: 0,
      eventIdx: 2,
      createdBlockId: '0000000001',
      createdEventId: '0000000001/0000000002',
      updatedBlockId: '0000000001',
    });

    await handleDidCreated(didCreated());

    expect(rows.get(`Portfolio/${PORTFOLIO_ID}`)).toMatchObject({
      eventIdx: 2,
      createdBlockId: '0000000001',
      updatedBlockId: '0026594857',
    });
  });

  it('creates the identity and its default portfolio when neither exists', async () => {
    await handleDidCreated(didCreated());

    expect(rows.get(`Identity/${DID}`)).toMatchObject({ primaryAccount: ADDRESS });
    expect(rows.get(`Portfolio/${PORTFOLIO_ID}`)).toMatchObject({ number: 0, eventIdx: 5 });
  });
});
