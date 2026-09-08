import { SubstrateEvent } from '@subql/types';
import mapChainUpgrade from '../../src/mappings/entities/block/mapChainUpgrade';
import { repairAuthorizationsAfterUpgrade } from '../../src/mappings/entities/identities/repairAuthorizations';
import { handleMultiSigProposalDeleted } from '../../src/mappings/entities/multiSig/mapMultiSigProposal';

jest.mock('../../src/mappings/entities/multiSig/mapMultiSigProposal', () => ({
  handleMultiSigProposalDeleted: jest.fn(),
}));
jest.mock('../../src/mappings/entities/identities/repairAuthorizations', () => ({
  repairAuthorizationsAfterUpgrade: jest.fn(),
}));

const upgradeEvent = (blockNumber: number, specVersion: number): SubstrateEvent =>
  ({
    block: {
      block: {
        header: {
          number: { toString: () => `${blockNumber}` },
          parentHash: `0xparent-${blockNumber}`,
        },
      },
      specVersion,
      timestamp: new Date('2024-06-01T00:00:00.000Z'),
    },
  } as unknown as SubstrateEvent);

/** `api.rpc.state.getRuntimeVersion(hash?)` - the current block's version, or the parent's */
const stubRuntimeVersions = (current: number, parent: number) => {
  (api.rpc as any).state = {
    getRuntimeVersion: jest.fn(async (hash?: string) =>
      hash
        ? { specVersion: { toNumber: () => 0 }, transactionVersion: { toNumber: () => parent } }
        : { specVersion: { toNumber: () => 0 }, transactionVersion: { toNumber: () => current } }
    ),
  };
};

const savedUpgrades = () =>
  (store.set as jest.Mock).mock.calls
    .filter(([entity]) => entity === 'ChainUpgrade')
    .map(([, , row]) => row);

describe('mapChainUpgrade', () => {
  beforeEach(() => {
    (handleMultiSigProposalDeleted as jest.Mock).mockResolvedValue(undefined);
    (repairAuthorizationsAfterUpgrade as jest.Mock).mockResolvedValue(undefined);
    (store.set as jest.Mock).mockResolvedValue(undefined);
  });

  it('records the upgrade with a zero padded spec version id', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004000', specVersionId: 7_004_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions(5, 4);

    await mapChainUpgrade(upgradeEvent(1_234, 8_000_000));

    expect(savedUpgrades()).toEqual([
      {
        id: '0008000000',
        specVersionId: 8_000_000,
        transactionVersion: 5,
        firstBlockId: '0000001234',
        datetime: new Date('2024-06-01T00:00:00.000Z'),
      },
    ]);
  });

  it('is a no-op when the spec version is already recorded, so a replay writes nothing', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0008000000', specVersionId: 8_000_000, transactionVersion: 5 },
    ]);
    stubRuntimeVersions(5, 5);

    await mapChainUpgrade(upgradeEvent(1_234, 8_000_000));

    expect(savedUpgrades()).toHaveLength(0);
    expect(handleMultiSigProposalDeleted).not.toHaveBeenCalled();
  });

  it('runs the boundary work when the transaction version changed', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004000', specVersionId: 7_004_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions(5, 4);

    await mapChainUpgrade(upgradeEvent(1_234, 8_000_000));

    expect(handleMultiSigProposalDeleted).toHaveBeenCalledTimes(1);
    expect(repairAuthorizationsAfterUpgrade).toHaveBeenCalledTimes(1);
  });

  it('skips the boundary work when only the spec version moved', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007003000', specVersionId: 7_003_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions(4, 4);

    await mapChainUpgrade(upgradeEvent(1_234, 7_004_000));

    expect(savedUpgrades()).toHaveLength(1);
    expect(handleMultiSigProposalDeleted).not.toHaveBeenCalled();
  });

  it('reads the previous version from the parent block only when nothing is persisted', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([]);
    stubRuntimeVersions(5, 4);

    await mapChainUpgrade(upgradeEvent(1_234, 8_000_000));

    expect((api.rpc as any).state.getRuntimeVersion).toHaveBeenCalledWith('0xparent-1234');
    expect(handleMultiSigProposalDeleted).toHaveBeenCalledTimes(1);
  });
});
