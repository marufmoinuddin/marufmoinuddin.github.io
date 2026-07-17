---
layout: post
title: "FAQ Document: Database and Backup Alerts Troubleshooting (Updated with PGO Crunchy FAQs)"
date: 2025-07-08
category: PostgreSQL
tags: [backup, kubernetes, postgresql, rsync]
excerpt: "This FAQ document provides guidance on resolving common database, replication, and backup alerts, including additional scenarios specific to the Crunchy Data PostgreSQL Operator (PGO). Follow the instructions carefully…"
read_time: 8
source_doc: 39_FAQ_UPAY_DBA.md
draft_import: true
---
# FAQ Document: Database and Backup Alerts Troubleshooting (Updated with PGO Crunchy FAQs)

This FAQ document provides guidance on resolving common database, replication, and backup alerts, including additional scenarios specific to the Crunchy Data PostgreSQL Operator (PGO). Follow the instructions carefully to address each issue.

---

## Table of Contents

1. [Database Alert: Pod in Error State](#1-database-alert-pod-in-error-state)
2. [Database Alert: Container Status Unknown](#2-database-alert-container-status-unknown)
3. [Backup Alert: Missing or Old Backup](#3-backup-alert-missing-or-old-backup)
4. [DB Replication Alert: Replica Lag](#4-db-replication-alert-replica-lag)
5. [PGO Crunchy: High CPU Usage on Primary Pod](#5-pgo-crunchy-high-cpu-usage-on-primary-pod)
6. [PGO Crunchy: Failed to Create New Replica](#6-pgo-crunchy-failed-to-create-new-replica)
7. [PGO Crunchy: Backup Job Stuck in Pending State](#7-pgo-crunchy-backup-job-stuck-in-pending-state)
8. [PGO Crunchy: WAL Archiving Failure](#8-pgo-crunchy-wal-archiving-failure)

---

## 1. Database Alert: Pod in Error State

**Details:**

- **Timestamp:** 2025-04-09 07:00:03
- **Total Master DBs:** 117
- **Errors:** 2
- **Affected Pod Details:**
  - **Name:** nakadi-repo1-full
  - **Pod:** nakadi-repo1-full-29068975-fdnds
  - **Ready:** 0/1
  - **Status:** Error
  - **Restart Count:** 0
  - **Age:** 6h4m
  - **IP:** <pod-ip>
  - **Node:** <worker-node-hostname>

**Explanation:**
The pod `nakadi-repo1-full-29068975-fdnds` is in an error state (not ready, 0 restart count), which may indicate application failure or resource constraints. This could be due to insufficient resources, configuration issues, or application errors, potentially causing service disruption.

**Solution:**
Delete the affected pod to resolve the error state and allow Kubernetes to recreate it.

**Steps:**

1. Open a terminal or command-line interface with `kubectl` access to the cluster.
2. Run the following command to delete the pod:
   ```
   kubectl delete pod nakadi-repo1-full-29068975-fdnds
   ```
3. Verify that a new pod is automatically recreated by Kubernetes:
   ```
   kubectl get pods -l app=nakadi-repo1-full
   ```
4. Check the status of the new pod to ensure it is in a `Running` state and `Ready: 1/1`.

---

## 2. Database Alert: Container Status Unknown

**Details:**

- **Timestamp:** 2025-04-08 11:30:03
- **Total Master DBs:** 117
- **Errors:** 1
- **Affected Pod Details:**
  - **Name:** merchantfundtransfer-rsync-hqreplica
  - **Pod:** merchantfundtransfer-rsync-hqreplica-846c8dd6-t5zt6
  - **Ready:** 0/1
  - **Status:** ContainerStatusUnknown
  - **Restart Count:** 1
  - **Age:** 18d
  - **IP:** <none>
  - **Node:** <worker-node-hostname>

**Solution:**
Attempt the following steps in order to resolve the issue.

### Attempt 1: Restart the Deployment
In some cases, simply restarting the deployment can resolve the issue.

1. Open a terminal with `kubectl` access to the cluster.
2. Restart the deployment to trigger a pod recreation:
   ```
   kubectl rollout restart deployment merchantfundtransfer-rsync-hqreplica
   ```
3. Check the status of the pods:
   ```
   kubectl get pods -l app=merchantfundtransfer-rsync-hqreplica
   ```
4. If the pod status becomes `Running` and `Ready: 1/1`, the issue is resolved. If not, proceed to Attempt 2.

### Attempt 2: Delete and Reapply the YAML
If the pod remains in an unknown state, you may need to delete and reapply the original YAML configuration.

1. Delete the deployment:
   ```
   kubectl delete deployment merchantfundtransfer-rsync-hqreplica
   ```
2. Reapply the original YAML configuration file (ensure you have the correct YAML file available):
   ```
   kubectl apply -f merchantfundtransfer-rsync-hqreplica.yaml
   ```
3. Verify the new pod is running:
   ```
   kubectl get pods -l app=merchantfundtransfer-rsync-hqreplica
   ```

---

## 3. Backup Alert: Missing or Old Backup

**Details:**

- **Timestamp:** 2025-04-08 08:30:53
- **Backups Done:** 116
- **Missing/Old:** 1
- **Affected Cluster Details:**
  - **Cluster:** banglalinkussd
  - **Backup Status:** 20250406-202522F (1 day old)

**Explanation:**
The backup for the `banglalinkussd` cluster is either missing or outdated (older than 1 day). This could be due to a failed backup job, misconfiguration, or resource constraints.

**Solution:**
Check if the backup process is still running by inspecting the corresponding backup pod.

**Steps:**

1. Open a terminal with `kubectl` access to the cluster.
2. List the backup pods associated with the `banglalinkussd` cluster:
   ```
   kubectl get pods -l cluster=banglalinkussd,role=backup
   ```
3. Look for a pod with a status of `Running` instead of `Completed`. If found, the backup is still in progress—monitor it until completion:
   ```
   kubectl describe pod <backup-pod-name>
   ```
4. If no backup pod is running, investigate further (e.g., check backup logs or cronjob schedules) to determine why the backup is missing or outdated.

---

## 4. DB Replication Alert: Replica Lag

**Details:**

- **Timestamp:** 2025-04-04 09:00:34
- **Replicas with Lag:** 1
- **Affected Pod Details:**
  - **Pod:** banglalinkussd-cluster-l7p8-0
  - **Lag:** 16 MB

**Explanation:**
The replica `banglalinkussd-cluster-l7p8-0` is experiencing replication lag of 16 MB, which may indicate network issues, high load on the primary, or resource constraints on the replica.

**Solution:**
Monitor the replication lag and take action if it increases. The action may involve reducing the number of replicas temporarily to allow the remaining replica to catch up.

**Steps:**

1. Access the pod to check the current lag:
   ```
   kubectl exec -it banglalinkussd-cluster-l7p8-0 -- patronictl list
   ```
2. Review the output to confirm the lag value for the replica. If the lag is increasing over time, proceed with the next steps.
3. Reduce the number of replicas to 1 to remove the lagging replica:
   ```
   kubectl patch postgrescluster.postgres-operator.crunchydata.com -n prod-db --type='json' -p='[{"op": "replace", "path": "/spec/instances/0/replicas", "value":1}]' banglalinkussd
   ```
4. Wait for the cluster to stabilize, then verify the replica count:
   ```
   kubectl get postgrescluster -n prod-db banglalinkussd -o jsonpath='{.spec.instances[0].replicas}'
   ```
5. Increase the replica count back to 2:
   ```
   kubectl patch postgrescluster.postgres-operator.crunchydata.com -n prod-db --type='json' -p='[{"op": "replace", "path": "/spec/instances/0/replicas", "value":2}]' banglalinkussd
   ```
6. Confirm the new replica is running and lag is resolved:
   ```
   kubectl exec -it banglalinkussd-cluster-l7p8-0 -- patronictl list
   ```

---

## 5. PGO Crunchy: High CPU Usage on Primary Pod

**Details:**

- **Timestamp:** 2025-04-10 14:15:22
- **Cluster:** flds
- **Affected Pod Details:**
  - **Pod:** flds-cluster-5f7d9c8b-kj9p2
  - **Status:** Running
  - **CPU Usage:** 95% (exceeding threshold of 80%)
  - **Memory Usage:** Normal
  - **Node:** <worker-node-hostname>

**Explanation:**
The primary pod `flds-cluster-5f7d9c8b-kj9p2` is experiencing high CPU usage (95%), which may indicate a performance issue, such as long-running queries or insufficient resources allocated to the pod. This could lead to degraded performance for the database cluster and impact application functionality.

**Solution:**
Investigate the high CPU usage and scale resources if necessary.

**Steps:**

1. Look for the master pod:
   ```
   kubectl get pods -n prod-db  -l postgres-operator.crunchydata.com/role=master,postgres-operator.crunchydata.com/cluster=flds
   ```
2. Check the pod logs for unusual activity:
   ```
   kubectl logs flds-cluster-5f7d9c8b-kj9p2 -n prod-db
   ```
3. Exec into the pod and run `patronictl list` to verify the primary status and active queries:
   ```
   kubectl exec -it flds-cluster-5f7d9c8b-kj9p2 -n prod-db -- patronictl list
   ```
4. Identify long-running queries using:
   ```
   kubectl exec -it flds-cluster-5f7d9c8b-kj9p2 -n prod-db -- psql -U postgres -c "SELECT pid, query, state, wait_event FROM pg_stat_activity WHERE state = 'active';"
   ```
5. If a specific query is causing the issue, terminate it:
   ```
   kubectl exec -it flds-cluster-5f7d9c8b-kj9p2 -n prod-db -- psql -U postgres -c "SELECT pg_terminate_backend(<pid>);"
   ```
6. If CPU usage remains high due to workload, scale the primary pod’s resources by editing the PostgresCluster spec:
   ```
   kubectl edit postgrescluster flds -n prod-db
   ```
   - Update the `resources` section under `spec.instances[0]`:
     ```yaml
     resources:
       requests:
         cpu: "2"
         memory: "4Gi"
       limits:
         cpu: "4"
         memory: "8Gi"
     ```
7. Apply the changes and monitor CPU usage:
   ```
   kubectl top pod flds-cluster-5f7d9c8b-kj9p2 -n prod-db
   ```

---

## 6. PGO Crunchy: Failed to Create New Replica

**Details:**

- **Timestamp:** 2025-04-11 09:45:12
- **Cluster:** amexpg
- **Event:** Replica creation failed
- **Error Message:** "Pod amexpg-cluster-7d8f9c4b-mn5k3 in CrashLoopBackOff"
- **Affected Pod Details:**
  - **Pod:** amexpg-cluster-7d8f9c4b-mn5k3
  - **Status:** CrashLoopBackOff
  - **Restart Count:** 5
  - **Node:** <worker-node-hostname>

**Explanation:**
The replica pod `amexpg-cluster-7d8f9c4b-mn5k3` is in a `CrashLoopBackOff` state, indicating repeated failures during startup. This could be due to misconfiguration, resource constraints, or issues with the primary pod.

**Solution:**
Diagnose the crash and recreate the replica. If the issue persists, check the primary pod's WAL sender status.

**Steps:**

1. Check the pod logs for the root cause:
   ```
   kubectl logs amexpg-cluster-7d8f9c4b-mn5k3 -n prod-db
   ```
2. Describe the pod to identify events or resource issues:
   ```
   kubectl describe pod amexpg-cluster-7d8f9c4b-mn5k3 -n prod-db
   ```
3. If the issue is due to misconfiguration (e.g., WAL sync failure), delete the failing pod:
   ```
   kubectl delete pod amexpg-cluster-7d8f9c4b-mn5k3 -n prod-db
   ```
4. Verify that PGO recreates the replica:
   ```
   kubectl get pods -l postgres-operator.crunchydata.com/cluster=amexpg -n prod-db
   ```
5. If the replica continues to fail, check the primary’s WAL sender status:
   ```
   kubectl exec -it amexpg-primary-6g5h8j9k-lp2m3 -n prod-db -- psql -U postgres -c "SELECT * FROM pg_stat_replication;"
   ```
6. If necessary, temporarily reduce replicas to stabilize, then increase again:
   ```
   kubectl patch postgrescluster amexpg -n prod-db --type='json' -p='[{"op": "replace", "path": "/spec/instances/0/replicas", "value":1}]'
   ```
   After stabilization:
   ```
   kubectl patch postgrescluster amexpg -n prod-db --type='json' -p='[{"op": "replace", "path": "/spec/instances/0/replicas", "value":2}]'
   ```

---

## 7. PGO Crunchy: Backup Job Stuck in Pending State

**Details:**

- **Timestamp:** 2025-04-12 03:10:45
- **Cluster:** seblbanktransfer
- **Backup Job:** seblbanktransfer-backup-20250412-0310
- **Status:** Pending
- **Reason:** "Insufficient resources or PVC binding failure"

**Explanation:**
The backup job `seblbanktransfer-backup-20250412-0310` is stuck in a pending state, indicating that it cannot be scheduled due to insufficient resources or issues with the Persistent Volume Claim (PVC) binding.

**Solution:**
Resolve resource constraints or Persistent Volume Claim (PVC) issues.

**Steps:**

1. Check the backup job status:
   ```
   kubectl get job seblbanktransfer-backup-20250412-0310 -n prod-db
   ```
2. Describe the job to identify the issue:
   ```
   kubectl describe job seblbanktransfer-backup-20250412-0310 -n prod-db
   ```
3. If the pod is stuck due to resource limits, check node capacity:
   ```
   kubectl top nodes
   ```
4. If a PVC issue is reported, verify the PVC status:
   ```
   kubectl get pvc -l postgres-operator.crunchydata.com/cluster=seblbanktransfer -n prod-db
   ```
5. If the PVC is not bound, ensure the storage class and capacity match the requirements, then delete and recreate the job:
   ```
   kubectl delete job seblbanktransfer-backup-20250412-0310 -n prod-db
   ```
6. Trigger a new backup manually via the PostgresCluster spec:
   ```
    kubectl-pgo backup --repoName="repo1" --options="--type=full" -n prod-db seblbanktransfer
   ```
7. Monitor the new backup job:
   ```
   kubectl get jobs -n prod-db
   ```

---

## 8. PGO Crunchy: WAL Archiving Failure

## 8. PGO Crunchy: WAL Archiving Failure

**Details:**

- **Timestamp:** 2025-04-13 06:20:15
- **Cluster:** spinthewheel
- **Alert:** WAL archiving failed
- **Error Message:** "archive_command failed: could not connect to S3 bucket"
- **Affected Pod:** spinthewheel-cluster-8k9j5h7d-pq3m4

**Explanation:**
The Write-Ahead Log (WAL) archiving process is failing for the `spinthewheel` cluster. WAL files are critical for point-in-time recovery and replication. The error indicates connectivity issues with the storage destination, affecting backup integrity and potentially causing disk space issues if WALs accumulate.

**Solution:**
Diagnose and fix the WAL archiving configuration.

**Steps:**

1. Check the primary pod logs for detailed errors:
    ```
    kubectl logs spinthewheel-cluster-8k9j5h7d-pq3m4 -n prod-db
    ```
2. Verify the `pgBackRest` configuration in the PostgresCluster spec:
    ```
    kubectl get postgrescluster spinthewheel -n prod-db -o yaml | grep -A 15 pgbackrest
    ```
3. Check the storage configuration and permissions:
    ```
    kubectl get pvc -l postgres-operator.crunchydata.com/cluster=spinthewheel -n prod-db
    ```
4. Ensure the storage volume has sufficient space:
    ```
    kubectl exec -it spinthewheel-cluster-8k9j5h7d-pq3m4 -n prod-db -- df -h
    ```
5. Review PostgreSQL configuration for WAL archiving settings:
    ```
    kubectl exec -it spinthewheel-cluster-8k9j5h7d-pq3m4 -n prod-db -- psql -U postgres -c "SHOW archive_command;"
    ```
6. Check the status of recent WAL archives:
    ```
    kubectl exec -it spinthewheel-cluster-8k9j5h7d-pq3m4 -n prod-db -- psql -U postgres -c "SELECT * FROM pg_stat_archiver;"
    ```
7. Restart the pgBackRest repository host pod to reset connections:
    ```
    kubectl delete pod spinthewheel-repo-host -n prod-db
    ```
8. Monitor archiving status after changes:
    ```
    kubectl exec -it spinthewheel-cluster-8k9j5h7d-pq3m4 -n prod-db -- psql -U postgres -c "SELECT pg_walfile_name(pg_current_wal_lsn()), pg_walfile_name(pg_last_wal_receive_lsn()), pg_walfile_name(pg_last_wal_replay_lsn());"
    ```
