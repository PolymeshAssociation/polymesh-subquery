import { Seeder } from '../seeder';
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
] as Seeder[];
