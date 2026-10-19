/**
 * Mappings run in SubQuery's vm2 sandbox, where the host's `TextDecoder` rejects the sandbox's typed
 * arrays but accepts a `Buffer` (testnet block 90,237 failed on its first ticker; both dev-server
 * resyncs of 2026-10-19 at block 1, on a genesis lock id). `inSandbox` loads modules afresh, inside
 * the `describe` it is called from, with a `TextDecoder`, global and from `util`, that does the same.
 */
export const inSandbox = <T>(load: () => T): (() => T) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const util = require('node:util') as { TextDecoder: typeof TextDecoder };
  const realm = globalThis as unknown as { TextDecoder: typeof TextDecoder };
  const host = util.TextDecoder;
  let loaded: T;

  beforeAll(() => {
    class HostOnlyDecoder extends host {
      decode(input?: Parameters<TextDecoder['decode']>[0]): string {
        if (!Buffer.isBuffer(input)) {
          throw new TypeError('The "list" argument must be an instance of ArrayBufferView');
        }
        return super.decode(input);
      }
    }
    util.TextDecoder = HostOnlyDecoder;
    realm.TextDecoder = HostOnlyDecoder;
    jest.isolateModules(() => {
      loaded = load();
    });
  });

  afterAll(() => {
    util.TextDecoder = host;
    realm.TextDecoder = host;
  });

  return () => loaded;
};
