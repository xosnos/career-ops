// Notion plugin: export diffing, status sync and the helpers behind them.
//
// Everything runs against an in-memory fake of the Notion API injected through
// the client's `fetch`, so no network and no token are involved.
//
// Run: node --test tests/notion-plugin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

import notion, {
  parsePayNumber, formatNotionPlace, cleanLocation, resolveRowUrl, resolveRowPay,
} from '../plugins/notion/index.mjs';
import { syncNotionStatus, syncNotionAdditions } from '../plugins/notion/sync.mjs';
import { createNotionClient } from '../plugins/notion/_notion.mjs';

const APPS_DB = 'ds-apps';

/** In-memory Notion: one Applications data source, records every request. */
function fakeNotion(pages = []) {
  const calls = [];
  let nextId = 1;
  const store = pages.map((p) => ({ last_edited_time: new Date().toISOString(), ...p }));
  const fetch = async (url, init = {}) => {
    const path = url.replace('https://api.notion.com/v1/', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const ok = (json) => ({ ok: true, json: async () => json });
    if (path.startsWith('blocks/')) {
      return ok({ results: [{ type: 'child_database', id: 'db1', child_database: { title: 'Applications' } }], has_more: false });
    }
    if (path === 'databases/db1') return ok({ data_sources: [{ id: APPS_DB }] });
    if (path === `data_sources/${APPS_DB}/query`) return ok({ results: store, has_more: false });
    if (path === 'pages' && method === 'POST') {
      const page = { id: `new-${nextId++}`, properties: body.properties, last_edited_time: new Date().toISOString() };
      store.push(page);
      return ok(page);
    }
    if (path.startsWith('pages/') && method === 'PATCH') return ok({ id: path.slice(6) });
    throw new Error(`unexpected request ${method} ${path}`);
  };
  const writes = () => calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/query'));
  return { fetch, calls, writes };
}

const text = (s) => ({ rich_text: [{ plain_text: s }] });
const title = (s) => ({ title: [{ plain_text: s }] });

/** A page as the Notion API returns it. */
function page(id, company, role, extra = {}) {
  return {
    id,
    properties: {
      Company: text(company), Role: title(role),
      Status: { select: { name: extra.status ?? 'Evaluated' } },
      Score: { number: extra.score ?? 4.2 },
      URL: { url: extra.url ?? 'https://x.example/job/1' },
      Location: { place: extra.location ? { name: extra.location } : null },
      Pay: { number: extra.pay ?? null },
    },
    ...(extra.last_edited_time ? { last_edited_time: extra.last_edited_time } : {}),
  };
}

const ctxFor = (fake, env = {}) => ({
  fetch: fake.fetch,
  env: { NOTION_ACCESS_TOKEN: 'secret-token', NOTION_PARENT_PAGE_ID: 'parent', ...env },
  settings: { requestDelayMs: 0 },
  log: () => {},
  dryRun: false,
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'notion-plugin-'));
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  process.env.CAREER_OPS_ROOT = dir;
  return dir;
}

const row = (o = {}) => ({
  company: 'Acme', role: 'Staff Engineer', status: 'Evaluated', score: '4.2/5',
  url: 'https://x.example/job/1', ...o,
});

// ── helpers ─────────────────────────────────────────────────────────────

test('parsePayNumber reads ranges, k-suffixes and rejects non-pay text', () => {
  assert.equal(parsePayNumber('$150,000 - $200,000'), 150000);
  assert.equal(parsePayNumber('$150K-$200K'), 150000);
  assert.equal(parsePayNumber('$180K'), 180000);
  assert.equal(parsePayNumber('$180,000'), 180000);
  assert.equal(parsePayNumber('Competitive'), null);
  assert.equal(parsePayNumber('not stated'), null);
  assert.equal(parsePayNumber('—'), null);
  assert.equal(parsePayNumber(''), null);
});

test('formatNotionPlace pins known cities and refuses to guess', () => {
  const sf = formatNotionPlace('San Francisco, CA (Hybrid)');
  assert.deepEqual([sf.lat, sf.lon, sf.name], [37.7749, -122.4194, 'San Francisco, CA (Hybrid)']);
  assert.equal(formatNotionPlace('Remote - US'), null, 'Remote has no coordinates');
  assert.equal(formatNotionPlace('Reykjavik, Iceland'), null, 'unknown city is not pinned at 0,0');
  assert.equal(formatNotionPlace('—'), null);
  assert.equal(formatNotionPlace(''), null);
});

test('cleanLocation no longer falls back to San Francisco for long text', () => {
  const long = 'Somewhere far from anywhere recognised, with a very long free-text description';
  assert.equal(cleanLocation(long), '');
  assert.equal(cleanLocation('Remote (United States)'), 'Remote - US');
  assert.equal(cleanLocation('Palo Alto hybrid'), 'Palo Alto, CA (Hybrid)');
});

test('resolveRowUrl reads the href out of a markdown link cell', () => {
  const dir = workspace();
  try {
    assert.equal(resolveRowUrl({ url: '[ashby](https://jobs.ashbyhq.com/acme/1)' }, dir), 'https://jobs.ashbyhq.com/acme/1');
    assert.equal(resolveRowUrl({ url: 'https://x.example/j' }, dir), 'https://x.example/j');
    assert.equal(resolveRowUrl({ url: '—' }, dir), '');
  } finally { rmSync(dir, { recursive: true }); }
});

test('resolveRowPay prefers the tracker cell, then the report', () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'reports', '001-acme.md'), 'advertised_comp: "$160K-$200K"\n');
    assert.equal(resolveRowPay({ pay: '$120K' }, dir), '$120K');
    assert.equal(resolveRowPay({ report: '[1](reports/001-acme.md)' }, dir), '$160K-$200K');
    assert.equal(resolveRowPay({ pay: '—' }, dir), '');
  } finally { rmSync(dir, { recursive: true }); }
});

// ── export ──────────────────────────────────────────────────────────────

test('export creates a missing row with status, score, url, location and pay', async () => {
  const dir = workspace();
  try {
    const fake = fakeNotion();
    const res = await notion.export(
      { applications: [row({ location: 'San Francisco, CA', pay: '$150K-$200K' })] },
      ctxFor(fake),
    );
    assert.deepEqual(res, { pushed: 1, skipped: 0 });
    const [create] = fake.writes();
    assert.equal(create.path, 'pages');
    const p = create.body.properties;
    assert.equal(p.Status.select.name, 'Evaluated');
    assert.equal(p.Score.number, 4.2);
    assert.equal(p.URL.url, 'https://x.example/job/1');
    assert.equal(p.Location.place.name, 'San Francisco, CA');
    assert.equal(p.Pay.number, 150000);
  } finally { rmSync(dir, { recursive: true }); }
});

test('export skips a row that already matches Notion', async () => {
  const dir = workspace();
  try {
    const fake = fakeNotion([page('p1', 'Acme', 'Staff Engineer', { location: 'San Francisco, CA', pay: 150000 })]);
    const res = await notion.export(
      { applications: [row({ location: 'San Francisco, CA', pay: '$150K-$200K' })] },
      ctxFor(fake),
    );
    assert.deepEqual(res, { pushed: 0, skipped: 1 });
    assert.equal(fake.writes().length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test('export patches only the changed property and never trashes the page', async () => {
  const dir = workspace();
  try {
    const fake = fakeNotion([page('p1', 'Acme', 'Staff Engineer')]);
    await notion.export({ applications: [row({ status: 'Applied' })] }, ctxFor(fake));
    const writes = fake.writes();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, 'pages/p1');
    assert.deepEqual(writes[0].body, { properties: { Status: { select: { name: 'Applied' } } } });
  } finally { rmSync(dir, { recursive: true }); }
});

test('export never sends an empty PATCH when Notion has a value the tracker lacks', async () => {
  const dir = workspace();
  try {
    // Notion holds a location and pay; the tracker row has neither. Nothing to write.
    const fake = fakeNotion([page('p1', 'Acme', 'Staff Engineer', { location: 'Seattle, WA', pay: 170000 })]);
    const res = await notion.export({ applications: [row()] }, ctxFor(fake));
    assert.deepEqual(res, { pushed: 0, skipped: 1 });
    assert.equal(fake.writes().length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test('export leaves a page alone when its report is newer, unless refresh is enabled', async () => {
  const dir = workspace();
  try {
    const reportPath = join(dir, 'reports', '001-acme.md');
    writeFileSync(reportPath, '# Report\n\n**URL:** https://x.example/job/1\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(reportPath, future, future);
    const r = row({ report: '[1](reports/001-acme.md)' });
    const existing = () => page('p1', 'Acme', 'Staff Engineer', { last_edited_time: new Date().toISOString() });

    const off = fakeNotion([existing()]);
    const resOff = await notion.export({ applications: [r] }, ctxFor(off));
    assert.deepEqual(resOff, { pushed: 0, skipped: 1 });
    assert.equal(off.writes().length, 0, 'default: no trash, no create');

    const on = fakeNotion([existing()]);
    const resOn = await notion.export({ applications: [r] }, ctxFor(on, { NOTION_REFRESH_REPORTS: 'true' }));
    assert.equal(resOn.pushed, 1);
    const writes = on.writes();
    assert.equal(writes[0].path, 'pages', 'replacement is created first');
    assert.match(writes[0].body.markdown, /# Report/);
    assert.equal(writes[1].path, 'pages/p1');
    assert.deepEqual(writes[1].body, { in_trash: true }, 'old page trashed second');
  } finally { rmSync(dir, { recursive: true }); }
});

test('refresh keeps the old page when creating the replacement fails', async () => {
  const dir = workspace();
  try {
    const reportPath = join(dir, 'reports', '001-acme.md');
    writeFileSync(reportPath, '# Report\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(reportPath, future, future);
    const fake = fakeNotion([page('p1', 'Acme', 'Staff Engineer')]);
    const real = fake.fetch;
    const failingCreate = async (url, init) => {
      if (url.endsWith('/pages') && init?.method === 'POST') throw new Error('HTTP 500');
      return real(url, init);
    };
    await assert.rejects(
      notion.export({ applications: [row({ report: '[1](reports/001-acme.md)' })] },
        { ...ctxFor(fake, { NOTION_REFRESH_REPORTS: 'true' }), fetch: failingCreate }),
      /HTTP 500/,
    );
    assert.equal(fake.writes().filter((c) => c.body?.in_trash).length, 0, 'nothing was trashed');
  } finally { rmSync(dir, { recursive: true }); }
});

// ── status sync ─────────────────────────────────────────────────────────

function inject(fake) {
  return { client: createNotionClient({ token: 't', parent: 'p', fetch: fake.fetch, delayMs: 0 }), appsDb: APPS_DB };
}

test('syncNotionStatus patches the status of a matching row', async () => {
  const dir = workspace();
  try {
    const fake = fakeNotion([page('p1', 'Acme', 'Staff Engineer')]);
    const res = await syncNotionStatus({
      company: 'Acme', role: 'staff engineer', status: 'applied', dataRoot: dir, inject: inject(fake),
    });
    assert.deepEqual(res, { synced: true, action: 'updated', id: 'p1' });
    const [patch] = fake.writes();
    assert.equal(patch.path, 'pages/p1');
    assert.deepEqual(patch.body, { properties: { Status: { select: { name: 'Applied' } } } });
    const query = fake.calls.find((c) => c.path.endsWith('/query'));
    assert.deepEqual(query.body.filter, { property: 'Company', rich_text: { equals: 'Acme' } });
  } finally { rmSync(dir, { recursive: true }); }
});

test('syncNotionStatus is a no-op when the status already matches', async () => {
  const dir = workspace();
  try {
    const fake = fakeNotion([page('p1', 'Acme', 'Staff Engineer', { status: 'Applied' })]);
    const res = await syncNotionStatus({ company: 'Acme', role: 'Staff Engineer', status: 'Applied', dataRoot: dir, inject: inject(fake) });
    assert.equal(res.action, 'already-current');
    assert.equal(fake.writes().length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test('syncNotionStatus creates the row when Notion does not have it', async () => {
  const dir = workspace();
  try {
    const fake = fakeNotion();
    const res = await syncNotionStatus({
      company: 'Acme', role: 'Staff Engineer', status: 'Applied', score: '4.2/5',
      url: 'https://x.example/job/1', dataRoot: dir, inject: inject(fake),
    });
    assert.equal(res.action, 'created');
    const p = fake.writes()[0].body.properties;
    assert.equal(p.Status.select.name, 'Applied');
    assert.equal(p.Score.number, 4.2);
    assert.equal(p.URL.url, 'https://x.example/job/1');
  } finally { rmSync(dir, { recursive: true }); }
});

test('syncNotionStatus reports an error instead of throwing when Notion fails', async () => {
  const dir = workspace();
  try {
    const broken = { fetch: async () => { throw new Error('HTTP 401: unauthorized'); } };
    const res = await syncNotionStatus({ company: 'Acme', role: 'Staff Engineer', status: 'Applied', dataRoot: dir, inject: inject(broken) });
    assert.equal(res.synced, false);
    assert.match(res.error, /401/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('syncNotionStatus gives up after the deadline instead of hanging', async () => {
  const dir = workspace();
  try {
    const hang = { fetch: () => new Promise(() => {}) };
    const started = Date.now();
    const res = await syncNotionStatus({
      company: 'Acme', role: 'Staff Engineer', status: 'Applied', dataRoot: dir,
      inject: inject(hang), deadlineMs: 150,
    });
    assert.equal(res.synced, false);
    assert.match(res.error, /timed out after 150ms/);
    assert.ok(Date.now() - started < 3000, 'returned promptly');
  } finally { rmSync(dir, { recursive: true }); }
});

test('syncNotionStatus skips quietly when the plugin is not configured', async () => {
  const dir = workspace();
  const saved = { ...process.env };
  try {
    delete process.env.NOTION_ACCESS_TOKEN; delete process.env.NOTION_PARENT_PAGE_ID;
    // Not under NODE_ENV=test for this call, so the real configured-check runs.
    delete process.env.NODE_ENV;
    const res = await syncNotionStatus({ company: 'Acme', role: 'Staff Engineer', status: 'Applied', dataRoot: dir });
    assert.deepEqual(res, { synced: false, action: 'not-configured' });
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true });
  }
});

// ── additions sync ──────────────────────────────────────────────────────

test('syncNotionAdditions exports the rows of the tracker it is given', async () => {
  const dir = workspace();
  try {
    const tracker = join(dir, 'data', 'applications.md');
    writeFileSync(tracker, [
      '# Applications Tracker', '',
      '| # | Date | Company | Role | Location | Pay Range | Score | Status | PDF | Report | Notes | URL |',
      '|---|------|---------|------|----------|-----------|-------|--------|-----|--------|-------|-----|',
      '| 1 | 2026-10-01 | Acme | Staff Engineer | San Francisco, CA | $150K-$200K | 4.2/5 | Evaluated | ❌ | — | — | [ashby](https://jobs.ashbyhq.com/acme/1) |',
      '',
    ].join('\n'));
    const fake = fakeNotion();
    const res = await syncNotionAdditions(dir, { trackerPath: tracker, ctx: ctxFor(fake) });
    assert.deepEqual(res, { synced: true, pushed: 1, skipped: 0 });
    const p = fake.writes()[0].body.properties;
    assert.equal(p.URL.url, 'https://jobs.ashbyhq.com/acme/1', 'markdown-link URL cell resolved to its href');
    assert.equal(p.Pay.number, 150000);
    assert.equal(p.Location.place.name, 'San Francisco, CA');
  } finally { rmSync(dir, { recursive: true }); }
});

test('syncNotionAdditions reports a missing tracker without throwing', async () => {
  const dir = workspace();
  try {
    const res = await syncNotionAdditions(dir, { trackerPath: join(dir, 'data', 'nope.md'), ctx: ctxFor(fakeNotion()) });
    assert.deepEqual(res, { synced: false, action: 'no-tracker' });
  } finally { rmSync(dir, { recursive: true }); }
});
