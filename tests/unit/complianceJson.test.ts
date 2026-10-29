/**
 * A compliance requirement is stored as its JSON, which polkadot-js renders after the metadata that
 * decoded it: field names snake_case before metadata v14, and a claim type as its bare name until
 * 5.4 gave `ClaimType` a variant with data (`Custom`), as `{ variant: null }` after. The bytes are
 * the same either way, so every requirement is stored in the current form.
 */
import { getComplianceValue, getComplianceValues } from '../../src/utils/compliance';

const codecOf = (value: unknown) => ({ toString: () => JSON.stringify(value) } as any);

const ISSUER = '0xfd38c10a0ed8c81212698d02afcb0abfc9c9a80b57619682e9feb6706f71daa5';
const SCOPE = { ticker: '0x4d5449434b45523033000000' };

/** The current form */
const current = {
  senderConditions: [],
  receiverConditions: [
    {
      conditionType: { isPresent: { knowYourCustomer: SCOPE } },
      issuers: [
        { issuer: ISSUER, trustedFor: { specific: [{ knowYourCustomer: null }, { custom: 3 }] } },
      ],
    },
  ],
};

describe('getComplianceValue', () => {
  it('stores a requirement decoded with metadata before v14 in the current form', () => {
    const { complianceId, data } = getComplianceValue(
      codecOf({
        id: 1,
        sender_conditions: [],
        receiver_conditions: [
          {
            condition_type: { isPresent: { knowYourCustomer: SCOPE } },
            issuers: [
              { issuer: ISSUER, trusted_for: { specific: ['KnowYourCustomer', { custom: 3 }] } },
            ],
          },
        ],
      })
    );

    expect(complianceId).toBe(1);
    expect(JSON.parse(data)).toEqual(current);
  });

  it('leaves a requirement already in the current form, and trust in any claim, as they are', () => {
    const { data } = getComplianceValue(codecOf({ id: 2, ...current }));
    expect(JSON.parse(data)).toEqual(current);

    const any = { issuer: ISSUER, trustedFor: { any: null } };
    const [{ data: anyData }] = getComplianceValues(
      codecOf([{ id: 3, senderConditions: [], receiverConditions: [], issuers: [any] }])
    );
    expect(JSON.parse(anyData).issuers).toEqual([any]);
  });
});
