import { Codec } from '@polkadot/types/types';
import { Proposer } from '../types';
import { getAccountKey } from './accounts';
import { capitalizeFirstLetter } from './common';

export const getProposerValue = (item: Codec): Proposer => {
  const proposer = JSON.parse(item.toString());
  let type, value;
  if ('committee' in proposer) {
    type = 'Committee';
    value = capitalizeFirstLetter(Object.keys(proposer.committee)[0]);
  }
  if ('community' in proposer) {
    type = 'Community';
    value = getAccountKey(proposer.community, item.registry.chainSS58);
  }
  return {
    type,
    value,
  };
};
