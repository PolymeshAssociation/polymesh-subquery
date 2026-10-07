import { handleDistributionCreated } from '../../src/mappings/entities/assets/mapCorporateActions';
import { IndexerAnomaly } from '../../src/types';
import { codec, mockStore, tupleEvent } from './helpers';

const RAW_ASSET_ID = '0xabc123def456';
const LOCAL_ID = 4;

const distributionEvent = () =>
  tupleEvent({
    section: 'capitaldistribution',
    method: 'Created',
    data: [
      codec(TEST_DID),
      codec({ assetId: RAW_ASSET_ID, local_id: LOCAL_ID }),
      codec({
        from: { did: TEST_DID, kind: { User: 1 } },
        currency: RAW_ASSET_ID,
        per_share: 10,
        amount: 1_000,
        remaining: 1_000,
        payment_at: 1_700_000_000_000,
        expires_at: 1_800_000_000_000,
      }),
    ],
  });

/**
 * `capitalDistribution.distribute` names a corporate action an earlier extrinsic created, possibly in
 * an earlier block — so under an arbitrary start block, or after a missed `CAInitiated`, the action
 * can be outside the index. The payout terms are still worth keeping when it is, because the payments
 * that reference this row are not optional, so the relation is left null rather than the row dropped.
 */
describe('handleDistributionCreated', () => {
  it('links the corporate action when it is indexed', async () => {
    const id = `${RAW_ASSET_ID}/${LOCAL_ID}`;
    const db = mockStore({ CorporateAction: { [id]: { id } } });

    await handleDistributionCreated(distributionEvent());

    expect(db.Distribution[id].corporateActionId).toBe(id);
  });

  it('leaves the relation null and records an anomaly when it is not', async () => {
    const db = mockStore();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleDistributionCreated(distributionEvent());

    const row = db.Distribution[`${RAW_ASSET_ID}/${LOCAL_ID}`];

    expect(row).toBeDefined();
    expect(row.corporateActionId).toBeUndefined();
    expect(anomaly).toHaveBeenCalled();
  });
});
