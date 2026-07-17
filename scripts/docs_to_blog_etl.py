#!/usr/bin/env python3
"""
ETL: convert internal documentation markdown → Jekyll blog post drafts.

Extracts docs from a source tree, transforms them into `_posts`-ready files
(with YAML frontmatter), and loads them into a staging directory. You pick
which drafts to promote into `_posts/` yourself.

Examples
--------
  # List every candidate with inferred title / category / slug
  python3 scripts/docs_to_blog_etl.py --list

  # Dry-run: show what would be written (default target is _import/posts)
  python3 scripts/docs_to_blog_etl.py --dry-run

  # Convert everything into staging
  python3 scripts/docs_to_blog_etl.py

  # Convert a few specific files only
  python3 scripts/docs_to_blog_etl.py --select 34_Proxmox_Ubuntu_Template.md 40_Rook-Ceph_PVC_Multi_Attach_Error_Solution.md

  # Convert by number prefix / slug substring
  python3 scripts/docs_to_blog_etl.py --select 34 40 patroni

  # Write selected drafts straight into _posts/ (still safer to stage first)
  python3 scripts/docs_to_blog_etl.py --select 34 40 --out _posts

  # Force overwrite existing targets
  python3 scripts/docs_to_blog_etl.py --force
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

# ─── Defaults ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path(
    "/run/media/maruf/TiTAN1UM/Backups/upay/git_upay/documentation"
)
DEFAULT_STAGING = REPO_ROOT / "_import" / "posts"
DEFAULT_POSTS = REPO_ROOT / "_posts"

# Skip these basenames always
SKIP_FILES = {
    "readme.md",
    "security_sanitization_report.md",
    ".gitkeep",
}

# Skip directories (relative name match anywhere in path)
SKIP_DIR_NAMES = {".git", "build", "dist", "node_modules", "vendor"}

# Skip docs shorter than this (after strip) — catches WIP stubs
MIN_WORDS = 40

# ─── Category / tag heuristics ───────────────────────────────────────────────

CATEGORY_RULES: list[tuple[str, list[str]]] = [
    # (category, keywords matched against path + title + head content)
    ("PostgreSQL", ["postgresql", "postgres", "pgsql", "patroni", "pgbackrest",
                    "warehouse", "logical replication", "streaming standby",
                    "sequence", "dba", "pci-dss", "pci dss", "crunchy", "pgo"]),
    ("Redis", ["redis"]),
    ("Kubernetes", ["kubernetes", "k8s", "rook", "ceph", "istio", "cilium",
                    "prometheus", "pvc", "pod anti"]),
    ("Virtualization", ["proxmox", "qcow2", "qemu", "lvm", "cloud-init", "cloud init"]),
    ("Observability", ["superset", "prometheus", "grafana", "elk", "observability"]),
    ("Data Engineering", ["airflow", "pipelinewise", "etl", "scylladb", "oracle"]),
    ("Linux", ["ubuntu", "kernel", "debian", "linux", "termius", "office 2010"]),
    ("Backup", ["backup", "rsync", "s3", "snapshot", "restore", "recovery"]),
]

KEYWORDS_TO_TAGS: dict[str, str] = {
    "istio": "istio",
    "cilium": "cilium",
    "envoy": "envoy",
    "patroni": "patroni",
    "etcd": "etcd",
    "haproxy": "haproxy",
    "postgresql": "postgresql",
    "postgres": "postgresql",
    "pgbackrest": "pgbackrest",
    "rook": "rook",
    "ceph": "ceph",
    "rbd": "rbd",
    "pvc": "pvc",
    "prometheus": "prometheus",
    "grafana": "grafana",
    "superset": "superset",
    "airflow": "airflow",
    "pipelinewise": "pipelinewise",
    "proxmox": "proxmox",
    "qemu": "qemu",
    "qcow2": "qcow2",
    "kvm": "kvm",
    "cloud-init": "cloud-init",
    "ubuntu": "ubuntu",
    "debian": "debian",
    "kernel": "kernel",
    "linux": "linux",
    "pci-dss": "pci-dss",
    "encryption": "encryption",
    "docker": "docker",
    "kubernetes": "kubernetes",
    "redis": "redis",
    "oracle": "oracle",
    "scylladb": "scylladb",
    "backup": "backup",
    "rsync": "rsync",
    "s3": "s3",
    "high availability": "high-availability",
    "logical replication": "logical-replication",
    "streaming": "streaming-replication",
    "lvm": "lvm",
}

EMOJI_RE = re.compile(
    "["
    "\U0001F600-\U0001F64F"
    "\U0001F300-\U0001F5FF"
    "\U0001F680-\U0001F6FF"
    "\U0001F1E0-\U0001F1FF"
    "\U00002702-\U000027B0"
    "\U000024C2-\U0001F251"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FA6F"
    "\U0001FA70-\U0001FAFF"
    "\U00002600-\U000026FF"
    "\U0000FE00-\U0000FE0F"
    "\U0000200D"
    "]+",
    flags=re.UNICODE,
)

YAML_SPECIAL = re.compile(r'[:#\[\]{},&*?|!<>=!%@`\'"]')


# ─── Data model ──────────────────────────────────────────────────────────────

@dataclass
class DocCandidate:
    source: Path
    rel: str
    body: str
    title: str
    slug: str
    category: str
    tags: list[str]
    date: date
    excerpt: str
    read_time: int
    word_count: int
    source_sha: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def filename(self) -> str:
        return f"{self.date.isoformat()}-{self.slug}.md"


# ─── Extract ─────────────────────────────────────────────────────────────────

def should_skip_path(path: Path, source_root: Path) -> bool:
    try:
        rel_parts = path.relative_to(source_root).parts
    except ValueError:
        return True
    if any(p in SKIP_DIR_NAMES for p in rel_parts):
        return True
    if path.name.lower() in SKIP_FILES:
        return True
    if path.suffix.lower() != ".md":
        return True
    return False


def discover_sources(source_root: Path) -> list[Path]:
    if not source_root.is_dir():
        raise SystemExit(f"Source directory not found: {source_root}")
    files = [
        p for p in sorted(source_root.rglob("*.md"))
        if p.is_file() and not should_skip_path(p, source_root)
    ]
    return files


def strip_existing_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 3)
    if end == -1:
        return text
    # closing fence at end+1 ('\n---') → body starts after that fence
    rest = text[end + 4 :]  # skip '\n---'
    return rest.lstrip("\n\r")


# ─── Transform ───────────────────────────────────────────────────────────────

def clean_title(raw: str) -> str:
    title = EMOJI_RE.sub("", raw).strip()
    title = title.rstrip("*_# \t")
    title = re.sub(r"\*\*(.+?)\*\*", r"\1", title)
    title = re.sub(r"\*(.+?)\*", r"\1", title)
    title = re.sub(r"`(.+?)`", r"\1", title)
    title = re.sub(r"\s*[:：]\s*(A|a)\s+Step-by-Step\s+Guide.*$", "", title)
    title = re.sub(r"\s*[:：]\s*A\s+Comprehensive\s+Guide.*$", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    return title


def title_from_filename(stem: str) -> str:
    stem = re.sub(r"^\d+_", "", stem)
    stem = stem.replace("_", " ").replace("-", " ")
    # Keep known acronyms uppercase-ish
    words = []
    for w in stem.split():
        if w.upper() in {"PGO", "PCI", "DSS", "SQL", "HA", "LVM", "S3", "GL",
                         "KYC", "UCB", "ETL", "FAQ", "DBA", "BIOS", "RBD",
                         "PVC", "CNI"}:
            words.append(w.upper())
        elif w.lower() in {"postgresql", "redis", "ubuntu", "debian", "proxmox",
                           "oracle", "scylladb", "airflow", "pipelinewise"}:
            words.append(w.capitalize() if w.lower() != "postgresql" else "PostgreSQL")
            if w.lower() == "scylladb":
                words[-1] = "ScyllaDB"
            if w.lower() == "pipelinewise":
                words[-1] = "PipelineWise"
        else:
            words.append(w.capitalize())
    return " ".join(words) if words else "Untitled"


# Headings that are section labels, not document titles
GENERIC_HEADINGS = {
    "prerequisites", "introduction", "overview", "context", "background",
    "summary", "table of contents", "contents", "steps", "step 1",
    "getting started", "notes", "note", "warning", "architecture overview",
    "considerations", "requirements", "install", "installation",
    "configuration", "usage", "references", "appendix", "faq",
    "work in progress", "wip", "todo", "resolution steps",
}


def extract_title(body: str, rel: str) -> str:
    """
    Prefer a real document title:
      1. First H1 that is not a generic section label
      2. First H2/H3 that is not generic
      3. Filename-derived title
    """
    h1s: list[str] = []
    others: list[str] = []

    for line in body.splitlines():
        s = line.strip()
        m = re.match(r"^(#{1,3})\s+(.+)$", s)
        if not m:
            continue
        level = len(m.group(1))
        title = clean_title(m.group(2))
        if not title:
            continue
        if title.upper() in {"WORK IN PROGRESS", "WIP", "TODO"}:
            continue
        # strip leading "Documentation:" / "Document:" noise
        title = re.sub(
            r"^(Documentation|Document|Guide|Explanation Document)\s*[:：-]\s*",
            "",
            title,
            flags=re.IGNORECASE,
        ).strip()
        title = title.strip("*_ ")
        if not title:
            continue
        if title.lower() in GENERIC_HEADINGS:
            continue
        if re.match(r"^step\s+\d+", title, re.I):
            continue
        if level == 1:
            h1s.append(title)
        else:
            others.append(title)

    for title in h1s + others:
        # Avoid absurdly long H1s that are really run-on sentences
        if len(title) > 120:
            title = title[:117].rsplit(" ", 1)[0] + "…"
        return title

    return title_from_filename(Path(rel).stem)


def slugify(title: str, rel: str) -> str:
    base = title.lower()
    base = EMOJI_RE.sub("", base)
    base = re.sub(r"[^\w\s-]", "", base, flags=re.UNICODE)
    base = re.sub(r"[-\s]+", "-", base).strip("-")
    base = re.sub(r"-{2,}", "-", base)
    if not base or len(base) < 3:
        stem = re.sub(r"^\d+_", "", Path(rel).stem)
        base = re.sub(r"[^\w\s-]", "", stem.lower())
        base = re.sub(r"[-\s_]+", "-", base).strip("-")
    # Jekyll-friendly length cap
    if len(base) > 80:
        base = base[:80].rstrip("-")
    return base or "untitled"


def infer_category(rel: str, title: str, body: str) -> str:
    hay = f"{rel} {title}\n" + "\n".join(body.splitlines()[:60])
    hay = hay.lower()
    scores: dict[str, int] = {}
    for category, keys in CATEGORY_RULES:
        score = sum(1 for k in keys if k in hay)
        if score:
            scores[category] = score
    if not scores:
        return "Infrastructure"
    return max(scores.items(), key=lambda kv: kv[1])[0]


def extract_tags(rel: str, title: str, body: str, category: str) -> list[str]:
    tags: set[str] = set()
    # category as a tag (normalized)
    tags.add(re.sub(r"\s+", "-", category.lower()))

    hay = f"{rel} {title}\n" + "\n".join(body.splitlines()[:80])
    hay_l = hay.lower()
    for keyword, tag in KEYWORDS_TO_TAGS.items():
        if keyword in hay_l:
            tags.add(tag)

    # Prefer a stable, short list
    ordered = sorted(tags)
    # Cap at 8
    return ordered[:8]


def estimate_read_time(word_count: int) -> int:
    # ~220 wpm technical reading
    minutes = max(1, round(word_count / 220))
    return minutes


def make_excerpt(body: str, max_len: int = 220) -> str:
    """First meaningful prose paragraph, stripped of markdown noise."""
    lines = body.splitlines()
    buf: list[str] = []
    for line in lines:
        s = line.strip()
        if not s:
            if buf:
                break
            continue
        # skip headings, fences, list-only openers, images, pure horizontal rules
        if s.startswith("#"):
            continue
        if s.startswith("```"):
            continue
        if s in {"---", "***", "___"}:
            continue
        if s.startswith("!["):
            continue
        if re.match(r"^[-*+]\s*$", s):
            continue
        buf.append(s)
        # stop after a solid chunk
        if sum(len(x) for x in buf) > max_len:
            break

    text = " ".join(buf)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[`*_>#]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_len:
        text = text[: max_len - 1].rsplit(" ", 1)[0] + "…"
    return text


def post_date_from_source(path: Path) -> date:
    """Use file mtime as post date (stable-ish for archives)."""
    try:
        ts = path.stat().st_mtime
        return datetime.fromtimestamp(ts).date()
    except OSError:
        return date.today()


def yaml_quote(value: str) -> str:
    """Quote a YAML scalar safely for frontmatter."""
    if value == "":
        return '""'
    if YAML_SPECIAL.search(value) or value.strip() != value or "\n" in value:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def build_frontmatter(doc: DocCandidate) -> str:
    tags_yaml = "[" + ", ".join(doc.tags) + "]"
    lines = [
        "---",
        "layout: post",
        f"title: {yaml_quote(doc.title)}",
        f"date: {doc.date.isoformat()}",
        f"category: {yaml_quote(doc.category)}",
        f"tags: {tags_yaml}",
        f"excerpt: {yaml_quote(doc.excerpt)}",
        f"read_time: {doc.read_time}",
        f"source_doc: {yaml_quote(doc.rel)}",
        "draft_import: true",
        "---",
        "",
    ]
    return "\n".join(lines)


def transform(path: Path, source_root: Path) -> DocCandidate | None:
    rel = str(path.relative_to(source_root)).replace("\\", "/")
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raw = path.read_text(encoding="utf-8", errors="replace")

    body = strip_existing_frontmatter(raw).strip() + "\n"
    words = body.split()
    word_count = len(words)
    if word_count < MIN_WORDS:
        return None

    title = extract_title(body, rel)
    slug = slugify(title, rel)
    category = infer_category(rel, title, body)
    tags = extract_tags(rel, title, body, category)
    post_date = post_date_from_source(path)
    excerpt = make_excerpt(body)
    read_time = estimate_read_time(word_count)
    sha = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:12]

    warnings: list[str] = []
    if "upay" in body.lower() or "telenor" in body.lower():
        warnings.append("may contain org-specific names — review before publishing")
    if re.search(r"\b(?:password|secret|api[_-]?key|private[_-]?key)\b\s*[:=]", body, re.I):
        warnings.append("possible credentials patterns — scrub before publishing")
    if re.search(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", body):
        warnings.append("contains IP-like addresses — consider redacting")

    return DocCandidate(
        source=path,
        rel=rel,
        body=body,
        title=title,
        slug=slug,
        category=category,
        tags=tags,
        date=post_date,
        excerpt=excerpt or f"Notes from {title}.",
        read_time=read_time,
        word_count=word_count,
        source_sha=sha,
        warnings=warnings,
    )


def render_post(doc: DocCandidate) -> str:
    return build_frontmatter(doc) + doc.body


# ─── Load ────────────────────────────────────────────────────────────────────

def ensure_unique_slugs(docs: list[DocCandidate]) -> None:
    """Disambiguate colliding date+slug pairs by appending a short hash."""
    seen: dict[str, int] = {}
    for doc in docs:
        key = f"{doc.date.isoformat()}-{doc.slug}"
        if key in seen:
            seen[key] += 1
            doc.slug = f"{doc.slug}-{doc.source_sha[:6]}"
            doc.warnings.append("slug collision — appended content hash")
        else:
            seen[key] = 1


def write_doc(doc: DocCandidate, out_dir: Path, force: bool, dry_run: bool) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / doc.filename
    content = render_post(doc)

    if target.exists() and not force:
        existing = target.read_text(encoding="utf-8")
        if existing == content:
            return "IDENTICAL"
        return "EXISTS"

    if dry_run:
        return "DRY-RUN"

    target.write_text(content, encoding="utf-8")
    return "WROTE"


# ─── Selection ───────────────────────────────────────────────────────────────

def matches_select(doc: DocCandidate, selectors: list[str]) -> bool:
    if not selectors:
        return True
    hay = " ".join([doc.rel, doc.slug, doc.title, Path(doc.rel).stem]).lower()
    for sel in selectors:
        s = sel.lower().strip()
        if not s:
            continue
        # exact basename match
        if Path(doc.rel).name.lower() == s:
            return True
        # path contains
        if s in doc.rel.lower():
            return True
        # slug / title contains
        if s in doc.slug or s in doc.title.lower():
            return True
        # number prefix: "34" matches "34_Foo.md"
        if re.fullmatch(r"\d+", s):
            if re.match(rf"^{s}_", Path(doc.rel).name):
                return True
    return False


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="ETL documentation markdown into Jekyll blog post drafts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"Source documentation root (default: {DEFAULT_SOURCE})",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_STAGING,
        help=(
            "Output directory for converted posts. "
            f"Default: {DEFAULT_STAGING}. "
            f"Use --out {DEFAULT_POSTS} to write into the live posts folder."
        ),
    )
    p.add_argument(
        "--select",
        nargs="+",
        default=[],
        metavar="QUERY",
        help="Only convert docs matching these substrings / number prefixes / filenames",
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="List candidates and exit (no writes)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Show actions without writing files",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing output files",
    )
    p.add_argument(
        "--min-words",
        type=int,
        default=MIN_WORDS,
        help=f"Skip docs with fewer words (default: {MIN_WORDS})",
    )
    p.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Write a CSV/TSV-like manifest of converted posts to this path",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    global MIN_WORDS
    args = parse_args(argv)
    MIN_WORDS = args.min_words

    source = args.source.expanduser().resolve()
    out_dir = args.out.expanduser()
    if not out_dir.is_absolute():
        out_dir = (REPO_ROOT / out_dir).resolve()
    else:
        out_dir = out_dir.resolve()

    print("=" * 72)
    print("  Docs → Blog ETL")
    print(f"  Source : {source}")
    print(f"  Output : {out_dir}")
    print("=" * 72)
    print()

    sources = discover_sources(source)
    print(f"Discovered {len(sources)} markdown file(s)\n")

    candidates: list[DocCandidate] = []
    skipped_short = 0
    for path in sources:
        doc = transform(path, source)
        if doc is None:
            skipped_short += 1
            continue
        candidates.append(doc)

    ensure_unique_slugs(candidates)

    if args.select:
        selected = [d for d in candidates if matches_select(d, args.select)]
    else:
        selected = candidates

    if args.list:
        print(f"{'DATE':<12} {'CAT':<18} {'WORDS':>6}  FILE → TITLE")
        print("-" * 72)
        for d in selected:
            warn = f"  ⚠ {', '.join(d.warnings)}" if d.warnings else ""
            print(
                f"{d.date.isoformat():<12} {d.category:<18} {d.word_count:>6}  "
                f"{d.rel}"
            )
            print(f"{'':12} → {d.filename}")
            print(f"{'':12}   {d.title}{warn}")
        print()
        print(
            f"{len(selected)} candidate(s)"
            f"  (skipped {skipped_short} short/stub docs)"
        )
        return 0

    if not selected:
        print("No documents matched. Try --list or adjust --select.")
        return 1

    counts = {"WROTE": 0, "EXISTS": 0, "IDENTICAL": 0, "DRY-RUN": 0}
    rows: list[str] = []

    for doc in selected:
        status = write_doc(doc, out_dir, force=args.force, dry_run=args.dry_run)
        counts[status] = counts.get(status, 0) + 1
        mark = {
            "WROTE": "✓",
            "EXISTS": "·",
            "IDENTICAL": "=",
            "DRY-RUN": "○",
        }.get(status, "?")
        warn = ""
        if doc.warnings:
            warn = "  ⚠ " + "; ".join(doc.warnings)
        print(f"  [{mark}] {status:<9} {doc.filename}")
        print(f"           from {doc.rel}  ({doc.category}, {doc.read_time} min){warn}")
        rows.append(
            "\t".join(
                [
                    status,
                    doc.filename,
                    doc.rel,
                    doc.title,
                    doc.category,
                    ",".join(doc.tags),
                    str(doc.word_count),
                    ";".join(doc.warnings),
                ]
            )
        )

    print()
    print("-" * 72)
    print(
        f"Done. wrote={counts['WROTE']}  exists={counts['EXISTS']}  "
        f"identical={counts['IDENTICAL']}  dry-run={counts['DRY-RUN']}  "
        f"skipped-short={skipped_short}"
    )
    if counts["EXISTS"] and not args.force:
        print("Tip: re-run with --force to overwrite existing outputs.")
    if out_dir == DEFAULT_STAGING.resolve() or out_dir.name == "posts":
        print()
        print("Staging ready. Review files, scrub secrets, then copy picks into _posts/:")
        print(f"  ls {out_dir}")
        print(f"  cp {out_dir}/YYYY-MM-DD-your-slug.md {DEFAULT_POSTS}/")

    if args.manifest:
        manifest = args.manifest.expanduser()
        if not manifest.is_absolute():
            manifest = (REPO_ROOT / manifest).resolve()
        manifest.parent.mkdir(parents=True, exist_ok=True)
        header = "status\tfilename\tsource\ttitle\tcategory\ttags\twords\twarnings\n"
        manifest.write_text(header + "\n".join(rows) + "\n", encoding="utf-8")
        print(f"Manifest: {manifest}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
