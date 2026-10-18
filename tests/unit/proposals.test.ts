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

it("empties a PIP's balance once its deposits are refunded", async () => {
  const db = mockStore({
    Proposal: { '0000000001': { id: '0000000001', balance: BigInt(2_000) } },
  });

  await handleProposalRefunded(
    tupleEvent({
      section: 'pips',
      method: 'ProposalRefund',
      data: [codec(`0x${'01'.repeat(32)}`), codec(1)],
    })
  );

  expect(db.Proposal['0000000001'].balance).toBe(BigInt(0));
});
