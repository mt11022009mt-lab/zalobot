const fs = require('node:fs');
const path = require('node:path');

const changes = [
  ['var T_MS_WAIT_TIMEOUT_MS = 8e3;', 'var T_MS_WAIT_TIMEOUT_MS = 3e4;'],
  ['RECONNECT_DELAY_MS_DEFAULT = 2e3;', 'RECONNECT_DELAY_MS_DEFAULT = 15e3;']
];

function patchSource(source) {
  let result = source;
  for (const [before, after] of changes) {
    if (result.includes(after)) continue;
    const first = result.indexOf(before);
    if (first < 0 || result.indexOf(before, first + before.length) >= 0) {
      throw new Error(`Không tìm thấy đúng một vị trí cần sửa trong FCA: ${before}`);
    }
    result = result.slice(0, first) + after + result.slice(first + before.length);
  }
  return result;
}

if (require.main === module) {
  const packagePath = path.join(path.dirname(path.dirname(require.resolve('@dongdev/fca-unofficial'))), 'package.json');
  const fcaPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (fcaPackage.version !== '4.0.3') {
    throw new Error(`FCA ${fcaPackage.version} chưa được kiểm tra với bản vá MQTT này.`);
  }
  const bundlePath = path.join(path.dirname(packagePath), 'dist', 'index.js');
  const original = fs.readFileSync(bundlePath, 'utf8');
  const patched = patchSource(original);
  if (patched !== original) fs.writeFileSync(bundlePath, patched);
  console.log('FCA MQTT: chờ đồng bộ 30 giây, thử nối lại sau 15 giây.');
}

module.exports = { patchSource };
