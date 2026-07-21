#!/usr/bin/env python3
"""
Convert a plain Markdown document into a Jekyll _posts/ entry by prepending
the required YAML front matter block.

Usage:
    python3 scripts/md-to-post.py <input.md> [--output _posts/] [--title "Title"] \
        [--category Category] [--tags tag1,tag2] [--date 2026-07-21]

If --title is omitted, the first H1 heading in the file is used.
If --date is omitted, the YYYY-MM-DD prefix of the input filename is used,
otherwise today's date is used.
If --category or --tags are omitted, sensible defaults are used.
"""

import argparse
import datetime
import os
import re
import sys

WORDS_PER_MINUTE = 200
FRONT_MATTER_TEMPLATE = """---
layout: post
title: "{title}"
date: {date}
category: {category}
tags: [{tags}]
excerpt: "{excerpt}"
read_time: {read_time}
---

"""

def extract_first_h1(content: str) -> str | None:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return None

def extract_first_paragraph(content: str) -> str:
    lines = content.splitlines()
    paragraph_lines = []
    in_paragraph = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_paragraph:
                break
            continue
        if stripped.startswith("#") or stripped.startswith("---"):
            break
        paragraph_lines.append(stripped)
        in_paragraph = True
    text = " ".join(paragraph_lines)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_`]", "", text)
    return text[:160] + ("..." if len(text) > 160 else "")

def estimate_read_time(content: str) -> int:
    words = len(re.findall(r"\b\w+\b", content))
    return max(1, round(words / WORDS_PER_MINUTE))

def infer_tags_from_content(content: str, category: str) -> list[str]:
    lowered = content.lower()
    candidates = {
        "kubernetes": ["kubernetes", "k8s", "kubeadm", "kubectl"],
        "docker": ["docker", "container", "containerize"],
        "postgresql": ["postgresql", "postgres", "pg_", "psql"],
        "linux": ["linux", "ubuntu", "debian", "centos", "rhel", "apt", "yum"],
        "networking": ["network", "subnet", "vpc", "dns", "load balancer", "haproxy"],
        "security": ["tls", "ssl", "certificate", "encrypt", "firewall", "rbac"],
        "ci-cd": ["github actions", "jenkins", "gitlab ci", "ci/cd", "pipeline"],
        "monitoring": ["prometheus", "grafana", "monitoring", "metrics", "alert"],
        "terraform": ["terraform", "hcl"],
        "ansible": ["ansible", "playbook"],
    }
    found = set()
    for tag, keywords in candidates.items():
        if any(k in lowered for k in keywords):
            found.add(tag)
    found.discard(category.lower())
    return sorted(found)[:8]

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a Markdown doc to a Jekyll _posts/ entry.")
    parser.add_argument("input", help="Path to the source Markdown file")
    parser.add_argument("--output", default="_posts", help="Output directory (default: _posts)")
    parser.add_argument("--title", help="Post title (default: first H1 heading)")
    parser.add_argument("--category", help="Category (default: 'General')")
    parser.add_argument("--tags", help="Comma-separated tags")
    parser.add_argument("--date", help="YYYY-MM-DD date for the post (default: from filename or today)")
    return parser.parse_args()

def main() -> None:
    args = parse_args()
    input_path = args.input

    if not os.path.isfile(input_path):
        print(f"Error: file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    with open(input_path, "r", encoding="utf-8") as f:
        content = f.read()

    filename = os.path.basename(input_path)
    date_match = re.match(r"(\d{4}-\d{2}-\d{2})", filename)

    title = args.title or extract_first_h1(content) or os.path.splitext(filename)[0].replace("-", " ").title()
    category = args.category or "General"

    if args.date:
        date = args.date
    elif date_match:
        date = date_match.group(1)
    else:
        date = datetime.date.today().isoformat()

    if args.tags:
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    else:
        tags = infer_tags_from_content(content, category)

    excerpt = extract_first_paragraph(content)
    read_time = estimate_read_time(content)

    front_matter = FRONT_MATTER_TEMPLATE.format(
        title=title.replace('"', '\\"'),
        date=date,
        category=category,
        tags=", ".join(tags),
        excerpt=excerpt.replace('"', '\\"'),
        read_time=read_time,
    )

    if content.startswith("---"):
        print("Error: input file already appears to have front matter.", file=sys.stderr)
        sys.exit(1)

    new_content = front_matter + content

    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", filename)
    if not slug:
        slug = re.sub(r"[^\w\-]+", "-", title.lower()).strip("-") + ".md"

    output_filename = f"{date}-{slug}"
    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, output_filename)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    print(f"Converted: {input_path}")
    print(f"     Title: {title}")
    print(f"     Date:  {date}")
    print(f"     Saved: {output_path}")

if __name__ == "__main__":
    main()
