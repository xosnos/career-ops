// @ts-check
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { loadPluginConfig, loadDotenvOnce } from '../_engine.mjs';
import { createNotionClient, rich, canonicalStatus, plain } from './_notion.mjs';
import notionPlugin, {
  resolveReportPath, resolveRowUrl, resolvePageMarkdown, parseScore,
  formatNotionPlace, parsePayNumber, resolveRowLocation, resolveRowPay,
} from './index.mjs';

/**
 * Check whether the Notion plugin is enabled and configured with required credentials.
 *
 * @param {string} [dataRoot]
 * @returns {Promise<boolean>}
 */
export async function isNotionConfigured(dataRoot = getCareerOpsRoot()) {
  try {
    const cfg = await loadPluginConfig(dataRoot);
    if (cfg?.plugins?.notion?.enabled !== true) return false;
    await loadDotenvOnce(dataRoot);
    const token = process.env.NOTION_ACCESS_TOKEN;
    const parent = process.env.NOTION_PARENT_PAGE_ID;
    return Boolean(token && parent);
  } catch {
    return false;
  }
}

/**
 * Resolve client and Applications database ID if configured.
 *
 * @param {string} dataRoot
 * @returns {Promise<{ client: any, appsDb: string } | null>}
 */
async function resolveNotionContext(dataRoot) {
  const configured = await isNotionConfigured(dataRoot);
  if (!configured) return null;

  const client = createNotionClient({
    token: process.env.NOTION_ACCESS_TOKEN,
    parent: process.env.NOTION_PARENT_PAGE_ID,
  });
  const dbs = await client.resolveDBs();
  const appsDb = dbs['Applications'];
  if (!appsDb) return null;
  return { client, appsDb };
}

/**
 * Synchronize a single application status update to Notion in-place.
 *
 * @param {object} opts
 * @param {string} opts.company
 * @param {string} opts.role
 * @param {string} opts.status
 * @param {string} [opts.score]
 * @param {string} [opts.url]
 * @param {string} [opts.location]
 * @param {string|number} [opts.pay]
 * @param {string} [opts.report]
 * @param {string} [opts.dataRoot]
 * @returns {Promise<{ synced: boolean, action?: string, id?: string, error?: string }>}
 */
export async function syncNotionStatus({
  company,
  role,
  status,
  score,
  url,
  location,
  pay,
  report,
  dataRoot = getCareerOpsRoot(),
}) {
  if (process.env.NODE_ENV === 'test' || !company || !role) {
    return { synced: false, action: 'skipped' };
  }

  try {
    const ctx = await resolveNotionContext(dataRoot);
    if (!ctx) return { synced: false, action: 'not-configured' };

    const { client, appsDb } = ctx;
    const cleanCompany = company.trim();
    const cleanRole = role.trim();
    const targetStatus = canonicalStatus(status);

    // Query Notion database filtered by Company for fast lookup
    const res = await client.queryDB(appsDb, {
      filter: {
        property: 'Company',
        rich_text: { equals: cleanCompany },
      },
    });

    const match = (res || []).find(
      (r) => plain(r.properties?.Role).trim().toLowerCase() === cleanRole.toLowerCase()
    );

    const fakeRow = { company: cleanCompany, role: cleanRole, score, status, url, location, pay, report };
    const resolvedLocation = location || resolveRowLocation(fakeRow, dataRoot);
    const resolvedPay = pay !== undefined ? pay : resolveRowPay(fakeRow, dataRoot);

    if (match) {
      const currentStatus = match.properties?.Status?.select?.name || '';
      const patchProps = {};
      if (targetStatus && targetStatus !== currentStatus) {
        patchProps.Status = { select: { name: targetStatus } };
      }
      if (resolvedLocation) {
        const placeProp = formatNotionPlace(resolvedLocation);
        if (placeProp && placeProp.name !== match.properties?.Location?.place?.name) {
          patchProps.Location = { place: placeProp };
        }
      }
      if (resolvedPay !== undefined && resolvedPay !== '') {
        const numPay = parsePayNumber(resolvedPay);
        if (Number.isFinite(numPay) && numPay !== match.properties?.Pay?.number) {
          patchProps.Pay = { number: numPay };
        }
      }

      if (Object.keys(patchProps).length > 0) {
        await client.api(`pages/${match.id}`, 'PATCH', {
          properties: patchProps,
        });
        return { synced: true, action: 'updated', id: match.id };
      }
      return { synced: true, action: 'already-current', id: match.id };
    }

    // Row not found in Notion — create it with whatever details are available
    const props = {
      Role: { title: rich(cleanRole) },
      Company: { rich_text: rich(cleanCompany) },
    };
    if (targetStatus) props.Status = { select: { name: targetStatus } };
    const parsedScore = parseScore(score);
    if (Number.isFinite(parsedScore)) props.Score = { number: parsedScore };
    if (url) props.URL = { url };
    if (resolvedLocation) {
      const placeProp = formatNotionPlace(resolvedLocation);
      if (placeProp) props.Location = { place: placeProp };
    }
    if (resolvedPay !== undefined && resolvedPay !== '') {
      const numPay = parsePayNumber(resolvedPay);
      if (Number.isFinite(numPay)) props.Pay = { number: numPay };
    }

    const markdown = resolvePageMarkdown(fakeRow, dataRoot);
    const created = await client.createPage(appsDb, props, markdown || undefined);
    return { synced: true, action: 'created', id: created?.id };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

/**
 * Synchronize newly merged or updated applications to Notion.
 * Uses diff-aware export to sync only changed/added records.
 *
 * @param {string} [dataRoot]
 * @returns {Promise<{ synced: boolean, pushed?: number, skipped?: number, error?: string }>}
 */
export async function syncNotionAdditions(dataRoot = getCareerOpsRoot()) {
  if (process.env.NODE_ENV === 'test') {
    return { synced: false, action: 'skipped' };
  }

  try {
    const configured = await isNotionConfigured(dataRoot);
    if (!configured) return { synced: false, action: 'not-configured' };

    const appsPath = join(dataRoot, 'data', 'applications.md');
    if (!existsSync(appsPath)) return { synced: false, action: 'no-tracker' };

    const md = readFileSync(appsPath, 'utf8');
    const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    if (lines.length < 2) return { synced: false, action: 'empty-tracker' };

    const headers = lines[0].split('|').slice(1, -1).map((h) => h.trim().toLowerCase());
    const applications = [];
    for (const line of lines.slice(1)) {
      if (/^\|[\s|:-]+\|?$/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length === 0) continue;
      const row = {};
      headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
      applications.push(row);
    }

    const ctx = {
      env: {
        NOTION_ACCESS_TOKEN: process.env.NOTION_ACCESS_TOKEN,
        NOTION_PARENT_PAGE_ID: process.env.NOTION_PARENT_PAGE_ID,
      },
      log: () => {},
      dryRun: false,
    };

    const res = await notionPlugin.export({ applications }, ctx);
    return { synced: true, pushed: res.pushed, skipped: res.skipped };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}
