---
layout: post
title: "Explanation Document: Pod Anti-Affinity Configuration for PostgreSQL Cluster"
date: 2025-01-28
category: PostgreSQL
tags: [kubernetes, postgresql]
excerpt: This document explains the pod anti-affinity configuration used in the PostgresCluster resource to ensure that the master and replica pods are scheduled on different nodes. It also delves into why role-based…
read_time: 3
source_doc: 32_Crunchy_Pod_Anti_Affinity.md
draft_import: true
---
### **Explanation Document: Pod Anti-Affinity Configuration for PostgreSQL Cluster**

---

#### **Introduction**
This document explains the **pod anti-affinity configuration** used in the `PostgresCluster` resource to ensure that the **master and replica pods** are scheduled on **different nodes**. It also delves into why **role-based anti-affinity** might not work and provides insights into the current working configuration.

---

### **Current Working Configuration**
The following `affinity` configuration ensures that **no two pods** from the same PostgreSQL cluster are scheduled on the same node:

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            postgres-operator.crunchydata.com/cluster: alice
            postgres-operator.crunchydata.com/instance-set: cluster
        topologyKey: kubernetes.io/hostname
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: db
          operator: In
          values:
          - enabled
```

---

### **Key Components of the Configuration**

#### **1. `podAntiAffinity`**
- **Purpose**: Ensures that **no two pods** with the specified labels are scheduled on the same node.
- **Configuration**:
  - **`matchLabels`**:
    - `postgres-operator.crunchydata.com/cluster: alice`: Matches all pods belonging to the `alice` cluster.
    - `postgres-operator.crunchydata.com/instance-set: cluster`: Matches all pods in the `cluster` instance set.
  - **`topologyKey: kubernetes.io/hostname`**: Ensures that the anti-affinity rule is applied based on the node’s hostname.

#### **2. `nodeAffinity`**
- **Purpose**: Restricts scheduling to nodes with the `db=enabled` label.
- **Configuration**:
  - **`matchExpressions`**:
    - `key: db`: Matches nodes with the `db` label.
    - `operator: In`: Ensures the node’s label value is in the specified list.
    - `values: enabled`: Matches nodes where the `db` label is set to `enabled`.

---

### **Why This Configuration Works**
1. **Cluster-Wide Anti-Affinity**:
   - By targeting the **cluster name** (`postgres-operator.crunchydata.com/cluster: alice`) and **instance set** (`postgres-operator.crunchydata.com/instance-set: cluster`), the anti-affinity rule applies to **all pods** in the cluster, including the master and replicas.
   - This ensures that **no two pods** from the same cluster are scheduled on the same node.

2. **Node Affinity**:
   - The `nodeAffinity` rule ensures that pods are only scheduled on nodes with the `db=enabled` label, providing additional control over pod placement.

3. **Simplicity**:
   - This configuration avoids the complexity of role-based anti-affinity and ensures consistent behavior across all pods in the cluster.

---

### **Why Role-Based Anti-Affinity Might Not Work**

#### **1. Incorrect or Missing Labels**
- **Issue**: The `postgres-operator.crunchydata.com/role` label (e.g., `master` or `replica`) might not be applied correctly or consistently to the pods.
- **Solution**:
  - Verify the labels applied to the pods:
    ```bash
    kubectl get pods -n db-ns -o yaml | grep -A 5 labels:
    ```
  - Ensure the `postgres-operator.crunchydata.com/role` label is present and correct.

#### **2. Role Assignment Timing**
- **Issue**: The **role** (master or replica) might be assigned **after** the pod is scheduled. If the anti-affinity rule is based on the role, it won’t be enforced during initial scheduling.
- **Solution**:
  - Use **cluster-wide anti-affinity** (as in the current configuration) to ensure proper scheduling regardless of role assignment timing.

#### **3. Insufficient Nodes**
- **Issue**: If there are not enough nodes available with the `db=enabled` label, Kubernetes might ignore the anti-affinity rules and schedule pods on the same node.
- **Solution**:
  - Ensure there are enough nodes with the `db=enabled` label:
    ```bash
    kubectl get nodes -l db=enabled
    ```
  - Add the `db=enabled` label to additional nodes if necessary:
    ```bash
    kubectl label node <node-name> db=enabled
    ```

#### **4. Misconfigured Anti-Affinity Rules**
- **Issue**: The anti-affinity rules might be targeting the wrong labels or topology.
- **Solution**:
  - Double-check the `matchLabels` and `topologyKey` in the `podAntiAffinity` configuration.
  - Use **cluster-wide anti-affinity** to avoid role-specific issues.

#### **5. Role Changes During Runtime**
- **Issue**: If the **role** of a pod changes during runtime (e.g., from replica to master), the anti-affinity rules might not be re-evaluated.
- **Solution**:
  - Use **cluster-wide anti-affinity** to ensure consistent behavior regardless of role changes.

---

### **Advantages of the Current Configuration**
1. **Simplicity**:
   - The configuration is straightforward and avoids the complexity of role-based anti-affinity.

2. **Consistency**:
   - Ensures that **all pods** in the cluster are evenly distributed across nodes, regardless of their roles.

3. **Reliability**:
   - Works even if the role labels are missing, incorrect, or assigned after scheduling.

4. **Scalability**:
   - Easily scales to clusters with multiple replicas, ensuring no two pods are scheduled on the same node.

---

### **Conclusion**
The current configuration using **cluster-wide anti-affinity** is the most reliable and effective way to ensure that **master and replica pods** are scheduled on different nodes. It avoids the pitfalls of role-based anti-affinity and provides consistent behavior across the cluster.

If you encounter further issues, ensure that:
1. The correct labels are applied to the pods.
2. There are enough nodes with the `db=enabled` label.
3. The `podAntiAffinity` and `nodeAffinity` rules are correctly configured.
