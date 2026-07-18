---
layout: post
title: Backup Schedule Template in PGO Crunchy PostgreSQL Operator — Detailed Guide
date: 2025-01-02
category: Database
tags: [backup, pgbackrest, postgresql]
excerpt: Detailed guide explaining the rationale behind each step of managing and scheduling pgBackRest backups for a PostgreSQL PGO Crunchy cluster. Replace placeholders as needed.
read_time: 5
source_doc: Backup_Schedule_Template.md
draft_import: true
---
# Backup Schedule Template — Detailed Guide

## Overview

### Why this template exists
Database backups are your safety net. Without them, a corrupted database, accidental `DROP TABLE`, or a failed storage volume means **permanent data loss**. This template walks through the complete lifecycle of managing `pgBackRest` backups for a PostgreSQL cluster managed by the Crunchy PostgreSQL Operator (or a similar operator).

`pgBackRest` is a dedicated backup and restore tool for PostgreSQL. It supports:
- **Full backups** — a complete copy of the entire database cluster.
- **Incremental backups** — only the data changed since the last backup (any type), saving storage and time.
- **Differential backups** — only the data changed since the last **full** backup (a middle ground).

The Crunchy PostgreSQL Operator abstracts some of `pgBackRest`'s complexity via the `pgo` CLI, but understanding what each command does — and **why** — is essential to avoid accidentally removing backups, misconfiguring retention, or breaking the cluster's ability to restore.

### Key concepts to understand first

| Concept | Why it matters |
|---|---|
| **Retention policy** | Controls how many full backups are kept. Too few and you lose restore history; too many and you fill your backup repository. |
| **Backup repository** | The storage location (e.g., S3 bucket, NFS volume, local PV) where backup files live. |
| **Cron schedule** | Automates backups so you don't rely on manual intervention. A missed manual backup = a gap in your recovery window. |
| **Pod labels** | The operator uses Kubernetes labels to discover which pods belong to a database cluster. |
| **Patroni restart** | In HA setups, Patroni manages leader election and replica synchronization. Restarting an instance can be needed for config changes or recovery. |

---

## 1. Check existing backups

### Why you need to check before making changes
Before modifying any backup configuration, you must understand the **current state** of your backup repository. Checking existing backups answers critical questions:

1. **Is there a recent valid backup?** If yes, you have a safety net before making changes. If no, create one first (see Section 4).
2. **How much space is the repository using?** Helps you decide retention settings.
3. **What backup types exist?** You may see full, incremental, and differential backups with different timestamps.
4. **Are there any failed or incomplete backups?** These may need manual cleanup.

### Command
```bash
pgo show backup <DB_NAME> -n <NAMESPACE>
```

**What this does:** Queries the `pgBackRest` repository (via the operator) and lists every stored backup with its type, timestamp, size, and retention status.

**Example output interpretation:**
```
Stanza: mydb
    full backup: 20250101-120000F -> repo1 (size: 2.4GB, archive: WAL segments)
    incr backup: 20250101-180000I -> repo1 (size: 350MB, archive: WAL segments)
    full backup: 20241225-120000F -> repo1 (size: 2.3GB, archive: WAL segments)
```
- `full backup 20250101-120000F` — a full backup taken Jan 1st at 12:00 UTC.
- `incr backup 20250101-180000I` — an incremental backup taken later that day (much smaller).
- The older full backup may be kept or pruned depending on retention.

### What to look for
- **Staleness:** If the latest backup is more than a week old, you have a large recovery gap.
- **Incomplete backups:** Check the operator logs if backups show as "running" for too long.
- **Repository location:** Confirm the backup is going to the expected target (S3, NFS, etc.).

---

## 2. Ensure pod labels

### Why labels are critical for backup operations
The Crunchy PostgreSQL Operator uses **Kubernetes labels** to associate pods with a database cluster. The `pgo` CLI (and the operator's internal controllers) rely on these labels to:

- **Discover which pod to back up from** — the operator needs to connect to a running PostgreSQL instance (usually the primary) to perform the backup.
- **Route backup jobs** — the operator schedules a backup Job that targets the pod matching the label selector.
- **Service discovery** — internal Services (like `<DB_NAME>-primary` and `<DB_NAME>-replica`) use label selectors to route traffic.

If the labels are missing or wrong, the backup job may:
- Fail with "no matching pod found."
- Accidentally target the wrong pod (e.g., a replica instead of the primary), which can cause backup corruption or inconsistent data.
- Produce no error at all but back up from a stale or read-only replica, yielding an inconsistent snapshot.

### When labels can get lost
Labels can be stripped or overwritten by:
- Rolling updates or pod restarts.
- Manual `kubectl label` operations that replace the entire label set.
- Cluster scaling events (adding/removing replicas).
- Some automated tools or scripts that clean up labels.

### Example commands
```bash
# Label a primary pod
kubectl -n <NAMESPACE> label --overwrite pod <PRIMARY_POD_NAME> service-name=<DB_SERVICE_NAME>

# Label a replica pod
kubectl -n <NAMESPACE> label --overwrite pod <REPLICA_POD_NAME> service-name=<DB_SERVICE_NAME>-replica
```

**Breaking down the command:**
- `--overwrite` — forces the label to be set even if it already exists (idempotent).
- `service-name=<value>` — this is the specific label the operator uses to match pods to a cluster Service. The exact key may vary by operator version; check your operator documentation.
- `<PRIMARY_POD_NAME>` / `<REPLICA_POD_NAME>` — get these from `kubectl get pods -n <NAMESPACE> -l <cluster-selector>`.

> **Before skipping this step**, verify current labels:
> ```bash
> kubectl -n <NAMESPACE> get pods --show-labels | grep <DB_NAME>
> ```
> If the `service-name` label is already present and correct, you can skip this section.

---

## 3. Delete an existing backup schedule (optional)

### Why you might need to delete a schedule
A conflicting or outdated schedule can cause:
- **Duplicate backups** — two schedules triggering backups at overlapping times, straining the database and filling the repository.
- **Conflicting retention policies** — one schedule may set `--repo1-retention-full=3` while another sets `--repo1-retention-full=7`, leading to unpredictable behavior.
- **Changed business requirements** — you may need to replace a daily schedule with a different time or frequency.

The `pgo delete schedule` command **only removes the cron trigger** — it does **not** delete any existing backup files. Your stored backups remain safe in the repository.

### How to check for existing schedules first
```bash
pgo show schedule <DB_NAME> -n <NAMESPACE>
```
This lists all active cron schedules for the cluster. Each schedule has a name, a cron expression, a type (pgbackrest), and options. If you find one you want to replace, note its name.

### Example command
```bash
pgo delete schedule --schedule-name=<SCHEDULE_NAME> -n <NAMESPACE>
```

**What happens after deletion:**
1. The operator removes the CronJob resource from Kubernetes.
2. No new backup jobs will be triggered by this schedule.
3. Any currently running backup job will complete (it won't be killed).
4. Existing backup files in the repository are **untouched**.

> ⚠️ **You cannot undo this with `pgo`.** If you delete a schedule by accident, you must recreate it from scratch. Always verify the schedule name before running this command.

---

## 4. Create a full backup (manual on-demand)

### Why trigger a full backup manually?
Before you set up an automated schedule, you should **immediately establish a known-good restore point**. Reasons:

1. **Safety checkpoint** — If something goes wrong while configuring the schedule (e.g., a typo in retention flags), you have a fallback.
2. **Cold start** — If the cluster has no existing backups, this is your first line of defense.
3. **Change validation** — Verifying that the backup repository credentials, network path, and storage are all working correctly **before** the automation starts running nightly.
4. **WAL archive baseline** — A full backup resets the WAL (Write-Ahead Log) archive baseline, making future point-in-time recovery (PITR) more efficient.

### Understanding backup types

| Type | What it contains | Size | Restore dependency |
|---|---|---|---|
| **Full** | Entire database cluster | Largest | Standalone — no other backup needed |
| **Differential** | Changes since last full | Medium | Requires the latest full backup |
| **Incremental** | Changes since any last backup | Smallest | Requires all prior backups in the chain |

A **full backup** is the anchor of your restore chain. Without a recent full backup, restore requires replaying WAL from the beginning of time, which is impractical.

### Example command
```bash
pgo backup <DB_NAME> --backup-opts="--type=full --repo1-retention-full=3" -n <NAMESPACE>
```

**Breaking down the options:**
- `--type=full` — take a full backup (alternatives: `diff`, `incr`).
- `--repo1-retention-full=3` — keep the **3 most recent** full backups in repository 1. Older full backups (and their dependent differentials/incrementals) will be **automatically pruned** after the next successful backup. This is your **retention policy**.

### How to choose a retention value (`--repo1-retention-full=N`)

| N | Effect | Best for |
|---|---|---|
| 1 | Only the latest full backup kept | Small databases, frequent full backups, low storage cost |
| 2–3 | Keep recent history while limiting storage | **Most production databases** — balance of safety and cost |
| 4–7 | Extended history | Compliance-heavy environments, databases with slow backup windows |
| 7+ | Long restore window | Large storage budget, audit requirements |

> **Key insight:** Retention is enforced **after** the next backup completes. If you set `=3` and have 3 existing full backups, no pruning happens until the 4th full backup finishes. At that point, the oldest one is removed.

### Monitor the backup progress
```bash
pgo show backup <DB_NAME> -n <NAMESPACE>
```
Run this periodically until you see the new backup appear. Large databases can take hours for a full backup.

---

## 5. Reapply labels after backup (if needed)

### Why labels might need to be reapplied
Some operational workflows temporarily modify pod labels — for example:

- **Blue/green deployments** — labels are swapped to shift traffic, then need restoration.
- **Disaster recovery testing** — failover tests may re-label pods to simulate a new primary.
- **Manual failovers** — a Patroni switchover may change which pod is the primary, and the operator's automatic label management may not reapply immediately.
- **Operator bugs or version mismatches** — in rare cases, the operator may fail to re-label a new primary pod after a failover.

If labels are incorrect, the **next automated backup job may target a replica instead of the primary**, which can:
- Produce a backup of a read-only replica that is **lagging behind** the primary — the backup is inconsistent.
- Cause the backup job to fail entirely if the replica is configured to reject `pgBackRest` connections.

### Example commands
```bash
kubectl -n <NAMESPACE> label --overwrite pod <PRIMARY_POD_NAME> service-name=<DB_SERVICE_NAME>
kubectl -n <NAMESPACE> label --overwrite pod <REPLICA_POD_NAME> service-name=<DB_SERVICE_NAME>-replica
```

**How to verify labels are correct after applying:**
```bash
kubectl -n <NAMESPACE> get pods -l service-name=<DB_SERVICE_NAME> -o wide
kubectl -n <NAMESPACE> get pods -l service-name=<DB_SERVICE_NAME>-replica -o wide
```

Both commands should return exactly the pods you expect. If they return zero results, labels are missing.

---

## 6. Create an automated backup schedule

### Why automation is essential
Manual backups are unreliable. In production, you need **routine, predictable backups** that run without human intervention. An automated schedule ensures:

- **Consistent RPO (Recovery Point Objective)** — backups happen at regular intervals, limiting potential data loss to the window between backups.
- **No human forgetfulness** — even the most diligent engineer will miss a manual backup eventually.
- **Retention enforcement** — the schedule automatically prunes old backups based on your retention policy.
- **Compliance** — many regulations (SOC2, HIPAA, GDPR) require documented, automated backup schedules.

### Choosing a cron schedule

The cron expression `"37 18 * * *"` means **daily at 18:37 UTC**.

**How to choose the right time:**
1. **Off-peak hours** — Pick a time when database traffic is lowest (e.g., 02:00–05:00 local time). Full backups are I/O intensive and consume CPU, disk, and network.
2. **Avoid overlapping with other jobs** — Check if other cron jobs (ETL, reporting, maintenance windows) run at the same time.
3. **Consider time zones** — If your cluster spans regions, UTC is the neutral choice.
4. **Stagger with incremental backups** — If you add incremental backups later, space them so they don't overlap.

**Common frequency patterns:**

| Pattern | Cron expression | Use case |
|---|---|---|
| Daily full backup | `0 2 * * *` | Standard production |
| Weekly full + daily incr | Full: `0 2 * * 0`, Incr: `0 2 * * 1-6` | Large databases, longer backup windows |
| Twice-daily full | `0 2,14 * * *` | High-change databases, low RPO requirement |
| Every 6 hours incr | `0 */6 * * *` | Very high change rate, combined with weekly full |

### Example command (daily full backup at 18:37 UTC)
```bash
pgo create schedule --schedule="37 18 * * *" \
	--schedule-type=pgbackrest \
	--pgbackrest-backup-type=full \
	--schedule-opts="--repo1-retention-full=3" \
	<DB_NAME> -n <NAMESPACE>
```

**Breaking down the options:**
- `--schedule="37 18 * * *"` — standard cron syntax: minute, hour, day-of-month, month, day-of-week. `*` means "every."
- `--schedule-type=pgbackrest` — tells the operator this is a pgBackRest backup schedule (not, say, a `pgdump` or `sql` schedule).
- `--pgbackrest-backup-type=full` — the type of backup to take. Could also be `diff` or `incr`.
- `--schedule-opts="--repo1-retention-full=3"` — these options are passed **directly to `pgbackrest`** when the backup runs. They control retention behavior.

### How to verify the schedule was created
```bash
pgo show schedule <DB_NAME> -n <NAMESPACE>
```
You should see the new schedule listed with its cron expression, next scheduled run time, and options.

### What the operator does behind the scenes
1. Creates a Kubernetes `CronJob` resource in the same namespace.
2. The CronJob pod runs `pgbackrest` commands against the identified primary pod.
3. Backup output is stored in the configured repository (repo1, repo2 etc.).
4. On completion, retention policy is evaluated and old backups are pruned.

---

## 7. Restart Patroni instances (if applicable)

### Why you might need to restart Patroni
Patroni is a high-availability framework for PostgreSQL that manages automatic failover and replica synchronization. After making backup-related changes, you may need to restart Patroni instances if:

1. **Configuration changes** — You updated Patroni's config (e.g., `postgresql.conf` parameters, DCS settings). Patroni may not pick up all changes without a restart.
2. **Backup-related settings modified** — Changes to `archive_command`, `archive_mode`, or WAL shipping settings require a PostgreSQL reload or restart (which Patroni manages).
3. **Recovery from a failed backup** — If a backup job locked or stalled the database, restarting the Patroni-managed PostgreSQL instance can clear the issue.
4. **Manual switchover completed** — After a switchover, re-reading the cluster state ensures all nodes agree on the new leader.

### Important safety consideration
Restarting a Patroni instance **briefly interrupts PostgreSQL availability** on that pod:
- **Primary restart** — causes a **failover**: the application experiences a brief write outage (usually seconds) while a replica is promoted. **Plan this during maintenance windows.**
- **Replica restart** — no impact on writes; the replica is temporarily unavailable for reads while restarting.

### Example commands
```bash
kubectl exec -it -n <NAMESPACE> <POD_NAME> -- patronictl restart <CLUSTER_NAME> <POD_NAME>
kubectl exec -it -n <NAMESPACE> <REPLICA_POD_NAME> -- patronictl restart <CLUSTER_NAME> <REPLICA_POD_NAME>
```

**Breaking down the command:**
- `kubectl exec -it` — execute a command inside the pod interactively.
- `<POD_NAME>` — the pod running the Patroni container.
- `patronictl restart <CLUSTER_NAME> <POD_NAME>` — restarts the Patroni-managed PostgreSQL instance on that specific node. Patroni handles graceful shutdown and rejoin.

### How to check cluster health before and after restart
```bash
kubectl exec -it -n <NAMESPACE> <POD_NAME> -- patronictl list <CLUSTER_NAME>
```
This shows the current leader, replicas, and their Lag in MB. After a restart, the node should rejoin and show `Lag: 0` (or near-zero) within seconds.

---

## 8. Notes and recommendations (with rationale)

### ✅ Test restores regularly
**Why:** A backup that cannot be restored is worthless. The only way to know your backup is valid is to actually **restore it**. Schedule quarterly (or monthly) restore drills to a separate environment.

**Without this:** You discover corruption only when a real disaster hits — and by then it's too late.

### ✅ Ensure operator and `pgo` client versions are compatible
**Why:** The Crunchy PostgreSQL Operator and the `pgo` CLI evolve together. Using mismatched versions can cause:
- Backup commands to fail with "unrecognized option" errors.
- The operator to misinterpret backup options, leading to unintended retention behavior.
- Silent failures where the backup appears to succeed but produces unusable data.

**Check compatibility:**
```bash
pgo version
# Compare with the operator version deployed in the cluster.
```

### ✅ Verify RBAC permissions
**Why:** The `pgo` CLI interacts with the Kubernetes API through your `kubeconfig` context. If your user or ServiceAccount lacks permissions, commands will fail with `Forbidden` errors.

**Minimum required permissions for backup management:**
- `get`, `list`, `watch` pods, pgtasks, and pgclusters in the target namespace.
- `create`, `update`, `delete` pgbackrest schedules and backups.
- `exec` into pods (for `patronictl` commands).

**Test your permissions early:**
```bash
kubectl auth can-i create pgo.backup -n <NAMESPACE>
```

### ✅ Monitor backup jobs and repository storage
**Why:** Backup failures are often silent — the operator retries a few times and then stops reporting errors. Without active monitoring:
- You may not notice a failed backup for days or weeks.
- The repository may fill up, causing all subsequent backups to fail (a cascading failure).
- Storage costs may grow unexpectedly if retention is not enforced correctly.

**What to monitor:**
1. **Backup job status** — check `kubectl get jobs -n <NAMESPACE>` for backup-related jobs. Look for `COMPLETIONS` count.
2. **Repository storage usage** — check the S3 bucket or PV usage.
3. **WAL archive lag** — `pgBackRest` relies on WAL archiving. If WAL files aren't being shipped, backups will be stale.
4. **Operator logs** — `kubectl logs -n <NAMESPACE> deployment/pgo` — grep for "backup" and "error."

### ✅ Balance retention with storage costs
**Why:** Every retained full backup consumes storage. In a busy database, a full backup can be tens or hundreds of GB. Keeping too many backups inflates costs and may exceed repository quotas. Keeping too few compromises your ability to do point-in-time recovery (PITR) far into the past.

**A common strategy:**
- 3 full backups retained (about 3 days of history with daily fulls).
- Weekly full + daily incremental for databases larger than 100 GB.
- Archive old backups to cold storage (e.g., S3 Glacier) for compliance retention (e.g., 30 or 90 days).

### ✅ Document your recovery procedure
**Why:** When a disaster happens, stress is high. Having a documented, tested recovery runbook reduces time-to-recover (RTO) and prevents mistakes.

**Your recovery doc should include:**
1. How to identify the latest valid backup.
2. The exact `pgo restore` command for your cluster.
3. Expected restore time (based on test drills).
4. Post-restore validation steps (run a test query, check replication status).
5. Contact information for the DBA team.

---

## Placeholder reference

| Placeholder | Meaning | How to find it |
|---|---|---|
| `<DB_NAME>` | Name of your PostgreSQL cluster (e.g., `gpussdrecharge`) | `pgo show cluster` or `kubectl get pgclusters` |
| `<NAMESPACE>` | Kubernetes namespace where the cluster is deployed | `kubectl config view --minify -o jsonpath='{..namespace}'` |
| `<POD_NAME>` | Name of a database pod | `kubectl get pods -n <NAMESPACE> -l <cluster-selector>` |
| `<SCHEDULE_NAME>` | Name of a cron schedule | `pgo show schedule <DB_NAME> -n <NAMESPACE>` |
| `<PRIMARY_POD_NAME>` | The current primary pod | `pgo show cluster <DB_NAME> -n <NAMESPACE>` (look for "Primary") |
| `<REPLICA_POD_NAME>` | Any replica pod | `pgo show cluster <DB_NAME> -n <NAMESPACE>` (look for "Replica") |
| `<DB_SERVICE_NAME>` | The service name for the cluster | Usually `<DB_NAME>-primary` or `<DB_NAME>` |

---

> **Replace all placeholders with concrete values from your environment before running any command. Commands run with incorrect values may affect the wrong cluster or namespace.**

