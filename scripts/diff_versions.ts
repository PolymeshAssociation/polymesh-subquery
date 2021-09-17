import { load } from "js-yaml";
import { readFileSync, writeFileSync } from "fs";
import { diff } from "jest-diff";
import { join } from "path";

const project: any = load(
  readFileSync(join(__dirname, "../project.template.yaml"), {
    encoding: "utf-8",
  })
);

let versions: { minmax: [number, number]; types: object }[] =
  project.network.typesBundle.spec.polymesh.types;
versions = versions.reverse();
versions.pop(); // remove last item as it is the hacks

let previous = {};
const noColor = (string: string) => string;
for (const {
  minmax: [min, max],
  types,
} of versions) {
  let filename = min == max ? `${min}` : `${min}-${max}`;
  writeFileSync(
    join(__dirname, "../spec_diffs/", filename),
    diff(types, previous, {
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
