// @ts-check
// ── Reference seed ── This bundled plugin is a stable, reviewed example. To
// extend it, publish career-ops-plugin-<id> with "supersedesBundled": true and
// your version takes precedence once installed (see docs/PLUGINS.md). Bundled
// seeds take only security/compat fixes — feature work happens in the successor repo.
//
// Notion plugin — mirror your tracker to a Notion database (export) and read
// records back as job leads (search).
//
// Built on the Notion backend contributed by @pcomans in #959 (with thanks),
// reshaped per the plugin contract. The decisive change: Notion is an OPT-IN
// MIRROR, not a replacement backend. data/applications.md stays the canonical
// source of truth (the web reads it); `export` pushes a read-only snapshot of it
// to the user's own Notion DB. The core never writes to Notion as primary, and
// modes are not edited — this lives entirely behind `node plugins.mjs run notion`.
//
// Setup: a "Career Ops" parent page in Notion containing an "Applications" DB
// with Company / Role / Status / Score / URL properties, shared with your
// internal integration. Enable in config/plugins.yml; keys in .env.
//
//   node plugins.mjs run notion export            # mirror tracker → Notion
//   node plugins.mjs run notion search "platform" # read matching records → pipeline

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { findCaptureForReport } from '../../jd-capture.mjs';
import { createNotionClient, rich, canonicalStatus, plain } from './_notion.mjs';

function clientFromCtx(ctx) {
  return createNotionClient({
    token: ctx?.env?.NOTION_ACCESS_TOKEN,
    parent: ctx?.env?.NOTION_PARENT_PAGE_ID,
    fetch: ctx?.fetch, // route through the engine's allowedHosts/redirect guard
  });
}

async function applicationsDb(client) {
  const dbs = await client.resolveDBs();
  const apps = dbs['Applications'];
  if (!apps) throw new Error('No "Applications" database found under the Career Ops page — create it and share the integration with it.');
  return apps;
}

/**
 * Parse a tracker score cell into a numeric value for the Notion DB Score property.
 *
 * Scores in applications.md may be formatted like `4.2/5`, `**4.2/5**`, `4.25`, etc.
 * Strips formatting and extracts the first numeric value so slash-formatted
 * scores (e.g. 4.2/5) are not mangled into 4.25 (#1414).
 *
 * @param {unknown} s - Raw score value from tracker row.
 * @returns {number} Parsed score, or NaN if no valid number is present.
 */
export function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

/**
 * Extract the job URL for a tracker row.
 * Checks row.url first; if absent, reads the report file linked in row.report
 * and extracts the `**URL:**` header.
 *
 * @param {Record<string, string>} row - Tracker row from snapshot.
 * @param {string} [dataRoot] - Career-ops data directory.
 * @returns {string} Clean HTTP(S) URL or empty string.
 */
export function resolveRowUrl(row, dataRoot = getCareerOpsRoot()) {
  if (row?.url && /^https?:\/\//i.test(row.url.trim())) {
    return row.url.trim();
  }
  const reportCell = (row?.report || '').trim();
  if (!reportCell) return '';
  const linkMatch = reportCell.match(/\]\(([^)]+)\)/);
  const relPath = linkMatch ? linkMatch[1].trim() : reportCell;
  const cleanPath = relPath.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  const candidates = [
    join(dataRoot, cleanPath),
    join(dataRoot, 'reports', cleanPath.replace(/^reports\//, '')),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, 'utf8');
        const m = text.match(/\*\*URL:\*\*[ \t]*(\S+)/);
        if (m) {
          const raw = m[1].replace(/^<|>$/g, '').replace(/[),.;]+$/, '');
          if (/^https?:\/\//i.test(raw)) return raw;
        }
      } catch {}
    }
  }
  return '';
}

/**
 * Resolve evaluation report markdown and archived JD for a tracker row.
 *
 * @param {Record<string, string>} row
 * @param {string} [dataRoot]
 * @returns {string} Combined markdown for the Notion page body.
 */
export function resolvePageMarkdown(row, dataRoot = getCareerOpsRoot()) {
  let reportText = '';
  const reportCell = (row?.report || '').trim();
  if (reportCell) {
    const linkMatch = reportCell.match(/\]\(([^)]+)\)/);
    const relPath = linkMatch ? linkMatch[1].trim() : reportCell;
    const cleanPath = relPath.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
    const candidates = [
      join(dataRoot, cleanPath),
      join(dataRoot, 'reports', cleanPath.replace(/^reports\//, '')),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          reportText = readFileSync(p, 'utf8');
          break;
        } catch {}
      }
    }
  }

  // If JD is not already embedded in the report, check jds/
  const hasEmbeddedJd = /##\s*Job\s*Description/i.test(reportText);
  if (!hasEmbeddedJd && row?.['#']) {
    try {
      const cap = findCaptureForReport(join(dataRoot, 'jds'), row['#']);
      if (cap?.path && existsSync(cap.path)) {
        const jdContent = readFileSync(cap.path, 'utf8');
        if (jdContent && jdContent.trim()) {
          reportText = (reportText ? reportText.trim() + '\n\n---\n\n' : '') +
            '## Job Description (archived verbatim)\n\n' + jdContent.trim();
        }
      }
    } catch {}
  }

  return reportText.trim();
}

export default {
  parseScore,
  resolveRowUrl,
  resolvePageMarkdown,

  /**
   * export: upsert each tracker row into the user's Notion Applications DB.
   * Receives a frozen read-only snapshot of the tracker — never a file handle.
   * @param {{ applications: Array<Record<string,string>> }} snapshot
   * @param {any} ctx
   */
  async export(snapshot, ctx) {
    const rows = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    if (rows.length === 0) return { pushed: 0 };
    const client = clientFromCtx(ctx);
    const apps = await applicationsDb(client);
    const dataRoot = getCareerOpsRoot();

    // Cache existing database records once upfront to avoid 1 query per row
    let existingMap = new Map();
    if (!ctx?.dryRun) {
      const existingRaw = await client.queryDB(apps);
      for (const r of existingRaw) {
        const c = plain(r.properties?.Company).trim().toLowerCase();
        const ro = plain(r.properties?.Role).trim().toLowerCase();
        if (c && ro) existingMap.set(`${c} / ${ro}`, r.id);
      }
    }

    let pushed = 0;
    for (const row of rows) {
      const company = (row.company || '').trim();
      const role = (row.role || '').trim();
      if (!company || !role) continue;

      const props = { Role: { title: rich(role) }, Company: { rich_text: rich(company) } };
      const status = canonicalStatus(row.status);
      if (status) props.Status = { select: { name: status } };
      const score = parseScore(row.score);
      if (Number.isFinite(score)) props.Score = { number: score };
      const url = resolveRowUrl(row, dataRoot);
      if (url) props.URL = { url };
      const markdown = resolvePageMarkdown(row, dataRoot);

      if (ctx?.dryRun) {
        ctx.log(`would push: ${company} — ${role}${url ? ` (${url})` : ''}${markdown ? ' [with report body]' : ''}`);
        pushed++;
        continue;
      }

      // Upsert: update an existing company+role record, else create one.
      const key = `${company.toLowerCase()} / ${role.toLowerCase()}`;
      const existingId = existingMap.get(key);
      if (existingId) {
        if (markdown) {
          await client.api(`pages/${existingId}`, 'PATCH', { in_trash: true });
          const created = await client.createPage(apps, props, markdown);
          if (created?.id) existingMap.set(key, created.id);
        } else {
          await client.api(`pages/${existingId}`, 'PATCH', { properties: props });
        }
      } else {
        const created = await client.createPage(apps, props, markdown || undefined);
        if (created?.id) existingMap.set(key, created.id);
      }
      pushed++;
    }
    return { pushed };
  },

  /**
   * search: return Notion records matching a query as Job[]. Only records that
   * carry a job posting in a `URL` property are returned (e.g. a postings DB, or
   * leads you added in Notion). Untracked leads (without a status) are returned;
   * records already carrying a tracker status are excluded to prevent duplicate loops.
   * @param {string} query
   * @param {any} ctx
   */
  async search(query, ctx) {
    const client = clientFromCtx(ctx);
    const apps = await applicationsDb(client);
    const hits = await client.findRecords(apps, query);
    return hits
      .filter((h) => h.jobUrl && /^https?:\/\//i.test(h.jobUrl) && !h.status)
      .map((h) => ({ title: h.role || 'Notion record', url: h.jobUrl, company: h.company || '', location: '' }));
  },
};
