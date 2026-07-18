---
layout: post
title: Configuration Documentation for Potential Configuration Changes for Faster Availability
date: 2025-02-10
category: PostgreSQL
tags: [high-availability, kubernetes, patroni, postgresql]
excerpt: "This document explains two specific configuration changes made to the Patroni Configuration and the PodDisruptionBudget (PDB) in the Kubernetes and PGO Crunchy setup. These settings are crucial for the database's high…"
read_time: 4
source_doc: 33_Potential_Config_Changes_For_Faster_Availibility.md
draft_import: true
---
### Configuration Documentation for Potential Configuration Changes for Faster Availability

This document explains two specific configuration changes made to the **Patroni Configuration** and the **PodDisruptionBudget (PDB)** in the Kubernetes and PGO Crunchy setup. These settings are crucial for the database's high availability, failover behavior, and overall stability. We’ll break down each section and explain what the changes do and their impact on the system.

---

### 1. **Patroni Configuration**

Patroni is an open-source tool for managing PostgreSQL clusters in a high-availability (HA) setup. The following settings are found under the **Patroni configuration** in the `PostgresCluster` resource.

#### Configuration Changes:
```yaml
patroni:
  dynamicConfiguration:
    ttl: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
```

#### Explanation:

1. **ttl (Time to Live)**:  
   - **Default Value**: 30 seconds (commonly used for health-checks)  
   - **Configured Value**: `10` seconds
   - **Purpose**: This parameter controls the time for which a Patroni node considers itself "alive" in the absence of a heartbeat. If a node does not receive a heartbeat in `ttl` seconds, it will be considered dead.  
   - **Effect**: Lowering this value means Patroni will detect failed nodes more quickly, improving cluster responsiveness but potentially increasing the risk of unnecessary failovers if heartbeats are delayed for short periods.

2. **retry_timeout**:
   - **Default Value**: 10 seconds (common in HA setups)  
   - **Configured Value**: `10` seconds
   - **Purpose**: This sets how long Patroni waits before retrying an operation after a failure (e.g., if a leader node goes down).  
   - **Effect**: Setting this value to 10 seconds ensures that Patroni will retry within 10 seconds after a failure event, such as a primary node failure.

3. **maximum_lag_on_failover**:
   - **Default Value**: `1048576` bytes (1 MB)  
   - **Configured Value**: `1048576` bytes (1 MB)
   - **Purpose**: This setting defines the maximum acceptable replication lag (in bytes) for a replica to be promoted as the new leader. If the lag exceeds this value, Patroni will not promote the replica to become the primary node, ensuring that it is up-to-date enough to take over.  
   - **Effect**: By setting this value to 1MB, you ensure that the promoted replica has at most 1MB of lag behind the old primary node, maintaining data consistency during failover.

---

### 2. **PodDisruptionBudget (PDB) Configuration**

A PodDisruptionBudget (PDB) ensures that a certain number of pods in your application (e.g., PostgreSQL instances) remain available during voluntary disruptions like node upgrades, pod terminations, or scaling activities.

#### Configuration Changes:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: alice-pdb
  namespace: db-ns
spec:
  minAvailable: 2
  selector:
    matchLabels:
      postgres-operator.crunchydata.com/cluster: alice
```
>Note: Here `alice` is the cluster name of the Crunchy PGO.

#### Explanation:

1. **minAvailable**:  
   - **Configured Value**: `2`
   - **Purpose**: This setting determines the minimum number of pods that must remain available (running) during disruptions. In this case, **2 pods** should always be up and running, even if a voluntary disruption occurs (such as an upgrade or maintenance).  
   - **Effect**: This ensures that at least 2 PostgreSQL pods are available at any time, helping maintain the high availability and reliability of the system. If fewer than 2 pods are available, Kubernetes will prevent disruptive actions like node restarts or pod deletions to protect the availability of the service.

2. **selector**:  
   - **Purpose**: The `selector` defines which pods are affected by the PDB. It uses a label selector to match the PostgreSQL instances (identified by the `postgres-operator.crunchydata.com/cluster: alice` label).
   - **Effect**: This ensures that only pods related to the `alice` PostgreSQL cluster are impacted by this disruption budget, so it doesn't apply to other unrelated pods in the same namespace.

---

### **Impact of These Changes**

1. **Patroni Configuration**:
   - **Faster Detection of Failures**: By setting `ttl` to 10 seconds, your cluster will react quicker to node failures. However, it could lead to unnecessary failovers if the network latency or delays in heartbeat transmissions occur.
   - **Faster Failover Retry**: The `retry_timeout` ensures that the system will retry failed operations (such as leader election) every 10 seconds, making your failover process quicker.
   - **Promote More Up-to-Date Replicas**: By restricting the maximum lag on failover to 1MB (`maximum_lag_on_failover`), you are ensuring that the replicas are always sufficiently up-to-date before they are promoted to the leader role. This minimizes the risk of data loss during failovers.

2. **PodDisruptionBudget**:
   - **High Availability Assurance**: By ensuring that at least 2 PostgreSQL instances are always running, you protect your database from potential downtime during scheduled maintenance or Kubernetes node changes.
   - **Controlled Maintenance**: The PDB prevents Kubernetes from terminating too many PostgreSQL pods at once, thereby maintaining the required number of running instances to serve requests.

---

### **Potential Risks and Mitigations**

1. **Patroni Configuration**:
   - **Risk**: Lowering the `ttl` value too much can lead to unnecessary failovers due to transient network issues or heartbeat delays.
   - **Mitigation**: Monitor the Patroni logs for frequent failovers and adjust the `ttl` value if needed. Consider the network stability and latency in your environment.
2. **PodDisruptionBudget**:
   - **Risk**: Setting `minAvailable` too high might prevent necessary maintenance activities or scaling operations.
   - **Mitigation**: Regularly review the PDB settings and adjust them based on the operational requirements. Ensure that the number of pods specified in `minAvailable` aligns with your service level objectives (SLOs).

---

### **Summary**

- **Patroni Settings**: Quick failure detection and failover retry intervals, with tight control on replication lag before allowing failover.
- **PodDisruptionBudget**: Ensures that no more than one pod is disrupted at a time, maintaining the availability of your PostgreSQL cluster.

These configurations are critical to ensuring that your PostgreSQL cluster remains highly available, resilient to failovers, and able to handle maintenance operations with minimal downtime.
