import { Seeder } from '../seeder';
import {
  agentGroupMembershipSeeder,
  agentGroupSeeder,
  assetAgentSeeder,
  assetDocumentSeeder,
  assetMandatoryMediatorSeeder,
  assetMetadataSeeder,
  assetPreApprovalSeeder,
  assetSeeder,
  checkpointScheduleSeeder,
  checkpointSeeder,
  customAssetTypeSeeder,
  globalMetadataKeySeeder,
  tickerReservationSeeder,
} from './assets';
import { accountBalanceSeeder } from './balances';
import { authorizationSeeder, claimSeeder, customClaimTypeSeeder } from './claims';
import {
  complianceSeeder,
  statTypeSeeder,
  transferComplianceExemptionSeeder,
  transferComplianceSeeder,
  trustedClaimIssuerSeeder,
} from './compliance';
import { evmAccountMappingSeeder } from './evm';
import {
  assetAllowanceSeeder,
  assetHolderSeeder,
  holdingSeeder,
  nftApprovalSeeder,
  nftOperatorApprovalSeeder,
  nftSeeder,
} from './holdings';
import {
  instructionAffirmationSeeder,
  instructionPartySeeder,
  instructionSeeder,
  legSeeder,
  venueSeeder,
} from './settlement';
import { accountSeeder, identityKeySeeder, identitySeeder, portfolioSeeder } from './identities';

/**
 * Every seeder, which a start block's seed runs in this order. The order is only for the log: no
 * seeder reads another's rows, and the index has no foreign keys to satisfy.
 */
export const SEEDERS: Seeder[] = [
  identitySeeder,
  accountSeeder,
  identityKeySeeder,
  portfolioSeeder,
  accountBalanceSeeder,
  evmAccountMappingSeeder,
  customAssetTypeSeeder,
  assetSeeder,
  tickerReservationSeeder,
  assetDocumentSeeder,
  globalMetadataKeySeeder,
  assetMetadataSeeder,
  agentGroupSeeder,
  assetAgentSeeder,
  agentGroupMembershipSeeder,
  checkpointSeeder,
  checkpointScheduleSeeder,
  assetMandatoryMediatorSeeder,
  assetPreApprovalSeeder,
  customClaimTypeSeeder,
  claimSeeder,
  authorizationSeeder,
  statTypeSeeder,
  transferComplianceSeeder,
  transferComplianceExemptionSeeder,
  complianceSeeder,
  trustedClaimIssuerSeeder,
  holdingSeeder,
  assetHolderSeeder,
  nftSeeder,
  assetAllowanceSeeder,
  nftApprovalSeeder,
  nftOperatorApprovalSeeder,
  venueSeeder,
  instructionSeeder,
  legSeeder,
  instructionPartySeeder,
  instructionAffirmationSeeder,
] as Seeder[];
