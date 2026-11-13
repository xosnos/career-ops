// Tests for the LaTeX (latex-tex) web pdf flow: patches envelope, source
// resolution, index record and the render pipeline with a fake child process.
// Run:  node --test tests/lib/latex-flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatchesEnvelope, createPatchesEnvelopeFilter, latexToPlain } from "../../src/lib/cv-patches-envelope.mjs";
import { resolveLatexSource } from "../../src/lib/latex-source.mjs";
import { recordLatexPdf, renderLatexAndMarkPdf } from "../../src/lib/pdf-render.mjs";
import { buildPrompt } from "../../src/lib/run-prompts.mjs";

const wrap = (body) => `intro\n<<cv-patches>>\n${body}\n<</cv-patches>>\nVERDICT: 5/5 — ok`;

test("parsePatchesEnvelope: accepts valid patches, tolerates a json fence", () => {
  const r = parsePatchesEnvelope(wrap('```json\n{"patches":[{"id":"bullet-0","text":"x"}]}\n```'), new Set(["bullet-0"]));
  assert.deepEqual(r.patches, [{ id: "bullet-0", text: "x" }]);
});

test("parsePatchesEnvelope: fails closed on unknown id, duplicate, empty, two envelopes, unclosed", () => {
  assert.equal(parsePatchesEnvelope(wrap('{"patches":[{"id":"nope","text":"x"}]}'), new Set(["a"])).ok, false);
  assert.equal(parsePatchesEnvelope(wrap('{"patches":[{"id":"a","text":"x"},{"id":"a","text":"y"}]}')).ok, false);
  assert.equal(parsePatchesEnvelope(wrap('{"patches":[]}')).ok, false);
  assert.equal(parsePatchesEnvelope(wrap("{}") + "\n" + wrap("{}")).ok, false);
  assert.equal(parsePatchesEnvelope("<<cv-patches>>\n{}").ok, false);
  assert.equal(parsePatchesEnvelope("no envelope").ok, false);
});

test("patches filter keeps the body out of the log but parses it across chunks", () => {
  const f = createPatchesEnvelopeFilter();
  const text = wrap('{"patches":[{"id":"a","text":"hello"}]}');
  let shown = "";
  for (let i = 0; i < text.length; i += 7) shown += f.push(text.slice(i, i + 7));
  shown += f.flush();
  assert.ok(!shown.includes("hello"));
  assert.ok(shown.includes("VERDICT"));
  assert.equal(f.result().patches[0].text, "hello");
});

test("resolveLatexSource: needs cv.output_format latex, finds documents/cv/resume.tex, stays inside root", () => {
  const root = mkdtempSync(join(tmpdir(), "co-latexsrc-"));
  try {
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "documents", "cv"), { recursive: true });
    writeFileSync(join(root, "documents", "cv", "resume.tex"), "x");
    writeFileSync(join(root, "config", "profile.yml"), "cv:\n  output_format: html\n");
    assert.equal(resolveLatexSource(root), null);
    writeFileSync(join(root, "config", "profile.yml"), "cv:\n  output_format: latex\n");
    assert.equal(resolveLatexSource(root), join(root, "documents", "cv", "resume.tex"));
    writeFileSync(join(root, "config", "profile.yml"), "cv:\n  output_format: latex\nlatex:\n  source: ../../etc/passwd\n");
    assert.equal(resolveLatexSource(root), join(root, "documents", "cv", "resume.tex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordLatexPdf: supersedes the report's CV row, keeps its cover row and other reports", () => {
  const root = mkdtempSync(join(tmpdir(), "co-latexidx-"));
  const indexPath = join(root, "data", "pdf-index.tsv");
  try {
    mkdirSync(join(root, "data"));
    writeFileSync(indexPath, "# header\n141\toutput/old.pdf\told.html\tletter\t2026-01-01\tcv\n141\toutput/cover.pdf\tc.html\tletter\t2026-01-01\tcover\n7\toutput/o.pdf\to.tex\tletter\t2026-01-01\n");
    recordLatexPdf({ indexPath, root, reportNum: "141", pdf: join(root, "output", "n.pdf"), tex: join(root, "output", "n.tex"), format: "letter", today: "2026-10-29" });
    const lines = readFileSync(indexPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    assert.ok(!lines.some((l) => l.includes("old.pdf")));
    assert.ok(lines.some((l) => l.includes("cover.pdf")));
    assert.ok(lines.includes("141\toutput/n.pdf\toutput/n.tex\tletter\t2026-10-29\tcv"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeSpawn(routes, calls) {
  return (execPath, args, opts) => {
    calls.push({ args, opts });
    const route = Object.entries(routes).find(([suffix]) => args[0].endsWith(suffix))?.[1] ?? { exitCode: 0 };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (route.stdout) child.stdout.emit("data", Buffer.from(route.stdout));
      child.emit("close", route.exitCode);
    });
    return child;
  };
}

test("renderLatexAndMarkPdf: patches, compiles from the code root, records index, marks tracker", async () => {
  const root = mkdtempSync(join(tmpdir(), "co-latexrender-"));
  try {
    const scratch = join(root, ".career-ops-web", "pdf-tmp");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(root, "data"));
    const pdfPaths = { html: join(scratch, "cv-web-141.html"), finalPdf: join(root, "output", "me-resume-acme-swe-2026-10-29.pdf") };
    const calls = [];
    const spawnFn = fakeSpawn({ "generate-latex.mjs": { exitCode: 0, stdout: JSON.stringify({ compiled: true }) }, "mark-pdf-ready.mjs": { exitCode: 0, stdout: "{}" } }, calls);
    const result = await renderLatexAndMarkPdf({
      spawnFn, execPath: "node", root, codeRoot: "/code", sourceTex: "/src/resume.tex", slots: [{ id: "a" }], patches: [{ id: "a", text: "t" }],
      pdfPaths, indexPath: join(root, "data", "pdf-index.tsv"), today: "2026-10-29", reportNum: "141",
    });
    assert.equal(result.kind, "rendered");
    assert.deepEqual(calls.map((c) => c.args[0]), ["/code/patch-latex-content.mjs", "/code/generate-latex.mjs", "/code/mark-pdf-ready.mjs"]);
    assert.deepEqual(calls[1].args.slice(1), [pdfPaths.finalPdf.replace(/\.pdf$/, ".tex"), pdfPaths.finalPdf, "--compile-only", "--source", "/src/resume.tex"]);
    assert.equal(calls[0].opts.cwd, root);
    assert.equal(calls[1].opts.cwd, root);
    assert.equal(calls[2].opts.cwd, "/code");
    assert.ok(calls.every((c) => c.opts.env.CAREER_OPS_ROOT === root));
    assert.match(readFileSync(join(root, "data", "pdf-index.tsv"), "utf8"), /^141\toutput\/me-resume-acme-swe-2026-10-29\.pdf\toutput\/me-resume-acme-swe-2026-10-29\.tex\tletter\t2026-10-29\tcv$/m);
    assert.equal(existsSync(join(scratch, "cv-web-141.patches.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderLatexAndMarkPdf: a fact-gate block fails the render and never marks the tracker", async () => {
  const root = mkdtempSync(join(tmpdir(), "co-latexrender-"));
  try {
    const scratch = join(root, ".career-ops-web", "pdf-tmp");
    mkdirSync(scratch, { recursive: true });
    const calls = [];
    const spawnFn = fakeSpawn({ "generate-latex.mjs": { exitCode: 1, stdout: JSON.stringify({ compiled: false, factCheck: { verdict: "block", reason: "Fact check failed for x.tex: non-metric facts absent from sources: tool=ai-assisted. cv.md and article-digest.md do not contain these claims." } }) } }, calls);
    const result = await renderLatexAndMarkPdf({
      spawnFn, execPath: "node", root, sourceTex: "/s.tex", slots: [], patches: [{ id: "a", text: "t" }],
      pdfPaths: { html: join(scratch, "cv-web-1.html"), finalPdf: join(root, "output", "x.pdf") }, today: "2026-10-29", reportNum: "1",
    });
    assert.equal(result.kind, "render-failed");
    assert.match(result.error, /fact check blocked/i);
    assert.match(result.error, /tool=ai-assisted/);
    assert.ok(!calls.some((c) => c.args[0].endsWith("mark-pdf-ready.mjs")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrompt: latexSlots switches the pdf prompt to slot patching", () => {
  const p = buildPrompt({ kind: "pdf", input: "141", memory: "", today: "2026-10-29", latexSlots: [{ id: "bullet-0", kind: "bullet", text: "Did a thing", span: { start: 1, end: 2 } }] });
  assert.match(p, /latex-tex/);
  assert.match(p, /"id": "bullet-0"/);
  assert.match(p, /<<cv-patches>>/);
  assert.ok(!p.includes('"span"'));
  assert.ok(!/^<<cv-patches>>/m.test(p));
});

test("latexToPlain: slots are shown unescaped and a patch with escapes is normalized", () => {
  assert.equal(latexToPlain("cut time by 35\\% & more"), "cut time by 35% & more");
  const r = parsePatchesEnvelope(wrap('{"patches":[{"id":"a","text":"by 40\\\\% in R\\\\&D"}]}'));
  assert.equal(r.patches[0].text, "by 40% in R&D");
  const p = buildPrompt({ kind: "pdf", input: "1", memory: "", today: "2026-10-29", latexSlots: [{ id: "a", kind: "bullet", text: "up 35\\% faster" }] });
  assert.ok(p.includes("up 35% faster"));
  assert.match(p, /REAL tailoring/);
});
