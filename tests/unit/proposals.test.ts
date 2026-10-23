/**
 * A PIP's proposer as an event and the stored proposal both present it, and its deposit once
 * refunded.
 */
import { TypeRegistry } from '@polkadot/types';
import { handleProposalRefunded } from '../../src/mappings/entities/pips/mapProposal';
import { getProposerValue } from '../../src/utils/proposals';
import { codec, mockStore, tupleEvent } from './helpers';

const proposerCodec = (json: unknown) =>
  ({ toString: () => JSON.stringify(json), registry: new TypeRegistry() } as never);

describe('getProposerValue', () => {
  it("names a committee as an event's codec renders it", () => {
    expect(getProposerValue(proposerCodec({ committee: { technical: null } }))).toEqual({
      type: 'Committee',
      value: 'Technical',
    });
  });

  it('names a committee as stored, a fieldless variant rendered as its name', () => {
    expect(getProposerValue(proposerCodec({ committee: 'technical' }))).toEqual({
      type: 'Committee',
      value: 'Technical',
    });
  });
});

const PROPOSER = '5Ci94GCJC2JBM8U1PCkpHX6HkscWmucN9XwUrjb7o4TDgVns';

const pip = () =>
  mockStore({
    Proposal: {
      '0000000001': {
        id: '0000000001',
        proposer: { type: 'Community', value: PROPOSER },
        balance: BigInt(2_000),
      },
    },
  });

const refund = (specVersion: number) =>
  handleProposalRefunded(
    tupleEvent({
      section: 'pips',
      method: 'ProposalRefund',
      data: [codec(`0x${'01'.repeat(32)}`), codec(1), codec(2_000)],
      specVersion,
    })
  );

/** `deposits(pipId, account)` as the chain holds it at the end of the block */
const proposerDeposit = (held: boolean) => {
  const deposits = jest.fn().mockResolvedValue({ isSome: held, isNone: !held });
  (globalThis as any).api.query = { pips: { deposits } };
  return deposits;
};

it("empties a PIP's balance once its deposits are refunded, all at once before 8.0", async () => {
  const db = pip();
  const deposits = proposerDeposit(true);

  await refund(7_004_000);

  expect(db.Proposal['0000000001'].balance).toBe(BigInt(0));
  expect(deposits).not.toHaveBeenCalled();
});

/**
 * From 8.0 deposits are refunded 128 a block, in the chain's storage order, each batch with its own
 * event: the proposer's deposit is returned by whichever batch reached it.
 */
it("keeps a PIP's balance until the batch that returns the proposer's deposit", async () => {
  const db = pip();

  const deposits = proposerDeposit(true);
  await refund(8_000_000);
  expect(db.Proposal['0000000001'].balance).toBe(BigInt(2_000));
  expect(deposits).toHaveBeenCalledWith(1, PROPOSER);

  proposerDeposit(false);
  await refund(8_000_000);
  expect(db.Proposal['0000000001'].balance).toBe(BigInt(0));
});
