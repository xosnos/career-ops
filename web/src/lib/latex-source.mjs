/**
 * latex-source.mjs — decide whether a web pdf run tailors the user's own .tex.
 *
 * modes/latex-tex.md resolves the source from `latex.source`, then resume.tex,
 * then cv.tex in the project root. This adds documents/cv/resume.tex, where the
 * intake flow keeps the user's original. The LaTeX path is opt-in through
 * `cv.output_format: latex` in config/profile.yml, the same switch the CLI uses;
 * without it the web keeps rendering HTML.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { getProfilePath } from "./core/profile-path.mjs";

/**
 * @param {string} root - Data root.
 * @returns {string | null} Absolute path of the .tex to tailor, or null for the HTML path.
 */
export function resolveLatexSource(root) {
  let profile;
  try {
    profile = yaml.load(fs.readFileSync(getProfilePath(root), "utf8"));
  } catch {
    return null;
  }
  if (String(profile?.cv?.output_format ?? "").toLowerCase() !== "latex") return null;
  const configured = typeof profile?.latex?.source === "string" ? [profile.latex.source] : [];
  for (const rel of [...configured, "resume.tex", "cv.tex", path.join("documents", "cv", "resume.tex")]) {
    const abs = path.resolve(root, rel);
    // A configured path must stay inside the data root: the file is read and
    // its text is handed to an agent.
    if (path.relative(root, abs).startsWith("..") || path.isAbsolute(path.relative(root, abs))) continue;
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch { /* try the next candidate */ }
  }
  return null;
}
