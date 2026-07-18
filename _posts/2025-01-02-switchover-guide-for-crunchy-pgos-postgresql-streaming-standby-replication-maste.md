---
layout: post
title: "Switchover Guide for Crunchy PGO's PostgreSQL Streaming Standby Replication (Master ↔ Standby)"
date: 2025-01-02
category: PostgreSQL
tags: [high-availability, kubernetes, patroni, postgresql, streaming-replication]
excerpt: This guide explains how to perform a switchover between a PostgreSQL Master Cluster (primary) and Standby Cluster (replica). The switchover involves making the current Standby the new Master and the current Master the…
read_time: 3
source_doc: 10_Streaming_Switchover.md
draft_import: true
---
# Switchover Guide for Crunchy PGO's PostgreSQL Streaming Standby Replication (Master ↔ Standby)

## Overview

This guide explains how to perform a switchover between a PostgreSQL **Master Cluster** (primary) and **Standby Cluster** (replica). The switchover involves making the **current Standby the new Master** and the **current Master the new Standby**, ensuring seamless replication and high availability.

> [!NOTE] 
> We will use **NodePorts** for communication between clusters and ensure both clusters use the same **TLS certificates** for secure communication. Follow each step carefully, as some downtime is required to avoid issues like **split-brain syndrome**.

---

## Step-by-Step Explanation

### What is a Switchover?

A **switchover** is a planned event where the **Master** and **Standby** PostgreSQL clusters exchange roles:
- The **Standby Cluster** becomes the new **Master**.
- The **Master Cluster** becomes the new **Standby**.

**Why do this?**
- To test disaster recovery.
- To perform maintenance on the current Master.
- To balance the load between clusters.

### Prerequisites

1. Two PostgreSQL clusters running in **Kubernetes**:
   - One acting as **Master** (we'll call it `primary-cluster`).
   - Another as **Standby** (we'll call it `replica-cluster`).

2. Both clusters are using:
   - **TLS certificates** for secure communication.
   - **NodePorts** to allow external communication.

3. Downtime is acceptable for disconnecting the database service temporarily.

---

### Step 1: Prepare NodePorts for Both Clusters

**What are NodePorts?**  
NodePorts expose a Kubernetes service on a specific port, making it accessible outside the cluster.

#### Expose the Master Cluster
Run the following command to expose the **Master Cluster's high-availability service**:
```bash
kubectl expose svc primary-cluster-ha \
  --port=5432 --target-port=5432 \
  --name=primary-cluster-ha-nodeport \
  --type=NodePort \
  --selector=postgres-operator.crunchydata.com/patroni=primary-cluster-ha \
  -n db-ns
```

**Explanation**:
- `--port=5432`: The external port.
- `--target-port=5432`: The port inside the service.
- `--name=primary-cluster-ha-nodeport`: The name of the NodePort service.
- `--type=NodePort`: Exposes the service as NodePort.
- `--selector`: Matches the **primary cluster pods**.

#### Expose the Standby Cluster
Run a similar command for the **Standby Cluster**:
```bash
kubectl expose svc replica-cluster-ha \
  --port=5432 --target-port=5432 \
  --name=replica-cluster-ha-nodeport \
  --type=NodePort \
  --selector=postgres-operator.crunchydata.com/patroni=replica-cluster-ha \
  -n db-ns
```

---

### Step 2: Check Connectivity Between Clusters

Verify that both clusters can communicate using the exposed NodePorts.

1. Retrieve the NodePort numbers:
   ```bash
   kubectl get svc -n db-ns | grep nodeport
   ```
   Example output:
   ```
   primary-cluster-ha-nodeport  NodePort   5432:32000/TCP  ...
   replica-cluster-ha-nodeport  NodePort   5432:32001/TCP  ...
   ```

2. Ensure both clusters can ping each other:
   - From the Master:
     ```bash
     psql -h <node-ip-of-standby> -p <nodeport-of-standby>
     ```
   - From the Standby:
     ```bash
     psql -h <node-ip-of-master> -p <nodeport-of-master>
     ```

---

### Step 3: Disconnect the Database Service

To avoid **split-brain syndrome** (both clusters acting as Masters), **temporarily stop database service connections**:
- Update application configurations to prevent writes during the switchover.
- Notify your team about the downtime.

---

### Step 4: Change Standby to Master

Modify the **replica-cluster** YAML to make it the **Master**:

#### Edit the YAML
Locate the `standby` section and change `enabled` to `false`:
```yaml
standby:
  enabled: false
```

#### Apply the Changes
```bash
kubectl apply -f replica-cluster.yaml
```

---

### Step 5: Change Master to Standby

Modify the **primary-cluster** YAML to make it the **Standby**:

#### Edit the YAML
Add or modify the `standby` section:
```yaml
standby:
  enabled: true
  host: <node-ip-of-replica-cluster>
  port: <nodeport-of-replica-cluster>
```

#### Apply the Changes
```bash
kubectl apply -f primary-cluster.yaml
```

---

### Step 6: Verify the Switchover

1. Confirm the **replica-cluster** is now the Master:
   ```bash
   psql -h <node-ip-of-replica-cluster> -p <nodeport-of-replica-cluster> -c "SELECT pg_is_in_recovery();"
   ```
   Output should be:
   ```
   pg_is_in_recovery
   -----------------
   f
   ```

2. Confirm the **primary-cluster** is now the Standby:
   ```bash
   psql -h <node-ip-of-primary-cluster> -p <nodeport-of-primary-cluster> -c "SELECT pg_is_in_recovery();"
   ```
   Output should be:
   ```
   pg_is_in_recovery
   -----------------
   t
   ```

---

### Step 7: Resume Database Services

Reconnect your application to the new **Master Cluster** (`replica-cluster`). Test the application thoroughly to ensure everything is working as expected.

---

## Summary

1. Exposed both clusters using NodePorts for external communication.
2. Temporarily disconnected database services to prevent split-brain.
3. Modified configurations to swap Master and Standby roles.
4. Verified the switchover was successful and resumed services.

By following these steps, we can perform a successful Streaming Standby PostgreSQL switchover! 🚀
