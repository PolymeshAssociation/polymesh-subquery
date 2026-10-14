// Applies a SQL script that the indexer node may be migrating the same tables under. The script
// goes to the server as one transaction, so when it and the node's own start-up migration take the
// same table locks in a different order, Postgres either aborts one of them as a deadlock victim
// or, with a `lock_timeout`, gives up waiting. Both leave the script rolled back and the database
// untouched, so running the whole script again is safe once the other side has finished.

const DEADLOCK_DETECTED = '40P01';
const LOCK_NOT_AVAILABLE = '55P03';

export interface ApplySqlOptions {
  /** how long one statement may wait for a lock before giving up, in milliseconds */
  lockTimeoutMs: number;
  /** attempts in total, the first included */
  attempts: number;
  /** wait before the second attempt, doubled for each one after */
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const defaults: ApplySqlOptions = {
  lockTimeoutMs: 15000,
  attempts: 6,
  backoffMs: 2000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log: message => console.log(message),
};

const sqlStateOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, driverError } = error as { code?: unknown; driverError?: { code?: unknown } };
  const state = typeof code === 'string' ? code : driverError?.code;
  return typeof state === 'string' ? state : undefined;
};

/** whether the error means the script lost a lock conflict, not that the script is wrong */
export const isLockConflict = (error: unknown): boolean => {
  const state = sqlStateOf(error);
  return state === DEADLOCK_DETECTED || state === LOCK_NOT_AVAILABLE;
};

/**
 * Runs `sql` through `query` as one multi-statement transaction with a lock timeout, and runs it
 * again with a growing wait when it loses a lock conflict. Any other error, and the last conflict
 * once the attempts are spent, is thrown.
 */
export const applySql = async (
  query: (sql: string) => Promise<unknown>,
  sql: string,
  overrides: Partial<ApplySqlOptions> = {}
): Promise<void> => {
  const { lockTimeoutMs, attempts, backoffMs, sleep, log } = { ...defaults, ...overrides };
  // SET LOCAL ends with the transaction, so the timeout does not stay on the pooled connection
  const script = `SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)};\n${sql}`;

  for (let attempt = 1; ; attempt++) {
    try {
      await query(script);
      return;
    } catch (error) {
      if (!isLockConflict(error) || attempt >= attempts) throw error;
      const wait = backoffMs * 2 ** (attempt - 1);
      log(
        `Lock conflict (${sqlStateOf(
          error
        )}) applying the SQL, attempt ${attempt} of ${attempts}; retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
};
