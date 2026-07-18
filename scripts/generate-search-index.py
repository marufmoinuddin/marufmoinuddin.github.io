#!/usr/bin/env python3
"""
Generate search-index.json from Jekyll _posts/ directory.

Reads all Markdown posts, extracts frontmatter metadata,
and writes assets/js/search-index.json consumed by the
Fuse.js client-side search.
"""

import json
import re
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POSTS_DIR = REPO_ROOT / "_posts"
OUTPUT = REPO_ROOT / "assets" / "js" / "search-index.json"

def parse_frontmatter(text: str):
    """Return (frontmatter_dict, content) for a Jekyll markdown file."""
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n(.*)', text, re.DOTALL)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).split('\n'):
        line = line.strip()
        if ':' in line:
            key, _, val = line.partition(':')
            key = key.strip()
            val = val.strip()
            # Handle quoted values
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                val = val[1:-1]
            fm[key] = val
    return fm, m.group(2)

def parse_tags(tags_str: str):
    """Parse tags from frontmatter – supports YAML list or comma/space separated."""
    if not tags_str or tags_str.strip() == '[]':
        return []
    # Remove brackets
    tags_str = tags_str.strip()
    if tags_str.startswith('[') and tags_str.endswith(']'):
        tags_str = tags_str[1:-1]
    # Try comma separated first
    if ',' in tags_str:
        return [t.strip().strip("'\"").lower() for t in tags_str.split(',') if t.strip()]
    # Otherwise space separated
    return [t.strip().strip("'\"").lower() for t in tags_str.split() if t.strip()]

def slugify(title: str) -> str:
    """Create a URL slug from the title."""
    slug = title.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug

def main():
    posts = []

    if not POSTS_DIR.exists():
        print(f"Error: {POSTS_DIR} not found", file=sys.stderr)
        sys.exit(1)

    for fpath in sorted(POSTS_DIR.glob("*.md")):
        text = fpath.read_text(encoding='utf-8')
        fm, _ = parse_frontmatter(text)

        title = fm.get('title', '').strip().strip('"')
        if not title:
            continue

        # Parse date from filename or frontmatter
        date_str = fm.get('date', '')
        # Clean date_str – sometimes it has time component
        date_str = date_str.split()[0] if date_str else ''
        if not date_str:
            # Try filename: YYYY-MM-DD-title.md
            m = re.match(r'(\d{4}-\d{2}-\d{2})-', fpath.name)
            if m:
                date_str = m.group(1)

        # Build URL from permalink pattern: /blog/:year/:month/:title/
        if date_str:
            parts = date_str.split('-')
            year = parts[0]
            month = parts[1]
        else:
            year = '0000'
            month = '00'

        # Generate slug from title (consistent with Jekyll's default slug behavior)
        title_slug = fm.get('slug', '') or slugify(title)

        url = f"/blog/{year}/{month}/{title_slug}/"

        # Excerpt
        excerpt = fm.get('excerpt', '').strip().strip('"')
        # Clean excerpt – remove HTML tags
        excerpt = re.sub(r'<[^>]+>', '', excerpt)

        # Tags
        tags = parse_tags(fm.get('tags', ''))

        # Category
        category = fm.get('category', '').strip().strip('"')

        posts.append({
            "title": title,
            "url": url,
            "excerpt": excerpt,
            "tags": tags,
            "category": category,
            "date": date_str,
        })

    posts.sort(key=lambda p: p['date'], reverse=True)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(posts, indent=2), encoding='utf-8')
    print(f"✓ Generated search-index.json with {len(posts)} posts → {OUTPUT}")

if __name__ == '__main__':
    main()
