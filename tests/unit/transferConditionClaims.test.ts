/**
 * A claim condition's value as `TransferCompliance.claimValue` holds it: text, as its column is, though
 * the chain gives an accreditation or affiliation as a boolean and a jurisdiction as a country code.
 */
import { conditionId, getTransferConditions } from '../../src/mappings/entities/assets/mapStatistics';

const ASSET = '0x' + 'ab'.repeat(16);
const ISSUER = '0x' + '01'.repeat(32);
const conditions = (value: unknown) => ({ toString: () => JSON.stringify(value) } as never);

it('writes a claim condition its value as text', () => {
  const [accredited, jurisdiction, open] = getTransferConditions(
    conditions([
      { claimCount: [{ accredited: false }, ISSUER, 0, 10] },
      { claimOwnership: [{ jurisdiction: 'IE' }, ISSUER, 0, 500_000] },
      { claimCount: [{ jurisdiction: null }, ISSUER, 0, 10] },
    ]),
    ASSET
  );

  expect(accredited.claimValue).toBe('false');
  expect(jurisdiction.claimValue).toBe('IE');
  expect(open.claimValue).toBeUndefined();
});

it('names a condition on no jurisdiction with an empty value, as its other absent terms', () => {
  const [open] = getTransferConditions(
    conditions([{ claimCount: [{ jurisdiction: null }, ISSUER, 0, null] }]),
    ASSET
  );

  expect(conditionId(open)).toBe(`${ASSET}/Count/Jurisdiction/${ISSUER}//0/`);
});
