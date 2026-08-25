---
layout: post
title: "PostgreSQL High Availability with Patroni + pgpool-II — A Complete Guide"
date: 2026-08-25
category: PostgreSQL
tags: [postgresql, high-availability, patroni, pgpool-ii, etcd, pgbackrest, failover, ansible]
excerpt: "A complete, decision-ready guide to a production 3-node PostgreSQL 16 HA cluster — Patroni owns the data plane, pgpool-II owns the access plane, with 5/5 validated power-loss failovers, zero data loss, and honest caveats."
read_time: 96
---

# PostgreSQL High Availability with Patroni + pgpool-II — A Complete Guide

> **One file. No prior DBA knowledge required.**
> This guide explains a production PostgreSQL 16 high-availability cluster — what it is, why it exists, how it works, how it was deployed, how it behaves under failure, and what its honest limitations are — for a supervisor who needs to make an informed decision.

> 🗺️ **Reader's map — read only what you need:**
> - **Making the buy/build decision?** Read §1–8 (what it is, why it exists, how it works) and §14–16 (evidence + honest limitations).
> - **Deploying or operating the cluster?** Read §9 (deploy), then §10 (day-2 operations), §11 (production hardening), §12 (security & secrets — incl. the `CHANGE_ME_*` mapping for §9), and §13 (troubleshooting).
> - **Just need a term defined?** The Glossary (§16) defines every acronym.
> - §9 is a full implementer runbook; if you are only evaluating, you can skip it.

---

## 1. Executive Summary

This document describes a **3-node PostgreSQL 16 high-availability (HA) cluster** built with **Percona Distribution for PostgreSQL 16**, managed by **Patroni** (the "brain" that decides which node is the primary and fails over automatically), coordinated by **etcd** (a 3-node distributed consensus store), fronted by **pgpool-II + Watchdog** (the "traffic controller" that gives applications a single Virtual IP for connection pooling and read/write routing), and backed up by **pgBackRest**, with optional **PMM** monitoring dashboards.

The single most important mental model is: **Patroni owns the data plane** (which PostgreSQL node is primary, replication, failover, slots, config), and **pgpool-II owns the access plane** (where clients connect, pooling, query routing, Virtual IP). They do not fight over leadership — Patroni is the single source of truth, and pgpool-II follows Patroni's lead.

The architecture has been **stress-tested with real power-loss fault injection**: **5 out of 5 consecutive failovers passed**, with **zero lost commits** across ~104,000 confirmed writes and **zero split-brain** across 3,600 direct node probes. Failover took ~40 seconds (median), clients saw a 34–38 second write interruption, and killed nodes rejoined in 36–40 seconds — all automatically, without human intervention or re-provisioning.

> 📖 **Jargon you'll meet in this summary** (all defined properly in §3 and the Glossary §16): **Patroni** = the cluster manager that decides who is primary; **pgpool-II** = the traffic controller apps connect to; **replication** = copying the database to other nodes; **WAL** = the transaction log; **quorum** = a majority of nodes agreeing; **split-brain** = two nodes both acting as primary; **async replication** = replicas may lag slightly behind the primary.

This is not magic and not perfect: replication is asynchronous (a hard zero-data-loss guarantee would require synchronous mode), and etcd is a single point of failure for *write availability* (mitigations are documented). But for a self-contained production cluster, this design delivers automatic, safe, observable failover — with the evidence to prove it.

---

## 2. What Problem This Solves

### Why a single PostgreSQL server is not enough

A single PostgreSQL server is simple, but it has three problems:

1. **It is a single point of failure.** If the machine crashes, burns, loses power, or loses its disk, the database is down — and so is every application that depends on it. Recovery means waiting for a human and possibly restoring from backup (minutes to hours of downtime, and data loss since the last backup).
2. **Maintenance means downtime.** Upgrading the OS, the kernel, or PostgreSQL itself requires stopping the server. If your applications must be up 24/7, a single server cannot do that.
3. **It cannot survive network or hardware failures.** A rack switch failure, a hypervisor problem, or a bad NIC takes the whole database offline.

### What "high availability" means

High availability does **not** mean "never fails." It means the system **keeps serving through component failures automatically** — specifically, when one node dies, another node takes over its work without a human being called at 3 a.m. The target is usually expressed as "nines" (99.9%, 99.99%…), but the practical promise is:

- If any **one** node dies, the cluster **keeps accepting reads and writes** (through a small, measured interruption window).
- No data that was confirmed to the application is lost.
- No two nodes ever disagree about who is primary (no split-brain).
- The failed node **comes back automatically** and rejoins the cluster.

### Failover vs. switchover

| Aspect | **Failover** | **Switchover** |
|--------|--------------|----------------|
| Trigger | **Unplanned** — primary crashes, power loss, kernel panic, OOM | **Planned** — maintenance, OS upgrades, hardware replacement |
| Initiation | **Automatic** (Patroni detects the failure) | **Manual** (`patronictl switchover`) |
| Data loss risk | Possible with async replication (see §15) | Zero (graceful handoff) |
| Old primary | May still be running (split-brain risk, handled by fencing) | Gracefully demoted to replica |
| Speed | Seconds to ~40s (depends on TTL settings) | Near-instant (a few seconds with the callback fix) |

### What split-brain is, and why it is dangerous

**Split-brain** happens when two nodes both believe they are the *primary* (read-write) at the same time and both accept writes. Because they start from the same data but then diverge, the two copies become **irreconcilable** — the database is silently corrupted, and there is no reliable way to merge the two halves. This is the worst failure mode in distributed databases, worse than downtime: downtime is recoverable, corruption may not be.

Split-brain is caused by exactly the situations HA is supposed to survive:

- A **network partition**: the primary and a replica lose contact with each other, and each thinks the other is dead, so each tries to become/remain primary.
- **etcd quorum loss**: multiple nodes think they can hold the leader lock.
- **Clock drift**: election timeouts fire incorrectly.

This cluster prevents split-brain with three layers: **etcd quorum** (a majority must agree, §3 requires an odd number of nodes), **a TTL-based leader lock** (the primary's claim expires unless it keeps heartbeating), and **fencing** (a partitioned node that loses quorum is rebooted by a kernel watchdog rather than allowed to keep accepting writes). You will see these again in §3 and §7.

---

## 3. Core Concepts (Fundamentals)

This section explains the vocabulary you need before reading the architecture. Everything is defined in plain language; the formal definitions are also collected in the Glossary (§16).

### Primary vs. replica

- **Primary** (formerly called "master"): the *single* PostgreSQL instance that accepts **reads and writes**. It generates a write-ahead log record for every change.
- **Replica** (formerly "slave"/"standby"): a PostgreSQL instance that **receives** those records from the primary and **replays** them, keeping an up-to-date copy. It accepts **reads only** (this is called hot standby).

```
Primary (read/write) ──WAL stream──► Replica (read-only)
       │                                   │
       ▼                                   ▼
  WAL generated                      WAL replayed
```

### Streaming replication

PostgreSQL's native replication mechanism. The primary continuously **streams** its write-ahead log to connected replicas over dedicated replication connections. Key settings: `wal_level = replica` (log enough detail to replay), `max_wal_senders` (how many concurrent replicas), `max_replication_slots` (reserve WAL so slow replicas don't fall behind). On the replica: `hot_standby = on` (serve reads while replaying) and `primary_conninfo` (connection to the primary — **Patroni manages this automatically** in this cluster).

### WAL (Write-Ahead Log)

PostgreSQL's transaction log. Every data modification is written to the WAL **before** it is applied to the data files. This gives you two superpowers:

- **Durability / crash recovery** — a power loss can never corrupt committed data; PostgreSQL replays the WAL on restart.
- **Replication** — replicas replay the same WAL stream, so they end up with a consistent copy.

WAL segments are 16 MB files in `pg_wal/`, recycled by checkpoints and archiving. Once pgBackRest is applied (Phase 5), WAL is also **archived to the backup node**, enabling point-in-time recovery (§10). (Archiving is `off` by default until then.)

### Replication slots

A replication slot is a server-side bookmark that tells the primary: *"Do not remove WAL segments until this replica has received them."* Without slots, a slow or disconnected replica could cause the primary to recycle WAL the replica still needs — breaking replication and requiring a full re-copy. **Patroni always uses replication slots** (`use_slots: true`) and manages them automatically.

### Failover vs. switchover (quick reference)

| Aspect | Failover | Switchover |
|--------|----------|------------|
| Trigger | Unplanned (crash, power loss, partition) | Planned (maintenance) |
| Initiation | Automatic (Patroni) | Manual (`patronictl switchover`) |
| Data-loss risk | Possible (async replication) | Zero (graceful) |
| Old primary handling | May need fencing if still running | Gracefully demoted |
| Speed | ~40s with defaults (tunable) | ~3–4s with the callback fix |

### Split-brain and how it is prevented

As explained in §2, split-brain is two primaries accepting writes. This cluster prevents it with three layers:

1. **etcd quorum** — a leader lock can only be held if a *majority* of etcd nodes agree. A partitioned minority cannot create a new lock.
2. **TTL lease** — the leader lock expires automatically (default 30 s) unless the primary keeps renewing it. A dead primary loses its claim.
3. **Fencing (softdog watchdog)** — Patroni is configured with `mode: automatic`, `/dev/watchdog`. If a primary is partitioned and loses DCS quorum, Patroni stops feeding the kernel watchdog, and **the kernel reboots the host** — forcibly removing a stale primary instead of letting it keep writing. A hardware watchdog (`i6300ESB`) is also supported for stronger guarantees. (Disable with `patroni_watchdog: false` if you have an external BMC.)

Plus a safety valve: `maximum_lag_on_failover` prevents promoting a severely lagged replica (a lagged replica would be missing data — promoting it would *lose* committed transactions).

### Leader election and Raft consensus — why 3 nodes?

Patroni does not elect leaders by shouting. It uses **etcd's Raft consensus algorithm**, which is a formal, mathematically grounded way for a group of machines to agree on a single state (who holds the leader lock). In Raft, a decision is only valid when a **quorum** (majority) of members agree.

The lock is a single etcd key per scope: `/percona_lab/maruf/leader`. Only one node can hold it at a time. Every node tries to acquire it; the winner is the primary; everyone else follows. The lock has a TTL, and the holder must renew it — the heartbeats you will read about in §7.

**Why an odd number of nodes?** Because quorum is a majority:

| Cluster size | Quorum required | Tolerated failures |
|--------------|-----------------|--------------------|
| 1 | 1 | 0 (no HA) |
| **3** | **2** | **1** |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

With 3 nodes you tolerate **exactly one** node failure and still make decisions. With 2 nodes, quorum = 2, so **zero** failures are tolerated — two nodes are strictly worse than one for consensus. This is why this cluster uses **3 etcd nodes** (co-located on the 3 database nodes by default; dedicated witness options are discussed in §15).

---

## 4. Architecture Overview

### The full component diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           APPLICATION LAYER                                 │
│  Your application connects to: pgpool-II VIP (192.168.122.200:9999)        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         pgpool-II CLUSTER (Watchdog)                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │  pgpool-II  │    │  pgpool-II  │    │  pgpool-II  │   ← VIP floats here  │
│  │   (db1)     │◄───│   (db2)     │◄───│   (db3)     │   ← quorum = 2/3     │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                      │
│         │                  │                  │                             │
│         └──────────────────┼──────────────────┘                             │
│                            ▼                                                │
│              ┌─────────────────────────────────┐                            │
│              │   Health Checks (pg_isready)    │                            │
│              │   Streaming Replication Checks  │                            │
│              └─────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│    POSTGRESQL       │ │    POSTGRESQL       │ │    POSTGRESQL       │
│     PRIMARY         │ │     REPLICA         │ │     REPLICA         │
│    (db1:5432)       │ │    (db2:5432)       │ │    (db3:5432)       │
│  ┌───────────────┐  │ │  ┌───────────────┐  │ │  ┌───────────────┐  │
│  │   Patroni     │  │ │  │   Patroni     │  │ │  │   Patroni     │  │
│  │   (Leader)    │  │ │  │   (Follower)  │  │ │  │   (Follower)  │  │
│  └───────┬───────┘  │ │  └───────┬───────┘  │ │  └───────┬───────┘  │
└──────────│──────────┘ └──────────│──────────┘ └──────────│──────────┘
           │                       │                       │
           └───────────────────────┼───────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           etcd CLUSTER (3 nodes)                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                                      │
│  │  etcd   │  │  etcd   │  │  etcd   │   ← Raft consensus: leader lock      │
│  │ (db1)   │  │ (db2)   │  │ (db3)   │   ← cluster state, config, TTL       │
│  └────┬────┘  └────┬────┘  └────┬────┘   ← quorum = 2/3                     │
│       │            │            │                                           │
│       └────────────┴────────────┘                                           │
└─────────────────────────────────────────────────────────────────────────────┘

Plus a 4th node (db-backup, 192.168.122.153):
  • pgBackRest — receives archived WAL, makes full/incremental backups
  • PMM Server (Docker) — monitoring web dashboard (optional, policy-controlled)
```

### The nodes

| Node | IP address | Runs |
|------|-----------|------|
| db1 | 192.168.122.150 | PostgreSQL 16 + Patroni + etcd + pgpool-II |
| db2 | 192.168.122.151 | PostgreSQL 16 + Patroni + etcd + pgpool-II |
| db3 | 192.168.122.152 | PostgreSQL 16 + Patroni + etcd + pgpool-II |
| db-backup | 192.168.122.153 | pgBackRest server + PMM Server (Docker) — **PMM optional, disabled by policy** |

**Applications connect ONLY to the Virtual IP `192.168.122.200:9999` and never touch individual nodes.**

### Component roles — what each does, and what it deliberately does NOT do

| Component | Role | What It Does NOT Do |
|-----------|------|---------------------|
| **PostgreSQL 16** | Database engine — stores data, processes queries, streams WAL | Does not decide who is primary; does not fail over automatically |
| **Patroni** | Cluster manager — leader election, failover, replication orchestration, config management | Does not route client connections; does not pool connections |
| **etcd** | Distributed consensus store — holds the leader lock, cluster state, configuration | Does not manage PostgreSQL; does not understand SQL |
| **pgpool-II** | Connection middleware — routing, pooling, read balancing, VIP management | Does not manage PostgreSQL replication; does not elect leaders |
| **pgBackRest** | Backup & restore engine — full/incremental backups, archiving, point-in-time recovery | Does not manage HA; does not route traffic |
| **PMM** | Monitoring — dashboards, alerting, query analytics | Does not manage HA; is not required for failover |

### Data flow (numbered steps)

1. The application connects to the **pgpool-II VIP** (`192.168.122.200:9999`) — it never talks to individual nodes.
2. pgpool-II **routes writes** to the current PostgreSQL primary (detected via streaming-replication checks).
3. pgpool-II **load-balances reads** across replicas (optional, `load_balance_mode = on`).
4. **Patroni** on each node watches etcd for leadership changes.
5. **etcd** holds the leader lock — only one Patroni can hold it at a time.
6. When the primary fails, Patroni on a replica **acquires the lock and promotes** its PostgreSQL.
7. pgpool-II detects the new primary (via health checks + an active Patroni callback) and **routes traffic there**.
8. The **VIP moves** to the pgpool-II node that is currently the watchdog leader (independent of the PostgreSQL primary — both can move separately).
9. **pgBackRest** keeps archiving WAL; **PMM** keeps graphing everything (where enabled).

### Network ports

| Service | Port | Source → Destination | Purpose |
|---------|------|----------------------|---------|
| SSH | 22 | Admin → All nodes | Remote administration |
| **pgpool-II (VIP)** | **9999** | App servers → VIP | **Client connection endpoint** |
| PCP (pgpool control) | 9898 | Admin → All nodes | `pcp_*` admin commands |
| Watchdog heartbeat | 9000 (wd_port), 9694 (heartbeat_port) | All nodes ↔ All nodes | pgpool-II watchdog inter-node checks |
| PostgreSQL | 5432 | All nodes ↔ All nodes | Replication + pgpool health checks |
| Patroni REST API | 8008 | All nodes ↔ All nodes | Health checks, `patronictl` |
| etcd client | 2379 | All nodes ↔ All nodes | Patroni ↔ etcd communication |
| etcd peer | 2380 | All nodes ↔ All nodes | etcd Raft (cluster) communication |
| pgBackRest | 22 (SSH) | PG nodes → backup node | WAL archiving / backups |
| PMM Server | 443 | Admin / PG nodes → backup node | Monitoring web UI (HTTPS) |

> 🔥 **Firewall rule:** Allow these ports **only between cluster nodes** (source = cluster subnet). Do not expose etcd, the Patroni REST API, or PostgreSQL to application networks — **only the pgpool-II VIP** (and PMM where used).

### Why the separation matters — data plane vs. access plane

**Patroni owns the data plane** — which PostgreSQL node is primary, replication, failover, slots, config.
**pgpool-II owns the access plane** — where clients connect, connection pooling, query routing, VIP.

They do not fight over leadership. Patroni is the single source of truth for PostgreSQL; pgpool-II follows Patroni's lead via streaming-replication checks and an active `on_role_change` callback. If pgpool-II tried to manage failover too, you would have two systems fighting over who is primary — exactly the split-brain risk this design exists to prevent.

---

## 5. Why Patroni + pgpool-II instead of Standalone PostgreSQL + pgpool-II?

### The core question: who decides who is primary?

This single question drives every difference between the two options.

- **With Patroni:** a **consensus engine** (etcd + Raft) decides. The answer is objective, recorded, and impossible to duplicate — only one node can hold the leader lock.
- **Standalone + pgpool:** **pgpool itself** decides, based on polling health checks and a `failover_command` script. There is **no consensus** — nothing structurally stops two nodes from both thinking they are primary.

**The honest one-line summary:** In Option A, Patroni owns the data plane and pgpool owns the access plane. In Option B, **pgpool tries to own both — and it is not designed to be a consensus engine.**

### Side-by-side comparison

| Capability | Patroni + pgpool (A) | Standalone + pgpool (B) |
|------------|----------------------|--------------------------|
| Automatic failover | ✅ Consensus-driven | ⚠️ Script-driven, no consensus |
| Split-brain protection | ✅ etcd quorum + TTL + fencing | ❌ Weak (health-check only) |
| Automatic replica rejoin | ✅ `pg_rewind` | ❌ Manual `pg_basebackup` |
| Replication slots | ✅ Automatic | ❌ Manual |
| Centralized config | ✅ via etcd | ❌ Per-node editing |
| Connection pooling | ✅ pgpool | ✅ pgpool |
| Read/write splitting | ✅ pgpool | ✅ pgpool |
| Virtual IP (VIP) | ✅ pgpool watchdog | ✅ pgpool watchdog |
| REST API / CLI ops | ✅ `patronictl` | ❌ PCP only |
| Self-healing | ✅ timers + restart | ❌ |
| Component count | High (PG + Patroni + etcd + pgpool) | Low (PG + pgpool) |
| Learning curve | Steep | Moderate |
| Resource overhead | Higher (etcd) | Lower |
| Write-availability SPOF | etcd quorum | pgpool detection |
| Best for | Production HA, zero-data-loss | Demos, small/low-risk, manual ops |

### Honest pros and cons

**Patroni + pgpool-II (what this guide deploys):**
- ✅ Automatic, consensus-driven failover (measured ~38–43 s for a hard kill; ~3–4 s for a clean switchover with the callback fix).
- ✅ Real split-brain protection: 2/3 quorum + TTL lease + softdog host reboot.
- ✅ Automatic replica rejoin via `pg_rewind` — the old primary comes back and resynchronizes against the new leader without a full re-copy.
- ✅ Replication slots managed automatically.
- ✅ Centralized PostgreSQL configuration (stored in etcd, applied everywhere via `patronictl reload`).
- ✅ A clean REST API + `patronictl` — the cluster is operable by a human.
- ✅ Self-healing timers (see §10).
- ✅ Proven: 5/5 power-loss failovers with zero lost commits and zero split-brain.
- ❌ More moving parts (Patroni + etcd on every node).
- ❌ etcd is a write-availability SPOF if it loses quorum (documented finding — see §15).
- ❌ Higher operational complexity (TTL, loop_wait, pg_rewind, fencing concepts).
- ❌ Slightly more resource overhead (etcd is latency-sensitive).
- ❌ Failover is not instant — TTL + loop_wait means ~40 s worst case with defaults (tunable down to ~15–20 s).

**Standalone PostgreSQL + pgpool-II:**
- ✅ Fewer components, lower footprint, faster to stand up for a demo.
- ✅ Pooling + read/write split + VIP are identical to Option A (pgpool doesn't care what's underneath).
- ❌ **No automatic safe failover** — someone must promote a replica; no consensus means nothing stops two nodes both thinking they are primary.
- ❌ **High split-brain risk** — a network partition can leave the old primary writing while pgpool promotes a new one. The single biggest reason not to run this for anything important.
- ❌ Manual replication management (`primary_conninfo`, `standby.signal`, slots by hand).
- ❌ No `pg_rewind` automation — rejoining a diverged node needs a full `pg_basebackup`.
- ❌ No centralized config; drift is easy.
- ❌ pgpool's primary detection is polling-based and can be *stale* — this architecture observed exactly that (a ~4-minute switchover gap) and fixed it with a Patroni callback; without Patroni there is no such active signal, so the gap is unbounded by design.
- ❌ No self-healing — a crashed node stays down until a human intervenes.

### Recommendation

- **Choose Patroni + pgpool-II** for anything that matters: production, customer-facing, or where **zero data loss and no split-brain** are requirements. This is exactly what this guide describes and has validated with real fault injection.
- **Choose standalone + pgpool-II** only for a quick lab, a read-mostly workload where you accept manual failover, or where the simplicity of "no etcd, no Patroni" outweighs the risk. Treat it as **not HA** in the strict sense — it is "manual failover with a VIP."

> **Bottom line: pgpool-II is a traffic controller, not a consensus engine. Pair it with Patroni when you need real high availability; run it standalone only when you are willing to manage failover by hand.**

---

## 6. Why pgpool-II instead of HAProxy + PgBouncer?

Both architectures share the **same Patroni + etcd data plane** — automatic failover, split-brain protection, `pg_rewind`, slots, centralized config, `patronictl` are identical. The choice is purely about the **access layer** — the component(s) in front of the database that clients actually connect to.

- **Option A (this guide):** pgpool-II — one integrated component doing pooling + SQL-aware read/write splitting + primary detection + floating VIP (built-in watchdog).
- **Option B:** HAProxy (L4 TCP load balancer) + PgBouncer (dedicated connection pooler) + Keepalived (separate VIP mechanism) — three specialized components.

### How each layer handles the same jobs

| Job | Patroni + pgpool (A) | Patroni + HAProxy + PgBouncer (B) |
|-----|----------------------|------------------------------------|
| Connection pooling | pgpool-II (built-in) | PgBouncer (dedicated, per-node) |
| Read/write splitting | pgpool-II (**SQL-aware**, `load_balance_mode`) | HAProxy (two pools: primary vs replica) |
| Primary detection | pgpool-II `sr_check` + Patroni callback | HAProxy health check on Patroni `:8008` |
| Floating VIP | pgpool-II **watchdog** (built-in) | **Keepalived** (separate component) |
| SQL awareness | Yes (parses queries) | No (HAProxy is L4; PgBouncer is a pooler, not a router) |
| Session-level features | Yes (SELECT routing, function blacklist) | Limited (HAProxy can't see SQL) |
| Components to run | 1 (pgpool-II) | 2–3 (HAProxy + PgBouncer + Keepalived) |
| Active failover signal | ✅ `pcp_promote_node` callback (wired in this guide) | ⚠️ Polling only (scriptable) |

### Key differences that matter to a decision-maker

1. **SQL awareness.** pgpool parses queries, so it can route `SELECT` to replicas and `INSERT/UPDATE/DELETE` to the primary **from a single connection string**, blacklist unsafe functions (`nextval`, `setval`, …), and handle `SELECT … FOR UPDATE` correctly. HAProxy cannot see SQL at all — read/write splitting is done **by pool**, which means **the application must use separate connection strings for reads vs. writes**.
2. **Built-in VIP vs. extra daemon.** pgpool's watchdog elects a leader and floats the VIP with quorum + `wd_quorum_exit` split-brain protection (already hardened here). Option B needs a separate Keepalived — an extra daemon and an extra split-brain surface.
3. **Active failover signaling.** This guide wires a Patroni `on_role_change` callback that runs `pcp_promote_node` immediately, closing the switchover detection gap to ~3–4 s. HAProxy relies on polling the `:8008` health check (you can script a push, but it's extra work).
4. **Pooling strength.** PgBouncer is the de-facto standard for extreme concurrency (transaction pooling, thousands of clients). pgpool's pooling is adequate for hundreds to low thousands of connections but not as battle-tested at that scale.
5. **Component count and ops.** One service per node vs. three; fewer failure modes, less config drift — but pgpool is a heavier, more complex process with a steeper config surface than HAProxy.

### Which should you choose?

**Choose Patroni + pgpool-II when:**
- You want **one integrated access layer** (pooling + routing + VIP) — simpler to operate and monitor.
- You want **SQL-aware read/write splitting** — the app uses a single connection string and pgpool routes queries.
- You value the **built-in watchdog VIP** with quorum + split-brain protection and the **active failover callback** already wired in this guide.
- Your concurrency needs are moderate (hundreds to low thousands of connections).

**Choose Patroni + HAProxy + PgBouncer when:**
- You need **very high connection concurrency** (thousands of clients) — PgBouncer's transaction pooling is the clear winner.
- You prefer **clean separation of concerns** and are comfortable running and monitoring three components.
- Your application can **split read vs. write connection strings** (or you add a router), because HAProxy cannot route by SQL.
- You already run HAProxy/Keepalived elsewhere and want to reuse that expertise.

> **Bottom line:** pgpool-II delivers a complete, validated, all-in-one access layer with SQL-aware routing and a built-in VIP — ideal for a self-contained 3-node HA cluster. If the workload later demands extreme connection concurrency, the HAProxy + PgBouncer model is the natural evolution — and it reuses the exact same Patroni + etcd data plane already deployed here.

---

## 7. How Failover Actually Works

### The leader lock — the one idea everything rests on

Patroni's entire promotion mechanism rests on a single elegant idea: **a single key in etcd that only one node can hold at a time.**

```
etcd key:  /percona_lab/maruf/leader
value:     {"member": "db1", "ttl": 30}
```

- The current primary holds this lock and **renews it** (heartbeat) every `loop_wait` seconds (default 10 s).
- The lock has a **TTL** (default 30 s). If the primary stops renewing it, the lock **expires**.
- When the lock expires, the replicas **race** to acquire it. The winner becomes the new primary.

This is what makes failover **automatic and safe**: only one node can ever hold the lock, so only one node can ever be primary — no split-brain.

### Step-by-step timeline (primary crashes at t=0)

| Time | Event |
|------|-------|
| t=0 | db1 (primary) crashes — power loss, kernel panic, OOM. Patroni on db1 stops → no more heartbeats. |
| t=10 | db2's Patroni loop runs. The leader lock is still valid (it expires at t=30). |
| t=20 | db2's loop runs again. Lock still valid. |
| t=30 | **Leader lock expires** in etcd (TTL reached). |
| t=30–40 | db2 and db3 both try to acquire the expired lock. **Raft consensus** picks one winner — only one can win. |
| t=30–40 | The winner calls `pg_ctl promote` → its PostgreSQL ends recovery and becomes PRIMARY. |
| t=30–40 | The winner writes a new leader key with a fresh TTL and updates member state. |
| t=40 | The other node sees the new leader and becomes a replica (re-points replication to it). |

```
NORMAL STATE:
etcd: leader = db1 (TTL=30s, renewed every 10s)
db1:  PostgreSQL PRIMARY, Patroni LEADER
db2:  PostgreSQL REPLICA, Patroni FOLLOWER
db3:  PostgreSQL REPLICA, Patroni FOLLOWER

FAILURE:  db1 crashes → lock TTL counts down → expires at t=30s
ELECTION: db2/db3 race for the expired lock → Raft picks one winner
PROMOTION: winner runs pg_ctl promote → PostgreSQL becomes PRIMARY
RECONCILIATION: the other node follows the new leader
CLIENT ROUTING (pgpool-II): health check sees db2 up as primary →
   writes routed to db2; the VIP may move independently via watchdog
```

**Failover time ≈ TTL + loop_wait** (30 s + 10 s = ~40 s worst case with these defaults). Measured in this deployment: **38–43 s** from power loss to first successful write, median ~40 s.

> 📐 **Why the client-visible interruption (34–38 s) is shorter than the failover window (38–43 s):** the two numbers measure different endpoints. **T0→T4** is the full failover window — from the power loss (T0) until the observer confirms the new primary is fully promoted and pgpool has re-attached it (T4). The **client-visible write interruption** is measured from the *writer's* last successful commit to its *next* successful commit through the VIP. Because pgpool keeps serving reads and the writer's next commit can land on the new primary as soon as it is writable (before pgpool's final re-attach bookkeeping completes), the client-visible gap is a few seconds shorter than the full T0→T4 window. Both are reported so you can plan client retry timeouts against the larger (T0→T4) number.

### Timeline, history, and lag — why failover is *safe*

These three concepts are what make Patroni's failover safe and recoverable — and exactly what a standalone database lacks.

**Timeline.** PostgreSQL keeps a monotonically increasing timeline number that changes every time a new primary is promoted.

```
Timeline 1:  db1 is primary
Timeline 2:  db2 promoted (after db1 failed)
Timeline 3:  db3 promoted (after db2 failed)
```

Stored in `pg_control` and in the WAL, the timeline tells PostgreSQL which history branch a node belongs to. After a failover, the old primary is on an **older timeline**; timelines are what make it possible to safely rejoin it with `pg_rewind` instead of a full re-copy.

**History.** Patroni keeps a full audit trail of every leadership change in etcd:

```
patronictl -c /etc/patroni/patroni.yml history maruf

+----------+------------------+------------------+------------------+---------+
| Timeline | LSN              | Leader           | New Leader       | Reason  |
+----------+------------------+------------------+------------------+---------+
| 1        | 0/3000000        | db1              |                  |         |
| 2        | 0/5000000        | db2              | db1              | failover|
| 3        | 0/7000000        | db3              | db2              | failover|
+----------+------------------+------------------+------------------+---------+
```

Each row records **when** leadership moved, **from whom** to **whom**, and the **LSN** (log sequence number) at the switch. You can always answer "who was primary, when, and why did it change?" — observability a standalone database simply does not have.

**Lag.** Lag is how far behind a replica is from the primary (in WAL bytes). `maximum_lag_on_failover` (default 1 MB in this deployment) tells Patroni: *"do not promote a replica that is more than this far behind."* This is a **data-safety guarantee**: Patroni will never promote a replica that would lose committed transactions.

### The measured numbers (real fault injection, kernel-level VMs)

Faults were injected by **power-loss kill** (`virsh destroy` — no graceful stops), with a continuous write workload and a node-level observer running through each incident:

| Metric | Measured value |
|--------|----------------|
| Failover iterations | **5 / 5 PASS** (kills rotated across db1 → db3 → db1 → db3 → db2) |
| Failover T0→T4 | 38–43 s, **median 40 s** |
| Client-visible write interruption | **34–38 s** |
| Confirmed writes across all runs | ~104,000 |
| Lost commits | **0** (per-run `comm -23` verification) |
| Split-brain samples | **0 / 3,600** direct node probes |
| Killed-node rejoin | **36–40 s** (budget was ≤10 min; 15× margin) |
| Timeline progression | TL 10 → 15 across the 5 iterations |

---

## 8. Preferred Primary Node

### Can we make one node "always primary when available"? Yes.

Patroni supports this natively via the **`failover_priority`** tag (formerly `standby_priority`). You can make one node (e.g. db1) the preferred primary so that, whenever it is healthy and in sync, Patroni steers leadership back to it — automatically after a failover, or on demand with a switchover.

### How Patroni chooses a leader

Patroni does **not** pick a leader by "whoever is fastest." It uses a **priority number** stored per member. When the current leader's lock expires (or on a manual switchover), Patroni looks at the `failover_priority` of each candidate and promotes the one with the **highest** value.

- Higher `failover_priority` = more preferred to become primary.
- A node with `failover_priority: 0` is **never** promoted (replica only).
- The **current leader** keeps leadership until it loses the lease — priority only matters at *election time*.

> **Important:** `failover_priority` is a *preference*, not a hard guarantee. It is honored when the preferred node is **healthy and caught up** at the moment of election. If the preferred node is down or lagging, Patroni promotes the next-best candidate rather than wait.

### Automatic failback vs. manual switchover

**Automatic failback (recommended):** set db1 to the highest priority. If db1 dies, Patroni fails over to db2/db3. When db1 comes back and rejoins as a healthy, in-sync replica, Patroni **automatically switches leadership back to db1** — a self-healing "preferred primary" with no manual step.

**Manual switchover:** even without automatic failback, you can always force leadership back:

```bash
# Move leadership to db1 (interactive)
patronictl -c /etc/patroni/patroni.yml switchover maruf --master db2 --candidate db1

# Non-interactive (for scripts)
patronictl -c /etc/patroni/patroni.yml switchover maruf --master db2 --candidate db1 --force
```

This is a **graceful** operation (zero data loss), used for planned maintenance or to "return home" after a failover.

### How to configure it

In the `patroni.yml` from Phase 3, every node currently gets identical tags (no `failover_priority` — all three are equally preferred). To make db1 the preferred primary, add a `failover_priority` to the `tags:` block on each node:

```yaml
# In /etc/patroni/patroni.yml, inside the tags: block
# db1 -> 100, db2 -> 50, db3 -> 0 (never primary)
tags:
    nofailover: false
    noloadbalance: false
    clonefrom: false
    nosync: false
    failover_priority: 100   # db1; use 50 on db2, 0 on db3
```

Or, for explicit per-host control, use a per-host map (e.g. `db1: 100`, `db2: 50`, `db3: 0`) and set each node's `failover_priority` from it.

> **Note:** `failover_priority` is a **dynamic** DCS setting read from etcd, so you can also change it at runtime with `patronictl edit-config` — no full redeploy needed. Verify with `patronictl list` / `patronictl show-config maruf`.

### pgpool-II? It follows Patroni.

pgpool-II does **not** need to know about `failover_priority`. It simply routes writes to whatever node Patroni says is primary (via `sr_check` + the `on_role_change` callback). Once Patroni steers leadership back to db1, pgpool automatically follows — the VIP keeps serving, the app sees no change. If you also want the **pgpool watchdog leader** (VIP owner) to prefer db1, raise its `wd_priority` (the per-node value in the pgpool watchdog config from Phase 4) — independent of the PostgreSQL primary, but keeping both on the same node reduces cross-node hops.

### Caveats — be honest about expectation

1. **Preference, not guarantee** — a down or lagging preferred node is skipped; Patroni will not wait for it (see §7 for the TTL-based "wait" pattern).
2. **Automatic failback causes a switchover** — when db1 returns and leadership is handed back, that is a real (graceful) switchover with a brief write blip (~3–4 s with the callback fix). If you want to avoid the blip entirely, use manual switchover instead.
3. **`failover_priority: 0` means "never primary"** — use deliberately; it reduces HA options if the other two nodes are down.
4. **Keep priorities sensible** — common patterns: `100 / 50 / 0` (one preferred, one backup, one never-primary) or `100 / 50 / 25` (all promotable, fixed order). Don't set all three equal if you want a clear preference.
5. **`maximum_lag_on_failover` still applies** — a preferred node that is too far behind will not be promoted even with the highest priority.

---

## 9. Manual Deployment Steps (Full Guide)

This is the **complete, hand-by-hand path** — every step needed to build the cluster from scratch, so you understand exactly what is happening under the hood. Every config file below is the **full, working version**, not a representative excerpt.

### What you need before you start

| Requirement | Detail |
|-------------|--------|
| **4 VMs / hosts** | `db1` (192.168.122.150), `db2` (.151), `db3` (.152), `db-backup` (.153) |
| **OS** | CentOS Stream 9 / RHEL 9 **or** Debian 12 / Ubuntu 22.04 / 24.04 (all nodes same family) |
| **Hardware (per DB node)** | 4 vCPU, 8 GB RAM minimum (32 GB recommended); separate disk for `/postgres/data` (or `/var/lib/pgsql`) and `/var/lib/etcd` — **persistent** storage, not tmpfs/ramfs |
| **Network** | 1 Gbps between nodes; a **free, unused IP** on your subnet for the VIP (`192.168.122.200` in this guide) |
| **DNS / hosts** | All nodes resolve each other by hostname (via `/etc/hosts` or internal DNS) |
| **Access** | Root (or sudo) on every node; a `postgres` system user exists (created by the packages) |
| **Secrets** | Choose strong passwords for every `CHANGE_ME_*` placeholder before you start (see §11 for the full list) |

> All commands in this section run as **root** unless stated otherwise. Run on **all nodes** unless a phase says otherwise.

**Pick your distro family** — logic is identical; package management and a few paths differ:

| Area | RHEL / CentOS / Stream 9 | Debian / Ubuntu (12, 22.04, 24.04) |
|------|-------------------------|-----------------------------------|
| Package manager | `dnf` | `apt` (with `apt update`) |
| Percona repo | RPM + `percona-release setup ppg-16` | `.deb` + `percona-release setup ppg-16` |
| PostgreSQL data dir | `/var/lib/pgsql/16/data/maruf` | `/postgres/data/16/maruf` |
| PostgreSQL bin dir | `/usr/pgsql-16/bin` | `/usr/lib/postgresql/16/bin` |
| PostgreSQL service | `postgresql-16` (systemd) | `postgresql` (via `pg_ctlcluster`) |
| Patroni binary | `/usr/bin/patroni` | `/bin/patroni` |
| **Pgpool config dir** | `/etc/pgpool-II` | `/etc/pgpool2` |
| **Pgpool service name** | `pgpool` | `pgpool2` |
| **Pgpool package** | `percona-pgpool-II-pg16` (4.7) | **PGDG `pgpool2` 4.7.2** + `postgresql-16-pgpool2` |
| Postgres user home | `/var/lib/pgsql` | `/var/lib/postgresql` |

> 📄 **Everything you need is in this guide.** All config files AND all helper scripts (`wait_for_etcd.sh`, `pgpool_role_signal.sh`, `failover.sh`, `follow_master.sh`, `reattach_nodes.sh`, `patroni_self_heal.sh`, `cluster_health.sh`) are included inline below — no external repository or Ansible is required. Where a phase says "create the file", the full content is given in the block that follows.

> 📝 **How to create the config files.** Throughout the phases, config files are shown as content blocks with a comment naming the target path (e.g. `# /etc/patroni/patroni.yml`). Create each file at that exact path with your editor, e.g. `vi /etc/patroni/patroni.yml` (paste the block, save, quit), or with a heredoc:
> ```bash
> cat > /etc/patroni/patroni.yml <<'EOF'
> <paste the block content here>
> EOF
> ```
> The systemd units and auth files already show the full `cat > ... <<'EOF'` command — for those, just run the block as-is. Where a phase says "create the file", the path in the comment is where it must live.

> ⚠️ **Every `192.168.122.x` address below is an EXAMPLE.** Replace **all** of them with YOUR VMs' IPs and YOUR chosen VIP before copying any file — they appear in every config block (etcd, Patroni, pgpool, pgBackRest) and in the verification commands. If you leave them as-is, the cluster will deploy against the wrong addresses and Phase 8's `psql -h 192.168.122.200` will time out.

> 🛡️ **The three classic self-inflicted failures (and their guards):**
> 1. **SSH lock-out** — `ufw --force enable` drops your SSH session unless you open port 22 first. Guard: the Phase 0 firewall block includes `ufw allow 22/tcp`.
> 2. **Wrong example IPs** — typing `192.168.122.x` literally instead of your real addresses. Guard: replace every `192.168.122.x` (see the warning above).
> 3. **Wrong NIC name** — copying `eth0`/`enp3s0` when your interface is different. Guard: run `ip link` first and use your real interface name everywhere (the pgpool watchdog blocks call this out).

---

### Phase 0 — OS preparation (all 4 nodes)

```bash
# 1. Hostnames (run each on the matching VM: db1 on .150, db2 on .151, db3 on .152,
#    db-backup on .153)
hostnamectl set-hostname db1      # db2, db3, db-backup respectively

# 2. /etc/hosts — same on every node
cat >> /etc/hosts <<'EOF'
192.168.122.150  db1
192.168.122.151  db2
192.168.122.152  db3
192.168.122.153  db-backup
192.168.122.200  pgpool-vip
EOF

# 3. Firewall: open cluster ports (between nodes only)
# RHEL/CentOS:
firewall-cmd --permanent --add-service=ssh        # keep SSH open so you don't lock yourself out
firewall-cmd --permanent --add-port={2379,2380}/tcp
firewall-cmd --permanent --add-port=5432/tcp
firewall-cmd --permanent --add-port=8008/tcp
firewall-cmd --permanent --add-port=9000/tcp
firewall-cmd --permanent --add-port=9694/udp     # watchdog heartbeat lifecheck
firewall-cmd --permanent --add-port={9898,9999}/tcp
firewall-cmd --reload

# Debian/Ubuntu (UFW):
ufw allow 22/tcp          # keep SSH open so you don't lock yourself out
ufw allow 2379/tcp
ufw allow 2380/tcp
ufw allow 5432/tcp
ufw allow 8008/tcp
ufw allow 9000/tcp
ufw allow 9694/udp     # watchdog heartbeat lifecheck
ufw allow 9898/tcp
ufw allow 9999/tcp
ufw --force enable
```

> 🔥 **Ports:** 2379/2380 (etcd client/peer), 5432 (PostgreSQL), 8008 (Patroni REST), 9000 (pgpool `wd_port`), **9694/udp (watchdog heartbeat — required, not optional)**, 9898 (PCP), 9999 (pgpool VIP). **Keep 22 (SSH) open** — `ufw --force enable` switches to default-deny incoming, and without an explicit `ufw allow 22/tcp` your SSH session dies at this exact command.

---

### Phase 1 — Install Percona packages (all 3 DB nodes + backup node)

#### RHEL / CentOS / Stream 9

```bash
# 1. Enable EPEL and CRB (CodeReady Builder) — needed for libssh2/libmemcached deps
dnf install -y epel-release
dnf config-manager --set-enabled crb

# 2. Install Percona release RPM (GPG key comes with the package)
dnf install -y https://repo.percona.com/yum/percona-release-latest.noarch.rpm

# 3. Enable the PostgreSQL 16 Percona repository
percona-release setup ppg-16

# 4. Install everything (RHEL: pgpool-II 4.7 base is installed here; extensions are added in Phase 4)
dnf install -y \
  percona-postgresql16-server percona-postgresql16-contrib \
  percona-patroni etcd jq \
  percona-pgbackrest \
  percona-pgpool-II-pg16 \
  percona-pg_stat_monitor16 \
  docker
```

#### Debian / Ubuntu

```bash
# 1. Install prerequisites
apt update && apt install -y curl wget gnupg2 ca-certificates

# 2. Download and install Percona release .deb
wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
apt install -y ./percona-release_latest.generic_all.deb

# 3. Enable the PostgreSQL 16 Percona repository
percona-release setup ppg-16

# 4. Add the PGDG repo + key (pgpool-II 4.7 is installed in Phase 4)
#    pgpool-II comes from PGDG (apt.postgresql.org), NOT Percona
wget -qO - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor | tee /usr/share/keyrings/pgdg.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt update
# NOTE: do NOT install pgpool2 here — it is installed (pinned to 4.7.2) in Phase 4

# 5. Install the rest from Percona (jq is required by the failover scripts in Phase 4)
apt install -y \
  percona-postgresql-16 \
  percona-patroni etcd \
  percona-pgbackrest \
  jq \
  docker.io
```

> ⚠️ **Debian pgpool2 note:** pgpool-II is installed from **PGDG** (`apt.postgresql.org`) at **4.7.2**, not from the Percona repo (which ships no pgpool-II daemon for Debian). Remove any old apt pin (`/etc/apt/preferences.d/pgpool2`) that would force the native Debian 4.3.5 — this guide expects 4.7. `pg_stat_monitor` is skipped on Debian (no package).

---

### Phase 2 — etcd cluster (db1, db2, db3)

Create `/etc/etcd/etcd.conf` on **each** node — the token and member IP list **must be identical** on all three nodes; only `ETCD_NAME`, `ETCD_ADVERTISE_CLIENT_URLS`, and `ETCD_INITIAL_ADVERTISE_PEER_URLS` differ per node:

```ini
# /etc/etcd/etcd.conf  (db1 example)
ETCD_NAME="db1"
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_LISTEN_CLIENT_URLS="http://0.0.0.0:2379"
ETCD_LISTEN_PEER_URLS="http://0.0.0.0:2380"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.122.150:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.122.150:2380"
ETCD_INITIAL_CLUSTER="db1=http://192.168.122.150:2380,db2=http://192.168.122.151:2380,db3=http://192.168.122.152:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="PostgreSQL_HA_Cluster_1"
```

> 🔑 **Per-node values:** on **db2** set `ETCD_NAME="db2"`, `ETCD_ADVERTISE_CLIENT_URLS="http://192.168.122.151:2379"`, `ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.122.151:2380"`. On **db3** use `192.168.122.152`. Everything else stays identical.

> 🔁 **`ETCD_INITIAL_CLUSTER_STATE`:** use `"new"` on the **first** bootstrap. On any later start (reboot, re-run) the data dir already exists — change it to `"existing"` or etcd will fail with a member/cluster-ID mismatch.

Create the systemd unit — **identical on all three nodes** (it reads each node's values from `/etc/etcd/etcd.conf` via `EnvironmentFile`):

```bash
cat > /etc/systemd/system/etcd.service <<'EOF'
[Unit]
Description=etcd key-value store
Documentation=https://etcd.io/docs/
After=network-online.target
Wants=network-online.target

[Service]
# Loads the per-node values from /etc/etcd/etcd.conf (ETCD_NAME, ETCD_*_URLS, ...)
EnvironmentFile=/etc/etcd/etcd.conf

ExecStart=/usr/bin/etcd \
  --data-dir=${ETCD_DATA_DIR} \
  --name ${ETCD_NAME} \
  --initial-advertise-peer-urls ${ETCD_INITIAL_ADVERTISE_PEER_URLS} \
  --listen-peer-urls ${ETCD_LISTEN_PEER_URLS} \
  --advertise-client-urls ${ETCD_ADVERTISE_CLIENT_URLS} \
  --listen-client-urls ${ETCD_LISTEN_CLIENT_URLS} \
  --initial-cluster ${ETCD_INITIAL_CLUSTER} \
  --initial-cluster-state ${ETCD_INITIAL_CLUSTER_STATE} \
  --initial-cluster-token ${ETCD_INITIAL_CLUSTER_TOKEN}

Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
```

> ⚠️ **Persistence guard:** etcd's data dir (`/var/lib/etcd`) **must** be on persistent disk, not tmpfs/ramfs — otherwise the cluster brain is lost on every reboot. Do not put it on volatile storage.

Start etcd on all three nodes together (quorum needs 2/3), then verify:

```bash
systemctl daemon-reload
systemctl enable --now etcd   # on all 3, roughly together

# Verify quorum from any node
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 endpoint health
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 member list
# All 3 members must show "healthy: true"

# If a member shows "unhealthy": check `journalctl -u etcd -f` on that node, and
# confirm all three /etc/etcd/etcd.conf files have IDENTICAL ETCD_INITIAL_CLUSTER
# and ETCD_INITIAL_CLUSTER_TOKEN values (a typo in one breaks the whole quorum).
```

> 🔁 **Re-runs never wipe etcd.** Only a fresh bootstrap / DR restore wipes the data dir. Never `rm -rf /var/lib/etcd/*` on a healthy cluster.

> ✅ **Done with etcd?** Phase 8 step 2 re-verifies quorum — run it after Phase 7.

---

### Phase 3 — Patroni + PostgreSQL (db1, db2, db3)

> 🔑 **Replace every `CHANGE_ME_*` below with your real passwords before starting** (see §12 for the full list). The `name` and the two `connect_address`/etcd host lines change per node.

Create `/etc/patroni/patroni.yml` on **each** node. The structure is the same everywhere; only `name` and the two `connect_address`/etcd host lines change per node.

```yaml
# /etc/patroni/patroni.yml  (db1 example)
namespace: percona_lab
scope: maruf
name: db1                       # db2 / db3 on the other nodes

restapi:
  listen: 0.0.0.0:8008
  connect_address: 192.168.122.150:8008   # this node's IP

etcd3:
  hosts: 192.168.122.150:2379,192.168.122.151:2379,192.168.122.152:2379   # ALL etcd endpoints (DCS redundancy)

# Self-fencing: if this Patroni loses DCS quorum / becomes partitioned, it stops
# feeding the kernel watchdog (softdog) and the host is rebooted — preventing a
# stale primary from accepting writes (split-brain protection).
watchdog:
  mode: automatic
  device: /dev/watchdog
  safety_margin: 5

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576

    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        wal_level: replica
        hot_standby: "on"
        max_wal_senders: 10
        max_replication_slots: 20
        wal_log_hints: "on"
        wal_keep_size: "1GB"
        logging_collector: "on"
        # max_wal_size is pgtune-calculated dynamically (not a fixed 10GB)
        archive_mode: "off"
        archive_timeout: 600s
        # NOTE: no archive_command here — archiving is OFF by default. If you run
        # pgBackRest (Phase 5), it re-enables archive_mode and sets the pgbackrest
        # archive-push/archive-get commands.

  initdb:
    - encoding: UTF8
    - data-checksums

  pg_hba:
    - host replication replicator 127.0.0.1/32 trust
    - host replication replicator 0.0.0.0/0 scram-sha-256
    - host all all 0.0.0.0/0 scram-sha-256
    - host all all ::0/0 scram-sha-256

  users:
    admin:
      password: CHANGE_ME_ADMIN
      options:
        - createrole
        - createdb
    percona:
      password: CHANGE_ME_PERCONA
      options:
        - createrole
        - createdb
    pgpool:
      password: CHANGE_ME_PGPOOL
      options:
        - createrole
        - createdb

postgresql:
  cluster_name: cluster_1
  listen: 0.0.0.0:5432
  connect_address: 192.168.122.150:5432   # this node's IP
  data_dir: /postgres/data/16/maruf         # DEBIAN PATH — change for RHEL below
  bin_dir: /usr/lib/postgresql/16/bin      # DEBIAN PATH — change for RHEL below
  pgpass: /tmp/pgpass0        # Patroni creates this file during bootstrap — you don't create it
  authentication:
    replication:
      username: replicator
      password: CHANGE_ME_REPLICATOR
    superuser:
      username: postgres
      password: CHANGE_ME_POSTGRES
  parameters:
    unix_socket_directories: /var/run/postgresql
  create_replica_methods:
    - basebackup
  basebackup:
    checkpoint: 'fast'

  # Active switchover signal: on promotion, immediately tell pgpool
  # (pcp_promote_node on every pgpool node) instead of waiting for sr_check
  # polling to notice the role change. Patroni reads callbacks from the
  # postgresql: subsection.
  callbacks:
    on_role_change: /usr/local/sbin/pgpool_role_signal.sh

tags:
  nofailover: false
  noloadbalance: false
  clonefrom: false
  nosync: false
```

> 📋 **Path differences for `patroni.yml`:**
> - **RHEL/CentOS:** `data_dir: /var/lib/pgsql/16/data/maruf`, `bin_dir: /usr/pgsql-16/bin`
> - **Debian/Ubuntu:** `data_dir: /postgres/data/16/maruf`, `bin_dir: /usr/lib/postgresql/16/bin`

#### Enable the softdog watchdog (self-fencing)

```bash
# Load the kernel softdog module + persist across reboots
modprobe softdog
echo "softdog" > /etc/modules-load.d/softdog.conf

# Give postgres write access to /dev/watchdog (udev rule)
cat > /etc/udev/rules.d/99-watchdog.rules <<'EOF'
KERNEL=="watchdog*", MODE="0666"
EOF
udevadm control --reload-rules && udevadm trigger
chmod 666 /dev/watchdog 2>/dev/null || true

# Verify
ls -l /dev/watchdog
```

#### Deploy the supporting scripts

```bash
# 1. wait_for_etcd.sh — Patroni ExecStartPre: wait until at least one etcd
#    endpoint accepts connections before starting (dependency-free TCP probe).
cat > /usr/local/sbin/wait_for_etcd.sh <<'EOF'
#!/bin/bash
ENDPOINTS="$1"
[ -z "$ENDPOINTS" ] && ENDPOINTS="192.168.122.150:2379,192.168.122.151:2379,192.168.122.152:2379"
TIMEOUT=90
wait_for_etcd() {
  local ep host port
  for ep in $(echo "$ENDPOINTS" | tr ',' ' '); do
    host="${ep%:*}"; port="${ep##*:}"
    if timeout 2 bash -c "</dev/tcp/$host/$port" 2>/dev/null; then return 0; fi
  done
  return 1
}
for i in $(seq 1 "$TIMEOUT"); do
  if wait_for_etcd; then echo "$(date): etcd reachable after ${i}s"; exit 0; fi
  sleep 1
done
echo "ERROR: etcd not reachable after ${TIMEOUT}s" >&2
exit 1
EOF
chmod 0755 /usr/local/sbin/wait_for_etcd.sh

# 2. pgpool_role_signal.sh — Patroni on_role_change callback: on promotion,
#    immediately run pcp_promote_node on every pgpool node (closes the ~4 min
#    switchover detection gap). Create it with the full script below.
cat > /usr/local/sbin/pgpool_role_signal.sh <<'EOF'
#!/bin/bash
# pgpool_role_signal.sh - Patroni on_role_change callback.
#
# PURPOSE
#   Signal pgpool immediately when Patroni promotes a node, instead of
#   waiting for pgpool's periodic sr_check polling to notice the role
#   change. Without this, a clean `patronictl switchover` left the
#   write path pointing at the old primary for ~4 minutes.
#
# Patroni invokes callbacks as:  <cmd> <cb_type> <role> <scope>
#   $1 = on_role_change
#   $2 = primary | replica
#   $3 = cluster scope
#
# SAFETY
#   - Acts ONLY on promotion to primary (role=primary).
#   - Confirms via patronictl that THIS node is the Patroni Leader.
#   - Maps own IP -> pgpool backend node id and runs pcp_promote_node
#     for that id on ALL pgpool nodes.
#   - Idempotent: promoting an already-primary node is a no-op.
#
# Runs as postgres (the Patroni service user); uses .pcppass for PCP auth.

set -u

# Distro-aware pgpool config dir (RHEL/Percona: /etc/pgpool-II, Debian: /etc/pgpool2)
if [ -d "/etc/pgpool-II" ]; then
    PGCONF_DIR="/etc/pgpool-II"
elif [ -d "/etc/pgpool2" ]; then
    PGCONF_DIR="/etc/pgpool2"
else
    PGCONF_DIR="/etc/pgpool-II"
fi

PCP_PORT=9898
PCP_USER=pgpool_pcp
export PCPPASSFILE="$PGCONF_DIR/.pcppass"
LOG_DIR="/var/log/pgpool"
[ -d "$LOG_DIR" ] || LOG_DIR="/tmp"
LOG_FILE="$LOG_DIR/role_signal.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S%z') $*" >> "$LOG_FILE"; }

CB="${1:-}"
ROLE="${2:-}"
SCOPE="${3:-}"

# Only react to a promotion to primary.
if [ "$CB" != "on_role_change" ] || [ "$ROLE" != "primary" ]; then
    exit 0
fi

log "on_role_change fired: cb=$CB role=$ROLE scope=$SCOPE"

# 1. Authoritative check: Patroni must name THIS node the Leader.
MY_HOST=$(hostname -s)

LEADER_JSON=$(patronictl -c /etc/patroni/patroni.yml list -f json 2>/dev/null | jq -c '.[] | select(.Role == "Leader")' | head -1)
if [ -z "$LEADER_JSON" ]; then
    log "WARN: cannot determine Patroni Leader - skipping (reattach timer will catch up)"
    exit 0
fi
LEADER_IP=$(echo "$LEADER_JSON" | jq -r '.Host')
LEADER_MEMBER=$(echo "$LEADER_JSON" | jq -r '.Member')

if [ "$LEADER_MEMBER" != "$MY_HOST" ]; then
    log "INFO: this node ($MY_HOST) is not the Patroni Leader ($LEADER_MEMBER@$LEADER_IP) - skipping"
    exit 0
fi
log "confirmed: this node is Patroni Leader $LEADER_MEMBER ($LEADER_IP)"

# 2. Map own host/IP -> pgpool backend node id from pgpool.conf.
NODE_ID=""
CONF="$PGCONF_DIR/pgpool.conf"
MY_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$')
for idx in $(seq 0 9); do
    HOST=$(grep -E "^backend_hostname${idx}[[:space:]]*=" "$CONF" 2>/dev/null | sed -E "s/.*=\s*'([^']+)'.*/\1/")
    if [ -n "$HOST" ]; then
        for ip in $MY_IPS; do
            if [ "$HOST" = "$ip" ] || [ "$HOST" = "$MY_HOST" ]; then
                NODE_ID=$idx
                break 2
            fi
        done
    fi
done
if [ -z "$NODE_ID" ]; then
    log "ERROR: cannot map $MY_IP/$MY_HOST to a pgpool backend node id in $CONF"
    exit 1
fi
log "own pgpool backend node id: $NODE_ID"

# 2b. If pgpool still marks this node down but the backend is up, attach first.
LINE=$(pcp_node_info -h localhost -p $PCP_PORT -U $PCP_USER -w "$NODE_ID" 2>/dev/null)
if [ -n "$LINE" ]; then
    STATUS=$(echo "$LINE" | awk '{print $5}')
    PG_STATUS=$(echo "$LINE" | awk '{print $6}')
    if [ "$STATUS" = "down" ] && [ "$PG_STATUS" = "up" ]; then
        log "node $NODE_ID marked down but backend up - attaching first"
        pcp_attach_node -h localhost -p $PCP_PORT -U $PCP_USER -w "$NODE_ID" >> "$LOG_FILE" 2>&1
    fi
fi

# 3. Promote this node id on ALL pgpool nodes (local + peers).
PGPOOL_HOSTS=$(grep -E "^backend_hostname[0-9]+[[:space:]]*=" "$CONF" 2>/dev/null | sed -E "s/.*=\s*'([^']+)'.*/\1/" | sort -u)
[ -z "$PGPOOL_HOSTS" ] && PGPOOL_HOSTS="localhost"

for phost in $PGPOOL_HOSTS; do
    log "pcp_promote_node $NODE_ID -> pgpool $phost (leader=$LEADER_MEMBER)"
    if timeout 10 pcp_promote_node -h "$phost" -p $PCP_PORT -U $PCP_USER -w "$NODE_ID" >> "$LOG_FILE" 2>&1; then
        log "  ok: promote accepted on $phost"
    else
        rc=$?
        log "  warn: promote on $phost returned rc=$rc (pgpool may already be consistent)"
    fi
done

log "done: routing role corrected to node $NODE_ID on pgpool hosts: $PGPOOL_HOSTS"
exit 0
EOF
chown postgres:postgres /usr/local/sbin/pgpool_role_signal.sh
chmod 0755 /usr/local/sbin/pgpool_role_signal.sh
```

#### Initialize PostgreSQL + systemd unit

##### RHEL / CentOS / Stream 9

```bash
# Data directory will be created by Patroni on bootstrap
mkdir -p /var/lib/pgsql/16 /etc/patroni
chown -R postgres:postgres /var/lib/pgsql

# systemd unit (Patroni binary at /usr/bin/patroni)
cat > /etc/systemd/system/patroni.service <<'EOF'
[Unit]
Description=Runners to orchestrate a high-availability PostgreSQL
After=syslog.target network-online.target etcd.service
Wants=network-online.target
Requires=etcd.service   # etcd is co-located on this node

[Service]
Type=simple
User=postgres
Group=postgres
ExecStartPre=/usr/local/sbin/wait_for_etcd.sh
ExecStart=/usr/bin/patroni /etc/patroni/patroni.yml
ExecReload=/bin/kill -s HUP $MAINPID
KillMode=process
TimeoutSec=30
Restart=on-failure
RestartSec=15s
# Never let systemd give up on Patroni - it must retry forever
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
```

##### Debian / Ubuntu

```bash
# Create the cluster with pg_createcluster (on PRIMARY ONLY - db1)
mkdir -p /postgres/data/16 /etc/patroni
chown -R postgres:postgres /postgres

# On PRIMARY (db1) only:
pg_createcluster 16 maruf -d /postgres/data/16/maruf

# Stop it so Patroni can take over
pg_ctlcluster 16 maruf stop

# systemd unit (Patroni binary at /bin/patroni)
cat > /etc/systemd/system/patroni.service <<'EOF'
[Unit]
Description=Runners to orchestrate a high-availability PostgreSQL
After=syslog.target network-online.target etcd.service
Wants=network-online.target
Requires=etcd.service   # etcd is co-located on this node

[Service]
Type=simple
User=postgres
Group=postgres
ExecStartPre=/usr/local/sbin/wait_for_etcd.sh
ExecStart=/bin/patroni /etc/patroni/patroni.yml
ExecReload=/bin/kill -s HUP $MAINPID
KillMode=process
TimeoutSec=30
Restart=on-failure
RestartSec=15s
# Never let systemd give up on Patroni - it must retry forever
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
```

#### Bootstrap the cluster — start the primary FIRST

```bash
# On db1 ONLY — this creates the data directory and makes db1 the leader
systemctl enable --now patroni

# Wait ~30 seconds for initdb + leader lock
patronictl -c /etc/patroni/patroni.yml list
# db1 should appear as Leader

# Now start replicas — db2, db3
systemctl enable --now patroni

# Wait ~1-2 minutes for pg_basebackup + catch-up
patronictl -c /etc/patroni/patroni.yml list
# db1 Leader, db2 Streaming, db3 Streaming, lag 0
```

> 🧠 **Why primary first?** If you start a replica before any primary exists, Patroni would *also* try to bootstrap — two nodes racing to initdb is chaos. The leader lock in etcd prevents a real split-brain, but starting in order is clean and predictable.

> ✅ **Validate:** `patroni --validate-config /etc/patroni/patroni.yml` on each node before starting.

> ✅ **Done with Patroni?** Phase 8 step 1 re-checks the cluster — run it after Phase 7.

---

### Phase 4 — pgpool-II + Watchdog + VIP (db1, db2, db3)

> 🔑 **Replace every `CHANGE_ME_*` below with the same passwords you used in Phase 3** (`CHANGE_ME_HEALTH` = the `pgpool` user's password, `CHANGE_ME_WD_AUTH` = `watchdog_authkey`, etc. — see §12). The `wd_authkey` must be **identical on all three nodes**.

> 📋 **Config directory and package version differences:**
> - **RHEL/CentOS:** `/etc/pgpool-II`, pgpool-II 4.7 (Percona package), watchdog in **separate `pgpool_watchdog.conf`**
> - **Debian/Ubuntu:** `/etc/pgpool2`, pgpool-II 4.7 (PGDG repo), watchdog **inline in `pgpool.conf`**

#### RHEL/CentOS (pgpool-II 4.7) — Separate Watchdog Config

```ini
# /etc/pgpool-II/pgpool.conf  (db1 example)
listen_addresses = '*'
port = 9999
socket_dir = '/var/run/postgresql'      # this is why the mkdir step below also chowns /var/run/postgresql
pcp_listen_addresses = '*'
pcp_port = 9898
pcp_socket_dir = '/var/run/postgresql'  # same — must be writable by postgres

# Backend nodes (Patroni-managed PostgreSQL instances)
backend_hostname0 = '192.168.122.150'
backend_port0 = 5432
backend_weight0 = 1
backend_data_directory0 = '/var/lib/pgsql/16/data/maruf'   # RHEL PATH
backend_flag0 = 'ALLOW_TO_FAILOVER'

backend_hostname1 = '192.168.122.151'
backend_port1 = 5432
backend_weight1 = 1
backend_data_directory1 = '/var/lib/pgsql/16/data/maruf'   # RHEL PATH
backend_flag1 = 'ALLOW_TO_FAILOVER'

backend_hostname2 = '192.168.122.152'
backend_port2 = 5432
backend_weight2 = 1
backend_data_directory2 = '/var/lib/pgsql/16/data/maruf'   # RHEL PATH
backend_flag2 = 'ALLOW_TO_FAILOVER'

# Authentication
enable_pool_hba = on
pool_passwd = 'pool_passwd'
authentication_timeout = 60
ssl = off

# Load balancing
load_balance_mode = on
ignore_leading_white_space = on
black_function_list = 'nextval,setval,lastval,currval'
allow_sql_comments = off

# Master/slave mode (streaming replication with Patroni)
master_slave_mode = on
master_slave_sub_mode = 'stream'

# Health checks
health_check_period = 5
health_check_timeout = 10
health_check_user = 'pgpool'
health_check_password = 'CHANGE_ME_HEALTH'
health_check_database = 'postgres'
health_check_max_retries = 3
health_check_retry_delay = 1
connect_timeout = 10

# Streaming replication check (primary detection)
sr_check_period = 3
sr_check_user = 'pgpool'
sr_check_password = 'CHANGE_ME_HEALTH'
sr_check_database = 'postgres'
delay_threshold = 10000000

# Failover / failback
failover_command = '/etc/pgpool-II/failover.sh %d %h %p %D %m %H %M %P %r %R'
failback_command = ''
follow_master_command = '/etc/pgpool-II/follow_master.sh %d %h %p %D %m %H %M %P %r %R'

# Pooling (production tuned)
num_init_children = 64
max_pool = 4
child_life_time = 3600
child_max_connections = 1000
connection_life_time = 0
client_idle_limit = 300
reset_query_list = 'ABORT; DISCARD ALL'

# Logging
log_destination = 'stderr'
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
log_connections = on
log_hostname = off
log_statement = 'ddl'
log_per_node_statement = on
log_standby_delay = 'always'
log_min_messages = 'info'

# File locations
pid_file_name = '/var/run/pgpool/pgpool.pid'
logdir = '/var/log/pgpool'

# Failover settings
failover_on_backend_error = on
search_primary_node_timeout = 10
```

And the watchdog section in **separate `pgpool_watchdog.conf`** (4.7 parameter names):

```ini
# /etc/pgpool-II/pgpool_watchdog.conf (db1 example)
use_watchdog = on
wd_lifecheck_method = heartbeat
wd_monitoring_interfaces_list = 'eth0'

# Watchdog nodes — indexed tuples, ALL 3 on EVERY node (Pgpool 4.7 format)
hostname0 = '192.168.122.150'
wd_port0 = 9000
pgpool_port0 = 9999
hostname1 = '192.168.122.151'
wd_port1 = 9000
pgpool_port1 = 9999
hostname2 = '192.168.122.152'
wd_port2 = 9000
pgpool_port2 = 9999

# Local node priority + auth key (unindexed in 4.7)
# wd_priority is computed per node as wd_priority_base + (3 - node_index):
# db1=3, db2=2, db3=1 (this is the db1 example)
wd_priority = 3
wd_authkey = 'CHANGE_ME_WD_AUTH'

# Exit pgpool if the watchdog loses quorum (prevents split-brain VIP)
wd_quorum_exit = on

# Heartbeat (4.7 names: heartbeat_hostname, heartbeat_port, heartbeat_device)
heartbeat_hostname0 = '192.168.122.151'
heartbeat_port0 = 9694
heartbeat_device0 = 'eth0'
heartbeat_hostname1 = '192.168.122.152'
heartbeat_port1 = 9694
heartbeat_device1 = 'eth0'

# Virtual IP — only active on the watchdog leader
delegate_ip = '192.168.122.200'
if_cmd_path = '/usr/sbin'
if_up_cmd = '/usr/sbin/ip addr add 192.168.122.200/24 dev eth0 label eth0:pgpool'
if_down_cmd = '/usr/sbin/ip addr del 192.168.122.200/24 dev eth0'
arping_path = '/usr/sbin'
arping_cmd = '/usr/sbin/arping -U 192.168.122.200 -w 1 -I eth0'
```

#### Debian/Ubuntu (pgpool-II 4.7) — Inline Watchdog Config

First install pgpool-II 4.7 from PGDG (pinned):

```bash
# On each DB node — install pgpool-II 4.7.2 from PGDG (repo added in Phase 1)
apt install -y pgpool2=4.7.2-1.pgdg* libpgpoolpcp3=4.7.2-1.pgdg* postgresql-16-pgpool2=4.7.2-1.pgdg*
```

```ini
# /etc/pgpool2/pgpool.conf  (db1 example — watchdog INLINE)
listen_addresses = '*'
port = 9999
socket_dir = '/var/run/postgresql'      # this is why the mkdir step below also chowns /var/run/postgresql
pcp_listen_addresses = '*'
pcp_port = 9898
pcp_socket_dir = '/var/run/postgresql'  # same — must be writable by postgres

# Backend nodes
backend_hostname0 = '192.168.122.150'
backend_port0 = 5432
backend_weight0 = 1
backend_data_directory0 = '/postgres/data/16/maruf'   # DEBIAN PATH
backend_flag0 = 'ALLOW_TO_FAILOVER'

backend_hostname1 = '192.168.122.151'
backend_port1 = 5432
backend_weight1 = 1
backend_data_directory1 = '/postgres/data/16/maruf'   # DEBIAN PATH
backend_flag1 = 'ALLOW_TO_FAILOVER'

backend_hostname2 = '192.168.122.152'
backend_port2 = 5432
backend_weight2 = 1
backend_data_directory2 = '/postgres/data/16/maruf'   # DEBIAN PATH
backend_flag2 = 'ALLOW_TO_FAILOVER'

# Authentication
enable_pool_hba = on
pool_passwd = 'pool_passwd'
authentication_timeout = 60
ssl = off

# Load balancing
load_balance_mode = on
ignore_leading_white_space = on
black_function_list = 'nextval,setval,lastval,currval'
allow_sql_comments = off

# Master/slave mode
master_slave_mode = on
master_slave_sub_mode = 'stream'

# Health checks
health_check_period = 5
health_check_timeout = 10
health_check_user = 'pgpool'
health_check_password = 'CHANGE_ME_HEALTH'
health_check_database = 'postgres'
health_check_max_retries = 3
health_check_retry_delay = 1
connect_timeout = 10

# Streaming replication check
sr_check_period = 3
sr_check_user = 'pgpool'
sr_check_password = 'CHANGE_ME_HEALTH'
sr_check_database = 'postgres'
delay_threshold = 10000000

# Failover / failback
failover_command = '/etc/pgpool2/failover.sh %d %h %p %D %m %H %M %P %r %R'
failback_command = ''
follow_master_command = '/etc/pgpool2/follow_master.sh %d %h %p %D %m %H %M %P %r %R'

# Pooling
num_init_children = 64
max_pool = 4
child_life_time = 3600
child_max_connections = 1000
connection_life_time = 0
client_idle_limit = 300
reset_query_list = 'ABORT; DISCARD ALL'

# Logging
log_destination = 'stderr'
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
log_connections = on
log_hostname = off
log_statement = 'ddl'
log_per_node_statement = on
log_standby_delay = 'always'
log_min_messages = 'info'

# File locations
pid_file_name = '/var/run/pgpool/pgpool2.pid'
logdir = '/var/log/pgpool2'

# Failover settings
failover_on_backend_error = on
search_primary_node_timeout = 10

# Watchdog (INLINE in pgpool.conf — 4.7 parameter names)
use_watchdog = on
wd_lifecheck_method = 'heartbeat'
wd_monitoring_interfaces_list = 'enp3s0'

# Watchdog nodes (indexed: 0,1,2 — must list ALL nodes)
hostname0 = '192.168.122.150'
wd_port0 = 9000
pgpool_port0 = 9999
hostname1 = '192.168.122.151'
wd_port1 = 9000
pgpool_port1 = 9999
hostname2 = '192.168.122.152'
wd_port2 = 9000
pgpool_port2 = 9999

# Local node priority + auth key (unindexed in 4.7)
# wd_priority is computed per node as wd_priority_base + (3 - node_index):
# db1=3, db2=2, db3=1 (this is the db1 example)
wd_priority = 3
wd_authkey = 'CHANGE_ME_WD_AUTH'

# Exit pgpool if the watchdog loses quorum (prevents split-brain VIP)
wd_quorum_exit = on

# Heartbeat (4.7 names: heartbeat_hostname, heartbeat_port, heartbeat_device)
heartbeat_hostname0 = '192.168.122.151'
heartbeat_port0 = 9694
heartbeat_device0 = 'enp3s0'
heartbeat_hostname1 = '192.168.122.152'
heartbeat_port1 = 9694
heartbeat_device1 = 'enp3s0'

# Virtual IP — only active on the watchdog leader
delegate_IP = '192.168.122.200'
if_cmd_path = '/usr/sbin'
if_up_cmd = '/usr/sbin/ip addr add 192.168.122.200/24 dev enp3s0 label enp3s0:pgpool'
if_down_cmd = '/usr/sbin/ip addr del 192.168.122.200/24 dev enp3s0'
arping_path = '/usr/sbin'
arping_cmd = '/usr/sbin/arping -U 192.168.122.200 -w 1 -I enp3s0'
```

> ⚠️ **`enp3s0` is an example NIC name.** Check your actual interface with `ip link` (Debian 12 commonly uses `enp3s0` or `enp1s0`, but it can be `ens18`, `eth0`, etc.). Change **every** `enp3s0` in this file — `wd_monitoring_interfaces_list`, `heartbeat_device0/1`, and `if_up_cmd`/`if_down_cmd`/`arping_cmd` — or the watchdog heartbeats will silently fail and the VIP will never form.

> 🔑 **Debian vs RHEL parameter differences (both 4.7):**
> | 4.7 (CentOS, separate file) | 4.7 (Debian, inline) |
> |-----------------------------|------------------------|
> | `delegate_ip` | `delegate_IP` (uppercase) |
> | `pgpool_watchdog.conf` | inline in `pgpool.conf` |
> | (all other watchdog params identical) | |

#### Per-node files (identical on both distros except config dir)

```bash
# Create the pgpool log, pid, and socket directories (pgpool will not start
# without them). RHEL: /var/log/pgpool + /var/run/pgpool; Debian: /var/log/pgpool2.
mkdir -p /var/log/pgpool /var/run/pgpool /var/run/postgresql   # RHEL
# mkdir -p /var/log/pgpool2 /var/run/pgpool /var/run/postgresql  # Debian
chown -R postgres:postgres /var/log/pgpool /var/run/pgpool /var/run/postgresql   # RHEL
# chown -R postgres:postgres /var/log/pgpool2 /var/run/pgpool /var/run/postgresql  # Debian

# db1 → 0, db2 → 1, db3 → 2
echo -n "0" > /etc/pgpool-II/pgpool_node_id    # RHEL path
# echo -n "0" > /etc/pgpool2/pgpool_node_id    # Debian path

# postgres needs to raise the VIP → sudoers entry
cat > /etc/sudoers.d/pgpool-vip <<'EOF'
postgres ALL=(ALL) NOPASSWD: /usr/sbin/ip, /usr/sbin/arping
EOF
chmod 440 /etc/sudoers.d/pgpool-vip
```

> 📋 **Config dir for these files:**
> - **RHEL/CentOS:** `/etc/pgpool-II/`
> - **Debian/Ubuntu:** `/etc/pgpool2/`

#### Auth files: pool_passwd (plaintext for SCRAM), pcp.conf (MD5), pool_hba.conf

```bash
# pool_passwd — PLAINTEXT passwords (PostgreSQL 16 + pgpool 4.7 uses SCRAM-SHA-256)
cat > /etc/pgpool-II/pool_passwd <<'EOF'
pgpool_admin:CHANGE_ME_PGPOOL_ADMIN
pgpool:CHANGE_ME_PGPOOL
postgres:CHANGE_ME_POSTGRES
EOF

# pcp.conf — MD5-hashed password (pgpool 4.x). Use md5sum (not shell pg_md5)
# so passwords with shell metacharacters like '$' hash correctly.
# Manual alternative:  pg_md5 -p -u pgpool_pcp
echo "pgpool_pcp:$(printf '%s' 'CHANGE_ME_PCP' | md5sum | awk '{print $1}')" > /etc/pgpool-II/pcp.conf

# pool_hba.conf — governs client auth through pgpool (scram, no hostssl)
cat > /etc/pgpool-II/pool_hba.conf <<'EOF'
# TYPE  DATABASE  USER  ADDRESS          METHOD
local   all       all                     trust
host    all       all   127.0.0.1/32      scram-sha-256
host    all       all   192.168.122.0/24  scram-sha-256
host    all       all   0.0.0.0/0         scram-sha-256
EOF

# .pcppass — plaintext so pcp_* commands run non-interactively
cat > /etc/pgpool-II/.pcppass <<'EOF'
*:9898:pgpool_pcp:CHANGE_ME_PCP
EOF

chown postgres:postgres /etc/pgpool-II/pool_passwd /etc/pgpool-II/pcp.conf \
  /etc/pgpool-II/pool_hba.conf /etc/pgpool-II/.pcppass
chmod 0640 /etc/pgpool-II/pool_passwd /etc/pgpool-II/pcp.conf /etc/pgpool-II/pool_hba.conf
chmod 0600 /etc/pgpool-II/.pcppass
```

> 📋 **Config dir for these files:** RHEL `/etc/pgpool-II/`, Debian `/etc/pgpool2/`.

#### Create the pgpool users in PostgreSQL (on the current primary)

```bash
# On the current Patroni primary (db1 initially) — as the postgres user
su - postgres -c "psql" <<'SQL'
DO $body$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgpool_admin') THEN
    CREATE ROLE pgpool_admin WITH LOGIN SUPERUSER PASSWORD 'CHANGE_ME_PGPOOL_ADMIN';
  ELSE
    ALTER ROLE pgpool_admin WITH LOGIN SUPERUSER PASSWORD 'CHANGE_ME_PGPOOL_ADMIN';
  END IF;
END
$body$;

DO $body$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgpool_pcp') THEN
    CREATE ROLE pgpool_pcp WITH LOGIN SUPERUSER PASSWORD 'CHANGE_ME_PCP';
  ELSE
    ALTER ROLE pgpool_pcp WITH LOGIN SUPERUSER PASSWORD 'CHANGE_ME_PCP';
  END IF;
END
$body$;

DO $body$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgpool') THEN
    CREATE ROLE pgpool WITH LOGIN PASSWORD 'CHANGE_ME_PGPOOL';
  ELSE
    ALTER ROLE pgpool WITH LOGIN PASSWORD 'CHANGE_ME_PGPOOL';
  END IF;
END
$body$;
SQL
```

> 💡 The `pgpool` health-check user is already created by Patroni's `bootstrap.users` block (Phase 3); the `pgpool_admin` and `pgpool_pcp` roles are created here.

#### Deploy the Patroni-aware failover scripts

These scripts are what make pgpool follow Patroni's leader after a failover. The versions below are **functional** (they poll Patroni, map the new leader to a pgpool backend node id, and re-attach it). On Debian, change `/etc/pgpool-II` → `/etc/pgpool2` and `/var/log/pgpool` → `/var/log/pgpool2` inside the scripts.

> ✅ **Prerequisite check:** `failover.sh` uses `jq` to parse `patronictl` output. Verify it is installed before continuing: `command -v jq` (RHEL installs it in Phase 1; Debian now does too). If it prints nothing, install it: `apt install -y jq` (Debian) or `dnf install -y jq` (RHEL).

```bash
# /etc/pgpool-II/failover.sh — on backend failover, wait for Patroni to elect a
# new leader, map its IP to a pgpool backend node_id, and pcp_attach_node it.
cat > /etc/pgpool-II/failover.sh <<'EOF'
#!/bin/bash
# Failover script for Pgpool-II with Patroni (runs as postgres user).
# Re-attaches the new Patroni primary so pgpool routes writes correctly.

FAILED_NODE_ID=$1
FAILED_NODE_HOST=$2
FAILED_NODE_PORT=$3
FAILED_NODE_DATA=$4
NEW_MASTER_ID=$5
NEW_MASTER_HOST=$6
NEW_MASTER_PORT=$7
OLD_MASTER_ID=$8
NEW_MASTER_DATA=$9
OLD_MASTER_DATA=${10}

LOG_FILE="/var/log/pgpool/failover.log"
PATRONI_CONFIG="/etc/patroni/patroni.yml"
PCP_USER="pgpool_pcp"
PCP_PORT=9898

exec >> "$LOG_FILE" 2>&1
echo "$(date): Failover triggered - failed node $FAILED_NODE_ID ($FAILED_NODE_HOST), new master $NEW_MASTER_ID ($NEW_MASTER_HOST)"

# Wait for Patroni to complete leader election (etcd sync). Skip any result
# whose Host is empty or equals the failed node.
NEW_LEADER=""
NEW_LEADER_IP=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 5
    NEW_LEADER=$(patronictl -c $PATRONI_CONFIG list -f json 2>/dev/null | jq -r '.[] | select(.Role=="Leader") | .Member')
    NEW_LEADER_IP=$(patronictl -c $PATRONI_CONFIG list -f json 2>/dev/null | jq -r '.[] | select(.Role=="Leader") | .Host')
    if [ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "null" ] && \
       [ -n "$NEW_LEADER_IP" ] && [ "$NEW_LEADER_IP" != "null" ] && \
       [ "$NEW_LEADER_IP" != "$FAILED_NODE_HOST" ]; then
        echo "$(date): Leader candidate after poll $attempt: $NEW_LEADER ($NEW_LEADER_IP)"
        break
    fi
    NEW_LEADER=""
    NEW_LEADER_IP=""
done

if [ -z "$NEW_LEADER" ]; then
    echo "$(date): ERROR - could not determine new Patroni leader after 50s"
    exit 1
fi

# Map leader IP -> node id using pgpool.conf backend_hostname entries
NODE_ID=""
for idx in 0 1 2 3 4 5; do
    B_HOST=$(grep -E "^backend_hostname$idx\s*=" /etc/pgpool-II/pgpool.conf | sed -E "s/.*=\s*'([^']+)'.*/\1/")
    if [ -n "$B_HOST" ] && [ "$B_HOST" = "$NEW_LEADER_IP" ]; then
        NODE_ID=$idx
        break
    fi
done

if [ -z "$NODE_ID" ]; then
    echo "$(date): ERROR - could not map leader $NEW_LEADER ($NEW_LEADER_IP) to a pgpool backend node id"
    exit 1
fi

echo "$(date): Attaching node $NODE_ID ($NEW_LEADER) as primary"
PCPPASSFILE=/etc/pgpool-II/.pcppass pcp_attach_node -h localhost -U $PCP_USER -p $PCP_PORT $NODE_ID

exit 0
EOF

# /etc/pgpool-II/follow_master.sh — on primary change, log the event (Patroni
# already handles re-following).
cat > /etc/pgpool-II/follow_master.sh <<'EOF'
#!/bin/bash
LOG_FILE="/var/log/pgpool/failover.log"
exec >> "$LOG_FILE" 2>&1
echo "$(date): Follow master triggered - new master $5 ($6)"
exit 0
EOF

chmod +x /etc/pgpool-II/failover.sh /etc/pgpool-II/follow_master.sh
chown postgres:postgres /etc/pgpool-II/failover.sh /etc/pgpool-II/follow_master.sh
```

> 📄 **Optional hardening — auto-reattach timer.** pgpool never re-attaches a backend node that comes back after being marked down during a failover. The script below periodically re-attaches recovered backends and corrects routing-role mismatches (only when Patroni confirms the node is the Leader). It is optional but recommended. Create it and its systemd timer:

```bash
# /etc/pgpool-II/reattach_nodes.sh  (RHEL path; Debian: /etc/pgpool2/reattach_nodes.sh)
cat > /etc/pgpool-II/reattach_nodes.sh <<'EOF'
#!/bin/bash
# Re-attach pgpool backend nodes that have recovered but are still marked
# down by pgpool, and correct routing-role mismatches when pgpool's routing
# role diverges from the actual Patroni primary (pg_role).
# Runs as postgres (systemd timer), uses .pcppass for PCP auth.
#
# SAFETY (Case 2 role correction) - hardened against thrash:
#   - Acts ONLY when Patroni (the authoritative leader source) confirms
#     this node is the Leader.
#   - Requires the same mismatch to be stable across 2 consecutive timer
#     runs (state file).
#   - Performs at most ONE correction per run.

PCP_PORT=9898
PCP_USER=pgpool_pcp
export PCPPASSFILE=/etc/pgpool-II/.pcppass
LOG_FILE="/var/log/pgpool/reattach.log"
STATE_FILE="/var/log/pgpool/reattach_state"

# Authoritative Patroni leader - the single source of truth.
PATRONI_LEADER_IP=""
PATRONI_LEADER_MEMBER=""
PATRONI_LEADER_JSON=$(patronictl -c /etc/patroni/patroni.yml list -f json 2>/dev/null | jq -c '.[] | select(.Role == "Leader")' | head -1)
if [ -n "$PATRONI_LEADER_JSON" ]; then
    PATRONI_LEADER_IP=$(echo "$PATRONI_LEADER_JSON" | jq -r '.Host')
    PATRONI_LEADER_MEMBER=$(echo "$PATRONI_LEADER_JSON" | jq -r '.Member')
fi
if [ -n "$PATRONI_LEADER_MEMBER" ]; then
    echo "$(date): Patroni Leader confirmed: $PATRONI_LEADER_MEMBER ($PATRONI_LEADER_IP)"
else
    echo "$(date): WARN - could not determine Patroni Leader, skipping Case 2 role corrections this run"
fi

# Number of backends to check (3 in this cluster)
NUM_BACKENDS=3
NEW_MISMATCH=0
for idx in $(seq 0 $(( NUM_BACKENDS - 1 ))); do
    LINE=$(pcp_node_info -h localhost -p $PCP_PORT -U $PCP_USER -w $idx 2>/dev/null)
    [ -z "$LINE" ] && continue
    # fields: host port status_code weight status pg_status role pg_role ...
    STATUS=$(echo "$LINE" | awk '{print $5}')
    PG_STATUS=$(echo "$LINE" | awk '{print $6}')
    ROLE=$(echo "$LINE" | awk '{print $7}')
    PG_ROLE=$(echo "$LINE" | awk '{print $8}')
    HOST=$(echo "$LINE" | awk '{print $1}')

    # Case 1: backend recovered (pg_status=up) but pgpool marks it down
    if [ "$STATUS" = "down" ] && [ "$PG_STATUS" = "up" ]; then
        echo "$(date): Re-attaching node $idx ($HOST) - backend up, pgpool marked down"
        pcp_attach_node -h localhost -p $PCP_PORT -U $PCP_USER -w $idx >> "$LOG_FILE" 2>&1
        continue
    fi

    # Case 2: routing role is stale. Requires ALL of:
    #   1. backend up and pgpool marks it up
    #   2. sr_check says pg_role=primary
    #   3. routing role != primary (the mismatch)
    #   4. Patroni authoritatively confirms THIS node is Leader
    #   5. same mismatch seen on the previous run (stability)
    if [ "$STATUS" = "up" ] && [ "$PG_STATUS" = "up" ] && \
       [ "$PG_ROLE" = "primary" ] && [ "$ROLE" != "primary" ] && \
       [ "$HOST" = "$PATRONI_LEADER_IP" ]; then
        if grep -q "^MISMATCH:$idx$" "$STATE_FILE" 2>/dev/null; then
            echo "$(date): Correcting routing role - node $idx ($HOST) confirmed Patroni Leader ($PATRONI_LEADER_MEMBER), mismatch stable across 2 runs"
            pcp_promote_node -h localhost -p $PCP_PORT -U $PCP_USER -w $idx >> "$LOG_FILE" 2>&1
            echo "$(date): Role correction performed - exiting (one correction per run)"
            : > "$STATE_FILE"
            exit 0
        else
            echo "$(date): Node $idx ($HOST) pg_role=primary but routing role=$ROLE - mismatch observed, awaiting confirmation run"
            echo "MISMATCH:$idx" > "$STATE_FILE"
            NEW_MISMATCH=1
        fi
    fi
done

# No stable mismatch recorded this run - reset state
if [ "$NEW_MISMATCH" -eq 0 ]; then
    : > "$STATE_FILE"
fi
exit 0
EOF
chown postgres:postgres /etc/pgpool-II/reattach_nodes.sh
chmod 0755 /etc/pgpool-II/reattach_nodes.sh

# systemd service + timer (runs every 15 s)
cat > /etc/systemd/system/pgpool-reattach.service <<'EOF'
[Unit]
Description=Re-attach recovered pgpool backend nodes
After=network.target

[Service]
Type=oneshot
User=postgres
Group=postgres
ExecStart=/etc/pgpool-II/reattach_nodes.sh
EOF

cat > /etc/systemd/system/pgpool-reattach.timer <<'EOF'
[Unit]
Description=Periodically re-attach recovered pgpool backend nodes

[Timer]
OnBootSec=60
OnUnitActiveSec=15
Unit=pgpool-reattach.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now pgpool-reattach.timer
```

> 📋 On Debian, change `/etc/pgpool-II` → `/etc/pgpool2` and `/var/log/pgpool` → `/var/log/pgpool2` inside the script and the service unit.

#### systemd override (VIP capabilities + fast stop + self-heal)

> ⚠️ **The override differs by distro.** RHEL runs pgpool as `root` (the watchdog heartbeat needs euid=0 for `SO_BINDTODEVICE`); Debian runs it as `postgres`. Use the correct block below.

```bash
# RHEL/CentOS — service is `pgpool`, run as root:
mkdir -p /etc/systemd/system/pgpool.service.d
cat > /etc/systemd/system/pgpool.service.d/override.conf <<'EOF'
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
User=root
Group=root
# Allow pgpool to manage the VIP via ip/arping
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_DAC_OVERRIDE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW CAP_DAC_OVERRIDE
# Watchdog ignores SIGTERM during shutdown - force fast stop
TimeoutStopSec=3
SendSIGKILL=yes
EOF
systemctl daemon-reload
```

```bash
# Debian/Ubuntu — service is `pgpool2`, run as postgres (NO User=/Group= lines):
mkdir -p /etc/systemd/system/pgpool2.service.d
cat > /etc/systemd/system/pgpool2.service.d/override.conf <<'EOF'
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
# Allow pgpool to manage the VIP via ip/arping
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_DAC_OVERRIDE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW CAP_DAC_OVERRIDE
# Watchdog ignores SIGTERM during shutdown - force fast stop
TimeoutStopSec=3
SendSIGKILL=yes
EOF
systemctl daemon-reload
```

#### Start pgpool on all three nodes

```bash
# RHEL/CentOS:
systemctl enable --now pgpool

# Debian/Ubuntu:
systemctl enable --now pgpool2

# Verify watchdog + VIP from any node
PCPPASSFILE=/etc/pgpool-II/.pcppass pcp_watchdog_info -v -h localhost -p 9898 -U pgpool_pcp -w
# One node is "LEADER" and owns 192.168.122.200
ip addr show eth0 | grep 192.168.122.200    # RHEL (or your NIC)
# ip addr show enp3s0 | grep 192.168.122.200  # Debian (predictable NIC name)
```

> 🔁 **Auto-reattach (optional):** the `pgpool-reattach.timer` (created in the "Optional hardening" step above) periodically re-attaches recovered backend nodes and corrects routing-role mismatches. It is optional but recommended.

> ✅ **Done with pgpool?** Phase 8 steps 3–4 re-verify the watchdog/VIP and the connection through it — run them after Phase 7.

---

### Phase 5 — pgBackRest (backup node `.153` + PG nodes)

> 📋 **Postgres user home:**
> - **RHEL/CentOS:** `/var/lib/pgsql`
> - **Debian/Ubuntu:** `/var/lib/postgresql`

```bash
# On the backup node (.153)
mkdir -p /postgres/pgbackup
chown -R postgres:postgres /postgres

# SSH key exchange: backup node ↔ each PG node (as postgres user)
# 1. On backup node:  sudo -iu postgres ssh-keygen -t rsa -b 4096
# 2. Copy key to each PG node:  sudo -iu postgres ssh-copy-id postgres@db1 (etc.)
#    NOTE: ssh-copy-id prompts for the postgres user's password on the target.
#    On a fresh install the postgres account may be locked — set a temporary
#    password first (e.g.  sudo passwd postgres  on each PG node) or the copy
#    will fail.
# 3. Also allow postgres@dbX to SSH into the backup node (for archiving)

# /etc/pgbackrest.conf on the BACKUP node
cat > /etc/pgbackrest.conf <<'EOF'
[global]
repo1-path = /postgres/pgbackup
repo1-retention-archive-type = full
repo1-retention-full = 1
process-max = 12
log-level-console = info
log-level-file = info
start-fast = y
delta = y
backup-standby = y
protocol-timeout = 30

[maruf]
pg1-host = db1                          # hostname (must resolve via /etc/hosts)
pg1-host-user = postgres
pg1-port = 5432
pg1-path = /postgres/data/16/maruf      # DEBIAN PATH — change for RHEL
pg1-socket-path = /var/run/postgresql
pg2-host = db2
pg2-host-user = postgres
pg2-port = 5432
pg2-path = /postgres/data/16/maruf
pg2-socket-path = /var/run/postgresql
pg3-host = db3
pg3-host-user = postgres
pg3-port = 5432
pg3-path = /postgres/data/16/maruf
pg3-socket-path = /var/run/postgresql
EOF

# /etc/pgbackrest.conf on each PG NODE (client only, for archiving)
cat > /etc/pgbackrest.conf <<'EOF'
[global]
repo1-host = db-backup                  # hostname of the backup node
repo1-host-user = postgres
process-max = 16
log-level-console = info
log-level-file = debug
protocol-timeout = 30                   # fail fast on a hung SSH session

[maruf]
pg1-path = /postgres/data/16/maruf      # DEBIAN PATH — change for RHEL
EOF
```

> 📋 **pgBackRest `pg1-path` values:**
> - **RHEL/CentOS:** `/var/lib/pgsql/16/data/maruf`
> - **Debian/Ubuntu:** `/postgres/data/16/maruf`

> 🔒 **Mask the unused server daemon:** this stack is SSH-based (no pgBackRest TLS daemon). Mask the unit so it can never start: `systemctl mask pgbackrest` (only if a unit file exists — the Debian package ships none).

#### Enable archiving in Patroni FIRST (for PITR)

> ⚠️ **Do this BEFORE the first backup.** A backup taken before archiving is enabled cannot be used for point-in-time recovery — it has no WAL archive chain to replay. The order below matters.

```bash
# On the primary, re-enable archiving and point it at pgBackRest
# NOTE: the archive path below is the DEBIAN data dir. On RHEL use
# /var/lib/pgsql/16/data/maruf/pg_wal/%f instead.
patronictl -c /etc/patroni/patroni.yml edit-config \
  -s postgresql.parameters.archive_mode=on \
  -s 'postgresql.parameters.archive_command="pgbackrest --stanza=maruf archive-push /postgres/data/16/maruf/pg_wal/%f"' \
  -s 'postgresql.recovery_conf.restore_command="timeout 60 pgbackrest --config=/etc/pgbackrest.conf --stanza=maruf archive-get %f %p"' \
  --force

# Restart Patroni to apply
patronictl -c /etc/patroni/patroni.yml restart maruf --force
```

Now create the stanza and take the first full backup (on the backup node):

```bash
sudo -iu postgres pgbackrest --stanza=maruf stanza-create
sudo -iu postgres pgbackrest --stanza=maruf --type=full backup
sudo -iu postgres pgbackrest --stanza=maruf info
```

---

### Phase 6 — PMM (optional, backup node `.153` + PG nodes) — disabled by policy

> ⚠️ **PMM is optional and disabled by default in this guide.** The steps below are for reference if you enable it. The client package is `pmm-client` (not `pmm3-client`).

#### RHEL / CentOS / Stream 9

```bash
# 1. On the backup node — run PMM Server as a Docker container
dnf install -y docker-ce docker-ce-cli
systemctl enable --now docker

# NOTE: the image listens on 8443 internally; map host 443 → container 8443
docker run -d --name pmm-server --restart always \
  -p 443:8443 -v pmm-data:/srv perconalab/pmm-server:3

# Wait 2-3 minutes, then change the default admin password
docker exec pmm-server change-admin-password YourNewPassword

# 2. On each PG node — install PMM Client
percona-release enable pmm3-client release
dnf install -y pmm-client percona-pg_stat_monitor16

# 3. Register each node with the server (retry until it succeeds)
pmm-admin config --server-insecure-tls \
  --server-url=https://admin:YourNewPassword@192.168.122.153:443 --force

# 4. Add PostgreSQL monitoring (repeat on each node)
pmm-admin add postgresql --username=pmm --password=CHANGE_ME --skip-connection-check

# 5. Browse to https://192.168.122.153:443 and watch the dashboards!
```

#### Debian / Ubuntu

```bash
# 1. On the backup node — run PMM Server as a Docker container
apt update && apt install -y docker.io
systemctl enable --now docker

# NOTE: the image listens on 8443 internally; map host 443 → container 8443
docker run -d --name pmm-server --restart always \
  -p 443:8443 -v pmm-data:/srv perconalab/pmm-server:3

# Wait 2-3 minutes, then change the default admin password
docker exec pmm-server change-admin-password YourNewPassword

# 2. On each PG node — install PMM Client
percona-release enable pmm3-client release
apt update && apt install -y pmm-client
# Note: percona-pg-stat-monitor16 is NOT available on Debian/Ubuntu — skip it

# 3. Register each node with the server (retry until it succeeds)
pmm-admin config --server-insecure-tls \
  --server-url=https://admin:YourNewPassword@192.168.122.153:443 --force

# 4. Add PostgreSQL monitoring (repeat on each node)
pmm-admin add postgresql --username=pmm --password=CHANGE_ME --skip-connection-check

# 5. Browse to https://192.168.122.153:443 and watch the dashboards!
```

> 🔥 If the PG nodes cannot reach `https://192.168.122.153:443`, open the firewall on the backup node:
> - **RHEL:** `firewall-cmd --permanent --add-port=443/tcp && firewall-cmd --reload`
> - **Debian:** `ufw allow 443/tcp`
> and add an iptables FORWARD rule for Docker if needed.

> In this deployment, PMM is **disabled by policy** on the backup node — the stack is fully validated without it; it remains an optional component.

---

### Phase 7 — Cluster health & self-healing (db1, db2, db3)

This phase adds two optional-but-recommended systemd timers: **self-heal** (restarts a crashed local Patroni member) and **cluster-health** (monitors etcd quorum, the Patroni leader, pgpool watchdog quorum, backends, and the VIP every 60 s). The cluster works fine without this phase; it only adds resilience and visibility.

```bash
# 1. patroni_self_heal.sh — restart a crashed/stopped/failed LOCAL Patroni member
#    (NEVER the leader). Create it with the full script below.
cat > /usr/local/sbin/patroni_self_heal.sh <<'EOF'
#!/bin/bash
# =============================================================================
# Patroni self-heal: restart a crashed/stopped/failed LOCAL member.
# NEVER restarts the leader. Remote crashed members are reported (and
# optionally alerted) but NOT auto-reinitialized - reinit is a manual,
# documented operation.
# =============================================================================
SCOPE="maruf"
PATRONI_CFG="/etc/patroni/patroni.yml"
LOG="/var/log/patroni/self_heal.log"
LOCK="/var/run/patroni-self-heal.lock"
ALERT_CMD=""   # optional: set to a command (e.g. a webhook curl) to get paged

exec 9>"$LOCK"
flock -n 9 || exit 0   # only one self-heal run at a time

exec >> "$LOG" 2>&1

HOSTNAME_SHORT=$(hostname -s)

LIST=$(patronictl -c "$PATRONI_CFG" list -f json 2>/dev/null) || {
  echo "$(date): patronictl failed - is etcd reachable?"
  exit 1
}

echo "$(date): self-heal check on $HOSTNAME_SHORT"
echo "$LIST" | jq -r '.[] | .Member + "|" + .Role + "|" + (.State // "")' | \
while IFS='|' read -r member role state; do
  [ "$member" = "$HOSTNAME_SHORT" ] || continue
  case "$state" in
    crashed|stopped|failed)
      if [ "$role" = "Leader" ]; then
        echo "$(date): WARN $member state=$state but is LEADER - refusing to restart (would force a failover / risk split-brain)"
        continue
      fi
      echo "$(date): member $member state=$state -> restarting patroni"
      systemctl restart patroni
      ;;
    *) ;;
  esac
done

CRASHED=$(echo "$LIST" | jq -r '[.[] | select(.State == "crashed" or .State == "stopped" or .State == "failed")] | length' 2>/dev/null)
if [ "${CRASHED:-0}" -gt 0 ]; then
  BAD_MEMBERS=$(echo "$LIST" | jq -r '[.[] | select(.State == "crashed" or .State == "stopped" or .State == "failed") | .Member] | join(",")' 2>/dev/null)
  echo "$(date): WARN $CRASHED member(s) in non-running state: $BAD_MEMBERS"
  echo "$LIST" | jq -r '.[] | select(.State == "crashed" or .State == "stopped" or .State == "failed") | "  - " + .Member + " (" + .Role + ", " + .State + ")"'
  if [ -n "$ALERT_CMD" ]; then
    $ALERT_CMD "Patroni self-heal: $CRASHED member(s) non-running ($BAD_MEMBERS)"
  fi
fi

exit 0
EOF
chmod 0755 /usr/local/sbin/patroni_self_heal.sh

# 2. cluster_health.sh — checks etcd quorum, Patroni leader, pgpool watchdog
#    quorum, backend status, VIP presence every 60s; writes Prometheus textfile
#    metrics and fires health_alert_command on CRITICAL. Create it below.
#    NOTE: change VIP_IF to your real NIC (eth0 on RHEL, enp3s0/enp1s0 on
#    Debian) and PCPPASS to /etc/pgpool2/.pcppass on Debian.
cat > /usr/local/sbin/cluster_health.sh <<'EOF'
#!/bin/bash
# =============================================================================
# Cluster health monitor: etcd quorum, Patroni leader, pgpool watchdog
# quorum, backend status and VIP presence.
#   - Writes /var/log/patroni/cluster_health.log
#   - Writes Prometheus textfile metrics for PMM (if a textfile dir exists)
#   - Fires the optional alert command when the cluster is CRITICAL
#   - Exit code 0 = healthy, 1 = CRITICAL
# =============================================================================
SCOPE="maruf"
PATRONI_CFG="/etc/patroni/patroni.yml"
ETCD_ENDPOINTS="http://192.168.122.150:2379,http://192.168.122.151:2379,http://192.168.122.152:2379"
VIP="192.168.122.200"
VIP_IF="eth0"
PCP_PORT=9898
PCP_USER=pgpool_pcp
PCPPASS=/etc/pgpool-II/.pcppass
LOG="/var/log/patroni/cluster_health.log"
ALERT_CMD=""   # optional: set to a command (e.g. a webhook curl) to get paged
TEXTFILE_DIRS="/var/lib/pmm-node-exporter/textfile_collector /var/lib/node_exporter/textfile_collector /usr/local/percona/pmm2/collectors/textfile-collector"

CRITICAL=0
NOW=$(date "+%Y-%m-%d %H:%M:%S")

log() { echo "$NOW $*" >> "$LOG"; }

# --- durable leader-election / false-positive event logging -----------
EVENT_LOG="/var/log/patroni/leader_events.log"
STATE_FILE="/var/log/patroni/cluster_health.state"

PREV_LEADER=""; PREV_WRITABLE=1; PREV_QUORUM=1
LEADER_CHANGES_TOTAL=0; READ_ONLY_EVENTS_TOTAL=0
LEADER_LOST_TOTAL=0; ETCD_QUORUM_LOSS_TOTAL=0
if [ -f "$STATE_FILE" ]; then
  . "$STATE_FILE"
fi

event() { echo "$(date -Is) $*" >> "$EVENT_LOG"; }

# --- etcd -------------------------------------------------------------
ETCD_HEALTHY=0; ETCD_QUORUM=0; ETCD_UP=0; ETCD_TOTAL=0
for ep in $(echo "$ETCD_ENDPOINTS" | tr ',' ' '); do
  ETCD_TOTAL=$((ETCD_TOTAL + 1))
  if ETCDCTL_API=3 etcdctl --endpoints="$ep" endpoint health >/dev/null 2>&1; then
    ETCD_UP=$((ETCD_UP + 1))
  fi
done
[ "$ETCD_UP" -ge 1 ] && ETCD_HEALTHY=1
ETCD_NEED=$(( (ETCD_TOTAL / 2) + 1 ))
[ "$ETCD_UP" -ge "$ETCD_NEED" ] && ETCD_QUORUM=1
[ "$ETCD_QUORUM" -ne 1 ] && { CRITICAL=1; log "CRITICAL etcd quorum lost: $ETCD_UP/$ETCD_TOTAL healthy (need $ETCD_NEED)"; }

# --- Patroni leader ---------------------------------------------------
LEADER_PRESENT=0; LEADER_MEMBER=""; MEMBERS_TOTAL=0; MEMBERS_NONRUN=0
LIST=$(patronictl -c "$PATRONI_CFG" list -f json 2>/dev/null)
if [ -n "$LIST" ]; then
  LEADER_MEMBER=$(echo "$LIST" | jq -r '[.[] | select(.Role == "Leader")][0].Member // ""' 2>/dev/null)
  [ -n "$LEADER_MEMBER" ] && [ "$LEADER_MEMBER" != "null" ] && LEADER_PRESENT=1
  MEMBERS_TOTAL=$(echo "$LIST" | jq -r 'length' 2>/dev/null || echo 0)
  MEMBERS_NONRUN=$(echo "$LIST" | jq -r '[.[] | select(.State != "running" and .State != "streaming")] | length' 2>/dev/null || echo 0)
fi
[ "$LEADER_PRESENT" -ne 1 ] && { CRITICAL=1; log "CRITICAL no Patroni leader"; }

# --- leader writability (DCS leader must actually accept writes) ---
LEADER_WRITABLE=1; LEADER_HOST=""
if [ "$LEADER_PRESENT" -eq 1 ]; then
  LEADER_HOST=$(echo "$LIST" | jq -r '[.[] | select(.Role == "Leader")][0].Host // ""' 2>/dev/null)
  if [ -n "$LEADER_HOST" ] && [ "$LEADER_HOST" != "null" ]; then
    LEADER_ROLE=$(curl -s -m 5 "http://${LEADER_HOST}:8008/patroni" 2>/dev/null | jq -r '.role // "unknown"' 2>/dev/null)
    [ -z "$LEADER_ROLE" ] && LEADER_ROLE="unknown"
    if [ "$LEADER_ROLE" != "primary" ]; then
      LEADER_WRITABLE=0
      CRITICAL=1
      log "CRITICAL leader $LEADER_MEMBER ($LEADER_HOST) is NOT writable (REST role=$LEADER_ROLE) - DCS leader but read-only"
    fi
  fi
fi

# --- durable event detection (leader changes / elections / false positives) ---
if [ "$LEADER_PRESENT" -eq 1 ]; then
  if [ -z "$PREV_LEADER" ]; then
    event "leader_elected member=$LEADER_MEMBER writable=$LEADER_WRITABLE"
    LEADER_CHANGES_TOTAL=$((LEADER_CHANGES_TOTAL + 1))
  elif [ "$PREV_LEADER" != "$LEADER_MEMBER" ]; then
    event "leader_changed from=$PREV_LEADER to=$LEADER_MEMBER writable=$LEADER_WRITABLE"
    LEADER_CHANGES_TOTAL=$((LEADER_CHANGES_TOTAL + 1))
  fi
  if [ "$LEADER_WRITABLE" -eq 0 ] && [ "$PREV_WRITABLE" -ne 0 ]; then
    event "false_positive leader=$LEADER_MEMBER not_writable role=$LEADER_ROLE"
    READ_ONLY_EVENTS_TOTAL=$((READ_ONLY_EVENTS_TOTAL + 1))
  fi
  if [ "$LEADER_WRITABLE" -eq 1 ] && [ "$PREV_WRITABLE" -eq 0 ]; then
    event "leader_writable_restored member=$LEADER_MEMBER"
  fi
else
  if [ -n "$PREV_LEADER" ]; then
    event "leader_lost previous=$PREV_LEADER"
    LEADER_LOST_TOTAL=$((LEADER_LOST_TOTAL + 1))
  fi
fi

# etcd quorum loss / recovery transitions
if [ "$ETCD_QUORUM" -ne 1 ] && [ "$PREV_QUORUM" -eq 1 ]; then
  event "etcd_quorum_lost up=$ETCD_UP total=$ETCD_TOTAL"
  ETCD_QUORUM_LOSS_TOTAL=$((ETCD_QUORUM_LOSS_TOTAL + 1))
fi
if [ "$ETCD_QUORUM" -eq 1 ] && [ "$PREV_QUORUM" -ne 1 ]; then
  event "etcd_quorum_restored up=$ETCD_UP total=$ETCD_TOTAL"
fi

# Persist state for next run
cat > "$STATE_FILE" <<EOF
PREV_LEADER="$LEADER_MEMBER"
PREV_WRITABLE=$LEADER_WRITABLE
PREV_QUORUM=$ETCD_QUORUM
LEADER_CHANGES_TOTAL=$LEADER_CHANGES_TOTAL
READ_ONLY_EVENTS_TOTAL=$READ_ONLY_EVENTS_TOTAL
LEADER_LOST_TOTAL=$LEADER_LOST_TOTAL
ETCD_QUORUM_LOSS_TOTAL=$ETCD_QUORUM_LOSS_TOTAL
EOF

# --- pgpool watchdog + backends ----------------------------------------
WD_QUORUM=0
export PCPPASSFILE="$PCPPASS"
WD_INFO=$(pcp_watchdog_info -v -h localhost -p "$PCP_PORT" -U "$PCP_USER" -w 2>/dev/null)
if echo "$WD_INFO" | grep -qi "quorum.*exist"; then
  WD_QUORUM=1
fi
[ "$WD_QUORUM" -ne 1 ] && { CRITICAL=1; log "CRITICAL pgpool watchdog quorum lost"; }

BACKENDS_TOTAL=0; BACKENDS_UP=0
BACKENDS_TOTAL=$(pcp_node_count -h localhost -p "$PCP_PORT" -U "$PCP_USER" -w 2>/dev/null || echo 0)
if [ "$BACKENDS_TOTAL" -gt 0 ]; then
  for idx in $(seq 0 $((BACKENDS_TOTAL - 1))); do
    LINE=$(pcp_node_info -h localhost -p "$PCP_PORT" -U "$PCP_USER" -w "$idx" 2>/dev/null)
    STATUS=$(echo "$LINE" | awk '{print $5}')
    [ "$STATUS" = "up" ] && BACKENDS_UP=$((BACKENDS_UP + 1))
  done
fi

# --- VIP (informational - only the watchdog leader holds it) ---
VIP_IFACE="$(ip -4 addr show | awk -v vip="$VIP" '/^[0-9]+:/ {iface=$2; gsub(/:/, "", iface)} index($0, vip) {print iface; exit}' || echo "$VIP_IF")"
VIP_PRESENT=0
if [ -n "$VIP_IFACE" ] && ip -4 addr show dev "$VIP_IFACE" 2>/dev/null | grep -Fq "$VIP"; then
  VIP_PRESENT=1
fi

log "status: leader=$LEADER_MEMBER leader_writable=$LEADER_WRITABLE etcd=$ETCD_UP/$ETCD_TOTAL wd_quorum=$WD_QUORUM backends=$BACKENDS_UP/$BACKENDS_TOTAL vip=$VIP_PRESENT members=$MEMBERS_TOTAL nonrunning=$MEMBERS_NONRUN"
if [ "$CRITICAL" -eq 1 ]; then
  log "RESULT CRITICAL"
else
  log "RESULT OK"
fi

# --- Prometheus textfile metrics (PMM node_exporter scrape) --------------
PROM="patroni_leader_present $LEADER_PRESENT
patroni_leader{member=\"$LEADER_MEMBER\"} $LEADER_PRESENT
patroni_leader_writable $LEADER_WRITABLE
patroni_members_total $MEMBERS_TOTAL
patroni_members_nonrunning $MEMBERS_NONRUN
etcd_healthy $ETCD_HEALTHY
etcd_quorum $ETCD_QUORUM
pgpool_wd_quorum $WD_QUORUM
pgpool_backends_total $BACKENDS_TOTAL
pgpool_backends_up $BACKENDS_UP
vip_present $VIP_PRESENT
patroni_leader_changes_total $LEADER_CHANGES_TOTAL
patroni_leader_read_only_events_total $READ_ONLY_EVENTS_TOTAL
patroni_leader_lost_events_total $LEADER_LOST_TOTAL
patroni_etcd_quorum_loss_total $ETCD_QUORUM_LOSS_TOTAL
"
for dir in $TEXTFILE_DIRS; do
  [ -z "$dir" ] && continue
  if [ -d "$dir" ]; then
    echo "$PROM" > "$dir/cluster_health.prom" 2>/dev/null
  fi
done

# --- alert hook -----------------------------------------------------------
if [ "$CRITICAL" -eq 1 ] && [ -n "$ALERT_CMD" ]; then
  $ALERT_CMD "CLUSTER CRITICAL: etcd_quorum=$ETCD_QUORUM leader=$LEADER_MEMBER leader_writable=$LEADER_WRITABLE wd_quorum=$WD_QUORUM backends=$BACKENDS_UP/$BACKENDS_TOTAL"
fi

exit "$CRITICAL"
EOF
chmod 0755 /usr/local/sbin/cluster_health.sh

# ✅ Verify both scripts are non-empty:
ls -l /usr/local/sbin/patroni_self_heal.sh /usr/local/sbin/cluster_health.sh
#    Each should be several KB. If either is 0 bytes, the heredoc failed —
#    re-run the cat command for that script.

# 3. systemd timers
cat > /etc/systemd/system/patroni-self-heal.service <<'EOF'
[Unit]
Description=Auto-restart crashed local Patroni members (never the leader)
After=network-online.target patroni.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/patroni_self_heal.sh
EOF

cat > /etc/systemd/system/patroni-self-heal.timer <<'EOF'
[Unit]
Description=Periodically check for crashed Patroni members
[Timer]
OnBootSec=60
OnUnitActiveSec=30
Unit=patroni-self-heal.service
[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/cluster-health.service <<'EOF'
[Unit]
Description=Cluster health monitor (etcd, Patroni, pgpool watchdog, VIP)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cluster_health.sh
EOF

cat > /etc/systemd/system/cluster-health.timer <<'EOF'
[Unit]
Description=Periodically check cluster health
[Timer]
OnBootSec=90
OnUnitActiveSec=60
Unit=cluster-health.service
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now patroni-self-heal.timer cluster-health.timer

# ✅ Verify both timers are active and scheduled:
systemctl list-timers | grep -E 'patroni-self-heal|cluster-health'
#    Both rows should show populated NEXT / LEFT / LAST columns (not "n/a").
```

---

### Phase 8 — Post-deployment verification checklist

```bash
# 1. Patroni cluster is green — one Leader, two Streaming, lag 0
patronictl -c /etc/patroni/patroni.yml list

# 2. etcd quorum healthy
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 endpoint health
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 member list

# 3. pgpool watchdog elected a leader and owns the VIP
PCPPASSFILE=/etc/pgpool-II/.pcppass pcp_watchdog_info -v -h localhost -p 9898 -U pgpool_pcp -w
ip addr show eth0 | grep 192.168.122.200

# 4. You can connect through the VIP (it will prompt for the postgres password
#    you set in Phase 3)
psql -h 192.168.122.200 -p 9999 -U postgres -d postgres -c "SELECT 1;"

# 5. pgBackRest stanza + first backup exist
sudo -iu postgres pgbackrest --stanza=maruf info

# 6. Health timers are running
systemctl status patroni-self-heal.timer cluster-health.timer
tail -f /var/log/patroni/cluster_health.log
```

---

## 10. Operations (Day-2)

### Patroni (run on any node)

```bash
# Cluster status — THE command you will run daily
patronictl -c /etc/patroni/patroni.yml list

# Show current DCS config (ttl, loop_wait, maximum_lag_on_failover, priorities)
patronictl -c /etc/patroni/patroni.yml show-config maruf

# Planned switchover (move primary) — safe, zero data loss
patronictl -c /etc/patroni/patroni.yml switchover

# Restart a node's PostgreSQL (rolling, Patroni-aware); use --no-wait in scripts
patronictl -c /etc/patroni/patroni.yml restart maruf --no-wait

# Pause automatic failover for a maintenance window, then resume
patronictl -c /etc/patroni/patroni.yml pause
patronictl -c /etc/patroni/patroni.yml resume

# History of leaders/timelines — the audit trail
patronictl -c /etc/patroni/patroni.yml history
```

### etcd

```bash
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 endpoint health
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 member list
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 get /percona_lab/maruf --prefix
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 get /percona_lab/maruf/leader
```

### pgpool-II (PCP)

> 🔑 The `pcp_*` commands below use `-w` (no password prompt), which reads the passfile. Run them with `PCPPASSFILE` pointing at the passfile created in Phase 4 (RHEL: `/etc/pgpool-II/.pcppass`, Debian: `/etc/pgpool2/.pcppass`), or as the `postgres` user whose home has a `.pcppass`.

```bash
export PCPPASSFILE=/etc/pgpool-II/.pcppass    # RHEL; Debian: /etc/pgpool2/.pcppass
pcp_watchdog_info -h localhost -p 9898 -U pgpool_pcp -w    # watchdog cluster / VIP owner
pcp_node_info    -h localhost -p 9898 -U pgpool_pcp -w     # backend node status
pcp_pool_status  -h localhost -p 9898 -U pgpool_pcp -w     # pool status per database
pcp_attach_node  -h localhost -p 9898 -U pgpool_pcp -w 1   # re-attach backend node 1 (node id is positional)
pcp_detach_node  -h localhost -p 9898 -U pgpool_pcp -w 1   # detach for maintenance
journalctl -u pgpool -f                                    # pgpool logs (RHEL; Debian: pgpool2)
```

### Backups (pgBackRest — on the backup node)

```bash
sudo -iu postgres pgbackrest --stanza=maruf info
sudo -iu postgres pgbackrest --stanza=maruf --type=full backup
sudo -iu postgres pgbackrest --stanza=maruf --type=incr backup
# Point-in-time restore example:
sudo -iu postgres pgbackrest --stanza=maruf --type=time --target="2026-08-07 12:00:00" restore
```

### Monitoring (PMM, where enabled)

- **Web UI:** `https://192.168.122.153:443` — PostgreSQL overview, replication graphs, query analytics (pg_stat_monitor).
- **CLI from any PG node:** `pmm-admin list`, `pmm-admin status`, `pmm-admin add postgresql`.

### Health & self-healing (installed in Phase 7)

| Timer | Interval | What it does |
|-------|----------|--------------|
| `patroni-self-heal.timer` | 30 s | Restarts a **crashed/stopped/failed local** Patroni member. Never touches the leader. Remote crashed members are logged + alerted (manual `patronictl reinit` for corrupt data dirs). |
| `cluster-health.timer` | 60 s | Checks etcd quorum, Patroni leader, pgpool watchdog quorum, backend status, VIP presence. Logs to `/var/log/patroni/cluster_health.log`, writes Prometheus textfile metrics for PMM, fires `health_alert_command` on CRITICAL. |
| `pgpool-reattach.timer` | 15 s | Re-attaches pgpool backend nodes that recovered but are still marked down, and corrects routing-role mismatches (only when Patroni confirms the node is the Leader). Logs to `/var/log/pgpool/reattach.log`. |

Metrics exposed (scraped by PMM's node_exporter textfile collector): `patroni_leader_present`, `patroni_leader{member}`, `patroni_members_total`, `patroni_members_nonrunning`, `etcd_healthy`, `etcd_quorum`, `pgpool_wd_quorum`, `pgpool_backends_total/up`, `vip_present`.

```bash
systemctl status patroni-self-heal.timer
systemctl status cluster-health.timer
tail -f /var/log/patroni/cluster_health.log       # health monitor log
tail -f /var/log/patroni/leader_events.log        # durable, ISO-8601 event log of every
                                                  # leader election/change, read-only-leader
                                                  # false positive, writability-restored,
                                                  # and etcd quorum loss/restore
```

Set `health_alert_command` (e.g. a webhook curl) inside `cluster_health.sh` (Phase 7) to get paged *before* an outage becomes permanent.

### Restore from pgBackRest (disaster recovery)

> ⚠️ **Restore is the most critical DR action — do it deliberately.** The steps below restore the whole cluster from the pgBackRest repository on `db-backup`.

```bash
# 1. Stop Patroni on ALL nodes so no PostgreSQL instance is running
#    (a restore must not race a live primary).
systemctl stop patroni        # on db1, db2, db3

# 2. On the node you are restoring (e.g. db1), restore the data directory.
#    --delta applies only the changed files; --force overwrites the existing dir.
sudo -iu postgres pgbackrest --stanza=maruf --delta --force restore

# 3. Start Patroni on the restored node first — it becomes the new primary.
systemctl start patroni
patronictl -c /etc/patroni/patroni.yml list

# 4. Start Patroni on the other nodes — they rejoin as replicas via pg_basebackup.
systemctl start patroni       # on db2, db3

# 5. Verify
patronictl -c /etc/patroni/patroni.yml list     # one Leader, two Streaming
sudo -iu postgres pgbackrest --stanza=maruf info
```

> 📋 **Point-in-time restore (PITR):** to restore to a specific moment (not the latest backup), use `--type=time --target="YYYY-MM-DD HH:MM:SS"` instead of a plain restore. This requires the WAL archive to be complete up to that point (see §10 Backups). For a full-cluster DR, restore to one node, promote it, then let the others rejoin.

### Upgrade path

> **Golden rule: take a pgBackRest full backup before any upgrade, and test the upgrade on a non-production cluster first.**

#### PostgreSQL minor upgrade (e.g. 16.1 → 16.4)

```bash
# 1. Take a backup
sudo -iu postgres pgbackrest --stanza=maruf --type=full backup

# 2. Install the new minor packages on all nodes (RHEL: dnf; Debian: apt)
#    RHEL:  dnf update percona-postgresql16-server percona-postgresql16-contrib
#    Debian: apt update && apt install -y percona-postgresql-16

# 3. Rolling restart through Patroni (one node at a time, no downtime)
patronictl -c /etc/patroni/patroni.yml restart maruf --no-wait
#    Repeat until all nodes are on the new minor version.
```

#### PostgreSQL major upgrade (e.g. 16 → 17)

> A major upgrade is a **planned, multi-step operation** — do not attempt it casually. The safe pattern under Patroni:

1. Take a full pgBackRest backup.
2. Build the new major version's binaries on all nodes (new Percona repo: `percona-release setup ppg-17`).
3. Use `pg_upgrade` on the primary (offline) or a logical dump/restore; then point Patroni's `bin_dir`/`data_dir` at the new version in `patroni.yml`.
4. Re-run the Patroni bootstrap so replicas re-clone from the upgraded primary.
5. Validate with `patronictl list` and a full backup before decommissioning the old version.

> 💡 For a production cluster, prefer a **new-cluster migration** (build a fresh 17 cluster alongside, replicate, cut over) over an in-place `pg_upgrade` — it is far easier to roll back.

#### Patroni / pgpool / etcd package upgrades

```bash
# Patroni: install the new package, then rolling-restart through Patroni itself
dnf update percona-patroni        # RHEL; Debian: apt install -y percona-patroni
patronictl -c /etc/patroni/patroni.yml restart maruf --no-wait

# pgpool: install the new package, then restart the service on each node
dnf update percona-pgpool-II-pg16 # RHEL; Debian: apt install -y pgpool2
systemctl restart pgpool          # RHEL; Debian: pgpool2

# etcd: upgrade one node at a time, keeping quorum (never stop 2 at once)
dnf update etcd                   # RHEL; Debian: apt install -y etcd
systemctl restart etcd
```

### Adding & removing a node

#### Add a 4th database node

1. **etcd:** add the new host to the etcd cluster (`etcdctl member add <name> --peer-urls=http://<ip>:2380`), then start etcd on it with the updated `ETCD_INITIAL_CLUSTER`.
2. **Patroni:** install Patroni + PostgreSQL on the new node, write `patroni.yml` (same scope, its own `name`/`connect_address`), and start it — it joins as a replica via `pg_basebackup`.
3. **pgpool:** add a `backend_hostname3`/`backend_port3`/`backend_data_directory3` block and a `hostname3`/`wd_port3`/`pgpool_port3` watchdog tuple on **every** pgpool node, then reload pgpool.
4. **pgBackRest:** add `pg4-host`/`pg4-path` to `pgbackrest.conf` on the backup node.

> ⚠️ **etcd quorum changes are the risky part.** Going 3 → 4 nodes does **not** increase fault tolerance (quorum becomes 3 of 4). Prefer adding nodes in pairs, or jump straight to 5 for a real tolerance gain.

#### Remove a node

1. **Patroni:** `patronictl -c /etc/patroni/patroni.yml remove <scope> <member>` (or stop Patroni on the node and let it be forgotten).
2. **etcd:** `etcdctl member remove <id>` — **never** remove below quorum (3-node cluster: never remove 2).
3. **pgpool:** remove the node's `backend_hostnameN` block and `hostnameN`/`wd_portN` watchdog tuple from every pgpool node, renumber the remaining indexes, reload pgpool.
4. **pgBackRest:** remove the node's `pgN-host`/`pgN-path` from `pgbackrest.conf`.

### Teardown / uninstall (full cluster removal)

> Use this to cleanly remove the cluster (e.g. after an evaluation). **This destroys all data.**

```bash
# 1. Stop the health/self-heal timers first (they would fight the teardown)
systemctl disable --now patroni-self-heal.timer cluster-health.timer pgpool-reattach.timer

# 2. Stop Patroni on all nodes (graceful — releases the leader lock)
systemctl stop patroni        # on db1, db2, db3

# 3. Stop pgpool and etcd
systemctl stop pgpool pgpool2 etcd   # on all nodes (whichever exist)

# 4. Remove the cluster from etcd (on any node with etcd running)
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 del /percona_lab/maruf --prefix

# 5. Remove data + config directories on all nodes
rm -rf /var/lib/patroni /etc/patroni /var/log/patroni
rm -rf /var/lib/pgsql/16/data/maruf /postgres/data/16/maruf   # data dir (per distro)
rm -rf /var/lib/etcd /etc/etcd
rm -rf /etc/pgpool-II /etc/pgpool2 /var/log/pgpool /var/log/pgpool2
rm -rf /etc/pgbackrest.conf /var/lib/pgbackrest /postgres/pgbackup

# 6. Disable the services so they don't come back on reboot
systemctl disable patroni pgpool pgpool2 etcd

# 7. (Optional) purge the packages
#    RHEL:  dnf remove percona-postgresql16-server percona-patroni etcd percona-pgbackrest percona-pgpool-II-pg16
#    Debian: apt purge percona-postgresql-16 percona-patroni etcd percona-pgbackrest pgpool2
```

> 💡 The VIP is released automatically when the last pgpool node stops (the watchdog `if_down_cmd` removes it). If you need to remove it manually: `ip addr del 192.168.122.200/24 dev <iface>`.

---

## 11. Production Recommendations

1. **Verify the VIP interface** — the deployment **auto-detects** the default NIC (`eth0` on CentOS Stream 9, `enp3s0`/`enp1s0` on Debian 12). If that's wrong, set `vip_interface_override` in the pgpool watchdog config (check `ip link` first).
2. **Tune failover timing** — defaults (`ttl: 30`, `loop_wait: 10`) give ~40 s failover. For faster failover, lower `ttl` to 15–20 s (keep it comfortably above `loop_wait`). Remember: a higher `ttl` also means *longer* downtime before a failover completes — that is the "wait for preferred leader" knob.
3. **Set `maximum_lag_on_failover` sensibly** — 1 MB (current default) is conservative; consider 100 MB–1 GB for busy workloads so a slightly-lagged replica can still be promoted.
4. **WAL retention** — the config already sets `wal_keep_size: 1GB` (PG 16); no need for the legacy `wal_keep_segments`.
5. **Separate disks** — put `/postgres/data` and `/var/lib/etcd` on dedicated NVMe/SSD storage; etcd is latency-sensitive. (Do not put them on volatile tmpfs/ramfs.)
6. **Automate backups** — the initial `stanza-create` + full backup is taken in Phase 5; in production schedule the ongoing ones:
   ```bash
   # cron on the backup node
   0 1 * * * sudo -iu postgres pgbackrest --stanza=maruf --type=incr backup
   ```
7. **Test failover monthly** — a HA cluster you never test is a false promise. Kill the primary (or run `patronictl switchover`) and verify the cluster recovers and the VIP moves.
8. **Monitor the monitors** — PMM alerting should include: Patroni node down, etcd quorum lost, replica lag, backup age (add an archive-staleness/backlog check — see §15), VIP owner changes.
9. **Keep the deployment reproducible** — keep your config files and passwords in a safe place so you can rebuild the cluster if needed.
10. **Back up the etcd data too** — etcd holds the cluster brain (`/percona_lab/maruf/*`). A full backup strategy includes `etcdctl snapshot save`.

---

## 12. Security

### Secrets

All secrets are the `CHANGE_ME_*` placeholders in the config files from §9. Replace **every** one with a strong random password before going live:

| Placeholder | Purpose | Production value |
|-------------|---------|------------------|
| `CHANGE_ME_POSTGRES` | PostgreSQL superuser | **Strong random** |
| `CHANGE_ME_REPLICATOR` | Streaming replication user | **Strong random** |
| `CHANGE_ME_ADMIN` | Patroni REST API admin | **Strong random** |
| `CHANGE_ME_PERCONA` | Percona monitoring user | **Strong random** |
| `CHANGE_ME_PGPOOL` | pgpool monitoring user (also the health-check user) | **Strong random** |
| `CHANGE_ME_PCP` | Pgpool PCP admin | **Strong random** |
| `CHANGE_ME_PGPOOL_ADMIN` | pgpool admin user (created on PostgreSQL, used in `pool_passwd`) | **Strong random** |
| `CHANGE_ME_WD_AUTH` | Shared pgpool watchdog auth key (must be identical on all nodes) | **Strong random** |
| `YourNewPassword` / `CHANGE_ME` | PMM admin / PMM PostgreSQL monitor user (only if you enable PMM) | **Strong random** |

> 🔑 **Where each placeholder appears:** `CHANGE_ME_POSTGRES`/`CHANGE_ME_REPLICATOR`/`CHANGE_ME_ADMIN`/`CHANGE_ME_PERCONA`/`CHANGE_ME_PGPOOL` are in `patroni.yml` (Phase 3); `CHANGE_ME_HEALTH`/`CHANGE_ME_WD_AUTH`/`CHANGE_ME_PGPOOL_ADMIN`/`CHANGE_ME_PCP` are in the pgpool configs (Phase 4). Use the **same** password for `CHANGE_ME_PGPOOL` and `CHANGE_ME_HEALTH` (they are the same `pgpool` user).

Non-negotiable rules:

- **Firewall only the cluster subnet** — allow the ports in §4 only between cluster nodes.
- **Expose only the VIP (9999) and PMM (443)** to application/admin networks. **Never expose** etcd (:2379/2380), the Patroni REST API (:8008), or PostgreSQL (:5432) publicly.
- Keep the `pgpass` file private with `0600` permissions (the bootstrap uses `/tmp/pgpass0` — move it after first boot if you prefer).
- Keep PMM behind a VPN or at minimum behind strong auth (change the admin password on first login).
- `pcp.conf` and `pool_passwd` are chmod 0640; the sudoers entry (`postgres ALL=(ALL) NOPASSWD: /usr/sbin/ip, /usr/sbin/arping`) is the minimum needed for VIP management.
- Store your chosen passwords somewhere safe (a password manager) — they are not stored in any central file.

---

## 13. Troubleshooting

| Issue | Likely cause | Check / fix |
|-------|--------------|-------------|
| **Patroni won't start** | etcd not reachable | `systemctl status etcd`, `ETCDCTL_API=3 etcdctl endpoint health`; check `patroni.yml` `etcd3.hosts` (all endpoints are listed now). `ExecStartPre` waits `etcd_wait_timeout` (90 s) before giving up. |
| **etcd quorum not forming** | Stale data from a previous run | On a FRESH bootstrap only: wipe `/var/lib/etcd/*` and re-run Phase 2 with `ETCD_INITIAL_CLUSTER_STATE="new"`. Never `rm -rf /var/lib/etcd/*` on a healthy cluster. |
| **No leader after 2 hosts down** | Expected — 3-node etcd needs a 2/3 majority | Consensus working correctly. For higher tolerance use `etcd_group: "etcd_nodes"` with 3–5 dedicated witnesses (see §15). |
| **Crashed replica won't recover** | Corrupt data dir or DCS hiccup | `patroni-self-heal.timer` restarts a crashed LOCAL member automatically; for a corrupt data dir run `patronictl reinit maruf <member>` manually (never auto-reinit). |
| **Patroni won't start after reboot** | Patroni raced etcd at boot | `ExecStartPre` waits for DCS; check `journalctl -u patroni` and `/var/log/patroni/cluster_health.log`. |
| **etcd member fails GPG validation** | Fresh OS missing Percona keys | The RPM installs its own key; if the release RPM fails GPG validation, install it with `--nogpgcheck`. |
| **Replicas stuck with lag** | Replication slot missing / WAL removed | `patronictl list`; check `pg_replication_slots`; a full `pg_basebackup` may be needed. |
| **VIP not moving** | sudoers / capability issues | `sudoers.d/pgpool-vip` entry present? `journalctl -u pgpool` for vip_up/vip_down errors. |
| **Watchdog not forming** | Firewall 9000, auth key mismatch, heartbeat port collision | Open UDP/TCP 9000 (wd_port) and 9694 (heartbeat_port) between nodes; `wd_authkey` identical everywhere; heartbeat_port MUST differ from wd_port; nodes reachable. |
| **pgpool rejects config** | Unindexed `wd_*` params | Pgpool 4.5+ requires **indexed** `hostname0`/`wd_port0`/`pgpool_port0` (and `heartbeat_hostname0`/`heartbeat_port0`); remove bare `wd_port`/`hostname`. **`wd_authkey` and `wd_priority` stay unindexed** in 4.7 — do not index them. |
| **Debian pgpool2 missing / wrong version** | PGDG repo not added, or an old native 4.3.5 pin left over | Debian uses PGDG pgpool-II 4.7: ensure `/usr/share/keyrings/pgdg.gpg` + the `apt.postgresql.org` repo exist, remove any `/etc/apt/preferences.d/pgpool2` pin, then `apt install pgpool2=4.7.2-1.pgdg* libpgpoolpcp3=4.7.2-1.pgdg* postgresql-16-pgpool2=4.7.2-1.pgdg*`. |
| **Cannot connect via VIP** | VIP on wrong node / pgpool not started | `ip addr` (who owns .200?), `pcp_watchdog_info`, `systemctl status pgpool`. |
| **pool_passwd auth fails** | MD5 vs SCRAM mismatch | This guide uses a plaintext `pool_passwd` + `pool_hba.conf` (SCRAM-safe); keep file perms 0640. |
| **pgBackRest fails** | SSH keys / stanza missing | Run `stanza-create` first; `sudo -iu postgres pgbackrest --stanza=maruf info`; check `repo1-host`. |
| **PMM not reachable** | Docker port mapping / firewall | Image listens on 8443 internally → map `-p 443:8443`; open 443 on the backup node; iptables FORWARD ACCEPT for 443. |
| **`patronictl restart` hangs** | Interactive prompt | Use `patronictl restart maruf --no-wait` in automation. |
| **Deploy fails on a fresh VM** | Missing EPEL/CRB | `dnf install -y epel-release && dnf config-manager --set-enabled crb` before pgBackRest deps. |

---

## 14. Validation & Evidence

This architecture was **deployed end-to-end and validated on real hardware (kernel-level VMs)**, not just designed. Faults were injected with real power-loss semantics (`virsh destroy` — no graceful stops), with a continuous write workload and a 3-node observer running through every incident.

### Headline results — 5/5 power-loss failovers

| Iteration | Killed node | New leader | Failover T0→T4 | Write interruption | Lost commits | Split-brain samples | Rejoin |
|-----------|-------------|------------|----------------|--------------------|--------------|---------------------|--------|
| 1 | db1 | db3 | 38 s | 34 s | **0** | 0/720 | 39 s |
| 2 | db3 | db1 | 40 s | 35 s | **0** | 0/720 | 39 s |
| 3 | db1 | db3 | 43 s | 38 s | **0** | 0/720 | 36 s |
| 4 | db3 | db2 | 40 s | 35 s | **0** | 0/720 | 39 s |
| 5 | db2 | db1 | 41 s | 36 s | **0** | 0/720 | 40 s |

**Aggregates:** 5/5 PASS · ~104,000 confirmed writes, **0 lost** · **0 split-brain** across 3,600 direct node probes (≤1 node primary at all times) · failover 38–43 s (median ~40 s) · write interruption 34–38 s · killed-node rejoin 36–40 s (budget was ≤10 min — a 15× margin) · timeline advanced TL 10 → 15.

Durability was verified per run by the seed-line method (`comm -23` of confirmed IDs vs. the actual table): **LOST = 0 in every iteration.** (Two runs showed EXTRA=1 — an ID present in the table but absent from the confirmed file: a writer that had committed before being killed during duplicate-writer cleanup. That is *more* durable, not less — the client simply never logged CONFIRMED.)

### Additional fault-injection findings (beyond the 5 clean kills)

| Test | Scenario | Finding | Resolution |
|------|----------|---------|------------|
| **Test 1** | Watchdog timing audit | Config math correct (TTL=30 s, safety margin 5 s, hardware i6300ESB available) | ✅ Passed |
| **Test 2** | **Asymmetric network partition** (iptables cut the primary off from etcd/peers but left the client-facing VIP open) | Primary self-demoted in 17–35 s ✅, but promotion **hung >2 h** due to `pgbackrest archive-get` without a timeout on a wedged SSH to the backup node (upstream Patroni #3603) | **Fixed:** `restore_command: "timeout 60 pgbackrest…"`, pgbackrest `protocol-timeout`, SSH `ServerAliveInterval=10`, plus a "leader but read-only" detection check. Re-run: **31 s promotion, 140/140 writes survived** |
| **Test 3** | **Mixed/cascading failure** (etcd node loss + 30% packet loss on survivors) | **DCS (etcd) is a SPOF for write availability** — 2/3 PG nodes were fully healthy, yet all writes stopped because 2-of-3 etcd quorum was unreachable. Cluster correctly chose **safe-unavailable**: zero primaries, read-only, no split-brain, no data loss — 53/53 confirmed writes survived | Documented architectural limitation; mitigations: dedicated etcd witnesses, decoupled DCS failure domain, 5-node etcd |
| **Test 4** | Durable false-positive logging (soak instrumentation) | Built an append-only event log + Prometheus counters; smoke test found a 2nd bug: a timed-out leader REST probe produced empty `LEADER_ROLE=""`, skipping the writability guard, so a stuck leader passed as healthy | **Fixed:** empty/timeout → `role="unknown"` → NOT writable |
| **Live discovery** | Manual planned switchover (`patronictl switchover`) | pgpool had no active signal on clean switchover — relied on `sr_check` polling → **~4 min write-availability gap** observed (three rapid switchovers compounded it) | **Fixed & verified:** `pgpool_role_signal.sh` callback (Patroni `on_role_change` → `pcp_promote_node` on all pgpool nodes) + `sr_check_period` 10 → 3 → **~3–4 s gap, 999/999 writes survived, 0 lost, no split-brain** |

### Realistic application testing (2026-08-20)

Beyond the shell harness, the stack was validated with a **realistic customer-facing application** — a zero-cluster-awareness app simulator firing purchase requests at the VIP through every incident (a failover-aware script that "waits for the DB" does not prove production failover; real customers never wait):

- ✅ **Zero data loss** across crash (SIGKILL), graceful, extreme (3 sequential failovers), and keep-down scenarios — 50/50 confirmed, 0 lost, 0 extra, balance exact.
- ✅ **Money consistency** — balance always equals `seed − (purchases × price)`; no lost charge, no double charge.
- ✅ **Real failovers observed** — leaders changed (db1 → db2, db2 → db1 → db2 → db3), timeline advanced each time.
- ✅ **Self-healing** — killed nodes rejoined as replicas and caught up from archive (0 lag after recovery); the watchdog moved the VIP (db1 → db2) when the VIP node died.
- ⚠️ **Read availability measured, not assumed** — concurrent reads through the VIP were **89%** on default config, **95.71%** after tuning `health_check_period` (leader-failover scenario). Reads are highly available, not perfect; the gap is understood and tunable.

### Honest caveat about asynchronous replication

Replication is **asynchronous** (`synchronous_standby_names` not set). A transaction committed on the old primary moments before a power loss can, in the worst case, be absent from the promoted replica. Zero lost commits were observed across all runs — but that is **empirical evidence, not a design guarantee**. For a hard zero-RPO (zero data loss) guarantee, the stack must be switched to **synchronous replication**. The 34–38 s write interruption is the client-visible failover window (pgpool health polling + Patroni election + attach cycle) — not zero downtime; **stateful clients must retry**.

---

## 15. Known Limitations & Honest Caveats

This section exists so the supervisor has the complete picture — including the parts that are not flattering.

### 1. etcd is a single point of failure for *write availability* (confirmed by Test 3)

During Test 3, two of three PostgreSQL nodes were fully healthy throughout, yet **all writes stopped completely** because the etcd cluster lost quorum (one member killed + 30% packet loss between the two survivors made a 2-of-3 quorum unreachable). The cluster correctly chose **safe-unavailable** (zero primaries, read-only, no split-brain, no data loss — 53/53 confirmed writes survived), but the outcome stands: **a healthy database cannot accept writes without a healthy DCS.**

**DCS availability is the upper bound on write availability.** Mitigations, in increasing order of cost:

1. **Dedicated etcd witness nodes** — run etcd on dedicated witness hosts instead of the DB nodes, so a DB-host crash never touches quorum. Patroni on the DB nodes then talks to **all** etcd endpoints, so a local etcd failure never blinds it.
2. **5-node etcd topology** — tolerates two concurrent etcd losses, end-to-end, instead of one.
3. **Both** — dedicated witnesses *and* 5 members, for the strongest separation.

This is an architectural recommendation for a follow-up decision — **not a blocker** for the current single-host-loss HA guarantees, which are unaffected.

### 2. Asynchronous replication means no hard zero-RPO guarantee

See §14. Zero lost commits were observed empirically, but an async model cannot *guarantee* that a transaction acknowledged on the old primary microseconds before a power loss is present on the new primary. Zero-RPO requires synchronous mode (`synchronous_standby_names`), which trades write latency for durability.

### 3. Failover is automatic, but not zero-downtime

The 34–38 s write interruption is real and client-visible. A stateful application must handle connection errors and retry. This is standard for async streaming-replication HA and is the honest trade-off for automatic failover — it is *downtime-minimizing*, not *downtime-free*.

### 4. Client connection requirements (what your application must do)

For applications to survive failover cleanly, follow these rules:

1. **Connect only to the VIP** (`192.168.122.200:9999`) — never to individual node IPs. Node IPs change role and can be down; the VIP is the only stable address.
2. **Retry window must exceed the failover time.** Retry for **at least 60–90 s** (the measured failover is 38–43 s; add margin). A client that gives up after 10 s will fail during every failover.
3. **Use a connection pooler or retry with backoff.** On a connection error, reconnect with a short backoff (e.g. 1–2 s, doubling up to ~10 s) for the full retry window.
4. **Set sane timeouts.** `connect_timeout` ≥ 10 s, and keepalive/idle timeouts long enough that a failover (which can pause writes for ~40 s) does not kill idle sessions prematurely.
5. **Handle in-flight transactions.** A transaction in flight during failover will error — the client must roll back and retry. Idempotent writes (or a dedup key) make retries safe.
6. **Do not pin to a node.** No hardcoded `db1`/`db2`/`db3` hostnames in application config; use the VIP hostname only.

### 5. First-host-loss tolerance only (by default)

The default co-located topology tolerates losing **any single host**. Losing **two** DB hosts at once kills etcd quorum → correctly no leader (safe, but unavailable). The 3–5 witness etcd topology (above) is the fix. "All hosts down" is disaster recovery, not HA — the documented restore path is: bring etcd up first, then Patroni, then the rest, or restore from pgBackRest if data is unrecoverable.

### 6. Known non-blockers (open follow-ups in this deployment)

| Item | Status | Action |
|------|--------|--------|
| `db-backup` (the backup host, .153) under-provisioned (2 vCPU; in this lab it also ran an unrelated metrics stack — ClickHouse + Docker + Grafana + VictoriaMetrics + PMM — which thrashed it to loadavg 60+ and caused an sshd wedge during Test 2) | Open — not a blocker | Resize the backup host or move the metrics stack off it |
| pgBackRest **archive-push** can silently wedge for hours with no monitoring alert (observed ~2.5 h before Test 2) | Open — not a blocker | Add an archive-staleness/backlog check (oldest unarchived WAL age) to the health monitor |
| PMM monitoring | **Disabled by policy** on `db-backup` | Keep PMM off; do not redeploy; the stack is fully validated without it |

### 7. Watchdog/VIP hard facts

- `wd_quorum_exit = on` (default): a pgpool instance that loses watchdog quorum **exits** rather than serving the VIP alone → no split-brain VIP.
- The VIP is served by the *watchdog leader*, which is elected independently of the PostgreSQL primary — the VIP may move without a DB failover (and vice versa). If the pgpool process on the VIP-holding node dies, the VIP must move (measured ~50 s blip in one test) — applications should retry connections.
- `heartbeat_port` (9694) **must differ** from `wd_port` (9000), or watchdog heartbeats collide.

---

## 16. Glossary

| Term | Definition |
|------|-----------|
| **Primary** | The single PostgreSQL instance that accepts reads and writes; it generates the WAL. (Formerly "master".) |
| **Replica** | A PostgreSQL instance that receives and replays WAL from the primary; it accepts reads only (hot standby). (Formerly "slave"/"standby".) |
| **WAL** | Write-Ahead Log — PostgreSQL's transaction log. Every change is written here before touching data files, enabling crash recovery and replication. |
| **Streaming Replication** | PostgreSQL's native mechanism where the primary continuously sends WAL to connected replicas over replication connections. |
| **Replication Slot** | A server-side bookmark that stops the primary from discarding WAL a replica still needs. Prevents replication breaks caused by slow/disconnected replicas. |
| **Failover** | Automatic, unplanned promotion of a replica to primary after the primary fails. |
| **Switchover** | Manual, planned, graceful handover of primary role — zero data loss. |
| **Split Brain** | Two nodes both acting as primary and accepting writes, irreconcilably diverging — the worst database failure mode. |
| **Quorum** | The minimum number of nodes (majority of a consensus group) that must agree for the group to make decisions. |
| **Leader Lock** | A single etcd key only the current primary can hold; the basis of safe leader election. |
| **TTL** | Time-to-Live — the leader lock expires after this time unless renewed; the heartbeat deadline. |
| **Timeline** | PostgreSQL's monotonic counter that increments on every promotion; identifies history branches so `pg_rewind` can safely resynchronize diverged nodes. |
| **Lag** | How far behind a replica is from the primary (in WAL bytes/time); `maximum_lag_on_failover` prevents promoting a lagged replica. |
| **VIP** | Virtual IP — a floating address (192.168.122.200:9999 here) that moves between pgpool nodes; the only address applications ever use. |
| **Watchdog** | pgpool-II's high-availability module: elects a leader among pgpool nodes, owns/floats the VIP, monitors peers. |
| **PCP** | Pgpool Control Protocol — pgpool-II's administrative interface (port 9898) for `pcp_*` commands. |
| **pg_rewind** | PostgreSQL utility that fast-forward/rewinds a diverged node's data directory to match the new primary — the basis of automatic rejoin. |
| **pg_basebackup** | PostgreSQL utility that takes a physical base backup of a running cluster — how replicas are initially cloned. |
| **DCS** | Distributed Consensus Store — etcd in this architecture; holds the leader lock and cluster state. |

---

## 17. Further Reading

External links: [Patroni docs](https://patroni.readthedocs.io/) · [Percona Distribution for PostgreSQL](https://www.percona.com/software/postgresql-distribution) · [Percona Patroni setup](https://docs.percona.com/postgresql/16/patroni.html) · [pgpool-II docs](https://www.pgpool.net/docs/) · [pgBackRest](https://pgbackrest.org/) · [PMM](https://www.percona.com/software/database-tools/percona-monitoring-and-management) · [etcd](https://etcd.io/docs/)
