import { compactFromU8a, u8aToU8a } from '@polkadot/util';
import { codecBytes } from '../../src/utils/bytes';
import { hostBytes } from './helpers';

describe('codecBytes', () => {
  const host = hostBytes(new Uint8Array([0x08, 1, 2]));

  it('copies the host bytes into a Uint8Array @polkadot/util recognises', () => {
    // the failure it guards against: the host's bytes, read as their text "8,1,2"
    expect(u8aToU8a(host)).not.toEqual(new Uint8Array([0x08, 1, 2]));

    const bytes = codecBytes({ toU8a: () => host });

    expect(u8aToU8a(bytes)).toEqual(new Uint8Array([0x08, 1, 2]));
    expect(compactFromU8a(bytes)[1].toNumber()).toBe(2);
  });

  it('reads the bare encoding', () => {
    const toU8a = jest.fn().mockReturnValue(host);

    codecBytes({ toU8a });

    expect(toU8a).toHaveBeenCalledWith(true);
  });
});
