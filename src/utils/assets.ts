import { Codec } from '@polkadot/types/types';
import { hexAddPrefix, hexHasPrefix, hexStripPrefix, stringToHex, u8aToHex } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';
import { SubstrateBlock } from '@subql/types';
import { Asset, AssetDocument, SecurityIdentifier } from '../types';
import {
  coerceHexToString,
  extractString,
  extractValue,
  getNumberValue,
  getTextValue,
  hexToString,
  is7xChain,
  serializeTicker,
} from './common';

export interface AssetIdWithTicker {
  assetId: string;
  ticker?: string;
}

export const getCustomType = async (rawCustomId: Codec): Promise<string> => {
  // `customTypes` keys on `CustomAssetTypeId` (u32), not a raw `Codec`
  const customType = await api.query.asset.customTypes(getNumberValue(rawCustomId));
  return hexToString(customType.toString());
};

export const getAssetType = async (item: Codec): Promise<string> => {
  const anyItem: any = item;

  if (anyItem.isNonFungible) {
    const nftType = anyItem.asNonFungible;
    if (nftType.type === 'Custom') {
      return getCustomType(nftType.asCustom);
    }

    return nftType.type;
  } else {
    if (anyItem.isCustom) {
      return getCustomType(anyItem.asCustom);
    }

    return getTextValue(item);
  }
};

/**
 * Parses a raw Asset Document
 */
export const getDocValue = (
  doc: Codec
): Pick<AssetDocument, 'name' | 'link' | 'contentHash' | 'type' | 'filedAt'> => {
  const document = JSON.parse(doc.toString());

  const documentHash = extractValue(document, 'content_hash');

  const hashType = Object.keys(documentHash)[0];
  const contentHash = {
    type: hashType,
    value: documentHash[hashType],
  };

  let filedAt;
  const filingDate = extractString(document, 'filing_date');
  if (filingDate) {
    filedAt = new Date(filingDate);
  }

  return {
    name: coerceHexToString(extractString(document, 'name')),
    link: coerceHexToString(extractString(document, 'uri')),
    contentHash,
    type: coerceHexToString(extractString(document, 'doc_type')),
    filedAt,
  };
};

export const getSecurityIdentifiers = (item: Codec): SecurityIdentifier[] => {
  const identifiers = JSON.parse(item.toString());
  return identifiers.map(i => {
    const type = Object.keys(i)[0];
    return {
      type,
      value: coerceHexToString(i[type]),
    };
  });
};

export const getAssetIdForLegacyTicker = async (ticker: Codec | string): Promise<string> => {
  const getHexTicker = (value: string) => {
    if (hexHasPrefix(value)) {
      return value;
    }
    return stringToHex(value.padEnd(12, '\0'));
  };

  const hexTicker = typeof ticker === 'string' ? getHexTicker(ticker) : ticker.toString();
  const assetComponents = [stringToHex('legacy_ticker'), hexTicker];

  const data = hexAddPrefix(assetComponents.map(e => hexStripPrefix(e)).join(''));

  const rawBytes = blake2AsU8a(data, 128);

  // Current staging chain already migrated the old ticker into asset IDs without the valid UUID logic
  if (chainId !== '0x3c3183f6d701500766ff7d147b79c4f10014a095eaaa98e960dcef6b3ead50ee') {
    // Version 8.
    rawBytes[6] = (rawBytes[6] & 0x0f) | 0x80;
    // Standard RFC4122 variant (bits 10xx)
    rawBytes[8] = (rawBytes[8] & 0x3f) | 0x80;
  }

  return u8aToHex(rawBytes);
};

/**
 * Whether a raw asset identifier is already a migrated 16-byte asset ID, rather than a legacy
 * ticker.
 *
 * The public chain switched `asset` events from carrying a 12-byte `Ticker` to a 16-byte
 * `PolymeshPrimitivesAssetAssetId` at v7.0.0. The spec-version gate below would be enough if the
 * block always reported its true runtime — but `@subql/node` has been seen serving the
 * *pre-upgrade* spec for a long run of blocks after v7.0.0 actually activated (testnet: ~169k
 * blocks reported as spec 6003050 instead of 7000003, block 15,978,579 onward). A byte-length
 * test is immune to that: a `Ticker` is `[u8; 12]`, so any `0x`-prefixed value that decodes to
 * 16 bytes is unambiguously a migrated asset ID whatever spec the block claims.
 */
export const isMigratedAssetId = (value: string | Codec): boolean => {
  const hex = typeof value === 'string' ? value : value.toString();

  return hexHasPrefix(hex) && hexStripPrefix(hex).length === 32;
};

export const getAssetId = async (
  assetId: string | Codec,
  block: SubstrateBlock
): Promise<string> => {
  if (isMigratedAssetId(assetId) || is7xChain(block)) {
    return typeof assetId === 'string' ? assetId : assetId.toString();
  }

  return getAssetIdForLegacyTicker(assetId);
};

export const getNftId = async (
  nft: Codec,
  block: SubstrateBlock
): Promise<{ assetId: string; ids: number[] }> => {
  const { ticker: rawTicker, assetId: rawAssetId, ids } = nft.toJSON() as any;

  return { assetId: await getAssetId(rawTicker ?? rawAssetId, block), ids };
};

export const getAssetIdWithTicker = async (
  assetIdOrTicker: Codec | string,
  block: SubstrateBlock
): Promise<AssetIdWithTicker> => {
  let assetId: string;
  let ticker: string;
  if (isMigratedAssetId(assetIdOrTicker) || is7xChain(block)) {
    assetId = typeof assetIdOrTicker === 'string' ? assetIdOrTicker : assetIdOrTicker.toString();

    const asset = await Asset.get(assetId);
    ticker = asset?.ticker;
  } else {
    ticker =
      typeof assetIdOrTicker === 'string'
        ? coerceHexToString(assetIdOrTicker)
        : serializeTicker(assetIdOrTicker);
    assetId = await getAssetIdForLegacyTicker(assetIdOrTicker);
  }

  return {
    assetId,
    ticker,
  };
};
