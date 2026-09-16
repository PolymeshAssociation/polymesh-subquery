import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { Codec } from '@polkadot/types/types';
import { padNumericId } from '../../src/utils';
import { processInstructionId } from '../../src/mappings/entities/settlements/mapSettlement';
import { processVenueId } from '../../src/mappings/entities/settlements/mapVenue';

const codec = (value: string | null): Codec =>
  ({ toString: () => (value === null ? '' : value) } as unknown as Codec);

/**
 * Defect A14 / decision D12: chain-assigned numeric ids (instruction, venue, PIP, authorization
 * sequences) are stored as `String` ids, so a lexicographic `orderBy: ID_DESC` puts "9999"
 * above "14712". Zero-padding to 10 digits makes the string order a numeric one.
 */
describe('padNumericId', () => {
  it('zero-pads to 10 digits so lexical order matches numeric order', () => {
    expect(padNumericId('9999')).toBe('0000009999');
    expect(padNumericId('14712')).toBe('0000014712');
    expect(padNumericId('9999') < padNumericId('14712')).toBe(true);
  });

  it('passes undefined through, so a nullable FK stays absent', () => {
    expect(padNumericId(undefined)).toBeUndefined();
  });
});

describe('processInstructionId', () => {
  it('pads the raw chain instruction id', () => {
    expect(processInstructionId(codec('42'))).toBe('0000000042');
  });
});

describe('processVenueId', () => {
  it('pads the raw chain venue id', () => {
    expect(processVenueId(codec('7'))).toBe('0000000007');
  });
});
