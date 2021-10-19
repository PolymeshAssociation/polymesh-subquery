import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
import { ClaimScopeTypeEnum } from "./../../src/mappings/entities/mapClaim";
const { query } = getApolloClient();

describe("identityWithClaims", () => {
  test("should return no registries as given identity has no claims", async () => {
    const identityId =
      "0x9900000000000000000000000000000000000000000000000000000000000000";
    const res = await query({
      query: gql`
        query{
          identityWithClaims(filter: {
              did: {
                in: ["${identityId}"]
              }}) {
            totalCount
          }
        }
      `,
    });

    return expect(res?.data?.identityWithClaims?.totalCount).toEqual(0);
  });

  test("should return just total count", async () => {
    const res = await query({
      query: gql`
        query {
          identityWithClaims {
            totalCount
          }
        }
      `,
    });

    expect(res?.data).toMatchSnapshot();
  });

  test("should return all identities with their claims as there are no filters", async () => {
    const q = {
      query: gql`
        query {
          identityWithClaims(first: 10) {
            totalCount
            nodes {
              did
              claims
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });

  test("should return identities and claims filtered", async () => {
    const scopeType = ClaimScopeTypeEnum.Ticker;
    const scopeValue = "5TICKER";
    const trustedClaimIssuer =
      "0x70da84f285540a6174594f6fd69c7facf092cd29210f1b93ee3f4915c4c8f86c";
    const q = {
      variables: { scopeValue },
      query: gql`
        query q($scopeValue: String!){
          identityWithClaims(filter: {
            claims: {
              contains: [{
                scope: {type: ${scopeType}, value: $scopeValue},
                issuer: "${trustedClaimIssuer}"
              }]
            }
          }) {
            totalCount
            nodes {
              did
              claims
            }
          }
        }
      `,
    };
    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data?.identityWithClaims).toMatchSnapshot();
  });
});

describe("issuerIdentityWithClaims", () => {
  test("should return no registries as given identity has no claims", async () => {
    const target =
      "0x9900000000000000000000000000000000000000000000000000000000000000";
    const res = await query({
      query: gql`
        query {
          issuerIdentityWithClaims(filter: {
            did: {
              equalTo: "${target}"
            }
          }) {
            nodes {
              did
            }
          }
        }
      `,
    });

    return expect(res?.data?.issuerIdentityWithClaims.nodes.length).toEqual(0);
  });

  test("should return just total count", async () => {
    const target =
      "0x69650eb2544ed57930cc0bedacdfceeee3b5905470e56edb0eb96271e0e9fef3";
    const res = await query({
      query: gql`
      query {
        issuerIdentityWithClaims(filter: {
          did: {
            equalTo: "${target}"
          }
        }) {
          totalCount
        }
      }
      `,
    });

    expect(res?.data?.issuerIdentityWithClaims.totalCount).toEqual(0);
  });

  test("should return all issuers with their claims for given did", async () => {
    const target =
      "0x69650eb2544ed57930cc0bedacdfceeee3b5905470e56edb0eb96271e0e9fef3";
    const q = {
      query: gql`
        query {
          issuerIdentityWithClaims(filter: {
            did: {
              equalTo: "${target}"
            }
          }) {
            totalCount
            nodes {
              did
              claims
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });

  test("should return identities and claims filtered", async () => {
    const target =
      "0x69650eb2544ed57930cc0bedacdfceeee3b5905470e56edb0eb96271e0e9fef3";
    const scopeType = ClaimScopeTypeEnum.Identity;
    const scopeValue =
      "0x56a91c10f2368b30670b7bea260928f0291387abfb75b5953cd722917423bf01";
    const trustedClaimIssuer =
      "0x70da84f285540a6174594f6fd69c7facf092cd29210f1b93ee3f4915c4c8f86c";
    const q = {
      query: gql`
        query {
          issuerIdentityWithClaims(filter: {
            did: {
              in: ["${trustedClaimIssuer}"]
            },
            claims: {
              contains: [{
                scope: {
                  type: ${scopeType}, 
                  value: "${scopeValue}"
                },
                targetDid: "${target}"
              }]
            }
          }) {
            totalCount
            nodes {
              did
              claims 
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });
});

describe("claimScopes", () => {
  test("should return an empty list as given identity has no claims", async () => {
    const identityId =
      "0x0200000000000000000000000000000000000000000000000000000000000001";
    const res = await query({
      query: gql`
        query {
          claimScopes(
            filter: {
              targetDid: {
                equalTo: "${identityId}"
              }
            }
          ) {
            nodes {
              scope
              ticker
            }
          }
        }
      `,
    });

    return expect(res?.data?.claimScopes?.nodes?.length).toEqual(0);
  });

  test("should return a list of scopes for given identity", async () => {
    const identityId =
      "0x69650eb2544ed57930cc0bedacdfceeee3b5905470e56edb0eb96271e0e9fef3";
    const q = {
      query: gql`
      query {
        claimScopes(
          filter: {
            targetDid: {
              equalTo: "${identityId}"
            }
          }
        ) {
          nodes {
            scope
            ticker
          }
        }
      }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });
});
