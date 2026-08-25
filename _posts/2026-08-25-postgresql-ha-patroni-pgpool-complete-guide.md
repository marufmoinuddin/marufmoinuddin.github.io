---
layout: post
title: "PostgreSQL High Availability with Patroni + pgpool-II — A Complete Guide"
date: 2026-08-25
category: PostgreSQL
tags: [postgresql, high-availability, patroni, pgpool-ii, etcd, pgbackrest, failover, ansible]
excerpt: "A complete, decision-ready guide to a production 3-node PostgreSQL 16 HA cluster — Patroni owns the data plane, pgpool-II owns the access plane, with 5/5 validated power-loss failovers, zero data loss, and honest caveats."
read_time: 57
---

# PostgreSQL High Availability with Patroni + pgpool-II — A Complete Guide

> **One file. No prior DBA knowledge required.**
> This guide explains a production PostgreSQL 16 high-availability cluster — what it is, why it exists, how it works, how it was deployed, how it behaves under failure, and what its honest limitations are — for a supervisor who needs to make an informed decision.

---

## 1. Executive Summary

This document describes a **3-node PostgreSQL 16 high-availability (HA) cluster** built with **Percona Distribution for PostgreSQL 16**, managed by **Patroni** (the "brain" that decides which node is the primary and fails over automatically), coordinated by **etcd** (a 3-node distributed consensus store), fronted by **pgpool-II + Watchdog** (the "traffic controller" that gives applications a single Virtual IP for connection pooling and read/write routing), and backed up by **pgBackRest**, with optional **PMM** monitoring dashboards.

The single most important mental model is: **Patroni owns the data plane** (which PostgreSQL node is primary, replication, failover, slots, config), and **pgpool-II owns the access plane** (where clients connect, pooling, query routing, Virtual IP). They do not fight over leadership — Patroni is the single source of truth, and pgpool-II follows Patroni's lead.

The architecture has been **stress-tested with real power-loss fault injection**: **5 out of 5 consecutive failovers passed**, with **zero lost commits** across ~104,000 confirmed writes and **zero split-brain** across 3,600 direct node probes. Failover took ~40 seconds (median), clients saw a 34–38 second write interruption, and killed nodes rejoined in 36–40 seconds — all automatically, without human intervention or re-provisioning.

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
| Data loss risk | Possible with async replication (see §16) | Zero (graceful handoff) |
| Old primary | May still be running (split-brain risk, handled by fencing) | Gracefully demoted to replica |
| Speed | Seconds to ~40s (depends on TTL settings) | Near-instant (a few seconds with this repo's fix) |

### What split-brain is, and why it is dangerous

**Split-brain** happens when two nodes both believe they are the *primary* (read-write) at the same time and both accept writes. Because they start from the same data but then diverge, the two copies become **irreconcilable** — the database is silently corrupted, and there is no reliable way to merge the two halves. This is the worst failure mode in distributed databases, worse than downtime: downtime is recoverable, corruption may not be.

Split-brain is caused by exactly the situations HA is supposed to survive:

- A **network partition**: the primary and a replica lose contact with each other, and each thinks the other is dead, so each tries to become/remain primary.
- **etcd quorum loss**: multiple nodes think they can hold the leader lock.
- **Clock drift**: election timeouts fire incorrectly.

This cluster prevents split-brain with three layers: **etcd quorum** (a majority must agree, §3 requires an odd number of nodes), **a TTL-based leader lock** (the primary's claim expires unless it keeps heartbeating), and **fencing** (a partitioned node that loses quorum is rebooted by a kernel watchdog rather than allowed to keep accepting writes). You will see these again in §3 and §7.

---

## 3. Core Concepts (Fundamentals)

This section explains the vocabulary you need before reading the architecture. Everything is defined in plain language; the formal definitions are also collected in the Glossary (§17).

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

WAL segments are 16 MB files in `pg_wal/`, recycled by checkpoints and archiving. In this cluster, WAL is also **archived to the backup node** by pgBackRest, enabling point-in-time recovery (§11).

### Replication slots

A replication slot is a server-side bookmark that tells the primary: *"Do not remove WAL segments until this replica has received them."* Without slots, a slow or disconnected replica could cause the primary to recycle WAL the replica still needs — breaking replication and requiring a full re-copy. **Patroni always uses replication slots** (`use_slots: true`) and manages them automatically.

### Failover vs. switchover (quick reference)

| Aspect | Failover | Switchover |
|--------|----------|------------|
| Trigger | Unplanned (crash, power loss, partition) | Planned (maintenance) |
| Initiation | Automatic (Patroni) | Manual (`patronictl switchover`) |
| Data-loss risk | Possible (async replication) | Zero (graceful) |
| Old primary handling | May need fencing if still running | Gracefully demoted |
| Speed | ~40s with defaults (tunable) | ~3–4s with this repo's callback fix |

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

With 3 nodes you tolerate **exactly one** node failure and still make decisions. With 2 nodes, quorum = 2, so **zero** failures are tolerated — two nodes are strictly worse than one for consensus. This is why this cluster uses **3 etcd nodes** (co-located on the 3 database nodes by default; dedicated witness options are discussed in §16).

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

**Patroni + pgpool-II (what this repo deploys):**
- ✅ Automatic, consensus-driven failover (measured ~38–43 s for a hard kill; ~3–4 s for a clean switchover with the callback fix).
- ✅ Real split-brain protection: 2/3 quorum + TTL lease + softdog host reboot.
- ✅ Automatic replica rejoin via `pg_rewind` — the old primary comes back and resynchronizes against the new leader without a full re-copy.
- ✅ Replication slots managed automatically.
- ✅ Centralized PostgreSQL configuration (stored in etcd, applied everywhere via `patronictl reload`).
- ✅ A clean REST API + `patronictl` — the cluster is operable by a human.
- ✅ Self-healing timers (see §11).
- ✅ Proven: 5/5 power-loss failovers with zero lost commits and zero split-brain.
- ❌ More moving parts (Patroni + etcd on every node).
- ❌ etcd is a write-availability SPOF if it loses quorum (documented finding — see §16).
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
- ❌ pgpool's primary detection is polling-based and can be *stale* — this repo observed exactly that (a ~4-minute switchover gap) and fixed it with a Patroni callback; without Patroni there is no such active signal, so the gap is unbounded by design.
- ❌ No self-healing — a crashed node stays down until a human intervenes.

### Recommendation

- **Choose Patroni + pgpool-II** for anything that matters: production, customer-facing, or where **zero data loss and no split-brain** are requirements. This is exactly what this repository builds and has validated with real fault injection.
- **Choose standalone + pgpool-II** only for a quick lab, a read-mostly workload where you accept manual failover, or where the simplicity of "no etcd, no Patroni" outweighs the risk. Treat it as **not HA** in the strict sense — it is "manual failover with a VIP."

> **Bottom line: pgpool-II is a traffic controller, not a consensus engine. Pair it with Patroni when you need real high availability; run it standalone only when you are willing to manage failover by hand.**

---

## 6. Why pgpool-II instead of HAProxy + PgBouncer?

Both architectures share the **same Patroni + etcd data plane** — automatic failover, split-brain protection, `pg_rewind`, slots, centralized config, `patronictl` are identical. The choice is purely about the **access layer** — the component(s) in front of the database that clients actually connect to.

- **Option A (this repo):** pgpool-II — one integrated component doing pooling + SQL-aware read/write splitting + primary detection + floating VIP (built-in watchdog).
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
| Active failover signal | ✅ `pcp_promote_node` callback (wired in this repo) | ⚠️ Polling only (scriptable) |

### Key differences that matter to a decision-maker

1. **SQL awareness.** pgpool parses queries, so it can route `SELECT` to replicas and `INSERT/UPDATE/DELETE` to the primary **from a single connection string**, blacklist unsafe functions (`nextval`, `setval`, …), and handle `SELECT … FOR UPDATE` correctly. HAProxy cannot see SQL at all — read/write splitting is done **by pool**, which means **the application must use separate connection strings for reads vs. writes**.
2. **Built-in VIP vs. extra daemon.** pgpool's watchdog elects a leader and floats the VIP with quorum + `wd_quorum_exit` split-brain protection (already hardened in this repo). Option B needs a separate Keepalived — an extra daemon and an extra split-brain surface.
3. **Active failover signaling.** This repo wires a Patroni `on_role_change` callback that runs `pcp_promote_node` immediately, closing the switchover detection gap to ~3–4 s. HAProxy relies on polling the `:8008` health check (you can script a push, but it's extra work).
4. **Pooling strength.** PgBouncer is the de-facto standard for extreme concurrency (transaction pooling, thousands of clients). pgpool's pooling is adequate for hundreds to low thousands of connections but not as battle-tested at that scale.
5. **Component count and ops.** One service per node vs. three; fewer failure modes, less config drift — but pgpool is a heavier, more complex process with a steeper config surface than HAProxy.

### Which should you choose?

**Choose Patroni + pgpool-II when:**
- You want **one integrated access layer** (pooling + routing + VIP) — simpler to operate and monitor.
- You want **SQL-aware read/write splitting** — the app uses a single connection string and pgpool routes queries.
- You value the **built-in watchdog VIP** with quorum + split-brain protection and the **active failover callback** already wired in this repo.
- Your concurrency needs are moderate (hundreds to low thousands of connections).

**Choose Patroni + HAProxy + PgBouncer when:**
- You need **very high connection concurrency** (thousands of clients) — PgBouncer's transaction pooling is the clear winner.
- You prefer **clean separation of concerns** and are comfortable running and monitoring three components.
- Your application can **split read vs. write connection strings** (or you add a router), because HAProxy cannot route by SQL.
- You already run HAProxy/Keepalived elsewhere and want to reuse that expertise.

> **Bottom line for this repo:** pgpool-II delivers a complete, validated, all-in-one access layer with SQL-aware routing and a built-in VIP — ideal for a self-contained 3-node HA cluster. If the workload later demands extreme connection concurrency, the HAProxy + PgBouncer model is the natural evolution — and it reuses the exact same Patroni + etcd data plane already deployed here.

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

**Failover time ≈ TTL + loop_wait** (30 s + 10 s = ~40 s worst case with these defaults). Measured in this repo: **38–43 s** from power loss to first successful write, median ~40 s.

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

**Lag.** Lag is how far behind a replica is from the primary (in WAL bytes). `maximum_lag_on_failover` (default 1 MB in this repo) tells Patroni: *"do not promote a replica that is more than this far behind."* This is a **data-safety guarantee**: Patroni will never promote a replica that would lose committed transactions.

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

### How to configure it in this repository

In `03_Configure_Patroni.yml`, every node currently gets identical tags (no `failover_priority` — all three are equally preferred). To make db1 the preferred primary, add:

```yaml
# Inside the "Create Patroni configuration file" task, in the tags: block
tags:
    nofailover: false
    noloadbalance: false
    clonefrom: false
    nosync: false
    # Higher = more preferred to become primary.
    # db1 (node_index 1) -> 100, db2 -> 50, db3 -> 0 (never primary).
    failover_priority: "{{ 100 if node_index == 1 else (50 if node_index == 2 else 0) }}"
```

Or, for explicit per-host control, via a `failover_priority_map` in `variables.yaml` (e.g. `patroni-1: 100`, `patroni-2: 50`, `patroni-3: 0`) referenced in the same tags block.

> **Note:** `failover_priority` is a **dynamic** DCS setting read from etcd, so you can also change it at runtime with `patronictl edit-config` — no full redeploy needed. Verify with `patronictl list` / `patronictl show-config maruf`.

### pgpool-II? It follows Patroni.

pgpool-II does **not** need to know about `failover_priority`. It simply routes writes to whatever node Patroni says is primary (via `sr_check` + the `on_role_change` callback). Once Patroni steers leadership back to db1, pgpool automatically follows — the VIP keeps serving, the app sees no change. If you also want the **pgpool watchdog leader** (VIP owner) to prefer db1, raise its `wd_priority` via `wd_priority_base` in `variables.yaml` — independent of the PostgreSQL primary, but keeping both on the same node reduces cross-node hops.

### Caveats — be honest about expectation

1. **Preference, not guarantee** — a down or lagging preferred node is skipped; Patroni will not wait for it (see §7 for the TTL-based "wait" pattern).
2. **Automatic failback causes a switchover** — when db1 returns and leadership is handed back, that is a real (graceful) switchover with a brief write blip (~3–4 s with the callback fix). If you want to avoid the blip entirely, use manual switchover instead.
3. **`failover_priority: 0` means "never primary"** — use deliberately; it reduces HA options if the other two nodes are down.
4. **Keep priorities sensible** — common patterns: `100 / 50 / 0` (one preferred, one backup, one never-primary) or `100 / 50 / 25` (all promotable, fixed order). Don't set all three equal if you want a clear preference.
5. **`maximum_lag_on_failover` still applies** — a preferred node that is too far behind will not be promoted even with the highest priority.

---

## 9. Manual Deployment Steps

This is the hand-by-hand path (the same steps the Ansible playbooks automate). Commands are **representative**, not exhaustive — the repository's playbooks contain the complete, battle-tested versions of every config file inline.

**Pick your distro family** — logic is identical; package management and a few paths differ:

| Area | RHEL / CentOS / Stream 9 | Debian / Ubuntu |
|------|-------------------------|-----------------|
| Package manager | `dnf` | `apt` |
| Percona repo | `percona-release setup ppg-16` | `percona-release setup ppg-16` |
| PostgreSQL data dir | `/var/lib/pgsql/16/data/maruf` | `/postgres/data/16/maruf` |
| PostgreSQL bin dir | `/usr/pgsql-16/bin` | `/usr/lib/postgresql/16/bin` |
| Patroni binary | `/usr/bin/patroni` | `/bin/patroni` |
| **Pgpool config dir** | `/etc/pgpool-II` | `/etc/pgpool2` |
| **Pgpool service** | `pgpool` | `pgpool2` |
| **Pgpool package** | `percona-pgpool-II-pg16` (4.7) | **PGDG `pgpool2` 4.7.2** + `postgresql-16-pgpool2` (from `apt.postgresql.org`) |

### Phase 0 — OS preparation (all 4 nodes)

```bash
hostnamectl set-hostname db1      # db2, db3, db-backup respectively

# /etc/hosts — same on every node
192.168.122.150  db1
192.168.122.151  db2
192.168.122.152  db3
192.168.122.153  db-backup
192.168.122.200  pgpool-vip

# Open cluster ports (between nodes only)
# RHEL:  firewall-cmd --permanent --add-port={2379,2380,5432,8008,9000,9898,9999}/tcp ; firewall-cmd --reload
# Debian: ufw allow 2379,2380,5432,8008,9000,9694,9898,9999/tcp ; ufw --force enable
```

### Phase 1 — Install Percona packages

```bash
# RHEL/CentOS
dnf install -y epel-release && dnf config-manager --set-enabled crb
dnf install -y https://repo.percona.com/yum/percona-release-latest.noarch.rpm
percona-release setup ppg-16
dnf install -y percona-postgresql16-server percona-postgresql16-contrib percona-patroni \
  etcd jq percona-pgbackrest
# pgpool-II 4.7 is installed in playbook 01 (percona-pgpool-II-pg16); extensions are added in playbook 04

# Debian — pgpool-II comes from PGDG (apt.postgresql.org), NOT Percona
# Add the PGDG repo + key first, then install pgpool2 4.7.2 pinned
wget -qO - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor | tee /usr/share/keyrings/pgdg.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt update
apt install -y pgpool2=4.7.2-1.pgdg* libpgpoolpcp3=4.7.2-1.pgdg* postgresql-16-pgpool2=4.7.2-1.pgdg*
percona-release setup ppg-16
apt install -y percona-postgresql-16 percona-patroni etcd percona-pgbackrest
```

> ⚠️ **Debian pgpool2 note:** pgpool-II is installed from **PGDG** (`apt.postgresql.org`) at **4.7.2**, not from the Percona repo (which ships no pgpool-II daemon for Debian). The playbooks add the PGDG repo, remove any old apt pin, and install `pgpool2` + `libpgpoolpcp3` + `postgresql-16-pgpool2` (the extension module) pinned to `4.7.2-1.pgdg*`. Do **not** install the native Debian `pgpool2` 4.3.5 — the playbooks expect 4.7.

### Phase 2 — etcd cluster (db1, db2, db3)

Create `/etc/etcd/etcd.conf` — the token and member IP list **must be identical** on all three nodes; only `name` and the two `...ADVERTISE...` values differ:

```ini
# db1 example
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

Start etcd on all three nodes together (quorum needs 2/3), then verify:

```bash
systemctl enable --now etcd   # on all 3, roughly together
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 endpoint health
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 member list
# All 3 members must show "healthy: true"
```

### Phase 3 — Patroni + PostgreSQL (db1, db2, db3)

Create `/etc/patroni/patroni.yml` on each node (only `name` and connect/etcd addresses differ per node):

```yaml
namespace: percona_lab
scope: maruf
name: db1                       # db2 / db3 on the other nodes

restapi:
  listen: 0.0.0.0:8008
  connect_address: 192.168.122.150:8008   # this node's IP

etcd3:
  hosts: 192.168.122.150:2379,192.168.122.151:2379,192.168.122.152:2379   # ALL etcd endpoints (DCS redundancy)

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
        # max_wal_size is pgtune-calculated dynamically in the playbook (not a fixed 10GB)
        archive_mode: "off"          # pgBackRest handles archiving
        archive_timeout: 600s

  initdb:
    - encoding: UTF8
    - data-checksums               # enables corruption detection

  pg_hba:
    - host replication replicator 127.0.0.1/32 trust
    - host replication replicator 0.0.0.0/0 scram-sha-256
    - host all all 0.0.0.0/0 scram-sha-256
    - host all all ::0/0 scram-sha-256

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 192.168.122.150:5432   # this node's IP
  data_dir: /postgres/data/16/maruf       # DEBIAN; RHEL: /var/lib/pgsql/16/data/maruf
  bin_dir: /usr/lib/postgresql/16/bin     # DEBIAN; RHEL: /usr/pgsql-16/bin
  authentication:
    replication: { username: replicator, password: CHANGE_ME_REPLICATOR }
    superuser:    { username: postgres,   password: CHANGE_ME_POSTGRES }
  create_replica_methods: [ basebackup ]

tags:
  nofailover: false
  noloadbalance: false
  clonefrom: false
  nosync: false
```

**Bootstrap order matters — start the primary FIRST:**

```bash
# On db1 ONLY — runs initdb, creates the data dir, acquires the leader lock
systemctl enable --now patroni
patronictl -c /etc/patroni/patroni.yml list      # db1 should be Leader

# Now start replicas — they pg_basebackup from db1 and join as streaming replicas
systemctl enable --now patroni                   # on db2 and db3
patronictl -c /etc/patroni/patroni.yml list      # db1 Leader, db2/db3 Streaming, lag 0
```

> 🧠 **Why primary first?** If a replica starts before any primary exists, Patroni would *also* try to bootstrap — two nodes racing to initdb is chaos. The leader lock prevents a real split-brain, but starting in order is clean and predictable.

### Phase 4 — pgpool-II + Watchdog + VIP (db1, db2, db3)

The full `pgpool.conf` is long; here is the watchdog-relevant essence. **Config differs by distro**: RHEL uses pgpool-II 4.7 with a separate `pgpool_watchdog.conf`; Debian also runs pgpool-II 4.7 (from PGDG) with watchdog params **inline** in `pgpool.conf`.

```ini
# Core pgpool.conf (both distros; key lines)
listen_addresses = '*'
port = 9999

backend_hostname0 = '192.168.122.150'   # db1
backend_hostname1 = '192.168.122.151'   # db2
backend_hostname2 = '192.168.122.152'   # db3
# each backend: backend_port0/1/2 = 5432, backend_weight = 1,
# backend_data_directory = the node's pg data dir, backend_flag = 'ALLOW_TO_FAILOVER'

health_check_period = 5
health_check_timeout = 10
health_check_user = 'pgpool'
sr_check_period = 3                    # tightened from 10 by this repo (safety net)
sr_check_user = 'pgpool'
delay_threshold = 10000000

pcp_listen_addresses = '*'
pcp_port = 9898
```

Watchdog (RHEL 4.7 example, `pgpool_watchdog.conf`):

```ini
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
# Heartbeat lifecheck (heartbeat_port MUST differ from wd_port 9000)
heartbeat_hostname0 = '192.168.122.151'
heartbeat_port0 = 9694
heartbeat_device0 = 'eth0'
heartbeat_hostname1 = '192.168.122.152'
heartbeat_port1 = 9694
heartbeat_device1 = 'eth0'
# Virtual IP (VIP) management
delegate_ip = '192.168.122.200'
if_cmd_path = '/usr/sbin'
if_up_cmd = '/usr/sbin/ip addr add 192.168.122.200/24 dev eth0 label eth0:pgpool'
if_down_cmd = '/usr/sbin/ip addr del 192.168.122.200/24 dev eth0'
arping_path = '/usr/sbin'
arping_cmd = '/usr/sbin/arping -U 192.168.122.200 -w 1 -I eth0'
```

> 📋 **Debian vs RHEL parameter differences:** Both distros run pgpool-II 4.7 and use the same indexed watchdog names (`hostnameN`, `wd_portN`, `pgpool_portN`, `heartbeat_hostnameN` / `heartbeat_portN` / `heartbeat_deviceN`, unindexed `wd_priority` / `wd_authkey`). The only differences: Debian keeps watchdog params **inline** in `pgpool.conf` and uses `delegate_IP` (uppercase); RHEL uses a separate `pgpool_watchdog.conf` and `delegate_ip` (lowercase).

Per node: write the node id (`0`/`1`/`2` → `/etc/pgpool-II/pgpool_node_id` on RHEL, `/etc/pgpool2/pgpool_node_id` on Debian), the sudoers entry for the VIP (`postgres ALL=(ALL) NOPASSWD: /usr/sbin/ip, /usr/sbin/arping`), the PCP passfile (`pcp.conf` — MD5-hashed via Ansible, not `pg_md5`), and `pool_passwd` (plaintext works with SCRAM; perms 0640). Deploy the Patroni-aware `failover.sh` / `follow_master.sh` scripts (complete versions are inline in `04_Configure_Pgpool.yml`), then start pgpool on **all three nodes**:

```bash
systemctl enable --now pgpool       # RHEL; Debian: pgpool2
pcp_watchdog_info -h localhost -p 9898 -U pgpool_pcp -w    # one node = LEADER, owns the VIP
ip addr show eth0 | grep 192.168.122.200                   # verify the VIP is claimed
```

### Phase 5 — pgBackRest (backup node `.153` + PG nodes)

```bash
# On the backup node
mkdir -p /postgres/pgbackup && chown -R postgres:postgres /postgres
# SSH key exchange (as postgres user): backup node ↔ each PG node, both directions

# /etc/pgbackrest.conf on the BACKUP node
[global]
repo1-path = /postgres/pgbackup
repo1-retention-archive-type = full
repo1-retention-full = 1
[maruf]
pg1-host = db1                          # hostname (the playbook uses node fqdn)
pg1-host-user = postgres
pg1-path = /postgres/data/16/maruf      # or RHEL path
pg1-port = 5432

# On each PG node (client only, for archiving)
[global]
repo1-host = db-backup                  # hostname of the backup node
repo1-host-user = postgres
protocol-timeout = 30                   # fail fast on a hung SSH session
[maruf]
pg1-path = /postgres/data/16/maruf

# Create the stanza, then the first full backup (on the backup node)
sudo -iu postgres pgbackrest --stanza=maruf stanza-create
sudo -iu postgres pgbackrest --stanza=maruf --type=full backup
sudo -iu postgres pgbackrest --stanza=maruf info
```

> Archiving must be in place **before** the first backup for a complete point-in-time-recovery chain.

### Phase 6 — PMM (optional, backup node `.153` + PG nodes) — disabled by policy

> ⚠️ **PMM is disabled by policy** in `site.yml` (play 07 is commented out). The steps below are for reference if you re-enable it. The playbook installs the `pmm-client` package (not `pmm3-client`).

```bash
# On the backup node — PMM Server as a Docker container (image listens on 8443 internally)
docker run -d --name pmm-server --restart always -p 443:8443 -v pmm-data:/srv perconalab/pmm-server:3
docker exec pmm-server change-admin-password YourNewPassword

# On each PG node — PMM Client
percona-release enable pmm3-client release
# dnf install -y pmm-client percona-pg_stat_monitor16   (RHEL; pg_stat_monitor not on Debian)
pmm-admin config --server-insecure-tls --server-url=https://admin:YourNewPassword@192.168.122.153:443 --force
pmm-admin add postgresql --username=pmm --password=CHANGE_ME --skip-connection-check
# Browse to https://192.168.122.153:443
```

> In this deployment, PMM is **disabled by policy** on the backup node — the stack is fully validated without it; it remains an optional component.

---

## 10. Automated Deployment (Ansible)

**This is the recommended path.** One command deploys the whole cluster, and every playbook is **idempotent** — you can re-run it safely.

### The four-step recipe

```bash
# 1. Clone
git clone https://github.com/marufmoinuddin/patroni-pgpool-ansible.git
cd patroni-pgpool-ansible

# 2. Configure the inventory
cp hosts.ini.example hosts.ini          # → edit the 4 node IPs
# [pg_nodes]: 3 entries (.150/.151/.152); [pg_backrest]: 1 entry (.153)
ssh-copy-id root@192.168.122.150       # ...and the other 3 nodes

# 3. Configure + encrypt the secrets
cp variables.yaml.example variables.yaml   # → fill in real passwords
ansible-vault encrypt variables.yaml       # → recommended

# 4. Deploy (~10–15 minutes)
ansible-playbook -i hosts site.yml --syntax-check   # first: check it parses
ansible-playbook -i hosts site.yml --ask-vault-pass
```

Key variables you must change in `variables.yaml`: `patroni_scope` (cluster name, default `maruf`), `postgres_password`, `replicator_password`, `patroni_admin_password`, `percona_password`, `pgpool_password`, `pcp_password`, `pmm_admin_password`, `pg_pmm_user_password` (all **strong random**), `vip_address` (`192.168.122.200`), and `vip_interface` (verify with `ip link`).

> ⚠️ **Never commit `variables.yaml`** — it is in `.gitignore`. Only `variables.yaml.example` is committed. Details in §13.

### Post-deployment checklist

```bash
# 1. Patroni cluster is green — one Leader, two Streaming, lag 0
patronictl -c /etc/patroni/patroni.yml list

# 2. etcd quorum healthy
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 endpoint health
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.122.150:2379 member list

# 3. pgpool watchdog elected a leader and owns the VIP
pcp_watchdog_info -h localhost -p 9898 -U pgpool_pcp -w
ip addr show eth0 | grep 192.168.122.200

# 4. You can connect through the VIP
psql -h 192.168.122.200 -p 9999 -U postgres -d postgres -c "SELECT 1;"

# 5. Verify the pgBackRest stanza + first backup (play 05 runs stanza-create + full backup automatically)
sudo -iu postgres pgbackrest --stanza=maruf info

# 6. Log into PMM at https://192.168.122.153:443 (where enabled)
```

### The playbook sequence (plain English)

| # | Playbook | What it does |
|---|----------|--------------|
| 01 | `01_Install_Percona.yml` | Adds the Percona repository, enables EPEL + CRB (RHEL), installs PostgreSQL 16, Patroni, etcd, pgpool-II, pgBackRest, jq — and **purges old/broken installs** so you start clean. **On Debian:** purges any old `pgpool2`/`libpgpool2` packages; pgpool-II 4.7 is installed later from PGDG in playbook 04. |
| 02 | `02_Configure_Etcd.yml` | Writes the etcd config on all 3 nodes, starts etcd, verifies quorum. Only wipes etcd data when `etcd_force_reset: true` (fresh bootstrap / DR) — re-runs on a healthy cluster never wipe the DCS. |
| 03 | `03_Configure_Patroni.yml` | Writes `patroni.yml` (full HA config, pgtune-calculated parameters, watchdog, callbacks), installs the systemd unit with an `ExecStartPre` that waits for etcd, **starts the primary first**, waits, then starts replicas — then verifies with `patronictl list`. Also deploys the `pgpool_role_signal.sh` `on_role_change` callback (fresh installs). |
| 04 | `04_Configure_Pgpool.yml` | Adds the PGDG repo and installs pgpool-II 4.7 (Debian), writes `pgpool.conf` + **OS-conditional watchdog config** (CentOS: separate `pgpool_watchdog.conf`; Debian: inline params — both 4.7), `pool_hba.conf` + `pool_passwd` + `pcp.conf`, deploys Patroni-aware `failover.sh` / `follow_master.sh`, sets `pgpool_node_id`, and starts the watchdog cluster so the VIP is claimed. **Auto-detects the VIP interface.** |
| 05 | `05_Configure_Pgbackrest.yml` | Installs/connects pgBackRest on the backup node, exchanges SSH keys with all PG nodes, writes `pgbackrest.conf` with stanza `maruf`, and **runs `stanza-create` + an initial `--type=full backup` automatically** (printing the equivalent manual commands as a fallback). |
| 06 | `06_Configure_Cluster_Health.yml` | Deploys the self-healing timers (`patroni-self-heal.timer` every 30 s, `cluster-health.timer` every 60 s), the health log, Prometheus textfile metrics, an alert command hook, and the durable leader-event log. |
| 07 | `07_Install_Pmm_Monitoring.yml` | Runs the PMM Server Docker container on the backup node (cleans stale `pmm-data` first), opens the firewall, installs PMM Client on all 3 PG nodes (skips `pg_stat_monitor` on Debian), registers them. **Disabled by policy — not imported by `site.yml`.** |
| Optional | `Optional_Configure_Switchover_Signal.yml` | Deploys `pgpool_role_signal.sh` as Patroni's `on_role_change` callback — on promotion to primary, it confirms the node holds the DCS leader lease, maps the IP to a pgpool backend node_id, and runs `pcp_promote_node` on **all** pgpool nodes. This is the fix that eliminated the ~4-minute switchover detection gap (now ~3–4 s). **Baked into `03_Configure_Patroni.yml` for fresh installs; this playbook is only needed to retrofit an existing cluster. Not imported by `site.yml`.** |

> **What `site.yml` actually runs:** playbooks **01–06**. PMM (07) is **disabled by policy** (commented out in `site.yml` — see §16), and the switchover-signal playbook is **optional** (the fix is already baked into 03 for fresh installs).

**Rerunning safely:** every playbook is idempotent. If something failed midway, fix it and re-run `ansible-playbook -i hosts site.yml`. Re-runs no longer wipe etcd — only `etcd_force_reset: true` does.

---

## 11. Operations (Day-2)

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

```bash
pcp_watchdog_info -h localhost -p 9898 -U pgpool_pcp -w    # watchdog cluster / VIP owner
pcp_node_info    -h localhost -p 9898 -U pgpool_pcp -w     # backend node status
pcp_pool_status  -h localhost -p 9898 -U pgpool_pcp -w     # pool status per database
pcp_attach_node  -h localhost -p 9898 -U pgpool_pcp -w 1   # re-attach backend node 1 (node id is positional)
pcp_detach_node  -h localhost -p 9898 -U pgpool_pcp -w 1   # detach for maintenance
journalctl -u pgpool -f                                    # pgpool logs
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

### Health & self-healing (installed by playbook 06)

| Timer | Interval | What it does |
|-------|----------|--------------|
| `patroni-self-heal.timer` | 30 s | Restarts a **crashed/stopped/failed local** Patroni member. Never touches the leader. Remote crashed members are logged + alerted (manual `patronictl reinit` for corrupt data dirs). |
| `cluster-health.timer` | 60 s | Checks etcd quorum, Patroni leader, pgpool watchdog quorum, backend status, VIP presence. Logs to `/var/log/patroni/cluster_health.log`, writes Prometheus textfile metrics for PMM, fires `health_alert_command` on CRITICAL. |

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

Set `health_alert_command` (e.g. a webhook curl) in `variables.yaml` to get paged *before* an outage becomes permanent.

---

## 12. Production Recommendations

1. **Verify the VIP interface** — the playbook **auto-detects** the default NIC (`eth0` on CentOS Stream 9, `enp3s0`/`enp1s0` on Debian 12). If that's wrong, set `vip_interface_override` in `variables.yaml` (check `ip link` first).
2. **Tune failover timing** — defaults (`ttl: 30`, `loop_wait: 10`) give ~40 s failover. For faster failover, lower `ttl` to 15–20 s (keep it comfortably above `loop_wait`). Remember: a higher `ttl` also means *longer* downtime before a failover completes — that is the "wait for preferred leader" knob.
3. **Set `maximum_lag_on_failover` sensibly** — 1 MB (current default) is conservative; consider 100 MB–1 GB for busy workloads so a slightly-lagged replica can still be promoted.
4. **WAL retention** — the playbook already sets `wal_keep_size: 1GB` (PG 16); no need for the legacy `wal_keep_segments`.
5. **Separate disks** — put `/postgres/data` and `/var/lib/etcd` on dedicated NVMe/SSD storage; etcd is latency-sensitive. (The playbooks refuse to run when etcd/PostgreSQL data sits on volatile tmpfs/ramfs.)
6. **Automate backups** — play 05 runs the initial `stanza-create` + full backup automatically; in production schedule the ongoing ones:
   ```bash
   # cron on the backup node
   0 1 * * * sudo -iu postgres pgbackrest --stanza=maruf --type=incr backup
   ```
7. **Test failover monthly** — a HA cluster you never test is a false promise. Use the harness in `tests/` (run from your workstation, not the DB nodes).
8. **Monitor the monitors** — PMM alerting should include: Patroni node down, etcd quorum lost, replica lag, backup age (add an archive-staleness/backlog check — see §16), VIP owner changes.
9. **Keep the deployment reproducible** — the whole point of this repo: one `ansible-playbook` run rebuilds the world. Store your customized `hosts` + vars in Git (secrets in Vault).
10. **Back up the etcd data too** — etcd holds the cluster brain (`/percona_lab/maruf/*`). A full backup strategy includes `etcdctl snapshot save`.

---

## 13. Security

### Secrets

All secrets live in **`variables.yaml`** (never in the playbooks):

| Variable in `variables.yaml` | Purpose | Production value |
|-------------------------------|---------|------------------|
| `postgres_password` | PostgreSQL superuser | **Strong random** |
| `replicator_password` | Streaming replication user | **Strong random** |
| `patroni_admin_password` | Patroni REST API admin | **Strong random** |
| `percona_password` | Percona monitoring user | **Strong random** |
| `pgpool_password` | pgpool monitoring user | **Strong random** |
| `pcp_password` | Pgpool PCP admin | **Strong random** |
| `pmm_admin_password` | PMM web UI admin | **Strong random** |
| `pg_pmm_user_password` | PMM PostgreSQL monitor user | **Strong random** |

Non-negotiable rules:

- **Encrypt the whole file** with Ansible Vault: `ansible-vault encrypt variables.yaml`, then run playbooks with `--ask-vault-pass`.
- **Never commit `variables.yaml`** — it is in `.gitignore`. Only `variables.yaml.example` is committed.
- **Firewall only the cluster subnet** — allow the ports in §4 only between cluster nodes.
- **Expose only the VIP (9999) and PMM (443)** to application/admin networks. **Never expose** etcd (:2379/2380), the Patroni REST API (:8008), or PostgreSQL (:5432) publicly.
- Keep the `pgpass` file private with `0600` permissions (the bootstrap uses `/tmp/pgpass0` — move it after first boot if you prefer).
- Keep PMM behind a VPN or at minimum behind strong auth (change the admin password on first login).
- `pcp.conf` and `pool_passwd` are chmod 0640; the sudoers entry (`postgres ALL=(ALL) NOPASSWD: /usr/sbin/ip, /usr/sbin/arping`) is the minimum needed for VIP management.

---

## 14. Troubleshooting

| Issue | Likely cause | Check / fix |
|-------|--------------|-------------|
| **Patroni won't start** | etcd not reachable | `systemctl status etcd`, `ETCDCTL_API=3 etcdctl endpoint health`; check `patroni.yml` `etcd3.hosts` (all endpoints are listed now). `ExecStartPre` waits `etcd_wait_timeout` (90 s) before giving up. |
| **etcd quorum not forming** | Stale data from a previous run | On a FRESH bootstrap only: set `etcd_force_reset: true` and re-run 02 (wipes + sets `initial-cluster-state: new`). Never `rm -rf /var/lib/etcd/*` on a healthy cluster. |
| **No leader after 2 hosts down** | Expected — 3-node etcd needs a 2/3 majority | Consensus working correctly. For higher tolerance use `etcd_group: "etcd_nodes"` with 3–5 dedicated witnesses (see §16). |
| **Crashed replica won't recover** | Corrupt data dir or DCS hiccup | `patroni-self-heal.timer` restarts a crashed LOCAL member automatically; for a corrupt data dir run `patronictl reinit maruf <member>` manually (never auto-reinit). |
| **Patroni won't start after reboot** | Patroni raced etcd at boot | `ExecStartPre` waits for DCS; check `journalctl -u patroni` and `/var/log/patroni/cluster_health.log`. |
| **etcd member fails GPG validation** | Fresh OS missing Percona keys | The RPM installs its own key; the playbook uses `disable_gpg_check: true` for the release RPM. |
| **Replicas stuck with lag** | Replication slot missing / WAL removed | `patronictl list`; check `pg_replication_slots`; a full `pg_basebackup` may be needed. |
| **VIP not moving** | sudoers / capability issues | `sudoers.d/pgpool-vip` entry present? `journalctl -u pgpool` for vip_up/vip_down errors. |
| **Watchdog not forming** | Firewall 9000, auth key mismatch, heartbeat port collision | Open UDP/TCP 9000 (wd_port) and 9694 (heartbeat_port) between nodes; `wd_authkey` identical everywhere; heartbeat_port MUST differ from wd_port; nodes reachable. |
| **pgpool rejects config** | Unindexed `wd_*` params | Pgpool 4.5+ requires indexed `wd_port0/1/2`; remove bare `wd_port`, `wd_authkey`, etc. |
| **Debian pgpool2 missing / wrong version** | PGDG repo not added, or an old native 4.3.5 pin left over | Debian uses PGDG pgpool-II 4.7: ensure `/usr/share/keyrings/pgdg.gpg` + the `apt.postgresql.org` repo exist, remove any `/etc/apt/preferences.d/pgpool2` pin, then `apt install pgpool2=4.7.2-1.pgdg* libpgpoolpcp3=4.7.2-1.pgdg* postgresql-16-pgpool2=4.7.2-1.pgdg*`. |
| **Cannot connect via VIP** | VIP on wrong node / pgpool not started | `ip addr` (who owns .200?), `pcp_watchdog_info`, `systemctl status pgpool`. |
| **pool_passwd auth fails** | MD5 vs SCRAM mismatch | This repo uses a plaintext `pool_passwd` + `pool_hba.conf` (SCRAM-safe); keep file perms 0640. |
| **pgBackRest fails** | SSH keys / stanza missing | Run `stanza-create` first; `sudo -iu postgres pgbackrest --stanza=maruf info`; check `repo1-host`. |
| **PMM not reachable** | Docker port mapping / firewall | Image listens on 8443 internally → map `-p 443:8443`; open 443 on the backup node; iptables FORWARD ACCEPT for 443. |
| **`patronictl restart` hangs** | Interactive prompt | Use `patronictl restart maruf --no-wait` in automation. |
| **Deploy fails on a fresh VM** | Missing EPEL/CRB | `dnf install -y epel-release && dnf config-manager --set-enabled crb` before pgBackRest deps. |

---

## 15. Validation & Evidence

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

## 16. Known Limitations & Honest Caveats

This section exists so the supervisor has the complete picture — including the parts that are not flattering.

### 1. etcd is a single point of failure for *write availability* (confirmed by Test 3)

During Test 3, two of three PostgreSQL nodes were fully healthy throughout, yet **all writes stopped completely** because the etcd cluster lost quorum (one member killed + 30% packet loss between the two survivors made a 2-of-3 quorum unreachable). The cluster correctly chose **safe-unavailable** (zero primaries, read-only, no split-brain, no data loss — 53/53 confirmed writes survived), but the outcome stands: **a healthy database cannot accept writes without a healthy DCS.**

**DCS availability is the upper bound on write availability.** Mitigations, in increasing order of cost:

1. **Dedicated etcd witness nodes** (`etcd_group: "etcd_nodes"` in `hosts.ini`/`variables.yaml`) — etcd no longer co-locates with PostgreSQL, so a DB-host crash never touches quorum. Patroni on `pg_nodes` then talks to **all** etcd endpoints, so a local etcd failure never blinds it.
2. **5-node etcd topology** — tolerates two concurrent etcd losses, end-to-end, instead of one.
3. **Both** — dedicated witnesses *and* 5 members, for the strongest separation.

This is an architectural recommendation for a follow-up decision — **not a blocker** for the current single-host-loss HA guarantees, which are unaffected.

### 2. Asynchronous replication means no hard zero-RPO guarantee

See §15. Zero lost commits were observed empirically, but an async model cannot *guarantee* that a transaction acknowledged on the old primary microseconds before a power loss is present on the new primary. Zero-RPO requires synchronous mode (`synchronous_standby_names`), which trades write latency for durability.

### 3. Failover is automatic, but not zero-downtime

The 34–38 s write interruption is real and client-visible. A stateful application must handle connection errors and retry. This is standard for async streaming-replication HA and is the honest trade-off for automatic failover — it is *downtime-minimizing*, not *downtime-free*.

### 4. First-host-loss tolerance only (by default)

The default co-located topology tolerates losing **any single host**. Losing **two** DB hosts at once kills etcd quorum → correctly no leader (safe, but unavailable). The 3–5 witness etcd topology (above) is the fix. "All hosts down" is disaster recovery, not HA — the documented restore path is: bring etcd up first, then Patroni, then the rest, or restore from pgBackRest if data is unrecoverable.

### 5. Known non-blockers (open follow-ups in this deployment)

| Item | Status | Action |
|------|--------|--------|
| br1 (backup host) under-provisioned (2 vCPU running ClickHouse + Docker + Grafana + VictoriaMetrics + PMM; thrashes to loadavg 60+; caused an sshd wedge during Test 2) | Open — not a blocker | Resize br1 or split the metrics stack |
| pgBackRest **archive-push** can silently wedge for hours with no monitoring alert (observed ~2.5 h before Test 2) | Open — not a blocker | Add an archive-staleness/backlog check (oldest unarchived WAL age) to the health monitor |
| PMM monitoring | **Disabled by policy** on br1 | Keep PMM off; do not redeploy; the stack is fully validated without it |

### 6. Watchdog/VIP hard facts

- `wd_quorum_exit = on` (default): a pgpool instance that loses watchdog quorum **exits** rather than serving the VIP alone → no split-brain VIP.
- The VIP is served by the *watchdog leader*, which is elected independently of the PostgreSQL primary — the VIP may move without a DB failover (and vice versa). If the pgpool process on the VIP-holding node dies, the VIP must move (measured ~50 s blip in one test) — applications should retry connections.
- `heartbeat_port` (9694) **must differ** from `wd_port` (9000), or watchdog heartbeats collide.

---

## 17. Glossary

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

## 18. Further Reading

All source material lives in the repository: **https://github.com/marufmoinuddin/patroni-pgpool-ansible**

| Topic | Document |
|-------|----------|
| Quick start | `docs/getting-started/quick-start.md` |
| Architecture & concepts | `docs/concepts/architecture.md` · `docs/concepts/ha-fundamentals.md` · `docs/concepts/patroni-internals.md` · `docs/concepts/pgpool.md` · `docs/concepts/resilience.md` |
| Deployment | `docs/deployment/ansible.md` · `docs/deployment/manual.md` · `docs/deployment/server-planning.md` · `docs/deployment/repository-contents.md` |
| Operations | `docs/operations/operations.md` · `docs/operations/validation.md` · `docs/operations/security.md` · `docs/operations/production-recommendations.md` |
| Decision guides | `docs/solutions/patroni-pgpool-vs-standalone-pgpool.md` · `docs/solutions/patroni-pgpool-vs-haproxy-pgbouncer.md` · `docs/solutions/preferred-primary-node.md` · `docs/solutions/patroni-promotion-mechanism.md` |
| Validation | `docs/solutions/failover-test-report.md` · `docs/operations/validation.md` · `docs/troubleshooting/failover-testing.md` |
| Troubleshooting | `docs/troubleshooting/troubleshooting.md` |
| External references | `docs/reference/external-references.md` |

External links: [Patroni docs](https://patroni.readthedocs.io/) · [Percona Distribution for PostgreSQL](https://www.percona.com/software/postgresql-distribution) · [Percona Patroni setup](https://docs.percona.com/postgresql/16/patroni.html) · [pgpool-II docs](https://www.pgpool.net/docs/) · [pgBackRest](https://pgbackrest.org/) · [PMM](https://www.percona.com/software/database-tools/percona-monitoring-and-management) · [etcd](https://etcd.io/docs/)
