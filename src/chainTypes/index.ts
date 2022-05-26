import twoZeroZero from './2.0.0.json';
import fourZeroZero from './4.0.0.json';
import fourOneX from './4.1.x.json';
import fiveXX from './5.x.x.json';
import harvesterTypes from './harvesterTypes.json';

const specTypes = {
  types: [
    {
      minmax: [2021, 2023],
      types: twoZeroZero,
    },
    {
      minmax: [5000000, 5000999],
      types: fiveXX,
    },
    {
      minmax: [3010, 3019],
      types: fourOneX,
    },
    {
      minmax: [3002, 3002],
      types: fourOneX,
    },
    {
      minmax: [3003, 3003],
      types: fourZeroZero,
    },
    {
      minmax: [3000, 3001],
      types: fourZeroZero,
    },
  ],
};

export default {
  types: harvesterTypes,
  typesBundle: {
    spec: {
      polymesh_dev: specTypes,
      polymesh: specTypes,
      polymesh_ci: specTypes,
      polymesh_mainnet: specTypes,
      polymesh_testnet: specTypes,
    },
  },
};
