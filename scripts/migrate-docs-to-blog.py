#!/usr/bin/env python3
"""
Migrate _docs/ collection files to _posts/ blog posts.

For each doc:
- Converts layout from 'doc' to 'post'
- Adds date from last_updated (or file mtime as fallback)
- Maps category slug to display name
- Adds a read_time estimate based on word count
- Preserves all content
- Outputs to _posts/YYYY-MM-DD-<slug>.md
"""

import os
import re
import sys
import hashlib
from pathlib import Path
from datetime import datetime

SITE_ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = SITE_ROOT / "_docs"
POSTS_DIR = SITE_ROOT / "_posts"

CATEGORY_MAP = {
    "kubernetes": "Kubernetes",
    "postgresql": "PostgreSQL",
    "observability": "Observability",
    "cicd": "CI/CD",
    "android-security": "Android Security",
    "networking": "Networking",
    "linux": "Linux",
    "virtualization": "Virtualization",
}


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Extract YAML frontmatter and body from markdown content."""
    if not content.startswith("---"):
        return {}, content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content
    raw_fm = parts[1].strip()
    body = parts[2].strip()
    fm = {}
    for line in raw_fm.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            # Handle YAML lists inline [a, b, c]
            if val.startswith("[") and val.endswith("]"):
                items = [x.strip().strip("'\"") for x in val[1:-1].split(",") if x.strip()]
                fm[key] = items
            elif val.startswith('"') and val.endswith('"'):
                fm[key] = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                fm[key] = val[1:-1]
            else:
                fm[key] = val
    return fm, body


def estimate_read_time(text: str) -> int:
    """Estimate read time in minutes based on word count."""
    words = len(text.split())
    return max(1, round(words / 250))


def make_slug(title: str) -> str:
    """Create a URL-safe slug from a title."""
    slug = title.lower()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug.strip("-")


def migrate_doc(rel_path: Path) -> dict:
    """Migrate a single doc file to a blog post. Returns migration info."""
    full_path = DOCS_DIR / rel_path
    content = full_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)

    # Determine category from directory structure
    category_slug = rel_path.parts[0]  # e.g., 'kubernetes'
    category_display = CATEGORY_MAP.get(category_slug, category_slug.title())

    # Determine date
    date_str = fm.get("last_updated", "")
    if date_str:
        try:
            date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            date_obj = datetime.now()
    else:
        # Fallback to file mtime
        mtime = os.path.getmtime(full_path)
        date_obj = datetime.fromtimestamp(mtime)

    # Build new frontmatter
    title = fm.get("title", rel_path.stem.replace("-", " ").title())
    slug = make_slug(title)
    date_prefix = date_obj.strftime("%Y-%m-%d")

    # Ensure unique filename
    out_name = f"{date_prefix}-{slug}.md"
    out_path = POSTS_DIR / out_name

    # Handle collisions by appending category
    if out_path.exists():
        out_name = f"{date_prefix}-{category_slug}-{slug}.md"
        out_path = POSTS_DIR / out_name

    # Build tags - merge existing tags with category
    existing_tags = fm.get("tags", [])
    if isinstance(existing_tags, str):
        existing_tags = [t.strip() for t in existing_tags.split(",")]
    # Add category slug as tag if not already present
    cat_tag = category_slug.replace("-", " ")
    if cat_tag not in [t.lower() for t in existing_tags]:
        existing_tags.append(cat_tag)

    # Estimate read time
    read_time = estimate_read_time(body)

    # Build excerpt from first paragraph if not provided
    excerpt = fm.get("excerpt", "")
    if not excerpt:
        # Find first non-heading, non-empty line
        for line in body.split("\n"):
            line = line.strip()
            if line and not line.startswith("#") and not line.startswith("```") and not line.startswith(">"):
                excerpt = re.sub(r"[*_`\[\]]", "", line)[:180]
                break

    # Build new frontmatter
    new_fm_lines = [
        "---",
        "layout: post",
        f"title: \"{title}\"",
        f"date: {date_prefix}",
        f"category: {category_display}",
        f"tags: [{', '.join(existing_tags)}]",
    ]
    if excerpt:
        new_fm_lines.append(f"excerpt: \"{excerpt}\"")
    new_fm_lines.append(f"read_time: {read_time}")

    # Preserve the order field as a custom field for sorting within category
    if fm.get("order"):
        new_fm_lines.append(f"order: {fm['order']}")

    new_fm_lines.append("---")

    new_content = "\n".join(new_fm_lines) + "\n\n" + body + "\n"

    out_path.write_text(new_content, encoding="utf-8")

    return {
        "source": str(rel_path),
        "dest": out_name,
        "title": title,
        "category": category_display,
        "date": date_prefix,
    }


def main():
    if not DOCS_DIR.exists():
        print("ERROR: _docs/ directory not found")
        sys.exit(1)

    POSTS_DIR.mkdir(exist_ok=True)

    # Find all doc files
    doc_files = sorted(DOCS_DIR.rglob("*.md"))
    if not doc_files:
        print("No doc files found in _docs/")
        sys.exit(1)

    print(f"Found {len(doc_files)} docs to migrate\n")

    results = []
    for doc_path in doc_files:
        rel = doc_path.relative_to(DOCS_DIR)
        info = migrate_doc(rel)
        results.append(info)
        print(f"  {info['source']:55s} → _posts/{info['dest']}")

    print(f"\nMigrated {len(results)} docs to _posts/")
    print(f"Categories: {', '.join(sorted(set(r['category'] for r in results)))}")


if __name__ == "__main__":
    main()
