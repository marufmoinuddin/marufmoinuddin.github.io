---
layout: post
title: "Testing High Availability PostgreSQL: From Manual Failover to Patroni + etcd + pgpool-II — A Journey of Real Faults, Honest Gaps, and Two Bugs We Didn't Expect"
date: 2026-08-12
category: PostgreSQL
tags: [postgresql, patroni, etcd, pgpool-ii, high-availability, pgbackrest, failover, fault-injection, testing, production-readiness]
excerpt: "An honest engineering journey testing Patroni + etcd + pgpool-II against the exact fears that kept production on manual failover — false positives, data loss, and the real bugs we found along the way."
read_time: 24
---

## Table of Contents
1. [The Production Reality](#1-the-production-reality)
2. [Architecture Under Evaluation](#2-architecture-under-evaluation)
3. [The Goal — Not Theory, But Our Specific Fears](#3-the-goal--not-theory-but-our-specific-fears)
4. [Round 1: The Easy Case — Clean Node Death](#4-round-1-the-easy-case--clean-node-death)
5. [Round 2: The Harder Tests — Designed for the Fears](#5-round-2-the-harder-tests--designed-for-the-fears)
6. [Test 1 — Watchdog Timing Audit](#6-test-1--watchdog-timing-audit)
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

The alternative under evaluation is a **Patroni + etcd + pgpool-II** high-availability architecture:

- **3 PostgreSQL nodes** managed by Patroni
- **etcd** (3-node cluster) for distributed consensus and leader election
- **pgpool-II** providing a floating VIP and connection routing
- **pgBackRest** for backup and WAL archiving
- **Watchdog-based fencing** (hardware-backed VM reset via `i6300ESB`) to prevent split-brain

```
                    ┌─────────────────────────────────────┐
                    │           Application               │
                    └───────────────┬─────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │         pgpool-II (VIP)             │
                    │    Load Balancing + Connection      │
                    │    Pooling + Watchdog (3 nodes)     │
                    └───────────────┬─────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
    ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
    │ PostgreSQL    │       │ PostgreSQL    │       │ PostgreSQL    │
    │ Node 1        │       │ Node 2        │       │ Node 3        │
    │ (Primary)     │       │ (Replica)     │       │ (Replica)     │
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
                    │    (3 nodes, distributed consensus) │
                    └─────────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │         pgBackRest Node             │
                    │    Backup / WAL Archive / Restore   │
                    └─────────────────────────────────────┘
```

The goal was not to blindly advocate for switching, but to **actually test whether this architecture answers the production team's specific fears**, with real fault injection rather than just documentation claims.

---

## 3. The Goal — Not Theory, But Our Specific Fears

The project set out to prove something specific: **does this architecture actually answer the legitimate operational fears that have kept production on manual failover?**

Not "is this architecture theoretically better" — that's a vendor question. Our question was: *when the primary becomes temporarily unreachable (not dead), does the system correctly avoid promoting a replica? When it does promote, do we lose committed writes?*

Every test was designed against these two fears. If a test didn't probe one of them, it wasn't in the suite.

---

## 4. Round 1: The Easy Case — Clean Node Death

An initial 5-iteration test suite used clean, unambiguous node kills (`virsh destroy` — full power loss, equivalent to pulling the power cord) to validate baseline failover mechanics.

**Results (5/5 iterations passed):**

| Metric | Result |
|--------|--------|
| Lost commits | **0** across ~104,000 writes |
| Split-brain events | **0** across 3,600 direct `pg_is_in_recovery()` probes |
| Failover time | 38–43s (median ~40s) |
| Node rejoin time | 36–40s |

Strong result — but it only proved the architecture handles *unambiguous* death well. It didn't test the harder, more realistic case the production team actually fears: **a primary that's still alive but temporarily unreachable**, which is what actually causes false-positive promotions in the real world.

---

## 5. Round 2: The Harder Tests — Designed for the Fears

Four additional, more adversarial tests were designed specifically to probe the false-positive and data-loss fears directly. Each ran with a strict "stop and report before proceeding" discipline — if a test found a real bug, the process stopped immediately rather than plowing through the rest of the suite.

---

## 6. Test 1 — Watchdog Timing Audit

A pure configuration audit, not a fault injection: verified the fencing math (`watchdog timeout=25s` vs `leader-lock TTL=30s`) is genuinely safe by Patroni's own documented model, backed by a hardware-level `i6300ESB` watchdog device configured to force a full VM reset — a stronger guarantee than the software watchdog originally assumed.

**Result:** Passed clean. The hardware watchdog provides a stronger fence than the software equivalent, and the timing margins are correct per Patroni's documented safety model.

---

## 7. Test 2 — Asymmetric Network Partition (The Core False-Positive Test)

Instead of killing a node outright, this test used `iptables` to cut the primary's connectivity to etcd and its peers while leaving it reachable to application clients — the classic false-positive trap.

**What happened:**

1. The old primary correctly self-demoted within **~17–35 seconds** of losing DCS quorum, exactly as designed, with no split-brain.
2. **But the promotion on the successor hung indefinitely — for over two hours.**

The root cause: `pgbackrest archive-get`, used during recovery, had no timeout and hung on a wedged SSH connection to the backup node. The result was a DCS "leader" that Patroni believed was healthy but was actually stuck read-only — a worse failure mode than a clean outage, because it looked fine while silently failing all writes.

This was root-caused against a real, open upstream Patroni issue (**#3603**), confirming this wasn't a novel bug but a known, unaddressed gap.

**Fix applied (three layers):**

1. **Bounded `restore_command` timeout** — prevents indefinite blocking on WAL fetch
2. **`pgbackrest` protocol timeout** — `--protocol-timeout` and `--stanza-timeout` on the backup side
3. **Hardened SSH keepalive settings** — `ServerAliveInterval=10`, `ServerAliveCountMax=3`, `ConnectTimeout=10`

Plus a new **"leader but read-only" detection check** added specifically because vanilla Patroni has no built-in writability verification after promotion.

**Re-run result:** Promotion now completes in **31 seconds** instead of hanging, with **140/140 disputed writes confirmed to have survived**.

---

## 8. Test 3 — Mixed/Cascading Failure (The DCS SPOF Discovery)

Combined an etcd node loss with **30% packet loss** on the surviving link — a compound, more realistic fault.

**Result:** No bug found, but a significant architectural finding: **etcd is a single point of failure for write availability.**

Two of three PostgreSQL nodes were completely healthy throughout, and the cluster still went to zero writable primaries, because etcd's quorum requirement (2-of-3) became mathematically unreachable.

The cluster made the *correct* choice — safe-unavailable rather than risking split-brain — with zero writes lost. But it's a real limitation worth naming plainly: **a healthy database doesn't help if the consensus layer it depends on is unreachable.**

This finding is documented in the project's architectural notes (Section 12.1) with three mitigations under consideration:
- etcd witness nodes
- Decouple DCS failure domain
- 5-node etcd topology

---

## 9. Test 4 — Durable False-Positive Logging (Soak Instrumentation)

Rather than running one more discrete fault, this test built the logging infrastructure needed for longer-term, real-world observation: an **append-only event log** and **Prometheus counters** tracking every leader election and every "read-only leader" event.

The smoke test for this instrumentation immediately found a second real bug: the detection check itself had a blind spot — a timed-out health probe defaulted to reporting "healthy" instead of flagging the ambiguous state, which is precisely the false-positive class the whole exercise exists to catch.

**Fixed and reverified.**

---

## 10. A Live Discovery During Manual Verification

While manually verifying a planned switchover (not a crash-triggered failover — a deliberate, graceful handoff), a further gap surfaced:

**pgpool has no active signal when Patroni performs a *clean* switchover.** Its failover-detection script only fires when a backend goes *down*, so it relies on periodic polling to notice the primary changed.

In one observed run this produced roughly a **4-minute write-availability gap** — far worse than the ~40-second crash-failover number, and directly contradicting an internal claim that planned switchover was "zero downtime."

That fix (an active notification hook vs. tighter polling) and a corrected, honestly-worded doc claim are in progress as of this writing.

---

## 11. Honest Current Status

| Area | Status | Notes |
|------|--------|-------|
| False-positive promotion (network partition) | **Fixed & verified** | 31s promotion, 140/140 writes survived re-run |
| Data loss on async promotion | **Validated** | Zero lost commits across all fault scenarios |
| Split-brain prevention | **Validated** | 0 events across 3,600+ probes |
| Crash failover time | **~40s median** | Consistent across 5 clean-kill iterations |
| **DCS (etcd) as write-availability SPOF** | **Open — known limitation** | 2/3 PG nodes healthy, 0 writable primaries |
| **Planned switchover detection lag** | **Open — ~4 min gap** | pgpool polls; active notification hook WIP |
| Long-duration soak (weeks) | **Not yet completed** | Instrumentation ready; needs calendar time |

**The honest bottom line:** Two genuine, previously-unknown bugs were found and fixed through this process — a materially better outcome than an all-green test run would have been, because it demonstrates the testing methodology itself catches the failure modes that matter, not just the easy ones.

The architecture is meaningfully closer to a credible production candidate than when this process started, but it is **not** being pitched as "just switch now." The honest state:

- The exact fears the production team raised (false positives, data loss) were directly tested and answered well
- A real architectural gap (DCS SPOF) and a real performance gap (switchover detection lag) are known, named, and being worked on rather than hidden
- A longer real-world soak period is still the right bar before calling this fully done

---

## 12. What's Next

1. **Switchover notification hook** — Replace pgpool's polling with an active Patroni → pgpool signal on clean switchover (target: sub-10s detection)
2. **Extended soak** — Run the instrumented cluster under production-like load for 2–4 weeks with the event log and Prometheus counters active
3. **etcd topology decision** — Evaluate the three mitigations for the DCS SPOF (witness nodes, decoupled failure domain, 5-node etcd) and pick one for the next validation cycle
4. **Documentation alignment** — Update all internal runbooks to reflect the *actual* measured numbers (31s partition recovery, 40s crash failover, 4 min switchover gap) instead of aspirational claims

The journey continues. The goal was never a green checkbox — it was earning the production team's trust with evidence. That trust is built on the bugs we found, not the ones we didn't.

---

*This post documents work done in the `patroni-pgpool-ansible` repository and associated testing harnesses. The test scripts, Ansible playbooks, and fault-injection tooling are available in the project workspace. If you're evaluating a similar architecture, the asymmetric partition test (Test 2) and the DCS SPOF finding (Test 3) are the two highest-value areas to replicate in your own environment.*