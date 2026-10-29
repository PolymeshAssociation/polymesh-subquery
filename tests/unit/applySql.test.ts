import { applySql, isLockConflict } from '../../db/applySql';

const conflict = (code: string) => Object.assign(new Error('conflict'), { code });

describe('applySql', () => {
  const sleep = jest.fn(async () => undefined);
  const log = jest.fn();
  const options = { attempts: 4, backoffMs: 10, sleep, log };

  it('sends the script once, under a transaction-scoped lock timeout', async () => {
    const query = jest.fn(async () => undefined);

    await applySql(query, 'SELECT 1;', { ...options, lockTimeoutMs: 5000 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SET LOCAL lock_timeout = 5000;\nSELECT 1;');
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['40P01', '55P03'])('runs the script again after a %s', async code => {
    const query = jest
      .fn<Promise<unknown>, [string]>()
      .mockRejectedValueOnce(conflict(code))
      .mockRejectedValueOnce(conflict(code))
      .mockResolvedValue(undefined);

    await applySql(query, 'SELECT 1;', options);

    expect(query).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain(code);
  });

  it('reads the state off the driver error a query runner wraps', async () => {
    const wrapped = Object.assign(new Error('wrapped'), { driverError: { code: '40P01' } });
    const query = jest
      .fn<Promise<unknown>, [string]>()
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValue(undefined);

    await applySql(query, 'SELECT 1;', options);

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('throws the last conflict once the attempts are spent', async () => {
    const query = jest.fn(async () => {
      throw conflict('55P03');
    });

    await expect(applySql(query, 'SELECT 1;', options)).rejects.toMatchObject({ code: '55P03' });
    expect(query).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error in the script itself', async () => {
    const query = jest.fn(async () => {
      throw conflict('42P01');
    });

    await expect(applySql(query, 'SELECT 1;', options)).rejects.toMatchObject({ code: '42P01' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('only treats a deadlock or a lock timeout as a conflict', () => {
    expect(isLockConflict(conflict('40P01'))).toBe(true);
    expect(isLockConflict(conflict('55P03'))).toBe(true);
    expect(isLockConflict(conflict('23505'))).toBe(false);
    expect(isLockConflict('40P01')).toBe(false);
    expect(isLockConflict(undefined)).toBe(false);
  });
});
