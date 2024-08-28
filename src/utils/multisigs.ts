import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Attributes } from '../mappings/entities/common';
import { MultiSigSigner, SignerTypeEnum } from '../types';
import { capitalizeFirstLetter, is7xChain } from './common';

export const getMultiSigSigners = (
  item: Codec,
  block: SubstrateBlock
): Pick<Attributes<MultiSigSigner>, 'signerType' | 'signerValue'>[] => {
  if (is7xChain(block)) {
    const signers = item.toJSON() as string[];

    return signers.map(signer => ({
      signerType: SignerTypeEnum.Account,
      signerValue: signer,
    }));
  }

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
  item: Codec,
  block: SubstrateBlock
): Pick<Attributes<MultiSigSigner>, 'signerType' | 'signerValue'> => {
  if (is7xChain(block)) {
    const signer = item.toString();

    return {
      signerType: SignerTypeEnum.Account,
      signerValue: signer,
    };
  }

  const signer = JSON.parse(item.toString());

  const signerType = Object.keys(signer)[0];
  const signerValue = signer[signerType];
  return {
    signerType: capitalizeFirstLetter(signerType) as SignerTypeEnum,
    signerValue,
  };
};
