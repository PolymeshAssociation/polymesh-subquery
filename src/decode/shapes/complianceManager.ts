import { registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `complianceManager` pallet parameter shapes. None has changed arity; the asset was a
 * `Ticker` before 7.0.0, named `ticker` until then (`tickerBeforeV7`).
 */
registerShape(
  'complianceManager',
  'AssetCompliancePaused',
  tickerBeforeV7(stable(['callerDid', 'assetId']))
);
registerShape(
  'complianceManager',
  'AssetComplianceReplaced',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'requirements']))
);
registerShape(
  'complianceManager',
  'AssetComplianceReset',
  tickerBeforeV7(stable(['callerDid', 'assetId']))
);
registerShape(
  'complianceManager',
  'AssetComplianceResumed',
  tickerBeforeV7(stable(['callerDid', 'assetId']))
);
registerShape(
  'complianceManager',
  'ComplianceRequirementChanged',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'requirement']))
);
registerShape(
  'complianceManager',
  'ComplianceRequirementCreated',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'requirement']))
);
registerShape(
  'complianceManager',
  'ComplianceRequirementRemoved',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'requirementId']))
);
registerShape(
  'complianceManager',
  'TrustedDefaultClaimIssuerAdded',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'issuer']))
);
registerShape(
  'complianceManager',
  'TrustedDefaultClaimIssuerRemoved',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'issuerDid']))
);
