import { handleMultiSigProposalAdded } from '../../src/mappings/entities/multiSig/mapMultiSigProposal';
import { codec, mockStore, tupleEvent } from './helpers';

const MULTISIG = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const ID = `${MULTISIG}/0`;

const remark = { section: 'system', method: 'remark', args: { remark: '0x' } };
const propose = (multisig: string, proposal: unknown = remark) => ({
  section: 'multiSig',
  method: 'createProposal',
  args: { multisig, proposal, expiry: null },
});

const added = (method?: unknown) =>
  tupleEvent({
    section: 'multiSig',
    method: 'ProposalAdded',
    specVersion: 6_000_000,
    data: [codec(TEST_DID), codec(MULTISIG), codec(0)],
    extrinsic: method && {
      idx: 1,
      extrinsic: {
        signer: { toString: () => OTHER },
        method: { method: (method as { method: string }).method },
        toHuman: () => ({ method }),
      },
    },
  });

const anomalies = (db: Record<string, Record<string, unknown>>) =>
  Object.values(db.IndexerAnomaly ?? {});

describe('handleMultiSigProposalAdded', () => {
  it('reads the proposal of a top-level call', async () => {
    const db = mockStore();
    await handleMultiSigProposalAdded(added(propose(MULTISIG)));

    expect((db.MultiSigProposal[ID] as any).params.proposals).toEqual([
      { module: 'system', call: 'remark', args: JSON.stringify(remark.args) },
    ]);
    expect(anomalies(db)).toHaveLength(0);
  });

  it.each([
    [
      'utility.batch',
      { section: 'utility', method: 'batch', args: { calls: [propose(MULTISIG)] } },
    ],
    [
      'relayer.relay_tx',
      {
        section: 'relayer',
        method: 'relayTx',
        args: { call: { nonce: '1', call: propose(MULTISIG) } },
      },
    ],
  ])('finds the proposing call inside %s', async (_name, wrapper) => {
    const db = mockStore();
    await handleMultiSigProposalAdded(added(wrapper));

    expect((db.MultiSigProposal[ID] as any).params.proposals).toHaveLength(1);
    expect(anomalies(db)).toHaveLength(0);
  });

  it("takes the proposal to this multisig, not the outer multisig's proposal carrying it", async () => {
    const db = mockStore();
    await handleMultiSigProposalAdded(added(propose(OTHER, propose(MULTISIG))));

    expect((db.MultiSigProposal[ID] as any).params.proposals[0].call).toBe('remark');
  });

  it('writes the row and records an anomaly when no call proposes to the multisig', async () => {
    const db = mockStore();
    await handleMultiSigProposalAdded(added({ section: 'multiSig', method: 'approve', args: {} }));

    expect((db.MultiSigProposal[ID] as any).params.proposals).toBeUndefined();
    expect(anomalies(db)).toHaveLength(1);
  });

  it('writes the row and records an anomaly with no extrinsic at all', async () => {
    const db = mockStore();
    await handleMultiSigProposalAdded(added());

    expect(db.MultiSigProposal[ID]).toBeDefined();
    expect(anomalies(db)).toHaveLength(1);
  });
});
