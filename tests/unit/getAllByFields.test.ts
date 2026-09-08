import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { Leg } from '../../src/types';
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
