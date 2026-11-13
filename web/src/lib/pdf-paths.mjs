/**
 * pdf-paths.mjs — deterministic scratch + final paths for a web "pdf" run (#2172).
 *
 * Plain .mjs (same pattern as clean-chips.mjs / tracker-table.mjs) so this can
 * be unit-tested with `node --test`, no TypeScript build step. `careerOpsRoot`
 * and `findReportFile` are passed in rather than imported from career-ops.ts,
 * keeping this module free of TypeScript dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";

/**
 * Lowercase, non-alphanumeric runs -> single hyphen, trimmed.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Read the resume filename template from the user's modes/_custom.md, e.g.
 * `steven-nguyen-resume-{company-slug}-{role-slug}-{YYYY-MM-DD}.{ext}`. Only a
 * backticked line containing {company-slug} and ending in .{ext} counts, and only
 * the four known tokens are allowed: anything else returns null so the caller
 * falls back to the built-in name instead of writing a stray literal.
 * @param {string} root - Data root.
 * @returns {string | null}
 */
export function readResumeNameTemplate(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "modes", "_custom.md"), "utf8");
  } catch {
    return null;
  }
  for (const m of text.matchAll(/`([^`\n]*\{company-slug\}[^`\n]*\.\{ext\})`/g)) {
    const tokens = m[1].match(/\{[^}]*\}/g) ?? [];
    if (!tokens.every((t) => ["{company-slug}", "{role-slug}", "{YYYY-MM-DD}", "{ext}"].includes(t))) continue;
    if (!/^[a-z0-9.{}-]+$/i.test(m[1])) continue;
    return m[1];
  }
  return null;
}

/**
 * @typedef {Object} PdfPaths
 * @property {string} reportNum - Canonical report number, used for filenames and the PDF manifest.
 * @property {string} reportFile - Resolved report path relative to the data root, used by the tailoring prompt.
 * @property {string} html - Where the backend writes the tailored HTML it parsed out of the agent's envelope (#2185).
 * @property {string} finalPdf - Where the backend renders the final PDF (output/{candidate}-resume-{company}-{role}-{date}.pdf, the naming rule in modes/_custom.md when it has one; the report number stands in for an unreadable role).
 */

/**
 * Precompute the scratch HTML and final PDF paths for a
 * "pdf" run, so the agent never chooses its own filenames — the backend owns
 * naming, writing (#2185) and rendering. Resolves the report for its identity
 * and company slug, and config/profile.yml for the candidate slug. Including
 * the report number keeps same-company CVs generated on one day separate.
 *
 * Framework-agnostic: returns a result instead of constructing a Response, so
 * the caller (a Next.js route today) decides how to surface `ok: false`.
 *
 * Side effect: creates `.career-ops-web/pdf-tmp/` under `root` if it doesn't
 * exist yet (the backend writes the parsed envelope there, #2185) — this is
 * NOT a pure path computation, despite the name.
 *
 * @param {string} input - The application/report selector (e.g. "018").
 * @param {string} today - YYYY-MM-DD.
 * @param {string} root - careerOpsRoot().
 * @param {(input: string) => string | null} findReportFile - career-ops.ts's findReportFile.
 * @returns {{ok: true, paths: PdfPaths} | {ok: false, error: string}}
 */
export function resolvePdfPaths(input, today, root, findReportFile) {
  // Reject anything but a bare report number before it ever reaches a path.
  // findReportFile()'s parseInt-based matching can still resolve a crafted
  // selector like "123/../../etc/passwd" to a legitimate report file, but the
  // selector must never become a path segment unless it is purely numeric.
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  const reportName = path.basename(reportFile);
  // A tracker application can point to a differently numbered report. Use
  // that resolved report's number, not the selector, for the file and manifest.
  // Normalize padding without converting to Number, which can lose digits.
  const reportNum = (reportName.match(/^(\d+)-/)?.[1] ?? input)
    .replace(/^0+(?=\d)/, "")
    .padStart(3, "0");
  const companyMatch = reportName.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  // The report filename slug is "{company}-{role}" with no boundary between
  // them, so read both from the report's "# NNN — Company — Role" heading.
  // Unreadable or unparseable: the whole filename slug stands in for the company.
  let companySlug = companyMatch ? companyMatch[1] : "company";
  let roleSlug = "";
  try {
    const h1 = fs.readFileSync(reportFile, "utf8").split("\n", 1)[0];
    const m = h1.match(/^#\s+\d+\s+[—–-]\s+(.+?)\s+[—–]\s+(.+?)\s*$/);
    if (m && slugify(m[1])) {
      companySlug = slugify(m[1]);
      roleSlug = slugify(m[2]);
    }
  } catch { /* unreadable report: keep the filename slug */ }
  let candidateSlug = "candidate";
  try {
    // js-yaml v4's load() uses the safe default schema (no arbitrary type
    // construction, unlike Python's PyYAML) — same pattern already used in
    // web/src/app/api/profile/route.ts and portals/route.ts.
    const profile = yaml.load(fs.readFileSync(getProfilePath(root), "utf8"));
    if (profile?.candidate?.full_name) candidateSlug = slugify(profile.candidate.full_name);
  } catch (err) {
    // A missing profile.yml is expected (not every checkout has one yet) and
    // falls back silently. Anything else — a real YAML syntax error in the
    // user's own file — should not fail silently forever; it would otherwise
    // produce a wrong-but-plausible-looking filename with zero signal.
    if (err?.code !== "ENOENT") {
      console.warn(`resolvePdfPaths: could not read/parse config/profile.yml, defaulting candidate slug: ${err.message}`);
    }
  }
  // The user's own naming rule wins; the report number stands in for a role we
  // could not read so two roles at one company never share a name.
  const role = roleSlug || reportNum;
  const template = readResumeNameTemplate(root);
  const pdfName = template
    ? template.replace("{company-slug}", companySlug).replace("{role-slug}", role).replace("{YYYY-MM-DD}", today).replace("{ext}", "pdf")
    : `${candidateSlug}-resume-${companySlug}-${role}-${today}.pdf`;
  const scratchDir = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(scratchDir, { recursive: true });
  return {
    ok: true,
    paths: {
      reportNum,
      reportFile: path.relative(root, reportFile).split(path.sep).join("/"),
      html: path.join(scratchDir, `cv-web-${reportNum}.html`),
      finalPdf: path.join(root, "output", pdfName),
    },
  };
}
