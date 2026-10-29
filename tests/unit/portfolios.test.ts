import { accountHolder, getHoldingId, portfolioHolder } from '../../src/utils/portfolios';

const ASSET = '0xasset000000000000000000000000000';
const DID = '0x0a'.padEnd(66, '0');
const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('getHoldingId', () => {
  it('names a portfolio holding by asset, DID and portfolio number', () => {
    expect(getHoldingId(ASSET, portfolioHolder(DID, 2))).toBe(`${ASSET}/${DID}/2`);
  });

  it('names an account holding by asset and address, with or without an identity', () => {
    expect(getHoldingId(ASSET, accountHolder(DID, ADDRESS))).toBe(`${ASSET}/${ADDRESS}`);
    expect(getHoldingId(ASSET, accountHolder(undefined, ADDRESS))).toBe(`${ASSET}/${ADDRESS}`);
  });
});
