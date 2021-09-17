import { load } from "js-yaml";
import { readFileSync, writeFileSync } from "fs";
import { diff } from "jest-diff";
import { join } from "path";

const project: any = load(
  readFileSync(join(__dirname, "../project.template.yaml"), {
    encoding: "utf-8",
  })
);

let versions: { minmax: [number, number]; types: Record<string, string> }[] =
  project.network.typesBundle.spec.polymesh.types;
versions = versions.reverse();
versions.pop(); // remove last item as it is the hacks

let previous = {};
for (const {
  minmax: [min, max],
  types,
} of versions) {
  const filename = min == max ? `${min}` : `${min}-${max}`;

  const noColor = (string: string) => string;
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
