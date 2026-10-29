import { stringToHex } from '@polkadot/util';
import { SubstrateBlock } from '@subql/types';
import { AffirmStatusEnum, AnomalyKind, LegTypeEnum } from '../../../types/enums';
import { InstructionAffirmation } from '../../../types/models/InstructionAffirmation';
import { readOrAnomaly, recordAnomaly } from '../../../utils/anomaly';
import { LegDetails, portfolioNumber } from '../../../utils/settlements';
import { parentStateReadable, storageAtParent } from '../../../utils/storageAtParent';
import { applyHolderAffirmation } from './holderAffirmations';

/**
 * Runtimes 6.0.0 and 6.0.1 (spec 6_000_000 to 6_000_999) affirm a pre-approved receiver when the
 * instruction is created and emit no event for it; `InstructionAutomaticallyAffirmed` arrived in
 * 6.1.0. Public chains only: the private chain's versions are numbered differently.
 */
export const preApprovesSilently = (specName: string, specVersion: number): boolean =>
  specName !== 'polymesh_private_dev' && specVersion >= 6_000_000 && specVersion < 6_001_000;

const portfolioKey = (portfolioId: string) => {
  const number = portfolioNumber(portfolioId);
  return {
    did: portfolioId.split('/')[0],
    kind: number === 0 ? 'Default' : { User: number },
  };
};

const tickerKey = (ticker: string): string => stringToHex(ticker.padEnd(12, '\0'));

const isTrue = async (
  block: SubstrateBlock,
  section: string,
  item: string,
  ...keys: unknown[]
): Promise<boolean> => (await storageAtParent(block, section, item, ...keys))?.toJSON() === true;

/** The runtime's `skip_portfolio_affirmation` for a receiving portfolio and a ticker. */
const skipsAffirmation = async (
  block: SubstrateBlock,
  portfolioId: string,
  ticker: string
): Promise<boolean> => {
  const portfolio = portfolioKey(portfolioId);
  const asset = tickerKey(ticker);

  if (await isTrue(block, 'asset', 'tickersExemptFromAffirmation', asset)) {
    return true;
  }
  // an identity's ticker pre-approval doesn't cover a portfolio someone else holds custody of
  const custodian = await storageAtParent(block, 'portfolio', 'portfolioCustodian', portfolio);
  const custodied = custodian !== undefined && custodian.toJSON() !== null;
  if (!custodied && (await isTrue(block, 'asset', 'preApprovedTicker', portfolio.did, asset))) {
    return true;
  }
  return isTrue(block, 'portfolio', 'preApprovedPortfolios', portfolio, asset);
};

/**
 * The receivers the runtime affirmed at creation: those every leg they receive on skips
 * affirmation for, and that send on none.
 */
const preApprovedReceivers = async (
  block: SubstrateBlock,
  legs: LegDetails[]
): Promise<Set<string>> => {
  const onChain = legs.filter(
    leg => leg.legType !== LegTypeEnum.OffChain && leg.fromPortfolioId && leg.toPortfolioId
  );
  const skips = await Promise.all(
    onChain.map(leg => skipsAffirmation(block, leg.toPortfolioId as string, leg.ticker as string))
  );
  const pending = new Set<string>();
  const preApproved = new Set<string>();

  onChain.forEach((leg, i) => {
    pending.add(leg.fromPortfolioId as string);
    (skips[i] ? preApproved : pending).add(leg.toPortfolioId as string);
  });

  return new Set([...preApproved].filter(portfolioId => !pending.has(portfolioId)));
};

interface Creation {
  block: SubstrateBlock;
  eventIdx: number;
  instructionId: string;
  legs: LegDetails[];
  creatorDid: string;
  signerId: string | undefined;
  blockEventId: string;
}

/**
 * Affirms, among an instruction's new approval rows, the receivers v6.0.x affirmed silently. When
 * the state the runtime decided on can't be read, an anomaly is recorded and the rows stay pending.
 */
export const applySilentPreApprovals = async (
  rows: InstructionAffirmation[],
  { block, eventIdx, instructionId, legs, creatorDid, signerId, blockEventId }: Creation
): Promise<void> => {
  const consequence = `instruction ${instructionId}'s pre-approved receivers are left pending`;

  if (!(await parentStateReadable(block))) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `the state before block ${block.block.header.number.toString()} could not be read, so ${consequence}`,
      block,
      eventIdx,
    });
    return;
  }

  const preApproved = await readOrAnomaly({ block, eventIdx }, consequence, () =>
    preApprovedReceivers(block, legs)
  );

  rows
    .filter(row => row.portfolioId && preApproved?.has(row.portfolioId))
    .forEach(row =>
      applyHolderAffirmation(row, {
        status: AffirmStatusEnum.Affirmed,
        isAutomaticallyAffirmed: true,
        affirmedById: creatorDid,
        signerId,
        blockEventId,
      })
    );
};
