import { VM } from 'vm2';

/**
 * Mappings run in SubQuery's vm2 sandbox, where the host's `TextDecoder` rejects the sandbox's typed
 * arrays but accepts a `Buffer`. `inSandbox` loads modules afresh, inside the `describe` it is
 * called from, with a `TextDecoder`, global and from `util`, that does the same.
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

/**
 * A `Date` as the mappings see one the store returns: an object from the other side of vm2's
 * bridge. `new Date()` of it reads its `toString()`, which has no milliseconds; `getTime()` keeps
 * them.
 */
export const sandboxDate = (ms: number): Date => new VM().run(`new Date(${ms})`) as Date;
