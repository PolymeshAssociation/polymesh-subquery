import { writeFileSync } from 'fs';
import { diff } from 'jest-diff';
import { join } from 'path';
import chainTypes from '../src/chainTypes';

let versions: { minmax: number[]; types: Record<string, string> }[] =
  chainTypes.typesBundle.spec.polymesh.types;
versions = versions.reverse();

let previous = {};
for (const {
  minmax: [min, max],
  types,
} of versions) {
  const filename = min == max ? `${min}` : `${min}-${max}`;

  const noColor = (string: string) => string;
  writeFileSync(
    join(__dirname, '../spec_diffs/', filename),
    diff(previous, types, {
      aColor: noColor,
      bColor: noColor,
      changeColor: noColor,
      commonColor: noColor,
      patchColor: noColor,
      expand: false,
      contextLines: 3,
    })
  );
  previous = types;
}
