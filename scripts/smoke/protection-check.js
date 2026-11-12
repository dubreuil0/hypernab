// On-demand only. Tests and their fixtures never use the installed engine, a real browser profile, or user downloads.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const directory = fs.mkdtempSync((process.env.LOCALAPPDATA + '/Temp/opencode/hypernab-protection-report-'));
function snapshot() {
  const hashes = {};
  const visit = relative => {
    const full = path.join(root, relative);
    if (fs.statSync(full).isDirectory()) for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    else hashes[relative.replaceAll('\\', '/')] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  };
  for (const name of ['src', 'public', 'extension', 'desktop', 'package.json', 'package-lock.json']) visit(name);
  return hashes;
}
const before = snapshot(), started = performance.now();
const full = process.argv.includes('--full');
const focused = ['test/protection-capture.test.js', 'test/protection-network.test.js', 'test/protection-transfer.test.js', 'test/protection-oracles.test.js',
  'test/capture-noise.test.js', 'test/capture-sources.test.js', 'test/extension-grouping.test.js', 'test/quality.test.js', 'test/source-plan.test.js',
  'test/session.test.js', 'test/queue-controls.test.js', 'test/queue-order.test.js', 'test/recovery.test.js', 'test/hls-recovery.test.js'];
const result = spawnSync(process.execPath, ['--import', './test/setup-locale.js', '--test', '--test-reporter=tap', ...(full ? [] : focused)], { cwd: root, encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 20 * 1048576 });
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
const after = snapshot(), changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]);
const count = name => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(output)?.[1] ?? -1);
const summary = { appVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
  extensionVersion: JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'))).version,
  mode: full ? 'full' : 'focused', passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'),
  checkedProductionFiles: Object.keys(before).length, productionFilesUnchanged: changed.length === 0, changed,
  elapsedMs: Math.round(performance.now() - started), exitCode: result.status, processError: result.error?.code || null,
  success: result.status === 0 && count('fail') === 0 && count('cancelled') === 0 && count('pass') > 0 && changed.length === 0 };
fs.writeFileSync(path.join(directory, 'tests.tap'), output);
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(summary, null, 2));
console.log(`${summary.success ? 'PASS' : 'FAIL'} ${summary.passed} passed, ${summary.failed} failed; ${summary.checkedProductionFiles} production files ${summary.productionFilesUnchanged ? 'unchanged' : 'CHANGED'}.`);
if (!summary.success) console.log(output.split('\n').filter(line => /^not ok|^  error:|^  location:/.test(line)).join('\n'));
console.log(`Report: ${path.join(directory, 'report.json')}`);
process.exitCode = summary.success ? 0 : 1;
