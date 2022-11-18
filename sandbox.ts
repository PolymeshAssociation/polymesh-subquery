import { fetchLatestBlock } from './tests/setup';

const main = async (): Promise<void> => {
  const block = await fetchLatestBlock();
  console.log(block);
};

main();
