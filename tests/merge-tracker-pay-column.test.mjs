// tests/merge-tracker-pay-column.test.mjs — a `pay` cell on a tracker addition
// reaches the `Pay Range` column of the tracker.
//
// The headed addition parser resolved `pay` through the alias table but never
// copied it into the addition object, so a new row was written with `—` in
// Pay Range and an update merge could never replace an existing value.
//
// CLI integration, like tests/merge-tracker-sort.test.mjs: importing
// merge-tracker.mjs would run the merge at import time, so these drive the real
// script through the CAREER_OPS_TRACKER / CAREER_OPS_ADDITIONS overrides.
import { pass, fail, NODE, ROOT, rmSync, isolatedBatchStatePath } from './helpers.mjs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nmerge-tracker.mjs — Pay Range column carries the addition\'s pay');

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Location | Pay Range | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|----------|-----------|-------|--------|-----|--------|-------|',
  '',
].join('\n');

const HEADED = 'num\tdate\tcompany\trole\tlocation\tpay\tscore\tstatus\tpdf\treport\tnotes\n';

/**
 * One merge run in an isolated workspace.
 * @param {{rows?: string[], additions?: Record<string,string>}} opts
 * @returns {{tracker: string, output: string}}
 */
function runMerge(opts = {}) {
  const work = mkdtempSync(join(tmpdir(), 'cops-merge-pay-'));
  try {
    const tracker = join(work, 'applications.md');
    const addsDir = join(work, 'adds');
    mkdirSync(addsDir, { recursive: true });
    writeFileSync(tracker, TRACKER_HEADER + (opts.rows ?? []).join('\n') + '\n');
    for (const [name, line] of Object.entries(opts.additions ?? {})) {
      writeFileSync(join(addsDir, name), line);
    }
    let output = '';
    try {
      output = execFileSync(NODE, [join(ROOT, 'merge-tracker.mjs')], {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: addsDir, CAREER_OPS_BATCH_STATE: isolatedBatchStatePath(addsDir) },
      });
    } catch (e) {
      output = String(e.stdout ?? '') + String(e.stderr ?? '');
    }
    return { tracker: readFileSync(tracker, 'utf-8'), output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The cells of the tracker row whose `#` is `num`, or null. */
function rowCells(trackerText, num) {
  const line = trackerText.split('\n').find(l => l.startsWith(`| ${num} |`));
  return line ? line.split('|').slice(1, -1).map(c => c.trim()) : null;
}

const PAY_COL = 5;

try {
  // A new row carries the pay it was submitted with.
  const added = runMerge({
    additions: {
      '5-acme.tsv': HEADED + '5\t2026-02-01\tAcme\tML Eng\tSF\t$100K–$120K USD\t4.5/5\tEvaluated\t❌\t[5](reports/5-acme-2026-02-01.md)\tnew\n',
    },
  });
  const addedRow = rowCells(added.tracker, 5);
  if (addedRow && addedRow[PAY_COL] === '$100K–$120K USD') {
    pass('merge-tracker writes the addition\'s pay into a new row');
  } else {
    fail(`merge-tracker dropped pay on a new row: [${addedRow?.join(' | ')}]`);
  }

  // An addition with no pay still writes the `—` sentinel.
  const noPay = runMerge({
    additions: {
      '6-globex.tsv': HEADED + '6\t2026-02-02\tGlobex\tData Eng\tSF\t\t4.1/5\tEvaluated\t❌\t[6](reports/6-globex-2026-02-02.md)\tnew\n',
    },
  });
  const noPayRow = rowCells(noPay.tracker, 6);
  if (noPayRow && noPayRow[PAY_COL] === '—') {
    pass('merge-tracker writes — when the addition has no pay');
  } else {
    fail(`merge-tracker mishandled an empty pay cell: [${noPayRow?.join(' | ')}]`);
  }

  // An update merge fills a missing pay but never blanks an existing one.
  const existing = (pay) =>
    `| 7 | 2026-01-01 | Initech | Eng | SF | ${pay} | 3.0/5 | Evaluated | ❌ | [7](reports/7-initech-2026-01-01.md) | seeded |`;
  const update = (pay) => HEADED + `7\t2026-02-03\tInitech\tEng\tSF\t${pay}\t3.5/5\tEvaluated\t❌\t[7](reports/7-initech-2026-01-01.md)\tupdate\n`;

  const filled = rowCells(runMerge({ rows: [existing('—')], additions: { '7-initech.tsv': update('$90K USD') } }).tracker, 7);
  if (filled && filled[PAY_COL] === '$90K USD') {
    pass('merge-tracker update fills a missing pay');
  } else {
    fail(`merge-tracker update did not fill pay: [${filled?.join(' | ')}]`);
  }

  const kept = rowCells(runMerge({ rows: [existing('$80K USD')], additions: { '7-initech.tsv': update('') } }).tracker, 7);
  if (kept && kept[PAY_COL] === '$80K USD') {
    pass('merge-tracker update keeps an existing pay when the addition has none');
  } else {
    fail(`merge-tracker update blanked an existing pay: [${kept?.join(' | ')}]`);
  }
} catch (e) {
  fail(`merge-tracker pay column tests crashed: ${e.message}`);
}
