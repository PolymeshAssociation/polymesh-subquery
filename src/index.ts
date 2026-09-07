//Exports all handler functions
export * from './mappings/mappingHandlers';
export * from './mappings/entities';

// runtime type registry; `@polkadot/api-augment` used to pull this in, and `@polkadot/api`
// does not load it on its own
import '@polkadot/types-augment';
// must precede augment-api: it supplies the '@polkadot/types/lookup' types augment-api imports
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
// Polymesh chain-type augmentation for `api.query`/`api.tx`/etc. This is a replacement for
// `@polkadot/api-augment` (the generic Substrate kitchensink runtime), not an addition to it:
// loading both would make import order silently decide which chain's types ~161 shared members
// resolve to. See docs/implementation/12-types-and-ci.md §12.2.
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
