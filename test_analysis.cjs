const assert = require('node:assert/strict');
const math = require('./ephys_math.js');
const sweep = {dt_s: 0.001, metrics: {baseline_current_pA: 2, activation_change_pA: 4},
  segments: [{stored: true, start_s: 0, end_s: 0.005, sample_start: 0, sample_end: 5}]};
for (const [statistic, expected] of [['mean', 3], ['min', -1], ['max', 6]]) {
  const result = math.measure([2, -1, 6, 4, 99], sweep,
    {type: 'window', start: 0.001, end: 0.004, statistic}, 'raw');
  assert.equal(result.value, expected);
  assert.equal(result.n, 3);
}
const rows = [0, 11, 45].map((time, i) => ({group_elapsed_s: time, value: i,
  series_id: i < 2 ? 'A' : 'B', cursor_id: 'C1', trace_index: 1, trace_label: 'I', protocol_name: 'step'}));
assert.deepEqual(math.trendCurves(rows, 'elapsed_s')[0].x, [0, 11, null, 45]);
console.log('Full-sample measurements and acquisition-time gaps passed.');
