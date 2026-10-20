// electron-builder afterPack hook. Without an Apple Developer certificate the
// macOS build is left unsigned, and Apple Silicon refuses to run unsigned
// code ("GitSwitch is damaged"). An ad-hoc signature fixes that; users still
// confirm the first launch (right-click > Open) since it isn't notarized.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`ad-hoc signed ${app}`);
};
