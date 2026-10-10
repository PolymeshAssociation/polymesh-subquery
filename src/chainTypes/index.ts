import { typesBundle } from '@polymeshassociation/polymesh-types';
// Type definitions the chain's pre-v14 metadata needs and `typesBundle` lacks.
import legacyTypes from './legacyTypes.json';

export default {
  types: legacyTypes,
  typesBundle,
};
