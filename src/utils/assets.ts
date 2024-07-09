import { Codec } from '@polkadot/types/types';
import { AssetDocument, SecurityIdentifier } from '../types';
import {
  coerceHexToString,
  extractString,
  extractValue,
  getTextValue,
  hexToString,
} from './common';

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

export const getNftId = (nft: Codec): { ticker: string; ids: number[] } => {
  const { ticker: hexTicker, ids } = nft.toJSON() as any;

  const ticker = hexToString(hexTicker);

  return { ticker, ids };
};
