import { SubstrateEvent } from '@subql/types';
import mapChainUpgrade from '../../src/mappings/entities/block/mapChainUpgrade';
import { migrateToAssetIds } from '../../src/mappings/migrations/assetIdMigration';
import { migrateOffChainLegs } from '../../src/mappings/migrations/offChainLegMigration';
import { migrateTransferManagers } from '../../src/mappings/migrations/statisticsMigration';
import { removeIdentitySigners } from '../../src/mappings/entities/multiSig/mapMultiSig';
import { deletePendingProposals } from '../../src/mappings/entities/multiSig/mapMultiSigProposal';

jest.mock('../../src/mappings/entities/multiSig/mapMultiSig', () => ({
  removeIdentitySigners: jest.fn(),
}));

jest.mock('../../src/mappings/entities/multiSig/mapMultiSigProposal', () => ({
  deletePendingProposals: jest.fn(),
}));
jest.mock('../../src/mappings/migrations/assetIdMigration', () => ({
  migrateToAssetIds: jest.fn(),
}));
jest.mock('../../src/mappings/migrations/offChainLegMigration', () => ({
  migrateOffChainLegs: jest.fn(),
}));
jest.mock('../../src/mappings/migrations/statisticsMigration', () => ({
  migrateTransferManagers: jest.fn(),
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
    (deletePendingProposals as jest.Mock).mockResolvedValue(undefined);
    (removeIdentitySigners as jest.Mock).mockResolvedValue(undefined);
    (migrateToAssetIds as jest.Mock).mockResolvedValue(undefined);
    (migrateTransferManagers as jest.Mock).mockResolvedValue(undefined);
    (migrateOffChainLegs as jest.Mock).mockResolvedValue(undefined);
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
    expect(deletePendingProposals).not.toHaveBeenCalled();
  });

  it('runs the boundary work when the transaction version changed', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004000', specVersionId: 7_004_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 5 }, { spec: 7_004_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_004_000));

    expect(deletePendingProposals).toHaveBeenCalledTimes(1);
  });

  it('skips the boundary work when only the spec version moved', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007003000', specVersionId: 7_003_000, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 7_004_000, tx: 4 }, { spec: 7_003_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_003_000));

    expect(savedUpgrades()).toHaveLength(1);
    expect(deletePendingProposals).not.toHaveBeenCalled();
  });

  it('reads the previous version from the parent block only when nothing is persisted', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 5 }, { spec: 7_004_000, tx: 4 });

    await mapChainUpgrade(upgradeEvent(1_234, 7_004_000));

    expect((api.rpc as any).state.getRuntimeVersion).toHaveBeenCalledWith('0xparent-1234');
    expect(deletePendingProposals).toHaveBeenCalledTimes(1);
  });

  /**
   * Multisig stores the transaction version it last cleared at, which is 0 until the chain's first
   * upgrade: that upgrade clears every proposal, though the genesis runtime had the same version
   * (testnet 3000 to 3001, both 1).
   */
  it("deletes pending proposals at the chain's first upgrade, whatever its transaction version", async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([]);
    stubRuntimeVersions({ spec: 3_001, tx: 1 }, { spec: 3_000, tx: 1 });

    await mapChainUpgrade(upgradeEvent(1_045_804, 3_000));

    expect(deletePendingProposals).toHaveBeenCalledTimes(1);
  });

  it('keeps pending proposals when the transaction version went down', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0003000000', specVersionId: 3_000_000, transactionVersion: 7 },
    ]);
    stubRuntimeVersions({ spec: 4_000_000, tx: 1 }, { spec: 3_000_000, tx: 7 });

    await mapChainUpgrade(upgradeEvent(1_234, 3_000_000));

    expect(savedUpgrades()).toHaveLength(1);
    expect(deletePendingProposals).not.toHaveBeenCalled();
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
    expect(deletePendingProposals).toHaveBeenCalledTimes(1);
  });

  it('removes identity signers as the chain crosses into 7.0, which keeps only account signers', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0006003050', specVersionId: 6_003_050, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 7_000_003, tx: 5 }, { spec: 6_003_050, tx: 4 });

    await mapChainUpgrade(upgradeEvent(15_978_579, 6_003_050));

    expect(removeIdentitySigners).toHaveBeenCalledTimes(1);
  });

  it('writes the transfer conditions 5.0 made of transfer managers as the chain crosses into it', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0000003010', specVersionId: 3_010, transactionVersion: 2 },
    ]);
    stubRuntimeVersions({ spec: 5_000_002, tx: 3 }, { spec: 3_010, tx: 2 });

    await mapChainUpgrade(upgradeEvent(4_397_818, 3_010));

    expect(migrateTransferManagers).toHaveBeenCalledTimes(1);
    expect(migrateToAssetIds).not.toHaveBeenCalled();
  });

  it('settles the leg types 6.0 migrated as the chain crosses into it', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0005004001', specVersionId: 5_004_001, transactionVersion: 3 },
    ]);
    stubRuntimeVersions({ spec: 6_000_000, tx: 4 }, { spec: 5_004_001, tx: 3 });

    await mapChainUpgrade(upgradeEvent(10_036_147, 5_004_001));

    expect(migrateOffChainLegs).toHaveBeenCalledTimes(1);
    expect(migrateTransferManagers).not.toHaveBeenCalled();
    expect(migrateToAssetIds).not.toHaveBeenCalled();
  });

  it('rewrites what 7.0 migrated to asset ids as the chain crosses into it', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0006003050', specVersionId: 6_003_050, transactionVersion: 4 },
    ]);
    stubRuntimeVersions({ spec: 7_000_003, tx: 5 }, { spec: 6_003_050, tx: 4 });

    await mapChainUpgrade(upgradeEvent(15_978_579, 6_003_050));

    expect(migrateToAssetIds).toHaveBeenCalledTimes(1);
  });

  it('leaves signers alone at a later upgrade', async () => {
    (store.getByFields as jest.Mock).mockResolvedValue([
      { id: '0007004001', specVersionId: 7_004_001, transactionVersion: 7 },
    ]);
    stubRuntimeVersions({ spec: 8_000_000, tx: 8 }, { spec: 7_004_001, tx: 7 });

    await mapChainUpgrade(upgradeEvent(24_730_585, 7_004_001));

    expect(removeIdentitySigners).not.toHaveBeenCalled();
    expect(migrateToAssetIds).not.toHaveBeenCalled();
    expect(migrateTransferManagers).not.toHaveBeenCalled();
    expect(migrateOffChainLegs).not.toHaveBeenCalled();
  });
});
