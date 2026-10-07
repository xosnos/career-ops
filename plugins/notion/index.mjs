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

import { existsSync, readFileSync, statSync } from 'fs';
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
 * Resolve the on-disk report file path for a tracker row, if one exists.
 *
 * @param {Record<string, string>} row - Tracker row from snapshot.
 * @param {string} [dataRoot] - Career-ops data directory.
 * @returns {string} Absolute path to report file or empty string.
 */
export function resolveReportPath(row, dataRoot = getCareerOpsRoot()) {
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
    if (existsSync(p)) return p;
  }
  return '';
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
  const reportPath = resolveReportPath(row, dataRoot);
  if (reportPath) {
    try {
      const text = readFileSync(reportPath, 'utf8');
      const m = text.match(/\*\*URL:\*\*[ \t]*(\S+)/);
      if (m) {
        const raw = m[1].replace(/^<|>$/g, '').replace(/[),.;]+$/, '');
        if (/^https?:\/\//i.test(raw)) return raw;
      }
    } catch {}
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
  const reportPath = resolveReportPath(row, dataRoot);
  if (reportPath) {
    try {
      reportText = readFileSync(reportPath, 'utf8');
    } catch {}
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

/**
 * Standardize free-text location into a clean display string.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanLocation(raw) {
  if (!raw || raw === '—' || raw === '-' || /^(none|null|n\/?a)$/i.test(raw)) return '';
  let s = raw.trim().replace(/^\*\*|\*\*$/g, '').trim();

  let policy = '';
  if (/\b(?:hybrid)\b/i.test(s)) policy = 'Hybrid';
  else if (/\b(?:on-site|onsite|in-office|in office)\b/i.test(s)) policy = 'On-site';
  else if (/\b(?:remote)\b/i.test(s)) policy = 'Remote';

  let place = '';
  if (/palo alto/i.test(s)) place = 'Palo Alto, CA';
  else if (/mountain view/i.test(s)) place = 'Mountain View, CA';
  else if (/sunnyvale/i.test(s)) place = 'Sunnyvale, CA';
  else if (/san jose/i.test(s)) place = 'San Jose, CA';
  else if (/redwood city/i.test(s)) place = 'Redwood City, CA';
  else if (/menlo park/i.test(s)) place = 'Menlo Park, CA';
  else if (/san francisco|sf\b/i.test(s)) {
    if (/bay area/i.test(s)) place = 'SF Bay Area, CA';
    else place = 'San Francisco, CA';
  } else if (/bay area/i.test(s)) place = 'SF Bay Area, CA';
  else if (/new york|nyc/i.test(s)) place = 'New York, NY';
  else if (/seattle/i.test(s)) place = 'Seattle, WA';
  else if (/chicago/i.test(s)) place = 'Chicago, IL';
  else if (/los angeles/i.test(s)) place = 'Los Angeles, CA';
  else if (/boston/i.test(s)) place = 'Boston, MA';
  else if (/austin/i.test(s)) place = 'Austin, TX';
  else if (/denver/i.test(s)) place = 'Denver, CO';
  else if (/toronto/i.test(s)) place = 'Toronto, ON';
  else if (/vancouver/i.test(s)) place = 'Vancouver, BC';
  else if (/london/i.test(s)) place = 'London, UK';

  if (s.toLowerCase().startsWith('remote-first in the us') || s.toLowerCase().startsWith('remote (united states)') || s.toLowerCase().startsWith('remote (us') || s.toLowerCase().startsWith('usa - remote')) {
    return 'Remote - US';
  }

  if (place && policy) return `${place} (${policy})`;
  if (place) return place;
  if (policy === 'Remote') {
    if (/u\.?s\.?|united states/i.test(s)) return 'Remote - US';
    return 'Remote';
  }

  const short = s.split(/[;+—]/)[0].trim();
  return short.length <= 40 ? short : (policy || 'San Francisco, CA');
}

/**
 * Resolve location for a tracker row (from row itself or report).
 *
 * @param {Record<string, string>} row
 * @param {string} [dataRoot]
 * @returns {string} Clean location string.
 */
export function resolveRowLocation(row, dataRoot = getCareerOpsRoot()) {
  const direct = (row?.location || '').trim();
  if (direct && direct !== '—' && direct !== '-' && !/^(none|null|n\/?a)$/i.test(direct)) {
    return direct;
  }
  const reportPath = resolveReportPath(row, dataRoot);
  if (reportPath) {
    try {
      const content = readFileSync(reportPath, 'utf8');
      const plainText = content.replace(/\*\*/g, '');
      const locRowMatch = plainText.match(/\|\s*(?:Remote(?:\s*Policy)?|Location|Ubicaci[oó]n|Remoto)\s*\|\s*(.*?)\s*\|/i);
      if (locRowMatch) {
        const val = locRowMatch[1].trim();
        if (val && val !== '—' && val !== '-' && !/^(none|null|n\/?a)$/i.test(val)) return cleanLocation(val);
      }
      const geoMatch = plainText.match(/###\s*Geo-mismatch[^\n]*\n([\s\S]*?)(?=\n###|\n##|\n---|$)/i);
      if (geoMatch) {
        const m = geoMatch[1].match(/(?:states?|specifies|indicates?|based in|located in|office in)\s+[`"']?([^`"'\n.]+)[`"']?/i);
        if (m) return cleanLocation(m[1].trim());
      }
    } catch {}
  }
  return '';
}

/**
 * Resolve pay range for a tracker row (from row itself or report).
 *
 * @param {Record<string, string>} row
 * @param {string} [dataRoot]
 * @returns {string}
 */
export function resolveRowPay(row, dataRoot = getCareerOpsRoot()) {
  const direct = (row?.pay || row?.['pay range'] || '').trim();
  if (direct && direct !== '—' && direct !== '-' && !/^(none|null|n\/?a|not stated)$/i.test(direct)) {
    return direct;
  }
  const reportPath = resolveReportPath(row, dataRoot);
  if (reportPath) {
    try {
      const content = readFileSync(reportPath, 'utf8');
      const m = content.match(/advertised_comp:\s*(.*)/);
      if (m) {
        let c = m[1].trim();
        if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
          c = c.slice(1, -1).trim();
        }
        if (c && c !== 'null' && c !== 'not stated' && c !== 'none') return c;
      }
    } catch {}
  }
  return '';
}

/**
 * Convert location name to Notion place property value with coordinates.
 *
 * @param {string} locStr
 * @returns {{ lat: number, lon: number, name: string } | null}
 */
export function formatNotionPlace(locStr) {
  if (!locStr) return null;
  const s = String(locStr).trim();
  if (!s || s === '—' || s === '-' || /^(none|null|n\/?a)$/i.test(s)) return null;

  let lat = 0;
  let lon = 0;

  if (/palo alto/i.test(s)) { lat = 37.4419; lon = -122.1430; }
  else if (/mountain view/i.test(s)) { lat = 37.3861; lon = -122.0839; }
  else if (/sunnyvale/i.test(s)) { lat = 37.3688; lon = -122.0363; }
  else if (/san jose/i.test(s)) { lat = 37.3382; lon = -121.8863; }
  else if (/redwood city/i.test(s)) { lat = 37.4852; lon = -122.2364; }
  else if (/menlo park/i.test(s)) { lat = 37.4538; lon = -122.1822; }
  else if (/san francisco|sf\b/i.test(s)) { lat = 37.7749; lon = -122.4194; }
  else if (/bay area/i.test(s)) { lat = 37.7749; lon = -122.4194; }
  else if (/new york|nyc/i.test(s)) { lat = 40.7128; lon = -74.0060; }
  else if (/chicago/i.test(s)) { lat = 41.8781; lon = -87.6298; }
  else if (/seattle/i.test(s)) { lat = 47.6062; lon = -122.3321; }
  else if (/boston/i.test(s)) { lat = 42.3601; lon = -71.0589; }
  else if (/austin/i.test(s)) { lat = 30.2672; lon = -97.7431; }
  else if (/los angeles/i.test(s)) { lat = 34.0522; lon = -118.2437; }
  else if (/denver/i.test(s)) { lat = 39.7392; lon = -104.9903; }
  else if (/london/i.test(s)) { lat = 51.5074; lon = -0.1278; }
  else if (/vancouver/i.test(s)) { lat = 49.2827; lon = -123.1207; }
  else if (/toronto/i.test(s)) { lat = 43.6532; lon = -79.3832; }

  return { lat, lon, name: s };
}

/**
 * Parse pay string into numeric base dollar value for Notion number property.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parsePayNumber(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\*\*/g, '').trim();
  if (!s || s === '—' || s === '-' || /^(none|null|n\/?a|not stated|competitive)/i.test(s)) return null;

  const rangeMatch = s.match(/[$€£¥]?\s*([\d.,]+)\s*(k|m)?\s*(?:[-–—]|to)\s*[$€£¥]?\s*([\d.,]+)\s*(k|m)?/i);
  if (rangeMatch) {
    let num1 = parseFloat(rangeMatch[1].replace(/,/g, ''));
    let num2 = parseFloat(rangeMatch[3].replace(/,/g, ''));
    const k1 = rangeMatch[2];
    const k2 = rangeMatch[4];
    if ((k1 && k1.toLowerCase() === 'k') || (k2 && k2.toLowerCase() === 'k') || num1 < 1000) {
      if (num1 < 1000) num1 *= 1000;
      if (num2 < 1000) num2 *= 1000;
    }
    if (Number.isFinite(num1) && Number.isFinite(num2)) {
      return Math.min(num1, num2);
    }
  }

  const singleMatch = s.match(/[$€£¥]?\s*([\d.,]+)\s*(k|m)?/i);
  if (singleMatch) {
    let num = parseFloat(singleMatch[1].replace(/,/g, ''));
    const k = singleMatch[2];
    if ((k && k.toLowerCase() === 'k') || num < 1000) num *= 1000;
    if (Number.isFinite(num) && num >= 10000) {
      return num;
    }
  }
  return null;
}

/**
 * Clean a pay range string.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanPayRange(raw) {
  if (!raw || raw === '—' || raw === '-' || /^(none|null|n\/?a|not stated)$/i.test(raw)) return '';
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export default {
  parseScore,
  resolveReportPath,
  resolveRowUrl,
  resolvePageMarkdown,
  cleanLocation,
  resolveRowLocation,
  resolveRowPay,
  cleanPayRange,
  formatNotionPlace,
  parsePayNumber,

  /**
   * export: upsert each tracker row into the user's Notion Applications DB.
   * Diffs existing records: skips unchanged rows, applies in-place PATCH when only
   * properties (Status/Score/URL/Location/Pay) change, and only creates/replaces when new or report changes.
   * Receives a frozen read-only snapshot of the tracker — never a file handle.
   * @param {{ applications: Array<Record<string,string>> }} snapshot
   * @param {any} ctx
   */
  async export(snapshot, ctx) {
    const rows = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    if (rows.length === 0) return { pushed: 0, skipped: 0 };
    const client = clientFromCtx(ctx);
    const apps = await applicationsDb(client);
    const dataRoot = getCareerOpsRoot();

    // Cache existing database records once upfront with their properties and mtime
    let existingMap = new Map();
    try {
      const existingRaw = await client.queryDB(apps);
      for (const r of existingRaw) {
        const c = plain(r.properties?.Company).trim().toLowerCase();
        const ro = plain(r.properties?.Role).trim().toLowerCase();
        if (c && ro) {
          existingMap.set(`${c} / ${ro}`, {
            id: r.id,
            status: r.properties?.Status?.select?.name || '',
            score: typeof r.properties?.Score?.number === 'number' ? r.properties.Score.number : null,
            url: r.properties?.URL?.url || '',
            location: r.properties?.Location?.place?.name || '',
            pay: typeof r.properties?.Pay?.number === 'number' ? r.properties.Pay.number : null,
            lastEditedTime: r.last_edited_time ? new Date(r.last_edited_time).getTime() : 0,
          });
        }
      }
    } catch (err) {
      if (!ctx?.dryRun) throw err;
      ctx.log(`warning: could not fetch existing Notion records (${err.message})`);
    }

    let pushed = 0;
    let skipped = 0;
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

      const locationStr = resolveRowLocation(row, dataRoot);
      const placeProp = formatNotionPlace(locationStr);
      if (placeProp) props.Location = { place: placeProp };

      const payStr = resolveRowPay(row, dataRoot);
      const parsedPay = parsePayNumber(payStr);
      if (Number.isFinite(parsedPay)) props.Pay = { number: parsedPay };

      const key = `${company.toLowerCase()} / ${role.toLowerCase()}`;
      const existing = existingMap.get(key);

      const targetStatus = status || '';
      const targetScore = Number.isFinite(score) ? score : null;
      const targetUrl = url || '';
      const targetLocationName = placeProp ? placeProp.name : '';
      const targetPayNum = Number.isFinite(parsedPay) ? parsedPay : null;

      const reportFilePath = resolveReportPath(row, dataRoot);
      let reportMtime = 0;
      if (reportFilePath) {
        try { reportMtime = statSync(reportFilePath).mtimeMs; } catch {}
      }

      const statusDiff = existing ? (targetStatus !== existing.status) : false;
      const scoreDiff = existing ? (targetScore !== existing.score) : false;
      const urlDiff = existing ? (targetUrl !== existing.url) : false;
      const locationDiff = existing ? (targetLocationName !== existing.location) : false;
      const payDiff = existing ? (targetPayNum !== existing.pay) : false;
      const propsChanged = statusDiff || scoreDiff || urlDiff || locationDiff || payDiff;

      // Report file modified since last edit (with 5s buffer for clock skew)
      const reportModified = existing && reportMtime > 0 ? (reportMtime > existing.lastEditedTime + 5000) : false;

      // Skip if existing and completely unchanged
      if (existing && !propsChanged && !reportModified) {
        skipped++;
        continue;
      }

      if (ctx?.dryRun) {
        const action = !existing ? 'create' : reportModified ? 'recreate with report' : 'patch properties';
        ctx.log(`would ${action}: ${company} — ${role}${url ? ` (${url})` : ''}${targetLocationName ? ` [${targetLocationName}]` : ''}${targetPayNum ? ` [$${targetPayNum}]` : ''}`);
        pushed++;
        continue;
      }

      const markdown = (reportModified || !existing) ? resolvePageMarkdown(row, dataRoot) : '';

      // Upsert: in-place patch if only properties changed, recreate if report body changed, create if new
      if (existing) {
        if (reportModified && markdown) {
          await client.api(`pages/${existing.id}`, 'PATCH', { in_trash: true });
          const created = await client.createPage(apps, props, markdown);
          if (created?.id) {
            existingMap.set(key, {
              id: created.id,
              status: targetStatus,
              score: targetScore,
              url: targetUrl,
              location: targetLocationName,
              pay: targetPayNum,
              lastEditedTime: Date.now(),
            });
          }
        } else if (propsChanged) {
          const patchProps = {};
          if (statusDiff && status) patchProps.Status = { select: { name: status } };
          if (scoreDiff && Number.isFinite(score)) patchProps.Score = { number: score };
          if (urlDiff && url) patchProps.URL = { url };
          if (locationDiff && placeProp) patchProps.Location = { place: placeProp };
          if (payDiff && targetPayNum !== null) patchProps.Pay = { number: targetPayNum };
          await client.api(`pages/${existing.id}`, 'PATCH', { properties: patchProps });
          existing.status = targetStatus;
          existing.score = targetScore;
          existing.url = targetUrl;
          existing.location = targetLocationName;
          existing.pay = targetPayNum;
        }
      } else {
        const created = await client.createPage(apps, props, markdown || undefined);
        if (created?.id) {
          existingMap.set(key, {
            id: created.id,
            status: targetStatus,
            score: targetScore,
            url: targetUrl,
            location: targetLocationName,
            pay: targetPayNum,
            lastEditedTime: Date.now(),
          });
        }
      }
      pushed++;
    }
    return { pushed, skipped };
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
