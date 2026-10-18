import { encodeValue } from '../../mappings/args/encode';
import { claimRow, storedClaim } from '../../mappings/entities/identities/mapClaim';
import {
  Authorization,
  AuthorizationStatusEnum,
  AuthTypeEnum,
  Claim,
  CustomClaimType,
} from '../../types';
import { memberOf } from '../../utils/codec';
import {
  bytesToString,
  capitalizeFirstLetter,
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getTextValue,
  padNumericId,
} from '../../utils/common';
import { pageRows, Seeder } from '../seeder';
import { assetWithTicker } from './assetKeys';

export const customClaimTypeSeeder: Seeder<CustomClaimType> = {
  entity: 'CustomClaimType',
  reads: ['identity.customClaims'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('identity.customClaims')) {
      yield page.flatMap(({ args, value }) =>
        value
          ? [
              CustomClaimType.create({
                id: args[0].toString(),
                name: bytesToString(value),
                createdEventId: ctx.eventId,
                updatedEventId: ctx.eventId,
              }),
            ]
          : []
      );
    }
  },
};

/**
 * Every claim `identity.claims` holds, built as the claim handlers build it, its asset scope
 * naming the asset's ticker; nothing of a claim type the 6.0 upgrade retired. The genesis config's
 * CDD claims are in its plain 3.x form.
 */
export const claimSeeder: Seeder<Claim> = {
  entity: 'Claim',
  reads: ['identity.claims', 'asset.assetIdTicker'],
  oldShapes: { 'identity.claims': [3000] },
  terminal: ({ revokeDate }) => revokeDate !== undefined && revokeDate !== null,
  async *rows(snap, ctx) {
    const tickers = await snap.map('asset.assetIdTicker');
    // a scope names a ticker before 7.0, and an asset id from it
    const assetOf = assetWithTicker(tickers, ctx.block);
    for await (const page of snap.pages('identity.claims')) {
      yield await pageRows(page, async ({ args, value }) => {
        const stored = value && storedClaim(value);
        if (!stored) {
          return [];
        }
        const { target } = args[0].toJSON() as { target: string };
        const row = await claimRow(
          target,
          encodeValue(stored, 'IdentityClaim'),
          ctx.eventId,
          assetOf
        );
        return row ? [row] : [];
      });
    }
  },
};

/** Authorization types a runtime renamed, by their new name: 8.0 kept the old paying keys as `Old…` */
const RENAMED: Record<string, AuthTypeEnum> = {
  OldAddRelayerPayingKey: AuthTypeEnum.AddRelayerPayingKey,
};

/** An authorization's signatory as `identity.authorizations` keys it */
type Signatory = { identity: string } | { account: string };

/**
 * A pending authorization, by its zero-padded id. The chain removes one once it is consumed,
 * rejected or revoked, so only pending ones are held.
 */
export const authorizationSeeder: Seeder<Authorization> = {
  entity: 'Authorization',
  reads: ['identity.authorizations'],
  accounts: ['toAccountId'],
  terminal: ({ status }) => status !== AuthorizationStatusEnum.Pending,
  async *rows(snap, ctx) {
    for await (const page of snap.pages('identity.authorizations')) {
      yield page.flatMap(({ args, value }) => {
        if (!value) {
          return [];
        }
        const signatory = args[0].toJSON() as Signatory;
        const data = memberOf(value, 'authorizationData');
        return [
          Authorization.create({
            id: padNumericId(args[1].toString()),
            fromId: getTextValue(memberOf(value, 'authorizedBy')),
            toId: 'identity' in signatory ? signatory.identity : undefined,
            toAccountId: 'account' in signatory ? signatory.account : undefined,
            type: ((type: string) => RENAMED[type] ?? (type as AuthTypeEnum))(
              capitalizeFirstLetter(getFirstKeyFromJson(data))
            ),
            data: JSON.stringify(getFirstValueFromJson(data)),
            expiry: getDateValue(memberOf(value, 'expiry')),
            status: AuthorizationStatusEnum.Pending,
            createdEventId: ctx.eventId,
            updatedEventId: ctx.eventId,
          }),
        ];
      });
    }
  },
};
