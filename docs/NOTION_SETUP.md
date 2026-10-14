# Notion plugin — setup walkthrough

Step-by-step setup for the bundled [`plugins/notion/`](../plugins/notion/) plugin: mirrors
`data/applications.md` into a Notion database (`export`) and can pull leads with a job
`URL` back into the pipeline (`search`). `data/applications.md` stays the source of
truth throughout — Notion is an opt-in mirror, not a replacement backend.

## 1. Create the Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**.
2. Type: **Internal** integration, associated with your workspace.
3. **Capabilities** — this is the part people get wrong, since Notion integrations
   default to zero access. Based on exactly what the plugin's API calls need:

   | Capability | Set to | Why |
   |---|---|---|
   | Read content | ✅ On | `export` looks up existing rows before upserting; `search` queries the DB |
   | Update content | ✅ On | `export` patches an existing Company+Role row's properties |
   | Insert content | ✅ On | `export` creates a new page when no matching row exists yet |
   | Read comments | ❌ Off | never called |
   | Insert comments | ❌ Off | never called |
   | User information | **No user information** (most restrictive) | the plugin never reads profiles or emails |

4. Save, then copy the **Internal Integration Secret** (starts `secret_` or `ntn_`) —
   this becomes `NOTION_ACCESS_TOKEN`.

## 2. Build the database

1. In Notion, create a page named **"Career Ops"** (any parent is fine — this page is
   just a container the plugin walks for child databases).
2. Under it, add a database named **exactly** `Applications` — the plugin resolves it
   by this literal name (`resolveDBs()` in `_notion.mjs`) and throws if it's missing
   rather than creating it for you.
3. Give it these properties, with these **exact types** (the plugin writes typed
   property payloads, so a mismatched type will fail on export):

   | Property | Type | Notes |
   |---|---|---|
   | `Role` | **Title** | Must be the database's title property — the plugin sends `{ title: [...] }` for it |
   | `Company` | Text (rich text) | |
   | `Status` | Select | New option values are created automatically on first write if they don't exist yet, as long as Update content is on |
   | `Score` | Number | |
   | `URL` | URL | Automatically populated from the job posting URL (from the tracker row or linked evaluation report) |
   | `Location` | **Place** | Written only for cities the plugin can place on a map (a built-in list); "Remote" and unrecognised places are left blank, never pinned at a guessed spot |
   | `Pay` | Number | The low end of the pay range, in dollars, from the tracker's `Pay Range` column or the report's `advertised_comp` |

   Add both before the first export. Export writes them whenever a row has a
   location or pay, and Notion rejects a write to a property that does not exist.

4. Share the **Career Ops page** (not just the database) with your integration:
   page **•••** menu → **Connections** → add your integration by name.

## 3. Get the parent page ID

Open the Career Ops page in the browser and copy the 32-character id from the URL
(the segment right before any `?v=` query string) — this becomes
`NOTION_PARENT_PAGE_ID`.

## 4. Enable the plugin locally

```bash
cp config/plugins.example.yml config/plugins.yml   # if you haven't already
```

Edit `config/plugins.yml`:

```yaml
notion:
  enabled: true
```

## 5. Add secrets to `.env`

```
NOTION_ACCESS_TOKEN=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 6. Verify + run

```bash
node doctor.mjs --json                          # confirm notion shows configured
node plugins.mjs run notion export --dry-run     # preview what would be pushed
node plugins.mjs run notion export               # push tracker rows into Notion
```

Optional — pull leads that have a URL back into the pipeline:

```bash
node plugins.mjs run notion search "<query>"
```

## Scope, honestly

- `export` mirrors Role, Company, Status, Score, URL, Location and Pay (URL, location and pay come from the tracker row or the linked report). It never clears a value already in Notion, and it never touches notes or follow-up data. The linked report is also written as the page body when a row is first created.
- A changed report does **not** rewrite an existing page by default: Notion has no body-update call this plugin uses, so a refresh means trashing the page and creating a new one, which loses anything you added in Notion and changes the page id. Set `NOTION_REFRESH_REPORTS=true` in `.env` to allow it; the replacement is created before the old page is trashed.
- `set-status.mjs` and `merge-tracker.mjs` push changes to Notion automatically when the plugin is enabled. This is best-effort: a failure prints a warning and never blocks the tracker update, and each sync is capped (20s for a status change, 120s for a merge).
- `search` is a separate lead-discovery path for untracked leads added directly in Notion — rows carrying a tracker status are excluded to prevent duplicate loops.
- Once rows exist in the database, Notion's native views (Board grouped by Status,
  Calendar, filters/sorts) work for free on top — those are just views over whatever
  properties exist, independent of what the plugin writes.
