import { Codec, Registry } from '@polkadot/types/types';

/**
 * Before metadata v14 a type the chain types don't name decodes as `LookupN`, and the name it had
 * is kept on the lookup entry as `historicMetaCompat`. From v14 the entry carries a path instead.
 */
const lookupName = (registry: Registry, name: string): string | undefined => {
  const match = /^Lookup(\d+)$/.exec(name);
  if (!match) {
    return undefined;
  }

  const type = registry.lookup.getSiType(Number(match[1]));
  if (type.def.isHistoricMetaCompat) {
    return type.def.asHistoricMetaCompat.toString();
  }
  return type.path.length > 0 ? type.path.map(segment => segment.toString()).join('') : undefined;
};

/**
 * The name that says what a value is: `IdentityId`, `Ticker`, `PortfolioId`. It comes from `hint`,
 * which is the metadata's name for an argument and the parent's name for a nested value (its
 * `toRawType()` names each child), and otherwise from the value's own raw type. A value's class
 * can't be asked instead: the mappings' sandbox hides a host object's `constructor`. Lookup names
 * are resolved, generic arguments dropped and only the last path segment kept, so every era reads
 * the same.
 */
export const typeNameOf = (codec: Codec, hint?: string): string => {
  const given = hint ?? codec.toRawType();
  const name = lookupName(codec.registry, given) ?? given;
  const base = name.replace(/<[\s\S]*$/, '');

  return /^[\w:]+$/.test(base) ? base.split('::').pop() ?? base : name;
};

/** Whether `name` is the semantic type `suffix` under any era's naming. */
export const isType = (name: string, suffix: string): boolean =>
  name === suffix || name.endsWith(suffix);
