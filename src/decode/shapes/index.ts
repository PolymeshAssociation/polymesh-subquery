/**
 * Registered parameter shapes for tuple-style events.
 *
 * Polymesh's own pallets declare their events as tuples, so the block metadata carries types but
 * no field names at any spec version. Upstream Substrate pallets declare struct-style events and
 * are decoded from the metadata directly - see `namedFields`.
 *
 * Parameter names come from the Rust field names where
 * `docs/reference/event-shape-verification.md` records them. Where a parameter is not read by
 * any handler the name is descriptive rather than authoritative; the arity is the part the
 * metadata contract test enforces.
 *
 * Importing this module registers every shape, so it is imported for its side effects.
 */
import './asset';
import './balances';
import './capitalDistribution';
import './committees';
import './complianceManager';
import './corporateActions';
import './externalAgents';
import './identity';
import './multiSig';
import './nft';
import './pips';
import './portfolio';
import './protocolFee';
import './relayer';
import './settlement';
import './staking';
import './statistics';
import './treasury';

export * from './consts';
export * from './registry';
