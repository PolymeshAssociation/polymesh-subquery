/**
 * What `verify-seed` counts as a difference between a seed and the index it should equal: a row
 * either lacks, or a field they disagree on. Provenance, fields the index counts from its start, and
 * finished rows the chain pruned are not differences.
 */
import { connectionNames, diffSeed, sameValue } from '../../scripts/lib/seedDiff';
import { Seeder } from '../../src/seed/seeder';
import { legSeeder, venueSeeder } from '../../src/seed/seeders/settlement';

const seeder = (entity: string, extra: Partial<Seeder> = {}): Seeder => ({
  entity,
  reads: [],
  rows: async function* () {
    yield [];
  },
  ...extra,
});

describe('diffSeed', () => {
  it('reports the ids only one side holds, and the fields they disagree on', () => {
    const [diff] = diffSeed(
      {
        Venue: [
          { id: '1', details: 'a' },
          { id: '2', details: 'b' },
        ],
      },
      {
        Venue: [
          { id: '1', details: 'A' },
          { id: '3', details: 'c' },
        ],
      },
      [seeder('Venue')]
    );

    expect(diff).toMatchObject({
      entity: 'Venue',
      missing: ['2'],
      extra: ['3'],
      differing: [{ id: '1', field: 'details', seeded: 'a', indexed: 'A' }],
    });
  });

  it('skips provenance and the fields the index counts from its start', () => {
    const [diff] = diffSeed(
      { Asset: [{ id: '1', createdEventId: 's', updatedEventId: 's', totalTransfers: '0' }] },
      { Asset: [{ id: '1', createdEventId: 'x', updatedEventId: 'y', totalTransfers: '9' }] },
      [seeder('Asset', { relative: ['totalTransfers'] })]
    );

    expect(diff.differing).toEqual([]);
  });

  it("compares only the index's columns, so an older schema's missing field isn't a difference", () => {
    const [diff] = diffSeed(
      { Venue: [{ id: '1', details: 'a', signers: ['x'] }] },
      { Venue: [{ id: '1', details: 'a' }] },
      [seeder('Venue')]
    );

    expect(diff.differing).toEqual([]);
  });

  it('matches by natural key a row whose id names the block that opened it', () => {
    const [diff] = diffSeed(
      {
        IdentityKey: [{ id: 'd/a/0000001000/0', identityId: 'd', accountId: 'a', role: 'Primary' }],
      },
      {
        IdentityKey: [
          { id: 'd/a/0000000007/0', identityId: 'd', accountId: 'a', role: 'Primary' },
          { id: 'd/b/0000000005/0', identityId: 'd', accountId: 'b', validToBlockId: '0000000009' },
        ],
      },
      [
        seeder('IdentityKey', {
          key: ({ identityId, accountId }: any) => `${identityId}/${accountId}`,
          terminal: ({ validToBlockId }: any) => Boolean(validToBlockId),
        }),
      ]
    );

    expect(diff).toMatchObject({ missing: [], extra: [], allowed: 1, differing: [] });
  });

  it('skips block provenance, and an absent key inside a value reads as null', () => {
    const [diff] = diffSeed(
      { Proposal: [{ id: '1', createdBlockId: '9', params: { a: 1 } }] },
      { Proposal: [{ id: '1', createdBlockId: '2', params: { a: 1, expiry: null } }] },
      [seeder('Proposal')]
    );

    expect(diff.differing).toEqual([]);
  });

  it('allows a finished row the chain pruned, and the rows that belong to it', () => {
    const diffs = diffSeed(
      { Instruction: [{ id: '1', status: 'Pending' }], Leg: [{ id: '1/0', instructionId: '1' }] },
      {
        Instruction: [
          { id: '1', status: 'Pending' },
          { id: '2', status: 'Executed' },
          { id: '3', status: 'Pending' },
        ],
        Leg: [
          { id: '1/0', instructionId: '1' },
          { id: '2/0', instructionId: '2' },
          { id: '3/0', instructionId: '3' },
        ],
      },
      [
        seeder('Leg', { parent: { entity: 'Instruction', field: 'instructionId' } }),
        seeder('Instruction', { terminal: ({ status }: any) => status === 'Executed' }),
      ]
    );

    const byEntity = Object.fromEntries(diffs.map(diff => [diff.entity, diff]));
    expect(byEntity.Instruction).toMatchObject({ extra: ['3'], allowed: 1 });
    expect(byEntity.Leg).toMatchObject({ extra: ['3/0'], allowed: 1 });
  });
});

describe('sameValue', () => {
  it('reads a seeded value as GraphQL renders it', () => {
    expect(sameValue(BigInt(800), '800')).toBe(true);
    expect(sameValue(new Date('2024-06-01T00:00:00Z'), '2024-06-01T00:00:00')).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue({ b: BigInt(1), a: [1] }, { a: [1], b: '1' })).toBe(true);
    expect(sameValue('a', 'b')).toBe(false);
    expect(sameValue(0, null)).toBe(false);
  });
});

describe('fields the chain keeps less of than the index', () => {
  it("compares a venue's signers in any order, as the chain keeps them as a set", () => {
    const diffs = diffSeed(
      {
        Venue: [
          { id: '1', signers: ['a', 'b'] },
          { id: '2', signers: ['a'] },
        ],
      },
      {
        Venue: [
          { id: '1', signers: ['b', 'a'] },
          { id: '2', signers: ['a', 'b'] },
        ],
      },
      [venueSeeder]
    );

    expect(diffs[0].differing).toEqual([
      { id: '2', field: 'signers', seeded: ['a'], indexed: ['a', 'b'] },
    ]);
  });

  it("skips an off-chain leg's portfolios, which 6.0 dropped from a pre-6.0 leg it made off-chain", () => {
    const portfolio = (did: string) => `${did}/0`;
    const diffs = diffSeed(
      {
        Instruction: [{ id: '1', status: 'Pending' }],
        Leg: [
          { id: '1/0', instructionId: '1', legType: 'OffChain' },
          { id: '1/1', instructionId: '1', legType: 'Fungible', fromPortfolioId: portfolio('a') },
        ],
      },
      {
        Instruction: [{ id: '1', status: 'Pending' }],
        Leg: [
          {
            id: '1/0',
            instructionId: '1',
            legType: 'OffChain',
            fromPortfolioId: portfolio('a'),
            toPortfolioId: portfolio('b'),
          },
          { id: '1/1', instructionId: '1', legType: 'Fungible', fromPortfolioId: portfolio('c') },
        ],
      },
      [legSeeder]
    );

    expect(diffs.find(({ entity }) => entity === 'Leg')?.differing).toEqual([
      { id: '1/1', field: 'fromPortfolioId', seeded: portfolio('a'), indexed: portfolio('c') },
    ]);
  });
});

describe('connectionNames', () => {
  it("names each entity's connection by the type of its nodes", () => {
    const list = (name: string) => ({
      kind: 'NON_NULL',
      ofType: { kind: 'LIST', ofType: { kind: 'OBJECT', name } },
    });
    expect(
      connectionNames({
        queryType: {
          fields: [
            { name: 'identities', type: { name: 'IdentitiesConnection' } },
            { name: 'identity', type: { name: 'Identity' } },
            { name: 'validatorEras', type: { name: 'ValidatorErasConnection' } },
          ],
        },
        types: [
          { name: 'IdentitiesConnection', fields: [{ name: 'nodes', type: list('Identity') }] },
          {
            name: 'ValidatorErasConnection',
            fields: [{ name: 'nodes', type: list('ValidatorEra') }],
          },
        ],
      })
    ).toEqual({ Identity: 'identities', ValidatorEra: 'validatorEras' });
  });
});
