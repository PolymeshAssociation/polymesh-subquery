import BN from 'bn.js';
import { SubstrateExtrinsic } from '@subql/types';
import { ModuleIdEnum, CallIdEnum } from './common';
import { Token } from '../../types';

const chainNumberMultiplier = new BN(1000000);

export async function mapToken(
  blockId: number,
  callId: CallIdEnum,
  moduleId: ModuleIdEnum,
  params: Record<string, any>,
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  if (!extrinsic.success || ![ModuleIdEnum.Asset].includes(moduleId)) {
    return;
  }

  if (callId === CallIdEnum.CreateAsset) {
    const {
      name,
      ticker,
      assetType: type,
      fundingRound,
      divisible,
      disableIu,
      identifiers,
    } = params;
    const ownerDid = extrinsic.events[1].event.data[0].toString();
    await Token.create({
      id: ticker,
      ticker,
      name,
      type,
      fundingRound,
      isDivisible: divisible,
      isFrozen: false,
      isUniquenessRequired: !disableIu,
      documents: [],
      identifiers: JSON.stringify(identifiers),
      ownerDid,
      fullAgents: [ownerDid],
      holders: [],
      totalSupply: '0',
    }).save();
  }

  if (callId === CallIdEnum.RenameAsset) {
    const { ticker, name: newName } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      name: newName,
    }).save();
  }

  if (callId === CallIdEnum.SetFundingRound) {
    const { ticker, name: newFundingRound } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      fundingRound: newFundingRound,
    }).save();
  }

  if (callId === CallIdEnum.AddDocuments) {
    const { ticker, docs } = params;
    const formattedDocs = docs.map((d: any) => ({
      name: d.name,
      link: d.uri,
    }));
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      documents: formattedDocs,
    }).save();
  }

  if (callId === CallIdEnum.UpdateIdentifiers) {
    const { ticker, identifiers } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      identifiers: JSON.stringify(identifiers),
    }).save();
  }

  if (callId === CallIdEnum.MakeDivisible) {
    const { ticker } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      isDivisible: true,
    }).save();
  }

  if (callId === CallIdEnum.Issue) {
    const { ticker, amount } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    const formattedAmount = new BN(amount).div(chainNumberMultiplier);
    const newTotalSupply = new BN(token.totalSupply).add(formattedAmount);
    const ownerAmount =
      new BN(token.holders.find((h) => h.did === token.ownerDid)?.amount) ||
      new BN(0);
    const ownerNewAmount = ownerAmount.add(formattedAmount);
    const otherHolders = token.holders.filter((h) => h.did !== token.ownerDid);
    await Token.create({
      ...token,
      holders: [
        ...otherHolders,
        { did: token.ownerDid, amount: ownerNewAmount.toString() },
      ],
      totalSupply: newTotalSupply.toString(),
    }).save();
  }

  if (callId === CallIdEnum.Redeem) {
    const { ticker, value: amount } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    const formattedAmount = new BN(amount).div(chainNumberMultiplier);
    const newTotalSupply = new BN(token.totalSupply).sub(formattedAmount);
    const ownerAmount =
      new BN(token.holders.find((h) => h.did === token.ownerDid)?.amount) ||
      new BN(0);
    const ownerNewAmount = ownerAmount.sub(formattedAmount);
    const otherHolders = token.holders.filter((h) => h.did !== token.ownerDid);
    await Token.create({
      ...token,
      holders: [
        ...otherHolders,
        ...(ownerNewAmount.gt(new BN(0))
          ? [{ did: token.ownerDid, amount: ownerNewAmount.toString() }]
          : []),
      ],
      totalSupply: newTotalSupply.toString(),
    }).save();
  }

  if (callId === CallIdEnum.Freeze) {
    const { ticker } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      isFrozen: true,
    }).save();
  }

  if (callId === CallIdEnum.Unfreeze) {
    const { ticker } = params;
    const token = await Token.getByTicker(ticker);
    if (!token) return;
    await Token.create({
      ...token,
      isFrozen: false,
    }).save();
  }
}
