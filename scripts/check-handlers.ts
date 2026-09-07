// `project.ts` resolves each handler by name at runtime, with no static link to its
// implementation — a typo or a removed export is silently dropped rather than failing the
// build (defect A3: `Suspended: ['handleBalanceSuspended']` named a function that was never
// exported anywhere in `src/`). This asserts every handler name `project.ts` references is
// actually exported from `src/index.ts`.
import * as handlers from '../src/index';
import project from '../project';

const referenced = new Set<string>();
project.dataSources.forEach(ds => {
  ds.mapping.handlers.forEach(({ handler }) => referenced.add(handler));
});

const missing = [...referenced].filter(name => !(name in handlers));

if (missing.length > 0) {
  console.error(
    `check-handlers: project.ts references handler(s) not exported from src/index.ts: ${missing.join(
      ', '
    )}`
  );
  process.exit(1);
}

console.log(
  `check-handlers: all ${referenced.size} handler(s) referenced in project.ts are exported.`
);
