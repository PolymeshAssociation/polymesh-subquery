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
import { evmAccountMappingSeeder } from './evm';
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
] as Seeder[];
