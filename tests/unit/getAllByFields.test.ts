import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { Leg, Nomination } from '../../src/types';
import { getAllByFields } from '../../src/utils/common';

/**
 * `getAllByFields` replaced a hand-rolled helper that set `orderBy` to the column it was
 * filtering on (defect A13). Every row in a filtered set holds an identical value for that
 * column, so the order is not total and offset paging can return one row twice and skip
 * another. It must order by `id`, which is unique on every entity.
 */
describe('getAllByFields', () => {
  const getByFields = store.getByFields as jest.Mock;

  beforeEach(() => {
    getByFields.mockReset();
  });

  it('orders every page by the unique `id` column, not a filter column', async () => {
    getByFields.mockResolvedValue([]);

    await getAllByFields<Leg>('Leg', [['instructionId', '=', '42']]);

    expect(getByFields).toHaveBeenCalledWith(
      'Leg',
      [['instructionId', '=', '42']],
      expect.objectContaining({ orderBy: 'id', orderDirection: 'ASC' })
    );
  });

  it('walks every page and concatenates the results in order', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const page2 = [{ id: 'b0' }, { id: 'b1' }];
    getByFields.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const result = await getAllByFields<Leg>('Leg', [['instructionId', '=', '42']]);

    expect(result).toHaveLength(102);
    expect(getByFields).toHaveBeenNthCalledWith(
      2,
      'Leg',
      [['instructionId', '=', '42']],
      expect.objectContaining({ offset: 100, orderBy: 'id' })
    );
  });

  it('stops on the first short page rather than querying again', async () => {
    getByFields.mockResolvedValueOnce([{ id: 'a' }]);

    await getAllByFields<Leg>('Leg', [['instructionId', '=', '42']]);

    expect(getByFields).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty filter, which reads the whole table', async () => {
    getByFields.mockResolvedValue([]);

    await getAllByFields('ChildIdentity', []);

    expect(getByFields).toHaveBeenCalledWith('ChildIdentity', [], expect.anything());
  });

  /**
   * `store.getByFields` hands back plain objects, so a returned row used to carry every field but
   * no methods — `row.save()` was a TypeError that surfaced only when that exact row was reached.
   * It crashed a genesis resync at block 555,566 in `handleNominated`, with the same latent call
   * sitting in `mapValidator` and `mapEra`.
   */
  it('returns saveable entity instances, not plain rows', async () => {
    getByFields.mockResolvedValueOnce([{ id: 'nom-1', positionId: 'stash', validatorId: 'v1' }]);

    const [row] = await getAllByFields<Nomination>('Nomination', [['positionId', '=', 'stash']]);

    expect(typeof row.save).toBe('function');
    expect(row).toMatchObject({ id: 'nom-1', positionId: 'stash', validatorId: 'v1' });
  });

  it('passes through an entity name with no generated model rather than dropping rows', async () => {
    getByFields.mockResolvedValueOnce([{ id: 'x' }]);

    const rows = await getAllByFields('NotAGeneratedModel', []);

    expect(rows).toHaveLength(1);
  });

  it('carries several filters into one query rather than narrowing afterwards', async () => {
    getByFields.mockResolvedValue([]);

    await getAllByFields<Leg>('Leg', [
      ['instructionId', '=', '42'],
      ['legIndex', '=', 1],
    ]);

    expect(getByFields).toHaveBeenCalledWith(
      'Leg',
      [
        ['instructionId', '=', '42'],
        ['legIndex', '=', 1],
      ],
      expect.anything()
    );
  });
});
