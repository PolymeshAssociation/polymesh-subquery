import { retireChildIdentitiesAtV8 } from '../../src/mappings/entities/identities/retireChildIdentities';
import { ChainUpgradeCrossing } from '../../src/mappings/entities/block/mapChainUpgrade';

const crossing = (previousSpecVersion: number, specVersion: number): ChainUpgradeCrossing =>
  ({
    previousSpecVersion,
    specVersion,
    previousTransactionVersion: 4,
    transactionVersion: 5,
  } as ChainUpgradeCrossing);

const rows = (ids: string[]) => ids.map(id => ({ id }));

describe('retireChildIdentitiesAtV8', () => {
  beforeEach(() => {
    (api.runtimeVersion.specName as any).toString = () => 'polymesh';
    (store.getByFields as jest.Mock).mockResolvedValue([]);
  });

  it('removes every row when the chain crosses into 8.x', async () => {
    (store.getByFields as jest.Mock).mockResolvedValueOnce(rows(['a', 'b', 'c']));

    await retireChildIdentitiesAtV8(crossing(7_004_000, 8_000_000));

    expect(store.bulkRemove).toHaveBeenCalledWith('ChildIdentity', ['a', 'b', 'c']);
  });

  it('does nothing on an upgrade that stays below 8.x', async () => {
    await retireChildIdentitiesAtV8(crossing(7_003_000, 7_004_000));

    expect(store.getByFields).not.toHaveBeenCalled();
    expect(store.bulkRemove).not.toHaveBeenCalled();
  });

  it('does nothing on a later 8.x upgrade, so it runs once and not on every bump', async () => {
    await retireChildIdentitiesAtV8(crossing(8_000_000, 8_000_002));

    expect(store.getByFields).not.toHaveBeenCalled();
    expect(store.bulkRemove).not.toHaveBeenCalled();
  });

  it('pages until a short page, so a set larger than one page is fully removed', async () => {
    const first = rows(Array.from({ length: 100 }, (_, i) => `id-${i}`));
    (store.getByFields as jest.Mock)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(rows(['last']));

    await retireChildIdentitiesAtV8(crossing(7_004_000, 8_000_000));

    expect((store.getByFields as jest.Mock).mock.calls[1][2]).toMatchObject({
      offset: 100,
      orderBy: 'id',
    });
    expect(store.bulkRemove).toHaveBeenCalledWith('ChildIdentity', [
      ...first.map(({ id }) => id),
      'last',
    ]);
  });

  it('reads nothing when there is nothing to remove', async () => {
    await retireChildIdentitiesAtV8(crossing(7_004_000, 8_000_000));

    expect(store.bulkRemove).not.toHaveBeenCalled();
  });

  it('uses the private chain offset when the runtime says so', async () => {
    (api.runtimeVersion.specName as any).toString = () => 'polymesh_private_dev';
    (store.getByFields as jest.Mock).mockResolvedValueOnce(rows(['a']));

    await retireChildIdentitiesAtV8(crossing(2_001_000, 2_002_000));

    expect(store.bulkRemove).toHaveBeenCalledWith('ChildIdentity', ['a']);
  });
});
