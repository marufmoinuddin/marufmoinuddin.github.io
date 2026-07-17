---
layout: post
title: Backup Schedule Template
date: 2025-01-02
category: Database
tags: [backup, pgbackrest, postgresql]
excerpt: Generic template outlining steps to manage and schedule pgBackRest backups for a PostgreSQL cluster. Replace placeholders as needed.
read_time: 1
source_doc: Backup_Schedule_Template.md
draft_import: true
---
# Backup Schedule Template

## Overview
This template outlines steps to manage and schedule backups for a PostgreSQL cluster using `pgBackRest` (via an operator such as the Crunchy PostgreSQL Operator). Replace placeholders like `<DB_NAME>`, `<NAMESPACE>`, `<POD_NAME>` and `<SCHEDULE_NAME>` with values for your environment.

## Check existing backups
List backups stored in the repository:

### Command
```bash
pgo show backup <DB_NAME> -n <NAMESPACE>
```

## Ensure pod labels
Apply or verify labels on database pods so backup jobs can target them correctly.

### Example commands
```bash
# Label a primary pod
kubectl -n <NAMESPACE> label --overwrite pod <PRIMARY_POD_NAME> service-name=<DB_SERVICE_NAME>

# Label a replica pod
kubectl -n <NAMESPACE> label --overwrite pod <REPLICA_POD_NAME> service-name=<DB_SERVICE_NAME>-replica
```

## Delete an existing backup schedule (optional)
If a conflicting schedule exists, delete it before creating a new one.

### Example command
```bash
# pgo delete schedule --schedule-name=<SCHEDULE_NAME> -n <NAMESPACE>
```

## Create a full backup
Trigger a full backup now. Adjust retention settings to match your policy.

### Example command
```bash
pgo backup <DB_NAME> --backup-opts="--type=full --repo1-retention-full=3" -n <NAMESPACE>
```

Adjust `--repo1-retention-full` to the number of full backups you want to retain.

## Reapply labels after backup (if needed)
Some workflows temporarily modify labels; reapply them to preserve service discovery.

### Example commands
```bash
kubectl -n <NAMESPACE> label --overwrite pod <PRIMARY_POD_NAME> service-name=<DB_SERVICE_NAME>
kubectl -n <NAMESPACE> label --overwrite pod <REPLICA_POD_NAME> service-name=<DB_SERVICE_NAME>-replica
```

## Create an automated backup schedule
Create a cron-based schedule for pgBackRest backups. Change the cron expression and options as required.

### Example command (daily full backup at 18:37 UTC)
```bash
pgo create schedule --schedule="37 18 * * *" \
	--schedule-type=pgbackrest \
	--pgbackrest-backup-type=full \
	--schedule-opts="--repo1-retention-full=3" \
	<DB_NAME> -n <NAMESPACE>
```

## Restart Patroni instances (if applicable)
If your cluster uses Patroni and you need to restart instances, use `patronictl` via `kubectl exec`.

### Example commands
```bash
kubectl exec -it -n <NAMESPACE> <POD_NAME> -- patronictl restart <CLUSTER_NAME> <POD_NAME>
kubectl exec -it -n <NAMESPACE> <REPLICA_POD_NAME> -- patronictl restart <CLUSTER_NAME> <REPLICA_POD_NAME>
```

## Notes and recommendations
- Test restores regularly to validate backup integrity and recovery procedures.
- Ensure the operator and `pgo` client versions are compatible with your cluster.
- Verify RBAC permissions for the user running `pgo` and `kubectl` commands.
- Monitor backup jobs and repository storage usage; adjust retention and schedules to balance recovery objectives and storage costs.

Replace placeholders and examples with the concrete values from your environment before running these commands.

