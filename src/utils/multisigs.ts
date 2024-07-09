import { Codec } from '@polkadot/types/types';
import { Attributes } from '../mappings/entities/common';
import { MultiSigSigner, SignerTypeEnum } from '../types';
import { capitalizeFirstLetter } from './common';

export const getMultiSigSigners = (
  item: Codec
): Pick<Attributes<MultiSigSigner>, 'signerType' | 'signerValue'>[] => {
  const signers = JSON.parse(item.toString());

  return signers.map(signer => {
    const signerType = Object.keys(signer)[0];
    const signerValue = signer[signerType];
    return {
      signerType: capitalizeFirstLetter(signerType) as SignerTypeEnum,
      signerValue,
    };
  });
};

export const getMultiSigSigner = (
  item: Codec
): Pick<Attributes<MultiSigSigner>, 'signerType' | 'signerValue'> => {
  const signer = JSON.parse(item.toString());

  const signerType = Object.keys(signer)[0];
  const signerValue = signer[signerType];
  return {
    signerType: capitalizeFirstLetter(signerType) as SignerTypeEnum,
    signerValue,
  };
};
