// electron-builder の afterPack: Mac だけ、.app に ad-hoc 署名（証明書なしの署名）を付ける。
// 署名のない実行ファイルは Apple Silicon では起動しないため。macOS の Gatekeeper の警告は残る（desktop/README.md）。
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`ad-hoc 署名を付けます: ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
