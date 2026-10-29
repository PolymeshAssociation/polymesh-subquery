/**
 * A user's text reaches a handler decoded as `Text` before metadata v14 and as `Bytes` (hex) from
 * it; each is stored as the chain holds it, so testnet's venue 36 keeps its "New STO !!! " and
 * mainnet's ARVOGOLD its trailing space.
 */
import {
  handleAssetRenamed,
  handleFundingRoundSet,
} from '../../src/mappings/entities/assets/mapAsset';
import { handleCustomClaimTypeCreated } from '../../src/mappings/entities/identities/mapIdentities';
import { handlePortfolioRenamed } from '../../src/mappings/entities/identities/mapPortfolio';
import { handleVenueDetailsUpdated } from '../../src/mappings/entities/settlements/mapVenue';
import { TypeRegistry } from '@polkadot/types';
import { getDocValue } from '../../src/utils/assets';
import { codec, mockStore, tupleEvent } from './helpers';

const DID = '0x01'.padEnd(66, '0');
const ASSET = '0x1234567890abcdef1234567890abcdef';
const hex = (text: string) => `0x${Buffer.from(text, 'utf8').toString('hex')}`;

/** The same text as the type bundle decoded it before v14, and as the metadata decodes it from v14 */
const decodings = (text: string) => [
  ['Text, before v14', codec(text)],
  ['Bytes, from v14', codec(hex(text))],
];

describe.each(decodings('New STO !!! '))("a venue's details, as %s", (_how, details) => {
  it('are stored as the chain holds them', async () => {
    const db = mockStore({ Venue: { '0000000036': { id: '0000000036' } } });

    await handleVenueDetailsUpdated(
      tupleEvent({
        section: 'settlement',
        method: 'VenueDetailsUpdated',
        data: [codec(DID), codec(36), details],
      })
    );

    expect(db.Venue['0000000036'].details).toBe('New STO !!! ');
  });
});

describe.each(decodings('ARVOGOLD '))("an asset's name, as %s", (_how, name) => {
  it('is stored as the chain holds it', async () => {
    const db = mockStore({ Asset: { [ASSET]: { id: ASSET } } });

    await handleAssetRenamed(
      tupleEvent({
        section: 'asset',
        method: 'AssetRenamed',
        data: [codec(DID), codec(ASSET), name],
      })
    );

    expect(db.Asset[ASSET].name).toBe('ARVOGOLD ');
  });
});

describe("an asset's funding round", () => {
  it('is "" when the chain stores an empty one, not null', async () => {
    const db = mockStore({ Asset: { [ASSET]: { id: ASSET, fundingRound: 'Seed' } } });

    await handleFundingRoundSet(
      tupleEvent({
        section: 'asset',
        method: 'FundingRoundSet',
        data: [codec(DID), codec(ASSET), codec('0x')],
      })
    );

    expect(db.Asset[ASSET].fundingRound).toBe('');
  });
});

describe.each(decodings(' Treasury '))("a portfolio's name, as %s", (_how, name) => {
  it('is stored as the chain holds it', async () => {
    const db = mockStore({ Portfolio: { [`${DID}/1`]: { id: `${DID}/1` } } });

    await handlePortfolioRenamed(
      tupleEvent({
        section: 'portfolio',
        method: 'PortfolioRenamed',
        data: [codec(DID), codec(1), name],
      })
    );

    expect(db.Portfolio[`${DID}/1`].name).toBe(' Treasury ');
  });
});

describe.each(decodings('Accredited '))("a custom claim type's name, as %s", (_how, name) => {
  it('is stored as the chain holds it', async () => {
    const db = mockStore();

    await handleCustomClaimTypeCreated(
      tupleEvent({
        section: 'identity',
        method: 'CustomClaimTypeAdded',
        data: [codec(DID), codec(4), name],
      })
    );

    expect(db.CustomClaimType['4'].name).toBe('Accredited ');
  });
});

describe("an asset document's text", () => {
  // as the type bundle declared a document before v14, and as the metadata gives it from v14
  const registry = new TypeRegistry();
  registry.register({
    DocumentHash: { _enum: { None: 'Null', H128: '[u8; 16]' } },
    OldDocument: {
      uri: 'Text',
      content_hash: 'DocumentHash',
      name: 'Text',
      doc_type: 'Option<Text>',
      filing_date: 'Option<u64>',
    },
    NewDocument: {
      uri: 'Bytes',
      contentHash: 'DocumentHash',
      name: 'Bytes',
      docType: 'Option<Bytes>',
      filingDate: 'Option<u64>',
    },
  });

  it.each([
    ['OldDocument', { uri: 'https://x.io ', name: ' Prospectus ', doc_type: 'pdf ' }],
    ['NewDocument', { uri: 'https://x.io ', name: ' Prospectus ', docType: 'pdf ' }],
  ])('is read as stored from a %s', (type, fields) => {
    const document = getDocValue(registry.createType(type, fields));

    expect(document).toMatchObject({ link: 'https://x.io ', name: ' Prospectus ', type: 'pdf ' });
  });

  it('has no type when the document gives none', () => {
    expect(getDocValue(registry.createType('NewDocument', { name: 'Terms' })).type).toBeUndefined();
  });
});
