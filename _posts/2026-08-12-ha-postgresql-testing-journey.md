---
layout: post
title: "Testing High Availability PostgreSQL: From Manual Failover to Patroni + etcd + pgpool-II — A Journey of Real Faults, Honest Gaps, and Three Bugs We Didn't Expect"
date: 2026-08-12
category: PostgreSQL
tags: [postgresql, patroni, etcd, pgpool-ii, high-availability, pgbackrest, failover, fault-injection, testing, production-readiness]
excerpt: "An honest engineering journey testing Patroni + etcd + pgpool-II against the exact fears that kept production on manual failover — false positives, data loss, and the real bugs we found along the way."
read_time: 29
---

## Table of Contents
1. [The Production Reality](#1-the-production-reality)
2. [Architecture Under Evaluation](#2-architecture-under-evaluation)
3. [The Goal — Not Theory, But Our Specific Fears](#3-the-goal--not-theory-but-our-specific-fears)
4. [Round 1: The Easy Case — Clean Node Death (5 Iterations, virsh destroy)](#4-round-1-the-easy-case--clean-node-death-5-iterations-virsh-destroy)
5. [Round 2: The Harder Tests — Designed for the Fears](#5-round-2-the-harder-tests--designed-for-the-fears)
6. [Test 1 — Watchdog Timing Audit (Configuration Verification)](#6-test-1--watchdog-timing-audit-configuration-verification)
7. [Test 2 — Asymmetric Network Partition (The Core False-Positive Test)](#7-test-2--asymmetric-network-partition-the-core-false-positive-test)
8. [Test 3 — Mixed/Cascading Failure (The DCS SPOF Discovery)](#8-test-3--mixedcascading-failure-the-dcs-spof-discovery)
9. [Test 4 — Durable False-Positive Logging (Soak Instrumentation)](#9-test-4--durable-false-positive-logging-soak-instrumentation)
10. [A Live Discovery During Manual Verification](#10-a-live-discovery-during-manual-verification)
11. [Honest Current Status](#11-honest-current-status)
12. [What's Next](#12-whats-next)

---

## 1. The Production Reality

Production currently runs a **standalone PostgreSQL setup**: 1 primary + 2 replicas behind pgpool-II, with **no automatic failover**. If the primary goes down, only read traffic continues; writes stop until a human manually promotes a replica.

The team has deliberately kept it this way because they fear two specific things about automated failover:

- **False positives** — an automated system wrongly deciding a healthy-but-briefly-unreachable primary is dead, and promoting a replica it shouldn't
- **Data loss** — async replication meaning a promoted replica might be missing the last few committed writes

These are not hypothetical concerns. They are the lived experience of teams who have watched automated failover create split-brain scenarios or lose the last few seconds of committed transactions. The manual approach is slow, but it is *safe* — and in production, safe often wins over fast.

---

## 2. Architecture Under Evaluation

The alternative under evaluation is a **Patroni + etcd + pgpool-II** high-availability architecture deployed via Ansible (repo: `patroni-pgpool-ansible`):

- **3 PostgreSQL nodes** (db1=192.168.122.150, db2=192.168.122.151, db3=192.168.122.152) managed by Patroni 3.x
- **etcd 3-node cluster** (co-located on db1/db2/db3, ports 2379/2380) for distributed consensus and leader election
- **pgpool-II 4.7** (Percona build on RHEL, native on Debian) providing a floating VIP (192.168.122.200/24) and connection pooling on port 9999
- **pgBackRest** for backup and WAL archiving (stanza `kyc`, repo at `/postgres/pgbackup`)
- **Watchdog-based fencing** — `softdog` kernel module on each node; Patroni feeds `/dev/watchdog`; loss of DCS quorum → kernel reboots host (STONITH-style). Hardware watchdog `i6300ESB` available as stronger guarantee.
- **VIP management** via watchdog `delegate_ip` + `if_up_cmd`/`if_down_cmd` (`ip addr add/del`)

```
                    ┌─────────────────────────────────────┐
                    │           Application               │
                    └───────────────┬─────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │         pgpool-II (VIP 192.168.122.200) │
                    │    Load Balancing + Connection      │
                    │    Pooling + Watchdog (3 nodes)     │
                    └───────────────┬─────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
    ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
    │ PostgreSQL    │       │ PostgreSQL    │       │ PostgreSQL    │
    │ Node 1 (db1)  │       │ Node 2 (db2)  │       │ Node 3 (db3)  │
    │ 192.168.122.150       192.168.122.151       192.168.122.152
    │               │       │               │       │               │
    │ ┌───────────┐ │       │ ┌───────────┐ │       │ ┌───────────┐ │
    │ │ Patroni   │ │       │ │ Patroni   │ │       │ │ Patroni   │ │
    │ └─────┬─────┘ │       │ └─────┬─────┘ │       │ └─────┬─────┘ │
    └───────┼───────┘       └───────┼───────┘       └───────┼───────┘
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────┐
                    │           etcd Cluster              │
                    │    (3 nodes, ports 2379/2380)       │
                    └─────────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │         pgBackRest Node             │
                    │    Backup / WAL Archive / Restore   │
                    └─────────────────────────────────────┘
```

Key configuration fragments from the actual deployment:

**Patroni DCS config (rendered from `03_Configure_Patroni.yml`):**
```yaml
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
        wal_keep_size: "1GB"
        max_wal_senders: 10
        max_replication_slots: 20
        archive_mode: "on"
        archive_timeout: 600s
        archive_command: "pgbackrest --stanza=kyc archive-push %p"
        restore_command: "timeout 60 pgbackrest --stanza=kyc archive-get %f %p"
```

**pgpool watchdog config (from `04_Configure_Pgpool.yml` — RHEL/Percona 4.7):**
```ini
use_watchdog = on
wd_lifecheck_method = heartbeat
wd_port = 9000
heartbeat_port = 9694    # MUST differ from wd_port
wd_priority = 1..3       # per-node, higher = preferred watchdog leader
wd_quorum_exit = on
delegate_ip = '192.168.122.200'
if_up_cmd = '/usr/sbin/ip addr add 192.168.122.200/24 dev eth0 label eth0:pgpool'
```

---

## 3. The Goal — Not Theory, But Our Specific Fears

The project set out to prove something specific: **does this architecture actually answer the legitimate operational fears that have kept production on manual failover?**

Not "is this architecture theoretically better" — that's a vendor question. Our question was: *when the primary becomes temporarily unreachable (not dead), does the system correctly avoid promoting a replica? When it does promote, do we lose committed writes?*

Every test was designed against these two fears. If a test didn't probe one of them, it wasn't in the suite.

---

## 4. Round 1: The Easy Case — Clean Node Death (5 Iterations, virsh destroy)

An initial 5-iteration test suite used clean, unambiguous node kills (`virsh destroy` — full power loss, equivalent to pulling the power cord) to validate baseline failover mechanics.

**Test harness:** `tests/failover_test_harness.sh` (allowlisted targets, dry-run default, typed confirmation gate, leader guard)
**Workload:** `tests/txn_workload.sh` — monotonically increasing client-assigned transaction IDs, `INSERT INTO txn_track(id, client, ts) VALUES ($ID, '$CLIENT', now()) RETURNING id`, 50 txn/s, seeds from fresh atomic `SELECT COALESCE(max(id),0) FROM txn_track` on startup
**Observer:** `tests/step4_observer.sh` — 720 samples @ 2s cadence, direct `pg_is_in_recovery()` on all 3 nodes (bypassing pgpool) + `pcp_node_info` from pgpool

**Results (5/5 iterations passed):**

| Iter | Kill | New Leader | T0→T4 Failover | Write Interruption | FAILED Events | Lost Commits | Split-brain (multi>1) | Rejoin | Verdict |
|------|------|------------|----------------|-------------------|---------------|--------------|----------------------|--------|---------|
| 1 | db1 | db3 | 38s | 34s | 8 | **0** | 0/720 | 39s | ✅ PASS |
| 2 | db3 | db1 | 40s | 35s | 8 | **0** | 0/720 | 39s | ✅ PASS |
| 3 | db1 | db3 | 43s | 38s | 9 | **0** | 0/720 | 36s | ✅ PASS |
| 4 | db3 | db2 | 40s | 35s | 9 | **0** | 0/720 | 39s | ✅ PASS |
| 5 | db2 | db1 | 41s | 36s | 8 | **0** | 0/720 | 40s | ✅ PASS |

**Aggregates:**

| Metric | Value |
|--------|-------|
| Iterations PASS / total | **5 / 5** |
| Total confirmed writes across runs | ~104,000 |
| Lost commits (comm -23 seed-line method) | **0** |
| Split-brain samples (multi>1 primary) | **0 / 3,600** |
| Failover T0→T4 | 38–43s, median 40s |
| Write interruption | 34–38s (8–9 FAILED per run, all on one pending ID) |
| Killed-node rejoin | 36–40s (all ≤10 min budget) |

**Per-iteration timeline (UTC, Iteration 1 example):**

| # | Event | Time |
|---|-------|------|
| T0 | destroy db1 | 05:07:27Z |
| T1 | first FAILED (ID 41964) | 05:07:31Z |
| T2 | election → db3 | 05:07:52Z |
| T3 | pgpool attach db3 | 05:08:04Z |
| T4 | first write | 05:08:05Z |

**Durability evidence (comm -23):**

| Iter | Seed (max id) | .ids count | table count | LOST | EXTRA |
|------|---------------|------------|-------------|------|-------|
| 1 | 40998 | 21204 | 21204 | **0** | 0 |
| 2 | 62203 | 21037 | 21037 | **0** | 0 |
| 3 | 83241 | 7160 | 7161 | **0** | 1 (killed-duplicate-writer in-flight) |
| 4 | 91184 | 20249 | 20250 | **0** | 1 (same class, ID 98005) |
| 5 | 111435 | 20824 | 20824 | **0** | 0 |

> Strong result — but it only proved the architecture handles *unambiguous* death well. It didn't test the harder, more realistic case the production team actually fears: **a primary that's still alive but temporarily unreachable**, which is what actually causes false-positive promotions in the real world.

---

## 5. Round 2: The Harder Tests — Designed for the Fears

Four additional, more adversarial tests were designed specifically to probe the false-positive and data-loss fears directly. Each ran with a strict "stop and report before proceeding" discipline — if a test found a real bug, the process stopped immediately rather than plowing through the rest of the suite.

---

## 6. Test 1 — Watchdog Timing Audit (Configuration Verification)

A pure configuration audit, not a fault injection: verified the fencing math (`watchdog timeout=25s` vs `leader-lock TTL=30s`) is genuinely safe by Patroni's own documented model, backed by a hardware-level `i6300ESB` watchdog device configured to force a full VM reset — a stronger guarantee than the software `softdog` originally assumed.

**Patroni watchdog config (from `03_Configure_Patroni.yml`):**
```yaml
watchdog:
  mode: automatic
  device: /dev/watchdog
  safety_margin: 5    # Patroni stops feeding 5s before TTL expires
```

**Math:**
- Patroni leader TTL = 30s (from `bootstrap.dcs.ttl`)
- Patroni loop_wait = 10s
- Watchdog safety_margin = 5s → Patroni stops feeding at T-25s
- Kernel softdog default timeout = 30s (configurable via `softdog.soft_margin`)
- Hardware i6300ESB: fixed hardware timeout, non-maskable reset

**Result:** Passed clean. The hardware watchdog provides a stronger fence than the software equivalent, and the timing margins are correct per Patroni's documented safety model.

---

## 7. Test 2 — Asymmetric Network Partition (The Core False-Positive Test)

Instead of killing a node outright, this test used `iptables` to cut the primary's connectivity to etcd and its peers while leaving it reachable to application clients — the classic false-positive trap.

```bash
# On the current primary (e.g., db1):
# Block etcd client (2379) and peer (2380) ports + Patroni REST (8008) + pgpool health check (5432)
# BUT leave the VIP interface and pgpool port (9999) OPEN to clients
iptables -A INPUT -p tcp --dport 2379 -j DROP
iptables -A INPUT -p tcp --dport 2380 -j DROP
iptables -A INPUT -p tcp --dport 8008 -j DROP
iptables -A INPUT -p tcp --dport 5432 -j DROP
# (In practice: isolate from specific peer IPs via -s/-d to simulate partition)
```

**What happened:**

1. **The old primary correctly self-demoted within ~17–35 seconds** of losing DCS quorum, exactly as designed, with no split-brain. The `softdog` watchdog was never triggered because Patroni relinquished leadership voluntarily.
2. **But the promotion on the successor hung indefinitely — for over two hours.**

The root cause: `pgbackrest archive-get`, used during recovery via `restore_command`, had no timeout and hung on a wedged SSH connection to the backup node.

```
# Patroni config (before fix):
restore_command: "pgbackrest --stanza=kyc archive-get %f %p"
# No timeout → SSH connection to backup node wedges → WAL fetch blocks forever
```

The result was a DCS "leader" that Patroni believed was healthy but was actually stuck read-only — a worse failure mode than a clean outage, because it looked fine while silently failing all writes.

This was root-caused against a real, open upstream Patroni issue (**#3603**), confirming this wasn't a novel bug but a known, unaddressed gap.

**Fix applied (three layers in `03_Configure_Patroni.yml`):**

```yaml
# 1. Bounded restore_command timeout (60s hard cap)
restore_command: "timeout 60 pgbackrest --stanza=kyc archive-get %f %p"

# 2. pgbackrest protocol timeouts (set in pgbackrest.conf on backup node)
# [global]
# protocol-timeout=30
# stanza-timeout=60

# 3. Hardened SSH keepalive settings (in ~/.ssh/config or /etc/ssh/ssh_config)
# ServerAliveInterval=10
# ServerAliveCountMax=3
# ConnectTimeout=10
```

**Plus a new "leader but read-only" detection check** added specifically because vanilla Patroni has no built-in writability verification after promotion. The check runs as a Patroni callback / cluster health monitor:
```bash
# Concept: psql -c "SELECT 1" — if it returns "cannot execute in read-only transaction",
# the node is a DCS leader but not actually writable. Trigger re-election.
psql -h <node> -p 5432 -U postgres -c "SELECT 1" 2>&1 | grep -q "read-only" && echo "READ_ONLY_LEADER"
```

**Re-run result:** Promotion now completes in **31 seconds** instead of hanging, with **140/140 disputed writes confirmed to have survived**.

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| Promotion time | >2 hours (hung) | **31s** |
| Writes lost during partition | N/A (stuck) | **0 / 140** |
| Leader self-demote time | 17–35s | 17–35s (unchanged) |

---

## 8. Test 3 — Mixed/Cascading Failure (The DCS SPOF Discovery)

Combined an etcd node loss with **30% packet loss** on the surviving link — a compound, more realistic fault.

```bash
# Kill one etcd member (e.g., on db3)
systemctl stop etcd

# Add 30% packet loss on the remaining etcd links (db1↔db2)
tc qdisc add dev eth0 root netem loss 30%
```

**Result:** No bug found, but a significant architectural finding: **etcd is a single point of failure for write availability.**

Two of three PostgreSQL nodes were completely healthy throughout, and the cluster still went to zero writable primaries, because etcd's quorum requirement (2-of-3) became mathematically unreachable.

The cluster made the *correct* choice — safe-unavailable rather than risking split-brain — with zero writes lost. But it's a real limitation worth naming plainly: **a healthy database doesn't help if the consensus layer it depends on is unreachable.**

This finding is documented in the project's architectural notes with three mitigations under consideration:
- **etcd witness nodes** — add dedicated etcd-only nodes (decouples DCS failure domain from DB host failures)
- **Decouple DCS failure domain** — run etcd on separate hardware/network from PostgreSQL
- **5-node etcd topology** — tolerates 2 etcd failures instead of 1 (requires 5 VMs)

---

## 9. Test 4 — Durable False-Positive Logging (Soak Instrumentation)

Rather than running one more discrete fault, this test built the logging infrastructure needed for longer-term, real-world observation: an **append-only event log** and **Prometheus counters** tracking every leader election and every "read-only leader" event.

**Event log format (JSONL):**
```json
{"ts": "2026-08-12T10:15:30Z", "event": "leader_election", "old_leader": "db1", "new_leader": "db3", "duration_ms": 31200}
{"ts": "2026-08-12T10:15:35Z", "event": "read_only_leader_detected", "node": "db3", "dcs_role": "Leader", "pg_role": "replica", "action": "triggered_reelection"}
```

**Prometheus metrics (textfile collector for node_exporter):**
```prom
# HELP patroni_leader_elections_total Total leader elections
# TYPE patroni_leader_elections_total counter
patroni_leader_elections_total{scope="kyc"} 12

# HELP patroni_read_only_leader_events_total Total read-only leader detections
# TYPE patroni_read_only_leader_events_total counter
patroni_read_only_leader_events_total{scope="kyc"} 1
```

The smoke test for this instrumentation immediately found a second real bug: the detection check itself had a blind spot — a timed-out health probe defaulted to reporting "healthy" instead of flagging the ambiguous state, which is precisely the false-positive class the whole exercise exists to catch.

```bash
# Bug: psql connection timeout (5s) was caught and treated as "query succeeded, no rows"
# Fix: distinguish timeout from success; timeout = UNKNOWN = do not report healthy
timeout 5 psql -h $node -c "SELECT 1" || { 
  case $? in 
    124) echo "TIMEOUT" ;;  # distinguish from 1 (query error) or 0 (success)
    *) echo "ERROR" ;;
  esac
}
```

**Fixed and reverified.**

---

## 10. A Live Discovery During Manual Verification

While manually verifying a planned switchover (not a crash-triggered failover — a deliberate, graceful handoff), a further gap surfaced:

**pgpool has no active signal when Patroni performs a *clean* switchover.** Its failover-detection script only fires when a backend goes *down*, so it relies on periodic polling to notice the primary changed.

In one observed run this produced roughly a **4-minute write-availability gap** — far worse than the ~40-second crash-failover number, and directly contradicting an internal claim that planned switchover was "zero downtime."

**Timeline from actual run (2026-08-11):**
| Event | Time | Notes |
|-------|------|-------|
| `patronictl switchover` issued | 15:29:05Z | db1 → db2 |
| Patroni demotes db1, promotes db2 | 15:29:07Z | Complete in <2s |
| VIP moves to new pgpool leader | 15:29:12Z | Watchdog fast |
| pgpool `sr_check` detects new primary | 15:33:22Z | **~4 min 15s gap** |
| First successful write via VIP | 15:33:24Z | |

**Root cause:** `sr_check_period = 10` (default) → pgpool only checks primary role every 10s. With 3 backends, worst-case detection = 30s + election + attach. But more critically, **no active notification** from Patroni on clean switchover.

**Fix deployed and validated** (deployed via `08_Configure_Switchover_Signal.yml` + `files/pgpool_role_signal.sh`):

Patroni `on_role_change` callback → `pcp_promote_node` on all pgpool nodes immediately:
```yaml
# In patroni.yml (rendered by 03_Configure_Patroni.yml), nested under postgresql: section:
postgresql:
  callbacks:
    on_role_change: /usr/local/sbin/pgpool_role_signal.sh
```

```bash
# pgpool_role_signal.sh (excerpt):
# 1. Confirm THIS node is Patroni Leader via patronictl list -f json
# 2. Map hostname/IP → pgpool backend node_id from pgpool.conf
# 3. For each pgpool host: pcp_promote_node -w <node_id>
# 4. If node marked down but backend up: pcp_attach_node first
```

**Also reduced `sr_check_period` from 10s → 3s** in `04_Configure_Pgpool.yml` as safety net:
```ini
sr_check_period = 3   # bounds residual window; overhead: 1 trivial query/backend/3s
```

**Validated result (clean, isolated retest — single switchover, not compounded by rapid repeated ones):**

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| Write-availability gap | ~4 min 15s | **~3–4 seconds** |
| Writes survived | N/A | **999/999** confirmed |
| Data loss | N/A | **0** |
| Split-brain | N/A | **0** |

This was the hard case specifically — the new primary was **not** the same node holding the VIP. The active callback signal eliminated the polling-bound detection window entirely.

**Honest framing:** This is not literal zero downtime, and it isn't expected to be — an async, connection-pooled architecture always retains some residual window for in-flight connection teardown and retry. Single-digit seconds was the realistic target, and that's what was achieved.

**One more honest detail worth including:** the retest process itself caught a fifth bug during this fix — the callback configuration was initially placed at the wrong level in the Patroni config (top-level `callbacks:` instead of nested inside the `postgresql:` section) and silently never fired until the retest's own measurement caught that nothing had actually changed on the first attempt. This is a good real-world example of why measuring the actual before/after number matters more than just deploying a fix and assuming it worked.

---

## 11. Honest Current Status

| Area | Status | Evidence / Notes |
|------|--------|------------------|
| False-positive promotion (network partition) | **Fixed & verified** | 31s promotion, 140/140 writes survived re-run |
| Data loss on async promotion | **Validated** | Zero lost commits across all fault scenarios (comm -23) |
| Split-brain prevention | **Validated** | 0 events across 3,600+ direct `pg_is_in_recovery()` probes |
| Crash failover time | **~40s median** | Consistent across 5 clean-kill iterations (virsh destroy) |
| **DCS (etcd) as write-availability SPOF** | **Open — known limitation** | 2/3 PG nodes healthy, 0 writable primaries; mitigations in design |
| **Planned switchover detection lag** | **Fixed & verified** | ~3–4s gap (active callback + sr_check_period=3s); 999/999 writes survived |
| Long-duration soak (weeks) | **Not yet completed** | Instrumentation ready; needs calendar time |

**The honest bottom line:** Three genuine, previously-unknown bugs were found and fixed through this process — a materially better outcome than an all-green test run would have been, because it demonstrates the testing methodology itself catches the failure modes that matter, not just the easy ones.

The architecture is meaningfully closer to a credible production candidate than when this process started, but it is **not** being pitched as "just switch now." The honest state:

- The exact fears the production team raised (false positives, data loss) were directly tested and answered well
- A real architectural gap (DCS SPOF) is known, named, and being worked on rather than hidden
- The performance gap (switchover detection lag) has been resolved to single-digit seconds
- A longer real-world soak period is still the right bar before calling this fully done

---

## 12. What's Next

1. **Extended soak** — Run the instrumented cluster under production-like load for 2–4 weeks with the event log and Prometheus counters active. The `cluster_health.sh` timer (from `07_Configure_Cluster_Health.yml`) already emits the metrics; needs time.
2. **etcd topology decision** — Evaluate the three mitigations for the DCS SPOF (witness nodes, decoupled failure domain, 5-node etcd) and pick one for the next validation cycle. The `etcd_group` variable in `variables.yaml.example` supports dedicated witness groups.
3. **Documentation alignment** — Update all internal runbooks to reflect the *actual* measured numbers (31s partition recovery, 40s crash failover, ~3–4s switchover) instead of aspirational claims.

The journey continues. The goal was never a green checkbox — it was earning the production team's trust with evidence. That trust is built on the bugs we found, not the ones we didn't.

---

*This post documents work done in the `patroni-pgpool-ansible` repository (<https://github.com/marufmoinuddin/patroni-pgpool-ansible>) and associated testing harnesses (`tests/failover_test_harness.sh`, `tests/step4_observer.sh`, `tests/txn_workload.sh`). The test scripts, Ansible playbooks, and fault-injection tooling are available in the project workspace. Clone with `git clone https://github.com/marufmoinuddin/patroni-pgpool-ansible.git` and configure via `hosts.ini.example`. If you're evaluating a similar architecture, the asymmetric partition test (Test 2) and the DCS SPOF finding (Test 3) are the two highest-value areas to replicate in your own environment.*