const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, copyFileSync, rmSync } = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
  throw new Error('Mac icon generation requires macOS (sips and iconutil).');
}

const root = path.resolve(__dirname, '..');
const source = path.resolve(root, 'assets/icon-source.png');
const build = path.join(root, 'build');
mkdirSync(build, { recursive: true });
const temporary = mkdtempSync(path.join(build, '.icon-'));
const iconset = path.join(temporary, 'icon.iconset');
mkdirSync(iconset);

try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const filename = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', [
        '-z', pixels, pixels, source, '--out', path.join(iconset, filename),
      ], { stdio: 'pipe' });
    }
  }
  const output = path.join(temporary, 'icon.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', output]);
  copyFileSync(path.join(iconset, 'icon_512x512@2x.png'), path.join(build, 'icon.png'));
  copyFileSync(output, path.join(build, 'icon.icns'));
  // Keep a complete size set alongside the packaged icon for inspection.
  mkdirSync(path.join(build, 'icon.iconset'), { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      copyFileSync(path.join(iconset, filename), path.join(build, 'icon.iconset', filename));
    }
  }
  console.log('Generated build/icon.png and build/icon.icns from assets/icon-source.png');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
