/**
 * Plan 05 — PortfolioMovement folded into AssetTransaction.
 *
 * The classification subtlety the plan calls out for review: a holder that is *present* but
 * whose DID never resolved must not be treated as an *absent* holder — classify on presence
 * first, DID equality second, or an unresolved sender is silently recorded as an issuance.
 */

import { accountHolder, classifyInternalTransfer, portfolioHolder } from '../../src/utils';
import { createAssetTransaction } from '../../src/mappings/entities/assets/mapAsset';
import { handlePortfolioMovement } from '../../src/mappings/entities/identities/mapPortfolio';
import {
  codec,
  MockDb,
  mockStore,
  portfolioCodec,
  storeGet,
  storeSet,
  tupleEvent,
} from './helpers';

const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');
const ASSET = '0xasset000000000000000000000000000';
const ADDR = '5Signer0000000000000000000000000000000000000000000';

describe('classifyInternalTransfer', () => {
  it('is true only when both holders resolve to the same DID', () => {
    expect(classifyInternalTransfer(portfolioHolder(DID_A, 0), portfolioHolder(DID_A, 1))).toBe(
      true
    );
    expect(classifyInternalTransfer(portfolioHolder(DID_A, 0), portfolioHolder(DID_B, 0))).toBe(
      false
    );
  });

  it('a present but unresolved-DID holder is false, never undefined (not an issuance)', () => {
    const unresolvedSender = accountHolder(undefined, ADDR);

    expect(classifyInternalTransfer(unresolvedSender, portfolioHolder(DID_A, 0))).toBe(false);
    // and the key distinction: it is NOT the "no from holder" (issuance) case
    expect(
      classifyInternalTransfer(unresolvedSender, portfolioHolder(DID_A, 0))
    ).not.toBeUndefined();
  });

  it('is undefined for issuance (no from) and redemption (no to)', () => {
    expect(classifyInternalTransfer(undefined, portfolioHolder(DID_A, 0))).toBeUndefined();
    expect(classifyInternalTransfer(portfolioHolder(DID_A, 0), undefined)).toBeUndefined();
  });
});

describe('createAssetTransaction — isInternalTransfer', () => {
  beforeEach(() => {
    storeSet().mockResolvedValue(undefined);
    storeGet().mockResolvedValue(undefined);
  });

  it('classifies a ControllerTransfer internal when both sides resolve to one DID', async () => {
    await createAssetTransaction(
      '0000000100',
      0,
      new Date(0),
      {
        assetId: ASSET,
        fromHolder: portfolioHolder(DID_A, 0),
        toHolder: portfolioHolder(DID_A, 1),
        amount: BigInt(10),
      },
      '0000000100/0000000000',
      undefined,
      { idx: 1, extrinsic: { method: { method: 'controllerTransfer', section: 'asset' } } } as any
    );

    const [, , row] = storeSet().mock.calls.find(([e]) => e === 'AssetTransaction');
    expect(row.isInternalTransfer).toBe(true);
    expect(row.eventId).toBe('ControllerTransfer');
  });
});

describe('handlePortfolioMovement → AssetTransaction', () => {
  let db: MockDb;

  const movementEvent = () =>
    tupleEvent({
      section: 'portfolio',
      method: 'MovedBetweenPortfolios',
      idx: 2,
      extrinsic: {
        idx: 0,
        extrinsic: {
          signer: codec(ADDR),
          method: { method: 'movePortfolioFunds', section: 'portfolio' },
        },
      },
      data: [
        codec(DID_A),
        portfolioCodec(DID_A, 0),
        portfolioCodec(DID_A, 1),
        codec(ASSET),
        codec('750'),
        codec('rebalance'),
      ],
    });

  beforeEach(() => {
    db = mockStore();
  });

  it('writes exactly one internal-transfer AssetTransaction with matching identities', async () => {
    await handlePortfolioMovement(movementEvent());

    const rows = Object.values(db['AssetTransaction'] ?? {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetId: ASSET,
      fromPortfolioId: `${DID_A}/0`,
      toPortfolioId: `${DID_A}/1`,
      fromIdentityId: DID_A,
      toIdentityId: DID_A,
      amount: BigInt(750),
      isInternalTransfer: true,
      memo: 'rebalance',
      address: ADDR,
      eventId: 'MovedBetweenPortfolios',
    });
  });
});
