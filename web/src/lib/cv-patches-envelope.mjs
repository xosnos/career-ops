/**
 * cv-patches-envelope.mjs — the LaTeX flavour of the pdf agent's output channel.
 *
 * With a user-owned resume.tex (modes/latex-tex.md), the agent tailors prose
 * slots instead of writing a whole HTML document. It emits the replacement text
 * as JSON between `<<cv-patches>>` markers; the backend validates it, applies it
 * with patch-latex-content.mjs and compiles. Same fail-closed rules as
 * cv-envelope.mjs: markers own their line, more than one envelope is refused,
 * and nothing is applied from a stream that never closed.
 */
import { createEnvelopeFilter } from "./cv-envelope.mjs";

/**
 * Slot text is raw LaTeX source, so a percent shows as `35\\%`. The patch script
 * escapes whatever it is given, so showing the agent the escaped form and taking
 * it back unchanged renders a literal backslash ("35\\textbackslash{}\\%").
 * Both directions go through here: slots are shown as plain text, and a patch that
 * still carries the escapes is normalized before it reaches the patcher.
 * @param {string} text
 * @returns {string}
 */
export function latexToPlain(text) {
  return String(text).replace(/\\([%&$#_{}])/g, "$1");
}

export const PATCHES_OPEN_MARK = "<<cv-patches>>";
export const PATCHES_CLOSE_MARK = "<</cv-patches>>";

const OPENER_SRC = String.raw`^<<cv-patches>>[ \t]*$`;
const CLOSER_SRC = String.raw`^<<\/cv-patches>>[ \t]*$`;
const OPENER = new RegExp(OPENER_SRC, "gm");
const CLOSER = new RegExp(CLOSER_SRC, "m");
const CLOSER_ALL = new RegExp(CLOSER_SRC, "gm");

/**
 * Described MID-LINE for the same reason as CV_ENVELOPE_INSTRUCTION: `codex exec`
 * echoes its prompt, and a line-start marker in the echo would parse as a second
 * envelope.
 */
export const PATCHES_ENVELOPE_INSTRUCTION =
  `Do NOT save or edit any file. Instead OUTPUT one JSON object between two marker lines: a first line containing only \`${PATCHES_OPEN_MARK}\`, then the JSON, then a final line containing only \`${PATCHES_CLOSE_MARK}\`. The JSON is {"patches":[{"id":"bullet-0","text":"..."}]} and every id must be one of the slot ids you were given, each at most once. The text is plain text with NO LaTeX escaping (the platform escapes it). Include only the slots you changed. Each marker appears exactly once.`;

/**
 * @param {string} text - Everything the agent emitted.
 * @param {Set<string>} [slotIds] - When given, every patch id must be in it.
 * @returns {{ok: true, patches: {id: string, text: string}[], warnings: string[]} | {ok: false, error: string}}
 */
export function parsePatchesEnvelope(text, slotIds) {
  if (typeof text !== "string") return { ok: false, error: "No agent output to read a CV patches envelope from." };
  const normalized = text.replace(/\r\n/g, "\n");
  const openers = [...normalized.matchAll(OPENER)];
  if (openers.length === 0) return { ok: false, error: "The agent emitted no <<cv-patches>> envelope, so there is no CV to build." };
  if (openers.length > 1) return { ok: false, error: `Found ${openers.length} <<cv-patches>> envelopes; refusing to guess which is the real one.` };
  const after = normalized.slice(openers[0].index + openers[0][0].length);
  const closer = CLOSER.exec(after);
  if (!closer) return { ok: false, error: "The <<cv-patches>> envelope was never closed — the output is incomplete." };
  // Models sometimes fence JSON even when told not to; the fence is not content.
  const body = after.slice(0, closer.index).trim().replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/, "");
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return { ok: false, error: `The <<cv-patches>> envelope was not valid JSON: ${err.message}` };
  }
  if (!data || !Array.isArray(data.patches)) return { ok: false, error: 'The <<cv-patches>> JSON has no "patches" array.' };
  const seen = new Set();
  const patches = [];
  for (const p of data.patches) {
    if (!p || typeof p.id !== "string" || typeof p.text !== "string" || !p.text.trim()) {
      return { ok: false, error: "A patch needs a string id and non-empty string text." };
    }
    if (seen.has(p.id)) return { ok: false, error: `Patch id "${p.id}" appears more than once.` };
    if (slotIds && !slotIds.has(p.id)) return { ok: false, error: `Patch id "${p.id}" is not a slot in the source .tex.` };
    seen.add(p.id);
    patches.push({ id: p.id, text: latexToPlain(p.text) });
  }
  if (patches.length === 0) return { ok: false, error: "The <<cv-patches>> envelope had no patches — nothing was tailored." };
  return { ok: true, patches, warnings: [] };
}

/** @param {Set<string>} [slotIds] */
export function createPatchesEnvelopeFilter(slotIds) {
  return createEnvelopeFilter({
    opener: OPENER,
    closerAll: CLOSER_ALL,
    openMark: PATCHES_OPEN_MARK,
    closeMark: PATCHES_CLOSE_MARK,
    parse: (raw) => parsePatchesEnvelope(raw, slotIds),
  });
}
