/**
 * What the chain surveys share: JSON-RPC to an archive node, the runtimes a chain has run, and each
 * runtime's metadata, cached on disk.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CACHE = join(tmpdir(), 'polymesh-event-history');

export interface Runtime {
  specVersion: number;
  firstBlock: number;
}

/** Requests in flight per endpoint: an archive node is often serving an indexer too */
const CONCURRENCY = 6;
const inFlight = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

const acquire = async (url: string): Promise<void> => {
  if ((inFlight.get(url) ?? 0) >= CONCURRENCY) {
    await new Promise<void>(resolve => waiting.set(url, [...(waiting.get(url) ?? []), resolve]));
  }
  inFlight.set(url, (inFlight.get(url) ?? 0) + 1);
};

const release = (url: string): void => {
  inFlight.set(url, (inFlight.get(url) ?? 1) - 1);
  waiting.get(url)?.shift()?.();
};

let nextId = 1;
export const rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
  await acquire(url);
  try {
    return await call<T>(url, method, params);
  } finally {
    release(url);
  }
};

/** One request, retried with backoff up to six times */
const call = async <T>(url: string, method: string, params: unknown[], attempt = 0): Promise<T> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextId++, jsonrpc: '2.0', method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) {
      throw new Error(`${method}: ${body.error.message}`);
    }
    return body.result as T;
  } catch (error) {
    if (attempt >= 6) {
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    return call<T>(url, method, params, attempt + 1);
  }
};

const hashAt = (url: string, block: number) => rpc<string>(url, 'chain_getBlockHash', [block]);

const specAt = async (url: string, block: number): Promise<number> =>
  (await rpc<{ specVersion: number }>(url, 'state_getRuntimeVersion', [await hashAt(url, block)]))
    .specVersion;

/** Every block where the spec version changes, by bisecting each span whose ends disagree */
export const runtimesOf = async (url: string, head: number): Promise<Runtime[]> => {
  const specs = new Map<number, number>();
  const spec = async (block: number) => {
    if (!specs.has(block)) {
      specs.set(block, await specAt(url, block));
    }
    return specs.get(block) as number;
  };
  const changes: Runtime[] = [{ specVersion: await spec(0), firstBlock: 0 }];
  const bisect = async (lo: number, hi: number): Promise<void> => {
    if ((await spec(lo)) === (await spec(hi))) {
      return;
    }
    if (hi - lo === 1) {
      changes.push({ specVersion: await spec(hi), firstBlock: hi });
      return;
    }
    const mid = Math.floor((lo + hi) / 2);
    await Promise.all([bisect(lo, mid), bisect(mid, hi)]);
  };

  // Spec versions only increase, so a span whose ends agree ran one runtime; sampling first lets
  // the spans bisect in parallel
  const step = 100_000;
  const samples: number[] = [];
  for (let block = 0; block < head; block += step) {
    samples.push(block);
  }
  samples.push(head);
  // `rpc` holds each endpoint to CONCURRENCY requests at a time
  await Promise.all(samples.map(spec));
  await Promise.all(samples.slice(1).map((block, i) => bisect(samples[i], block)));

  return changes.sort((a, b) => a.firstBlock - b.firstBlock);
};

export const metadataAt = async (chain: string, url: string, runtime: Runtime): Promise<string> => {
  const path = join(CACHE, `${chain}-${runtime.specVersion}.hex`);
  if (existsSync(path)) {
    return readFileSync(path, 'utf8');
  }
  const hex = await rpc<string>(url, 'state_getMetadata', [await hashAt(url, runtime.firstBlock)]);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, hex);
  return hex;
};

/** The chain's best block number */
export const headOf = async (url: string): Promise<number> =>
  Number.parseInt((await rpc<{ number: string }>(url, 'chain_getHeader', [])).number, 16);

/** `<chain>=<rpc>` arguments, as both surveys take them */
export const chainArgs = (args: string[]): [string, string][] =>
  args
    .map(arg => arg.split(/=([\s\S]*)/))
    .filter(([name, url]) => name && url)
    .map(([name, url]) => [name, url]);

/** The pallets the seed reads, which the storage survey and the genesis recording cover */
export const SURVEYED_SECTIONS = [
  'asset',
  'balances',
  'capitalDistribution',
  'checkpoint',
  'complianceManager',
  'confidentialAsset',
  'confidentialAssets',
  'corporateAction',
  'corporateBallot',
  'externalAgents',
  'identity',
  'multiSig',
  'nft',
  'pips',
  'portfolio',
  'relayer',
  'revive',
  'session',
  'settlement',
  'staking',
  'statistics',
  'sto',
  'system',
  'validators',
];
