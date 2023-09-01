/* eslint-disable @typescript-eslint/no-var-requires */

import { Migration } from '../../types';

const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');

function getLastExecutedMigration() {
  const migrations = path.resolve(__dirname, '../../..db/migrations');
}
