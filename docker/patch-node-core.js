// node-core 19.2.0 to 19.3.1 exit on a fork found while registering an unfinalized block: the search
// for the last valid block starts from the reported header, which can be above the finalized height
// or a stored fork block. As the upstream fix does, this treats that fork only as a signal and lets
// hasForked check the stored blocks against the finalized chain. The build fails if the compiled
// code is not exactly what it replaces.
const fs = require('node:fs');

const file = '/node_modules/@subql/node-core/dist/indexer/unfinalizedBlocks.service.js';

const original = `    async processUnfinalizedBlockHeader(header) {
        let forkedHeader;
        if (header) {
            forkedHeader = await this.registerUnfinalizedBlock(header);
        }
        if (!forkedHeader) {
            forkedHeader = await this.hasForked();
        }
        if (!forkedHeader) {
            // Remove blocks that are now confirmed finalized
            await this.deleteFinalizedBlock();
        }
        else {
            // Get the last unfinalized block that is now finalized
            return this.getLastCorrectFinalizedBlock(forkedHeader);
        }
        return;
    }
`;

const patched = `    async processUnfinalizedBlockHeader(header) {
        const registrationFork = header ? await this.registerUnfinalizedBlock(header) : undefined;
        const forkedHeader = await this.hasForked();
        if (forkedHeader) {
            return this.getLastCorrectFinalizedBlock(forkedHeader);
        }
        if (registrationFork) {
            return this.getClosestRecord(this.finalizedBlockNumber) ?? this.finalizedHeader;
        }
        await this.deleteFinalizedBlock();
    }
`;

const source = fs.readFileSync(file, 'utf8');

if (source.split(original).length !== 2) {
  throw new Error(`${file} does not hold the code this patch replaces exactly once`);
}

fs.writeFileSync(file, source.replace(original, patched));
