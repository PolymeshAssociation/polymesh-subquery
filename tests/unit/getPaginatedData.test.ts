import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { getPaginatedData } from '../../src/utils/common';
import { Leg } from '../../src/types';

/**
 * Regression test for defect A13: `getPaginatedData` set `orderBy` to the column it was
 * filtering on. Every row in a filtered set holds an identical value for that column, so the
 * order is not total and offset paging can return one row twice and skip another. It must
 * order by `id`, which is unique on every entity.
 */
describe('getPaginatedData', () => {
  const getByField = store.getByField as jest.Mock;

  beforeEach(() => {
    getByField.mockReset();
  });

  it('orders every page by the unique `id` column, not the filter column', async () => {
    getByField.mockResolvedValue([]);

    await getPaginatedData<Leg, 'instructionId'>('Leg', 'instructionId', '42');

    expect(getByField).toHaveBeenCalledWith(
      'Leg',
      'instructionId',
      '42',
      expect.objectContaining({ orderBy: 'id', orderDirection: 'ASC' })
    );
  });

  it('walks every page and concatenates the results in order', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const page2 = [{ id: 'b0' }, { id: 'b1' }];
    getByField.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const result = await getPaginatedData<Leg, 'instructionId'>('Leg', 'instructionId', '42');

    expect(result).toHaveLength(102);
    expect(getByField).toHaveBeenNthCalledWith(
      2,
      'Leg',
      'instructionId',
      '42',
      expect.objectContaining({ offset: 100, orderBy: 'id' })
    );
  });
});
