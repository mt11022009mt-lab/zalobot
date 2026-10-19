const { test } = require('node:test');
const assert = require('node:assert/strict');
const { patchSource } = require('../scripts/patch-fca-timeouts');

test('bản vá MQTT chỉ áp dụng cho cấu trúc FCA 4.0.3 đã kiểm tra', () => {
  const source = 'var T_MS_WAIT_TIMEOUT_MS = 8e3;\nRECONNECT_DELAY_MS_DEFAULT = 2e3;';
  const patched = patchSource(source);
  assert.match(patched, /T_MS_WAIT_TIMEOUT_MS = 3e4/);
  assert.match(patched, /RECONNECT_DELAY_MS_DEFAULT = 15e3/);
  assert.equal(patchSource(patched), patched);
  assert.throws(() => patchSource('unexpected bundle'), /Không tìm thấy/);
});
