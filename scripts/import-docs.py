#!/usr/bin/env python3
"""
Import documentation markdown files into the Jekyll _docs collection.

Reads each source file VERBATIM (no content rewriting), prepends YAML
frontmatter with proper layout, title, category, tags, and metadata,
and writes the output to the correct _docs/{category}/ path.

Usage:
    python3 scripts/import-docs.py

Configuration:
    Edit DOC_MAP below to add/remove/modify source→target mappings.
    SOURCE_BASE and TARGET_BASE are set at the top of the file.
"""

import os
import re
import sys
from datetime import date
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────────────

SOURCE_BASE = Path("/run/media/maruf/TiTAN1UM/Backups/upay/git_upay/documentation")
TARGET_BASE = Path("/home/maruf/git/marufmoinuddin.github.io/_docs")

# (source_relative_path, category, target_slug, order, [optional_title_override])
DOC_MAP = [
    # K8s Networking
    ("41_Istio_w_Cilium_Readiness_Solution.md",          "kubernetes",      "istio-cilium-readiness",              10),
    # Storage
    ("40_Rook-Ceph_PVC_Multi_Attach_Error_Solution.md",   "kubernetes",      "rook-ceph-pvc-multi-attach",          20),
    # Compliance
    ("28_PCI_DSS_Postgres_Methodologies.md",              "postgresql",      "pci-dss-postgres-encryption",         30),
    # ETL / Data Pipeline
    ("30_ETL_Setup_Airflow_Pipelinewise.md",              "cicd",            "etl-airflow-pipelinewise",            40),
    # VM Templating
    ("34_Proxmox_Ubuntu_Template.md",                     "virtualization",  "proxmox-ubuntu-template",             50),
    ("35_Proxmox_Debian_BIOS_Template.md",                "virtualization",  "proxmox-debian-template",             55),
    # Linux
    ("42_Updating_Ubuntu_Kernel.md",                      "linux",           "updating-ubuntu-kernel",              60),
    # HA PostgreSQL
    ("pg-docs/patroni-etcd-haproxy_HAPostgres_Cluster.md","postgresql",      "patroni-etcd-haproxy-cluster",         5),
    # BI / Analytics (no H1 heading, so we override the title)
    ("04_Superset_Setup.md",                              "observability",   "superset-setup",                      70,
     "Apache Superset Setup with PostgreSQL 15"),
    # Storage / Virtualization
    ("24_Resize_QCOW2.md",                                "virtualization",  "resize-qcow2-disk",                   80),
    # Monitoring
    ("38_Fix_Prometheus.md",                              "observability",   "fix-prometheus-forbidden-errors",     90),
]

# Category → tag list (combined with title-derived tags)
CATEGORY_TAGS = {
    "kubernetes":     ["kubernetes"],
    "postgresql":     ["postgresql"],
    "cicd":           ["cicd", "data-engineering"],
    "virtualization": ["virtualization", "proxmox"],
    "linux":          ["linux", "ubuntu"],
    "observability":  ["observability", "monitoring"],
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def extract_title(content: str, source_rel: str) -> str:
    """
    Extract a clean title from the markdown content.
    Priority:
      1. First ATX heading (# or ## or ###)
      2. Filename-derived title (fallback)
    Strips leading hashes, emoji, and trailing cruft.
    """
    # Try to find first heading (H1, H2, or H3)
    for line in content.splitlines():
        stripped = line.strip()
        m = re.match(r'^#{1,3}\s+(.+)$', stripped)
        if m:
            title = m.group(1)
            # Remove emoji / icons (common Unicode ranges + emoji sequences)
            emoji_pattern = re.compile(
                "[\U0001F600-\U0001F64F"   # emoticons
                "\U0001F300-\U0001F5FF"     # symbols & pictographs
                "\U0001F680-\U0001F6FF"     # transport & map
                "\U0001F1E0-\U0001F1FF"     # flags
                "\U00002702-\U000027B0"     # dingbats
                "\U000024C2-\U0001F251"     # misc
                "\U0001F900-\U0001F9FF"     # supplemental symbols
                "\U0001FA00-\U0001FA6F"     # chess symbols
                "\U0001FA70-\U0001FAFF"     # symbols extended-A
                "\U00002600-\U000026FF"     # misc symbols
                "\U0000FE00-\U0000FE0F"     # variation selectors
                "\U0000200D"                # zero-width joiner
                "]+",
                flags=re.UNICODE,
            )
            title = emoji_pattern.sub('', title).strip()
            # Remove trailing bold markers or stray punctuation
            title = title.rstrip('*_# \t')
            # Strip trailing "A Step-by-Step Guide" or similar
            title = re.sub(r'\s*[:：]\s*(A|a)\s+Step-by-Step\s+Guide.*$', '', title)
            title = re.sub(r'\s*[:：]\s*A\s+Comprehensive\s+Guide.*$', '', title)
            title = re.sub(r'\s*for\s+CentOS\s+Stream\s+\d+.*$', '', title, flags=re.IGNORECASE)
            if title:
                return title.strip()

    # Fallback: generate title from filename
    stem = Path(source_rel).stem
    # Remove leading number prefix like "41_", "40_", etc.
    stem = re.sub(r'^\d+_', '', stem)
    # Replace underscores/hyphens with spaces, capitalize words
    title = stem.replace('_', ' ').replace('-', ' ').strip()
    title = ' '.join(w.capitalize() for w in title.split())
    return title if title else "Untitled Document"


def extract_tags(content: str, category: str) -> list:
    """
    Extract relevant tags from content. Combines:
    - Category-based default tags
    - Any additional technology keywords found in the first ~30 lines
    """
    tags = set(CATEGORY_TAGS.get(category, []))

    # Keyword lookup table (lowercase → tag)
    KEYWORDS = {
        "istio": "istio", "cilium": "cilium", "envoy": "envoy",
        "patroni": "patroni", "etcd": "etcd", "haproxy": "haproxy",
        "postgresql": "postgresql", "postgres": "postgresql", "pgsql": "postgresql",
        "rook": "rook", "ceph": "ceph", "rbd": "rbd", "pvc": "pvc",
        "prometheus": "prometheus", "grafana": "grafana",
        "superset": "superset", "airflow": "airflow", "pipelinewise": "pipelinewise",
        "proxmox": "proxmox", "qemu": "qemu", "qcow2": "qcow2",
        "kvm": "kvm", "libvirt": "libvirt", "cloud-init": "cloud-init",
        "ubuntu": "ubuntu", "debian": "debian",
        "kernel": "kernel", "linux": "linux",
        "pci": "pci-dss", "dss": "pci-dss", "compliance": "compliance",
        "encryption": "encryption", "tde": "tde", "transparent-data-encryption": "tde",
        "docker": "docker", "container": "container",
        "backup": "backup", "restore": "restore",
        "high-availability": "high-availability", "ha": "high-availability",
        "load-balancing": "load-balancing",
    }

    # Scan first 50 lines for keyword mentions
    head = "\n".join(content.splitlines()[:50]).lower()
    for keyword, tag in KEYWORDS.items():
        if keyword in head:
            tags.add(tag)

    return sorted(tags)


def generate_frontmatter(
    content: str,
    source_rel: str,
    category: str,
    order: int,
    title_override: str | None = None,
) -> str:
    """Generate YAML frontmatter string for a Jekyll doc."""
    title = title_override if title_override else extract_title(content, source_rel)
    tags = extract_tags(content, category)
    today = date.today().isoformat()

    # Build YAML
    fm = []
    fm.append("---")
    fm.append("layout: doc")
    fm.append(f'title: "{title}"')
    fm.append(f"category: {category}")
    fm.append(f"order: {order}")
    fm.append(f"last_updated: {today}")
    fm.append(f"tags: {tags}")
    fm.append("---")
    return "\n".join(fm) + "\n"


def import_doc(source_rel: str, category: str, target_slug: str, order: int, title_override: str | None = None) -> dict:
    """
    Import a single documentation file.
    Returns a dict with status, source, target, title, reason (on failure).
    """
    src = SOURCE_BASE / source_rel
    if not src.exists():
        return {"status": "SKIP", "source": str(src), "reason": "source file not found"}

    # Read original content verbatim
    try:
        raw = src.read_text(encoding="utf-8")
    except Exception as e:
        return {"status": "ERROR", "source": str(src), "reason": f"read error: {e}"}

    # Generate frontmatter
    try:
        fm = generate_frontmatter(raw, source_rel, category, order, title_override)
    except Exception as e:
        return {"status": "ERROR", "source": str(src), "reason": f"frontmatter generation error: {e}"}

    # Strip any existing frontmatter from source (in case source has Jekyll frontmatter)
    body = raw
    if body.startswith("---"):
        # Find closing ---
        end_idx = body.find("---", 3)
        if end_idx != -1:
            body = body[end_idx + 3:].lstrip("\n\r")

    # Combine: frontmatter + original body (unchanged)
    output = fm + body

    # Ensure output ends with exactly one newline
    output = output.rstrip("\n") + "\n"

    # Determine target path
    target_dir = TARGET_BASE / category
    target_file = target_dir / f"{target_slug}.md"

    # Create directory
    target_dir.mkdir(parents=True, exist_ok=True)

    # Write output
    try:
        # Read existing file to compare (avoid unnecessary writes)
        if target_file.exists():
            existing = target_file.read_text(encoding="utf-8")
            if existing == output:
                return {"status": "IDENTICAL", "source": str(src), "target": str(target_file), "title": extract_title(raw, source_rel)}

        target_file.write_text(output, encoding="utf-8")
        return {"status": "OK", "source": str(src), "target": str(target_file), "title": extract_title(raw, source_rel)}
    except Exception as e:
        return {"status": "ERROR", "source": str(src), "target": str(target_file), "reason": f"write error: {e}"}


def main():
    print(f"{'='*70}")
    print(f"  Documentation Import Script")
    print(f"  Source : {SOURCE_BASE}")
    print(f"  Target : {TARGET_BASE}")
    print(f"{'='*70}\n")

    results = []
    for entry in DOC_MAP:
        source_rel, category, target_slug, order = entry[:4]
        title_override = entry[4] if len(entry) > 4 else None
        result = import_doc(source_rel, category, target_slug, order, title_override)
        results.append(result)

        # Print result
        status = result["status"]
        if status == "OK":
            print(f"  ✅  {result['title']}")
            print(f"       → {result['target']}")
        elif status == "IDENTICAL":
            print(f"  🔹  {result['title']} (unchanged)")
        elif status == "SKIP":
            print(f"  ⏭️   {result['source']} — {result.get('reason', 'skipped')}")
        else:
            print(f"  ❌  {result.get('source', '?')} — {result.get('reason', 'unknown error')}")
        print()

    # Summary
    ok = sum(1 for r in results if r["status"] == "OK")
    identical = sum(1 for r in results if r["status"] == "IDENTICAL")
    skipped = sum(1 for r in results if r["status"] == "SKIP")
    errors = sum(1 for r in results if r["status"] == "ERROR")

    print(f"{'='*70}")
    print(f"  Summary: {ok} imported, {identical} unchanged, {skipped} skipped, {errors} errors")
    print(f"{'='*70}")

    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
