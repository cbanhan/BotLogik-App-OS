const { chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const platform = `${process.platform}-${process.arch}`;
const helperPath = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper');

if (existsSync(helperPath)) {
  chmodSync(helperPath, 0o755);
}
