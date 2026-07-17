#!/usr/bin/env python3
"""
Generate category index pages for the _docs collection.

Each category gets a docs/{category}/index.html page that lists all docs
within that category, sorted by the 'order' frontmatter field.

Usage:
    python3 scripts/generate-category-pages.py
"""

import sys
from pathlib import Path

DOCS_DIR = Path("/home/maruf/git/marufmoinuddin.github.io/_docs")
OUTPUT_DIR = Path("/home/maruf/git/marufmoinuddin.github.io/docs")

CATEGORY_META = {
    "android-security": {
        "title": "Android Security",
        "desc": "Android security research, SELinux policy analysis, and mobile application security testing.",
        "icon": "fa-android",
    },
    "cicd": {
        "title": "CI/CD",
        "desc": "CI/CD pipelines, GitOps workflows, and ETL infrastructure setup guides.",
        "icon": "fa-gears",
    },
    "kubernetes": {
        "title": "Kubernetes",
        "desc": "Kubernetes cluster operations, storage, networking, and troubleshooting runbooks.",
        "icon": "fa-ship",
    },
    "linux": {
        "title": "Linux",
        "desc": "Linux system administration, kernel updates, and automation scripts.",
        "icon": "fa-linux",
    },
    "networking": {
        "title": "Networking",
        "desc": "Network configuration, routers, firewalls, and infrastructure connectivity.",
        "icon": "fa-network-wired",
    },
    "observability": {
        "title": "Observability",
        "desc": "Monitoring, logging, and observability stack setup and maintenance.",
        "icon": "fa-eye",
    },
    "postgresql": {
        "title": "PostgreSQL",
        "desc": "PostgreSQL database administration, high availability, replication, and compliance.",
        "icon": "fa-database",
    },
    "virtualization": {
        "title": "Virtualization",
        "desc": "Virtual machine templating, Proxmox, QEMU/KVM, and disk management.",
        "icon": "fa-cloud",
    },
}


def get_categories() -> list[str]:
    """Discover categories from _docs directory structure."""
    return sorted(
        e.name for e in DOCS_DIR.iterdir()
        if e.is_dir() and not e.name.startswith(".")
    )


def generate_index(category: str) -> str:
    """Generate the index page content (Liquid template with frontmatter)."""
    meta = CATEGORY_META.get(category, {
        "title": category.replace("-", " ").title(),
        "desc": f"Documentation for {category}.",
        "icon": "fa-book",
    })

    # Build the Liquid template using f-string.
    # {{ and }} in Liquid need to be escaped as {{{{ and }}}} in f-strings.
    return f"""---
layout: page
title: "{meta['title']} Documentation"
description: "{meta['desc']}"
---

<div class="doc-category-header">
  <i class="fa-brands {meta['icon']} doc-category-icon"></i>
  <div>
    <h1 class="doc-category-title">{meta['title']}</h1>
    <p class="doc-category-desc">{meta['desc']}</p>
  </div>
</div>

<div class="doc-list">
  {{% assign category_docs = site.docs | where: "category", "{category}" | sort: "order" %}}
  {{% if category_docs.size > 0 %}}
    {{% for doc in category_docs %}}
    <a href="{{{{ doc.url | relative_url }}}}" class="doc-list-card">
      <div class="doc-list-card-body">
        <h3>{{{{ doc.title }}}}</h3>
        {{% if doc.last_updated %}}
        <p class="doc-list-date">Last updated: {{{{ doc.last_updated | date: "%B %d, %Y" }}}}</p>
        {{% endif %}}
      </div>
    </a>
    {{% endfor %}}
  {{% else %}}
    <p class="doc-list-empty">No documentation pages in this category yet.</p>
  {{% endif %}}
</div>
"""


def main():
    categories = get_categories()
    print(f"Found {len(categories)} categories: {', '.join(categories)}\n")

    created = 0
    for category in categories:
        target_dir = OUTPUT_DIR / category
        target_file = target_dir / "index.html"
        content = generate_index(category)
        target_dir.mkdir(parents=True, exist_ok=True)
        target_file.write_text(content, encoding="utf-8")
        print(f"  \u2705  /docs/{category}/index.html")
        created += 1

    print(f"\nCreated {created} category index pages.")


if __name__ == "__main__":
    main()
