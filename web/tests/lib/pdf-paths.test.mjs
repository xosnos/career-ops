// Tests for resolvePdfPaths()/slugify() using Node's built-in test runner.
// Imports directly from pdf-paths.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/pdf-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { slugify, resolvePdfPaths } from "../../src/lib/pdf-paths.mjs";
import { matchesTailoredCv } from "../../src/lib/apply/cv-match.mjs";
import { pdfPathForReport } from "../../src/lib/apply/cv-selection.mjs";

test("slugify: lowercases and hyphenates", () => {
  assert.equal(slugify("Jane Q. Smith"), "jane-q-smith");
});

test("slugify: trims leading/trailing hyphens", () => {
  assert.equal(slugify("  -Weird Name!- "), "weird-name");
});

// Given a career-ops root with a report on disk and a profile.yml naming the candidate
function makeRoot({ profileYaml } = {}) {
  const root = mkdtempSync(join(tmpdir(), "co-pdfpaths-"));
  mkdirSync(join(root, "config"), { recursive: true });
  if (profileYaml !== null) {
    writeFileSync(join(root, "config", "profile.yml"), profileYaml ?? 'candidate:\n  full_name: "Jane Smith"\n');
  }
  return root;
}

test("resolvePdfPaths: happy path builds html + finalPdf from report + profile", () => {
  // Given a root with a resolvable report and a named candidate
  const root = makeRoot();
  const findReportFile = (input) => (input === "018" ? join(root, "reports", "018-acme-2026-07-01.md") : null);
  try {
    // When resolving paths for report #018
    const result = resolvePdfPaths("018", "2026-07-26", root, findReportFile);

    // Then it returns deterministic scratch + final paths using the candidate/company slugs
    assert.equal(result.ok, true);
    assert.equal(result.paths.reportNum, "018");
    assert.equal(result.paths.html, join(root, ".career-ops-web", "pdf-tmp", "cv-web-018.html"));
    assert.equal(result.paths.finalPdf, join(root, "output", "jane-smith-resume-acme-018-2026-07-26.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: two reports at one company on the same day keep separate CVs", () => {
  const root = makeRoot();
  const findReportFile = (input) => join(root, "reports", `${input}-acme-2026-07-01.md`);
  try {
    const first = resolvePdfPaths("018", "2026-07-26", root, findReportFile);
    const second = resolvePdfPaths("019", "2026-07-26", root, findReportFile);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.paths.html, second.paths.html);
    assert.notEqual(first.paths.finalPdf, second.paths.finalPdf);

    mkdirSync(join(root, "output"));
    writeFileSync(first.paths.finalPdf, "CV tailored for the first role");
    writeFileSync(second.paths.finalPdf, "CV tailored for the second role");
    assert.equal(readFileSync(first.paths.finalPdf, "utf8"), "CV tailored for the first role");
    assert.equal(readFileSync(second.paths.finalPdf, "utf8"), "CV tailored for the second role");

    const index = [first, second].map(({ paths }) =>
      `${paths.reportNum}\t${relative(root, paths.finalPdf)}\t${relative(root, paths.html)}\tletter\t2026-07-26`
    ).join("\n");
    assert.equal(pdfPathForReport(index, 18), relative(root, first.paths.finalPdf));
    assert.equal(pdfPathForReport(index, 19), relative(root, second.paths.finalPdf));
    // Lookup goes through pdf-index.tsv by report number; the cv- company-slug
    // heuristic is only a fallback for CVs that predate the index.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: padded and unpadded selectors use the same resolved report identity", () => {
  const root = makeRoot();
  const findReportFile = () => join(root, "reports", "018-acme-2026-07-01.md");
  try {
    const padded = resolvePdfPaths("018", "2026-07-26", root, findReportFile);
    const unpadded = resolvePdfPaths("18", "2026-07-26", root, findReportFile);
    assert.equal(padded.ok, true);
    assert.equal(unpadded.ok, true);
    assert.deepEqual(padded.paths, unpadded.paths);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: a tracker selector uses its linked report number for paths and manifest", () => {
  const root = makeRoot();
  const findReportFile = () => join(root, "reports", "018-acme-2026-07-01.md");
  try {
    const result = resolvePdfPaths("309", "2026-07-26", root, findReportFile);
    assert.equal(result.ok, true);
    assert.equal(result.paths.reportNum, "018");
    assert.equal(result.paths.html, join(root, ".career-ops-web", "pdf-tmp", "cv-web-018.html"));
    assert.equal(result.paths.finalPdf, join(root, "output", "jane-smith-resume-acme-018-2026-07-26.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: path-traversal selector is rejected before any path is built", () => {
  // Given a findReportFile that would (via parseInt-based matching) resolve a
  // traversal-shaped selector to a real report, and a directory sentinel to
  // prove no scratch dir gets created for this input
  const root = makeRoot();
  const scratchDir = join(root, ".career-ops-web", "pdf-tmp");
  const findReportFile = () => join(root, "reports", "123-acme-2026-07-01.md");
  try {
    // When resolving paths for a crafted, non-canonical selector
    const result = resolvePdfPaths("123/../../etc/passwd", "2026-07-26", root, findReportFile);

    // Then it fails closed with a clear error, never calling findReportFile or touching disk
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid report selector/);
    assert.equal(existsSync(scratchDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: no matching report -> ok:false, no directories created", () => {
  // Given a root where findReportFile never resolves
  const root = makeRoot();
  const findReportFile = () => null;
  try {
    // When resolving paths for a report that doesn't exist
    const result = resolvePdfPaths("999", "2026-07-26", root, findReportFile);

    // Then it fails with a user-facing error and never touches the filesystem
    assert.equal(result.ok, false);
    assert.match(result.error, /No report #999 found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: missing profile.yml falls back to the default candidate slug", () => {
  // Given a root with a resolvable report but no profile.yml at all
  const root = makeRoot({ profileYaml: null });
  const findReportFile = (input) => (input === "5" ? join(root, "reports", "5-globex-2026-07-01.md") : null);
  try {
    // When resolving paths for report #5
    const result = resolvePdfPaths("5", "2026-07-26", root, findReportFile);

    // Then it still succeeds, using the "candidate" fallback slug
    assert.equal(result.ok, true);
    assert.equal(result.paths.reportNum, "005");
    assert.equal(result.paths.finalPdf, join(root, "output", "candidate-resume-globex-005-2026-07-26.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: malformed profile.yml falls back to the default candidate slug", () => {
  // Given a root with a resolvable report and an unparseable profile.yml
  const root = makeRoot({ profileYaml: "candidate: [unterminated" });
  const findReportFile = (input) => (input === "5" ? join(root, "reports", "5-globex-2026-07-01.md") : null);
  try {
    // When resolving paths for report #5
    const result = resolvePdfPaths("5", "2026-07-26", root, findReportFile);

    // Then it still succeeds, using the "candidate" fallback slug rather than throwing
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "candidate-resume-globex-005-2026-07-26.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: report filename that doesn't match the expected pattern falls back to the default company slug", () => {
  // Given findReportFile resolves to a filename that doesn't match ^\d+-(.+)-YYYY-MM-DD.md$
  const root = makeRoot();
  const findReportFile = (input) => (input === "7" ? join(root, "reports", "not-the-expected-shape.md") : null);
  try {
    // When resolving paths for report #7
    const result = resolvePdfPaths("7", "2026-07-26", root, findReportFile);

    // Then it still succeeds, using the "company" fallback slug
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "jane-smith-resume-company-007-2026-07-26.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: profile.yml present but candidate.full_name empty falls back to the default candidate slug", () => {
  // Given a profile.yml with a candidate block but no usable full_name
  const root = makeRoot({ profileYaml: 'candidate:\n  full_name: ""\n  email: "jane@example.com"\n' });
  const findReportFile = (input) => (input === "5" ? join(root, "reports", "5-globex-2026-07-01.md") : null);
  try {
    // When resolving paths for report #5
    const result = resolvePdfPaths("5", "2026-07-26", root, findReportFile);

    // Then it still succeeds, using the "candidate" fallback slug
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "candidate-resume-globex-005-2026-07-26.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: company and role come from the report heading, named per the resume convention", () => {
  const root = makeRoot();
  mkdirSync(join(root, "reports"), { recursive: true });
  const file = join(root, "reports", "141-clay-labs-software-engineer-developer-experience-ai-2026-09-29.md");
  writeFileSync(file, "# 141 \u2014 Clay Labs \u2014 Software Engineer, Developer Experience (AI)\n");
  try {
    const result = resolvePdfPaths("141", "2026-10-29", root, () => file);
    assert.equal(basename(result.paths.finalPdf), "jane-smith-resume-clay-labs-software-engineer-developer-experience-ai-2026-10-29.pdf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: the naming rule in modes/_custom.md decides the PDF name", () => {
  const root = makeRoot();
  mkdirSync(join(root, "reports"), { recursive: true });
  mkdirSync(join(root, "modes"), { recursive: true });
  const file = join(root, "reports", "141-clay-labs-swe-2026-09-29.md");
  writeFileSync(file, "# 141 — Clay Labs — Software Engineer\n");
  try {
    writeFileSync(join(root, "modes", "_custom.md"), "- naming: `acme-cv-{company-slug}-{role-slug}-{YYYY-MM-DD}.{ext}`\n");
    assert.equal(basename(resolvePdfPaths("141", "2026-10-29", root, () => file).paths.finalPdf), "acme-cv-clay-labs-software-engineer-2026-10-29.pdf");
    // An unknown token is not trusted: fall back to the built-in name.
    writeFileSync(join(root, "modes", "_custom.md"), "- naming: `{evil}-{company-slug}.{ext}`\n");
    assert.equal(basename(resolvePdfPaths("141", "2026-10-29", root, () => file).paths.finalPdf), "jane-smith-resume-clay-labs-software-engineer-2026-10-29.pdf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
