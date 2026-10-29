/** A PIP's proposer as an event and the stored proposal both present it. */
import { TypeRegistry } from '@polkadot/types';
import { getProposerValue } from '../../src/utils/proposals';

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
