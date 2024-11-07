import { Codec } from '@polkadot/types/types';
import { hexAddPrefix, hexHasPrefix, hexStripPrefix, stringToHex, u8aToHex } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';
import { SubstrateBlock } from '@subql/types';
import { Asset, AssetDocument, Block, SecurityIdentifier } from '../types';
import {
  coerceHexToString,
  extractString,
  extractValue,
  getTextValue,
  hexToString,
  is7xChain,
  serializeTicker,
} from './common';

export interface AssetIdWithTicker {
  assetId: string;
  ticker: string;
}

export const getCustomType = async (rawCustomId: Codec): Promise<string> => {
  const customType = await api.query.asset.customTypes(rawCustomId);
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

let genesisHash: string;
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

  if (!genesisHash) {
    ({ hash: genesisHash } = await Block.get('0'));
  }

  // Current staging chain already migrated the old ticker into asset IDs without the valid UUID logic
  if (genesisHash !== '0x3c3183f6d701500766ff7d147b79c4f10014a095eaaa98e960dcef6b3ead50ee') {
    // Version 8.
    rawBytes[6] = (rawBytes[6] & 0x0f) | 0x80;
    // Standard RFC4122 variant (bits 10xx)
    rawBytes[8] = (rawBytes[8] & 0x3f) | 0x80;
  }

  return u8aToHex(rawBytes);
};

export const getAssetId = async (
  assetId: string | Codec,
  block: SubstrateBlock
): Promise<string> => {
  if (is7xChain(block)) {
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
  if (is7xChain(block)) {
    assetId = typeof assetIdOrTicker === 'string' ? assetIdOrTicker : assetIdOrTicker.toString();

    const asset = await Asset.get(assetId);
    ticker = asset?.ticker ?? assetId;
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
