import { AuthTypeEnum } from '../types';
import { capitalizeFirstLetter } from './common';

/**
 * An `AuthorizationData` variant's name as the index stores it. From 8.0 the paying-key variant is
 * called `OldAddRelayerPayingKey`, which the enum doesn't have: it is the same authorization.
 */
export const authTypeOf = (variant: string): AuthTypeEnum => {
  const type = capitalizeFirstLetter(variant);
  return (
    type === 'OldAddRelayerPayingKey' ? AuthTypeEnum.AddRelayerPayingKey : type
  ) as AuthTypeEnum;
};

/** Whether an `AuthorizationData` variant is a paying-key authorization, under either name */
export const isPayingKeyOffer = (variant: string): boolean =>
  authTypeOf(variant) === AuthTypeEnum.AddRelayerPayingKey;
