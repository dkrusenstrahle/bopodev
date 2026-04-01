# Company file export and import (zip)

Operators can treat a company as a **folder of files**: export a `.zip`, edit markdown and YAML locally, and import a new company from that archive.

## Layout inside the zip

- **`.bopo.yaml`** — Machine-readable manifest (`schema: bopo/company-export/v1`): company, projects, agents (with slugs), optional **goals** (stable slugs, hierarchy via `parentGoalSlug`), scheduled routines (`routines` in the export manifest).
- **`COMPANY.md`**, **`README.md`** — Human-oriented summary and mission.
- **`projects/<slug>/PROJECT.md`** — Project front matter + description.
- **`agents/<slug>/...`** — Operating docs from the instance workspace (e.g. `AGENTS.md`, `HEARTBEAT.md`). **`agents/<slug>/memory/...`** is included in exports from the UI when present.
- **`tasks/<slug>/TASK.md`** — Scheduled loop summary and cron metadata.
- **`skills/...`** — Text files under the company workspace `skills/` directory, if present.

Slugs are derived from names and stabilized for the archive; database ids live only in `.bopo.yaml` for traceability.

## Where to use it in the UI

With a company selected, open **Templates** in the workspace and use the **Export** and **Import** tabs (the **Templates** tab holds the template list and metrics). **Export** lists every path, supports search and checkboxes, previews text, and downloads **`company-<id>-export.zip`**. **Import** lets board-role members pick a zip, see a short **preview** (counts and validation), then confirm to create a **new** company. **Create company** can optionally start from a **builtin template** (same catalog as Templates—e.g. Founder Startup Basic, Marketing Content Engine). Your company name and mission fill template variables; the dialog’s provider/model applies to the lead agent (CEO, or Head of Marketing for marketing packs). Optional zip-only starters can still be added under `apps/api` assets for edge cases.

## API

See [`../developer/api-reference.md`](../developer/api-reference.md) under **Companies** for manifest, preview, zip POST, and import routes.
