/**
 * Ambient declaration for the SubQuery injected `logger` global that this script's imports rely
 * on.
 *
 * `tsconfig.json` only maps SubQuery's globals onto `src/**`, so code running through ts-node
 * declares what it uses itself. At runtime the value only exists inside the SubQuery node; the
 * backfill shims it before importing any module that touches it
 */
declare global {
  const logger: {
    debug: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

export {};
