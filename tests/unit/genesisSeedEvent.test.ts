/**
 * The synthetic seed Event (decision D13 / defect A17). `genesisHandler` has always written
 * `createdEventId: '0000000000/0000000000'` for genesis-seeded rows, pointing at an `Event` that
 * did not exist — historical mode's foreign keys are virtual, so Postgres never caught it. This
 * writes that row so the reference resolves and `createdEvent` can be non-null after 7.5.
 */
import { EventIdEnum, ModuleIdEnum } from '../../src/types';
import { insertSeedEvent, seedEventId } from '../../src/mappings/migrations/genesisHandler';
import { MockDb, mockStore } from './helpers';

describe('insertSeedEvent', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore();
  });

  it('writes one seeding/Seeded Event at 0000000000/0000000000', async () => {
    await insertSeedEvent();

    expect(seedEventId).toBe('0000000000/0000000000');
    expect(db['Event'][seedEventId]).toMatchObject({
      id: seedEventId,
      blockId: '0000000000',
      eventIdx: 0,
      moduleId: ModuleIdEnum.seeding,
      moduleIdText: 'seeding',
      eventId: EventIdEnum.Seeded,
      eventIdText: 'Seeded',
      attributesTxt: '[]',
    });
  });
});
