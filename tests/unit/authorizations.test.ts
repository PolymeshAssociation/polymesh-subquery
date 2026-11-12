import { AuthTypeEnum } from '../../src/types';
import { authTypeOf, isPayingKeyOffer } from '../../src/utils/authorizations';
import { nftRowId, removeIfIncludes } from '../../src/utils/common';

describe('authTypeOf', () => {
  it('stores the deprecated paying-key variant under the name the enum has', () => {
    expect(authTypeOf('oldAddRelayerPayingKey')).toBe(AuthTypeEnum.AddRelayerPayingKey);
  });

  it('capitalises every other variant', () => {
    expect(authTypeOf('joinIdentity')).toBe(AuthTypeEnum.JoinIdentity);
  });
});

describe('isPayingKeyOffer', () => {
  it.each(['addRelayerPayingKey', 'oldAddRelayerPayingKey', 'AddRelayerPayingKey'])('%s', name => {
    expect(isPayingKeyOffer(name)).toBe(true);
  });

  it('is false for another variant', () => {
    expect(isPayingKeyOffer('joinIdentity')).toBe(false);
  });
});

describe('removeIfIncludes', () => {
  it('removes only the match', () => {
    const signers = ['A', 'B', 'C'];
    removeIfIncludes(signers, 'A');
    expect(signers).toEqual(['B', 'C']);
  });
});

describe('nftRowId', () => {
  it('is the same for a number and its string', () => {
    expect(nftRowId('asset', 7)).toBe(nftRowId('asset', '7'));
  });
});
