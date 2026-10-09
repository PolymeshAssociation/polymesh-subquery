/**
 * Every field a handler reads from `decodeEvent` is in every shape registered for the events
 * `project.ts` routes to it.
 *
 * `decodeEvent` throws `FieldNotFound` for a field the event's shape does not carry, and only on
 * the first block that reaches it, so a handler serving an event across a rename (or two events,
 * such as `NFTPortfolioUpdated` and `NFTHoldingsUpdated`) stops a sync partway. This reads each
 * handler's fields from the source: a destructure of `decodeEvent(...)`, a property read on it, or
 * property reads on a variable holding it. A field the handler first tests with `'field' in
 * decoded` counts as optional. Helpers are followed by name, and a `DecodedEvent` parameter counts
 * as decoded. Handlers reading by position (`params`) are not checked: a rename can't break them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import '../../src/decode/shapes';
import { shapesFor } from '../../src/decode/shapes/registry';

const ROOT = join(__dirname, '..', '..');

/**
 * Fields a handler reads only in its branch for some events, or some eras of one: field to those
 * events, as `pallet.Event`, or `pallet.Event@from` for the shape starting at that spec version.
 */
const BRANCHED: Record<string, Record<string, string[]>> = {
  handleAuthorization: {
    authorizedBy: ['identity.AuthorizationAdded'],
    authorizationData: ['identity.AuthorizationAdded'],
    expiry: ['identity.AuthorizationAdded'],
  },
  // `parseSchedule`: `storedSchedule` before v6, `scheduleId` and `schedule` from it
  handleScheduleCreated: {
    storedSchedule: ['checkpoint.ScheduleCreated@0'],
    scheduleId: ['checkpoint.ScheduleCreated@6000000'],
    schedule: ['checkpoint.ScheduleCreated@6000000'],
  },
  handleScheduleRemoved: {
    storedSchedule: ['checkpoint.ScheduleRemoved@0'],
    scheduleId: ['checkpoint.ScheduleRemoved@6000000'],
    schedule: ['checkpoint.ScheduleRemoved@6000000'],
  },
  // before v8 it reads by position; by name only `SlashReported`, and every event from v8
  handleStakingEvent: {
    validator: ['staking.SlashReported'],
    amount: [
      'staking.Bonded',
      'staking.Unbonded',
      'staking.Reward',
      'staking.Rewarded',
      'staking.Slash',
      'staking.Slashed',
    ],
  },
};

const branchedAway = (handler: string, field: string, event: string, from: number): boolean => {
  const events = BRANCHED[handler]?.[field];
  return !!events && !events.includes(event) && !events.includes(`${event}@${from}`);
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return path.endsWith(join('src', 'types')) ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** `project.ts`'s `filters`: pallet, event, and the handlers it routes the event to. */
const routes = (): { pallet: string; event: string; handler: string }[] => {
  const found: { pallet: string; event: string; handler: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'filters' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const pallet of node.initializer.properties) {
        if (!ts.isPropertyAssignment(pallet) || !ts.isObjectLiteralExpression(pallet.initializer)) {
          continue;
        }
        for (const event of pallet.initializer.properties) {
          if (!ts.isPropertyAssignment(event) || !ts.isArrayLiteralExpression(event.initializer)) {
            continue;
          }
          for (const handler of event.initializer.elements) {
            if (ts.isStringLiteral(handler)) {
              found.push({
                pallet: propertyName(pallet.name) ?? '',
                event: propertyName(event.name) ?? '',
                handler: handler.text,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(join(ROOT, 'project.ts')));
  return found;
};

const isDecodeCall = (node: ts.Node | undefined): boolean =>
  !!node &&
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'decodeEvent';

const bindingFields = (pattern: ts.ObjectBindingPattern): string[] =>
  pattern.elements.flatMap(element => {
    if (element.dotDotDotToken) {
      return [];
    }
    const name = element.propertyName ?? element.name;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? [name.text] : [];
  });

interface Reads {
  at: string;
  fields: Set<string>;
  optional: Set<string>;
  /** the functions it calls, by name */
  calls: Set<string>;
}

/** The fields one handler body reads from `decodeEvent`. */
const readsIn = (body: ts.Node, at: string): Reads => {
  const fields = new Set<string>();
  const optional = new Set<string>();
  const holders = new Set<string>();
  const calls = new Set<string>();

  const collect = (node: ts.Node): void => {
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type &&
      /\bDecodedEvent\b/.test(node.type.getText())
    ) {
      holders.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && isDecodeCall(node.initializer)) {
      if (ts.isObjectBindingPattern(node.name)) {
        bindingFields(node.name).forEach(field => fields.add(field));
      } else if (ts.isIdentifier(node.name)) {
        holders.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(body);

  const holderReads = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ((ts.isIdentifier(node.expression) && holders.has(node.expression.text)) ||
        isDecodeCall(node.expression))
    ) {
      fields.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      holders.has(node.initializer.text)
    ) {
      bindingFields(node.name).forEach(field => fields.add(field));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteral(node.left)
    ) {
      optional.add(node.left.text);
    }
    ts.forEachChild(node, holderReads);
  };
  holderReads(body);

  return { at, fields, optional, calls };
};

/** Every named function's own reads, by name, across the mappings and their helpers. */
const functionReads = (): Map<string, Reads> => {
  const reads = new Map<string, Reads>();
  const files = [
    ...sourceFiles(join(ROOT, 'src', 'mappings')),
    ...sourceFiles(join(ROOT, 'src', 'utils')),
  ];
  for (const path of files) {
    const source = parse(path);
    const visit = (node: ts.Node): void => {
      const declared =
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? { name: node.name.text, body: node.initializer as ts.Node }
          : ts.isFunctionDeclaration(node) && node.name && node.body
          ? { name: node.name.text, body: node as ts.Node }
          : undefined;
      if (declared) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        reads.set(declared.name, readsIn(declared.body, `${relative(ROOT, path)}:${line + 1}`));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return reads;
};

/** A handler's reads with those of every function it calls, directly or through others. */
const handlerReads = (handler: string, reads: Map<string, Reads>): Reads | undefined => {
  const own = reads.get(handler);
  if (!own) {
    return undefined;
  }
  const fields = new Set<string>();
  const optional = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string): void => {
    const read = reads.get(name);
    if (!read || seen.has(name)) {
      return;
    }
    seen.add(name);
    read.fields.forEach(field => fields.add(field));
    read.optional.forEach(field => optional.add(field));
    read.calls.forEach(visit);
  };
  visit(handler);
  return { at: own.at, fields, optional, calls: own.calls };
};

describe('handler fields', () => {
  const reads = functionReads();
  const checked = routes().flatMap(({ pallet, event, handler }) => {
    const read = handlerReads(handler, reads);
    const shapes = shapesFor(pallet, event);
    return read && read.fields.size > 0 && shapes.length > 0
      ? [{ pallet, event, handler, read, shapes }]
      : [];
  });

  it('finds the handlers it checks', () => {
    expect(checked.length).toBeGreaterThan(80);
  });

  it("reads only fields every shape of the handler's events carries", () => {
    const missing = checked.flatMap(({ pallet, event, handler, read, shapes }) =>
      shapes.flatMap(shape => {
        const absent = [...read.fields].filter(
          field =>
            !shape.fields.includes(field) &&
            !shape.aliases?.[field] &&
            !read.optional.has(field) &&
            !branchedAway(handler, field, `${pallet}.${event}`, shape.from)
        );
        return absent.length > 0
          ? [
              `${pallet}.${event} [${shape.from}, ${shape.to ?? 'open'}] via ${handler} (${
                read.at
              }): ${absent.join(', ')} not in [${shape.fields.join(', ')}]`,
            ]
          : [];
      })
    );

    expect(missing).toEqual([]);
  });
});
