# .tools — Graph RAG Vault automation scripts

## Pipeline overview

```
downloaded_pages/  →  [pipeline.py]  →  refined_vault/active/  →  [quality tools]
```

---

## Conversion pipeline (initial run)

| Script | §Step | Description |
|---------|------|------|
| `pipeline.py` | §4 | Combined HTML / PPTX / DOCX → MD run |
| `refine_html_to_md.py` | §4.1 | Confluence HTML → Obsidian MD |
| `pptx_to_md.py` | §4.3 | PPTX → MD (one section per slide) |
| `docx_to_md.py` | §4.5 | DOCX → MD (style-based headings) |

## Refinement / enhancement tools

| Script | §Step | Description |
|---------|------|------|
| `normalize_frontmatter.py` | §6 | Auto-classify empty tags, insert ## 개요 heading, chief tag |
| `enhance_wikilinks.py` | §7 | Inject cluster links between files sharing tags |
| `inject_keywords.py` | §9 | Character/system names → wikilink at first occurrence |
| `gen_year_hubs.py` | §11 | Generate yearly hub files (회의록_YYYY.md) |
| `gen_index.py` | §14 | Generate _index.md + currentSituation.md |

## Maintenance tools

| Script | §Step | Description |
|---------|------|------|
| `check_quality.py` | §13 | Quality audit (isolated nodes/tags/headings/broken links) |
| `check_outdated.py` | §18 | Freshness check (stale specs, archived files) |
| `fix_image_links.py` | Bugfix | Restore image links for filenames containing parentheses |
| `incremental_update.py` | §4+ | Incremental conversion of new HTML + automatic pipeline run |

---

## Quick start

```bash
# 1. Initial conversion (HTML+PPTX+DOCX)
python pipeline.py --step all \
  --src /path/to/downloaded_pages \
  --vault /path/to/refined_vault

# 2. Refinement
python normalize_frontmatter.py /path/refined_vault/active
python enhance_wikilinks.py /path/refined_vault/active
python inject_keywords.py /path/refined_vault/active

# 3. Hub/index generation
python gen_year_hubs.py /path/refined_vault/active
python gen_index.py /path/refined_vault/active

# 4. Quality audit
python check_quality.py /path/refined_vault/active \
  --attachments /path/refined_vault/attachments --verbose

# 5. When new files are added later
python incremental_update.py \
  --src /path/downloaded_pages /path/downloaded_pages2 \
  --vault /path/refined_vault \
  --scripts /path/refined_vault/.manual/scripts \
  --full-pipeline
```
