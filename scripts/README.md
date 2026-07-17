# Documentation Import Scripts

Two scripts for importing and managing documentation in the Jekyll `_docs` collection.

## `import-docs.py`

Reads source markdown files **verbatim** (no content rewriting), prepends YAML frontmatter, and writes them to `_docs/{category}/{slug}.md`.

### Usage

1. Place your markdown file in the source directory:  
   `/run/media/maruf/TiTAN1UM/Backups/upay/git_upay/documentation/`

2. Register it in the `DOC_MAP` inside `import-docs.py`:

   ```python
   ("your-file.md", "category-name", "url-slug", order_number),
   ```

   If the file has **no H1 heading**, add a 5th parameter with the title:

   ```python
   ("file.md", "category", "slug", 70, "Manual Title Override"),
   ```

3. Run the script:

   ```bash
   python3 scripts/import-docs.py
   ```

### How it works

- **Title** — extracted from the first `#`/`##`/`###` heading in the file
- **Tags** — auto-detected from keywords in the first 50 lines (istio, cilium, kubernetes, postgresql, etc.)
- **`last_updated`** — set to today's date
- **Category + order** — taken from the `DOC_MAP` entry
- **Content** — preserved 100% verbatim; only frontmatter is prepended

---

## `generate-category-pages.py`

Creates `/docs/{category}/index.html` listing pages for every category found in `_docs/`.

### Usage

```bash
python3 scripts/generate-category-pages.py
```

Run this **after** adding docs to a new category so the category index page exists.

---

## Full workflow

```bash
# 1. Add your doc to DOC_MAP in import-docs.py
# 2. Import
python3 scripts/import-docs.py
# 3. If it's a new category, generate the index page
python3 scripts/generate-category-pages.py
# 4. Build and verify
bundle exec jekyll build
# 5. Commit and push
git add _docs/ docs/ scripts/
git commit -m "docs: add your description"
git push
```
