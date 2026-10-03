import { SubstrateEvent } from '@subql/types';
import mapChainUpgrade from '../../src/mappings/entities/block/mapChainUpgrade';
import { repairAuthorizationsAfterUpgrade } from '../../src/mappings/entities/identities/repairAuthorizations';
import { retireChildIdentitiesAtV8 } from '../../src/mappings/entities/identities/retireChildIdentities';
import { handleMultiSigProposalDeleted } from '../../src/mappings/entities/multiSig/mapMultiSigProposal';

jest.mock('../../src/mappings/entities/multiSig/mapMultiSigProposal', () => ({
  handleMultiSigProposalDeleted: jest.fn(),
}));
jest.mock('../../src/mappings/entities/identities/repairAuthorizations', () => ({
  repairAuthorizationsAfterUpgrade: jest.fn(),
}));
jest.mock('../../src/mappings/entities/identities/retireChildIdentities', () => ({
  retireChildIdentitiesAtV8: jest.fn(),
}));

/**
 * The block carrying `system.CodeUpdated`. `specVersion` is the runtime that ran it — the one being
 * *replaced*, since the upgrade is applied by that very block and the new code runs from the next.
 */
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

interface RuntimeAt {
  spec: number;
  tx: number;
}

/**
 * `api.rpc.state.getRuntimeVersion(hash?)`. With no hash it is the state this block leaves behind —
 * the runtime the upgrade installed. With the parent's hash it is the runtime that ran this block.
 */
const stubRuntimeVersions = (after: RuntimeAt, before: RuntimeAt) => {
  const version = ({ spec, tx }: RuntimeAt) => ({
    specVersion: { toNumber: () => spec },
    transactionVersion: { toNumber: () => tx },
  });

  (api.rpc as any).state = {
    getRuntimeVersion: jest.fn(async (hash?: string) => version(hash ? before : after)),
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
    (retireChildIdentitiesAtV8 as jest.Mock).mockResolvedValue(undefined);
    (store.set as jest.Mock).mockResolvedValue(undefined);
  });

  it('records the upgrade with a zero padded spec version id', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004000', specVersionId: 7_004_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 5 }, { spec: 7_004_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_004_000));

    expect(savedUpgrades()).toEqual([
      {
        id: '0008000000',
        specVersionId: 8_000_000,
        transactionVersion: 5,
        firstBlockId: '0000001234',
      },
    ]);
  });

  it('is a no-op when the spec version is already recorded, so a replay writes nothing', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0008000000', specVersionId: 8_000_000, transactionVersion: 5 },
    ]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 5 }, { spec: 8_000_000, tx: 5 });

    await mapChainUpgrade(upgradeEvent(1_234, 8_000_000));

    expect(savedUpgrades()).toHaveLength(0);
    expect(handleMultiSigProposalDeleted).not.toHaveBeenCalled();
  });

  it('runs the boundary work when the transaction version changed', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004000', specVersionId: 7_004_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 5 }, { spec: 7_004_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_004_000));

    expect(handleMultiSigProposalDeleted).toHaveBeenCalledTimes(1);
    expect(repairAuthorizationsAfterUpgrade).toHaveBeenCalledTimes(1);
  });

  it('skips the boundary work when only the spec version moved', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007003000', specVersionId: 7_003_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 7_004_000, tx: 4 }, { spec: 7_003_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_003_000));

    expect(savedUpgrades()).toHaveLength(1);
    expect(handleMultiSigProposalDeleted).not.toHaveBeenCalled();
  });

  it('reads the previous version from the parent block only when nothing is persisted', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 5 }, { spec: 7_004_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_004_000));

    expect((api.rpc as any).state.getRuntimeVersion).toHaveBeenCalledWith('0xparent-1234');
    expect(handleMultiSigProposalDeleted).toHaveBeenCalledTimes(1);
  });

  /**
   * On testnet the block carrying the v8 upgrade ran under 7004001, and the chain ran 8000000 from
   * the next block. Reading the spec from that block recorded the upgrade as 7004001, beside v8's
   * transaction version, and the v8 boundary work waited for the following upgrade — hundreds of
   * thousands of blocks later.
   */
  it('records the spec the upgrade installed, and crosses into it at this block', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004001', specVersionId: 7_004_001, transactionVersion: 7 },
    ]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 8 }, { spec: 7_004_001, tx: 7 });

    await mapChainUpgrade(upgradeEvent(24_730_585, 7_004_001));

    expect(savedUpgrades()).toEqual([
      {
        id: '0008000000',
        specVersionId: 8_000_000,
        transactionVersion: 8,
        firstBlockId: '0024730585',
      },
    ]);
    expect(retireChildIdentitiesAtV8).toHaveBeenCalledWith(
      expect.objectContaining({ previousSpecVersion: 7_004_001, specVersion: 8_000_000 })
    );
  });
});
