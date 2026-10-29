//Exports all handler functions
export * from './mappings/mappingHandlers';
export * from './mappings/entities';

// the runtime type registry, which `@polkadot/api` does not load on its own
import '@polkadot/types-augment';
// must precede augment-api: it supplies the '@polkadot/types/lookup' types augment-api imports
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
// Polymesh chain-type augmentation for `api.query`/`api.tx`/etc. This is a replacement for
// `@polkadot/api-augment` (the generic Substrate kitchensink runtime), not an addition to it:
// loading both would make import order silently decide which chain's types ~161 shared members
// resolve to.
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
