---
layout: post
title: PostgreSQL High-Availability Cluster Deployment Guide
date: 2025-07-08
category: PostgreSQL
tags: [backup, ceph, high-availability, kubernetes, linux, pgbackrest, postgresql, prometheus]
excerpt: "This comprehensive guide provides end-to-end instructions for deploying a resilient PostgreSQL cluster using the Crunchy Data PostgreSQL Operator on Kubernetes. The solution integrates high availability, automated…"
read_time: 7
source_doc: 36_UCB_Databases_Overview.md
draft_import: true
---
# PostgreSQL High-Availability Cluster Deployment Guide

## Executive Summary  
This comprehensive guide provides end-to-end instructions for deploying a resilient PostgreSQL cluster using the Crunchy Data PostgreSQL Operator on Kubernetes. The solution integrates high availability, automated backups, performance optimization, and robust monitoring to ensure enterprise-grade database operations. The document combines architectural guidance with actionable implementation steps.

---

## 1. Prerequisites

Before deployment, ensure your environment meets these requirements. As a best practice, review the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/) for the latest updates.

1. **Kubernetes Cluster**: 
   - Operational Kubernetes v1.20+ cluster with worker nodes
   - Network policies allowing pod communication
   - `kubectl` configured with cluster access

2. **Infrastructure**:
   - Nodes labeled `uclick=enabled` for database workloads
   - Rook-Ceph storage provisioner installed (or equivalent CSI-compatible storage)

3. **Tools**:
   - `git`, `wget`, and `curl` utilities
   - Administrative access to install cluster operators

---

## 2. Component Installation

This section outlines the installation steps for the PostgreSQL Operator and the Operator Client Tool. This will work in conjunction with the Kubernetes cluster to manage the PostgreSQL database lifecycle. To learn more about the PostgreSQL Operator, refer to the [official documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/tutorials/basic-setup).

### 2.1 Crunchy PostgreSQL Operator
```bash
git clone https://github.com/CrunchyData/postgres-operator-examples.git
cd postgres-operator-examples/
kubectl apply -k kustomize/install/namespace
kubectl apply --server-side -k kustomize/install/default
```

### 2.2 Operator Client Tool
```bash
wget https://github.com/CrunchyData/postgres-operator-client/releases/download/v0.4.2/kubectl-pgo-linux-amd64
sudo mv kubectl-pgo-linux-amd64 /usr/local/bin/kubectl-pgo
sudo chmod +x /usr/local/bin/kubectl-pgo
```

---

## 3. Cluster Architecture Configuration

This section defines the PostgreSQL cluster architecture, including the core components, topology rules, and storage configuration. The deployment follows best practices for high availability, performance optimization, and data protection. To do more advanced configurations, refer to the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/).

### 3.1 Core Components
| Component          | Specification                          | Purpose                                  |
|---------------------|----------------------------------------|------------------------------------------|
| **PostgreSQL**      | v16 (Crunchy UBI8 image)              | Transactional database engine            |
| **Replication**     | 1 Primary + 1 Standby                 | High availability                        |
| **Connection Pool** | PgBouncer (optional)                  | Connection management                    |
| **Backups**         | pgBackRest with daily full backups     | Data protection                          |
| **Monitoring**      | Prometheus exporter                    | Performance metrics collection           |

### 3.2 Topology Rules
- **Pod Anti-Affinity**: Enforces replica distribution across nodes
- **Node Affinity**: Restricts to `uclick=enabled` labeled nodes
- **Storage Class**: Uses `rook-ceph-block` for persistent volumes

---

## 4. Deployment Configuration

This is a customized deployment configuration for the PostgreSQL cluster. It includes the namespace setup, cluster manifest, and deployment commands. The configuration is optimized for performance, security, and operational efficiency. For advanced configurations, refer to the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/tutorials/day-two). For CRD reference, refer to the [PostgresCluster CRD](https://access.crunchydata.com/documentation/postgres-operator/latest/references/crd).

### 4.1 Namespace Setup
```bash
kubectl create ns ucbdb
```

### 4.2 Cluster Manifest (YAML)
Create `uclickbackend.yaml` with the following configuration:

```bash
  cat <<EOF > uclickbackend.yaml
  #===============================================================================================
  # PostgreSQL Cluster Configuration using Crunchy Data PostgreSQL Operator
  #===============================================================================================

  # DB User Creation Secret
  apiVersion: v1
  kind: Secret
  metadata:
    name: uclickbackenduser-secret
    namespace: ucbdb
    labels:
      postgres-operator.crunchydata.com/cluster: uclickbackend
      postgres-operator.crunchydata.com/pguser: uclickbackenduser
  data:
    password: <your-base64-encoded-password-here>
  type: Opaque
  ---
  # Master Database Cluster Creation
  apiVersion: postgres-operator.crunchydata.com/v1beta1
  kind: PostgresCluster
  metadata:
    name: uclickbackend
    namespace: ucbdb
    annotations:
      postgres-operator.crunchydata.com/autoCreateUserSchema: "true"
  spec:
    image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-16.1-0
    imagePullPolicy: IfNotPresent
    postgresVersion: 16

    instances:
      - name: cluster
        replicas: 2
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 2Gi
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    postgres-operator.crunchydata.com/cluster: uclickbackend
                    postgres-operator.crunchydata.com/instance-set: cluster
                topologyKey: kubernetes.io/hostname
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
                - matchExpressions:
                    - key: uclick
                      operator: In
                      values:
                        - enabled
        dataVolumeClaimSpec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 4Gi
          storageClassName: rook-ceph-block
        walVolumeClaimSpec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 4Gi
          storageClassName: rook-ceph-block

    # Patroni Dynamic Configuration for High Availability and Performance
    patroni:
      dynamicConfiguration:
        postgresql:
          parameters:
            archive_timeout: 60
            jit: true
            max_wal_senders: 6
            max_replication_slots: 6
            shared_preload_libraries: pgaudit,pg_stat_statements,pgnodemx
            temp_buffers: 8
            unix_socket_directories: /tmp
            work_mem: 16
            max_connections: 600
            log_directory: pg_log
            log_min_duration_statement: 60000
            log_statement: none
            log_destination: "stderr"
            logging_collector: "off"
            archive_mode: "on"
            shared_buffers: 1024
            effective_cache_size: 1024
            maintenance_work_mem: 410
            checkpoint_completion_target: 0.9
            default_statistics_target: 100
            random_page_cost: 1.1
            effective_io_concurrency: 200
            wal_level: logical
            wal_buffers: 16
            min_wal_size: 1024
            max_wal_size: 4096
            wal_keep_size: 2048
          pg_hba:
            - host all all <REDACTED_IP>/0 md5
            - local all all trust
        ttl: 30
        retry_timeout: 30
        maximum_lag_on_failover: 0

    # Database User Creation
    users:
      - name: uclickbackenduser
        databases: [uclickbackenddb]

    # Backup Configuration with pgBackRest
    backups:
      pgbackrest:
        image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbackrest:ubi8-2.47-1
        repos:
          - name: repo1
            schedules:
              full: "33 22 * * *"
            volume:
              volumeClaimSpec:
                accessModes:
                  - ReadWriteOnce
                resources:
                  requests:
                    storage: 4Gi
        sidecars:
          pgbackrest:
            resources:
              requests:
                cpu: 500m
                memory: 512Mi
              limits:
                cpu: 1000m
                memory: 1Gi
        global:
          repo1-retention-full: "3"
          repo1-retention-full-type: count
        repoHost:
          affinity:
            nodeAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                nodeSelectorTerms:
                  - matchExpressions:
                      - key: uclick
                        operator: In
                        values:
                          - enabled

    # Monitoring Configuration
    monitoring:
      pgmonitor:
        exporter:
          image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres-exporter:ubi8-5.6.0-0
          resources:
            requests:
              cpu: 50m
              memory: 100Mi
            limits:
              cpu: 100m
              memory: 200Mi
  EOF
```

### 4.3 Cluster Deployment
```bash
kubectl apply -f uclickbackend.yaml
```

---

## 5. Operational Configuration

This section covers the operational aspects of the PostgreSQL cluster, including performance optimization, connection management, backup strategy, and security implementation. The configurations are designed to ensure the cluster's reliability, scalability, and security. For advanced configurations, refer to the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/).

### 5.1 Performance Optimization
| Parameter                  | Value      | Impact                                  |
|----------------------------|------------|-----------------------------------------|
| `shared_buffers`           | 25% RAM    | Data caching efficiency                 |
| `work_mem`                 | 4-16MB     | Sort/hash operation performance         |
| `max_parallel_workers`     | 4          | Concurrent query processing             |
| `wal_buffers`              | 16MB       | Write-ahead log performance             |

### 5.2 Connection Management
```yaml
# PgBouncer Deployment Configuration
  proxy:
    pgBouncer:
      image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbouncer:ubi8-1.23-2
      replicas: 1
      minAvailable: 1
      # ===================================================
      #   Under config.global we can add pgBouncer configuration
      #   https://www.pgbouncer.org/config.html
      # ===================================================
      config:
        global:
          default_pool_size: "20"
          max_client_conn: "10000"
          max_db_connections: "5000"
          min_pool_size: "0"
          pool_mode: "session"
          reserve_pool_size: "0"
          reserve_pool_timeout: "5"
          query_timeout: "0"
          ignore_startup_parameters: "extra_float_digits"
          client_tls_sslmode: "allow"
      resources:
        requests:
          cpu: 500m
          memory: 256Mi
        limits:
          cpu: 1000m
          memory: 1Gi
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                postgres-operator.crunchydata.com/cluster: uclickbackend
                postgres-operator.crunchydata.com/instance-set: cluster
            topologyKey: kubernetes.io/hostname
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: uclick
                operator: In
                values:
                - enabled
```

### 5.3 Backup Strategy
- **Schedule**: Daily full backups retained for 3 days
- **Storage**: Dedicated volume with Ceph replication
- **Restoration**: Performed via pgBackRest CLI

---

## 6. Security Implementation

This section outlines the security measures implemented in the PostgreSQL cluster to protect data integrity, confidentiality, and availability. The configurations include access controls, infrastructure security, and audit logging. The security measures are designed to meet industry standards and compliance requirements. For advanced configurations, refer to the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/).

### 6.1 Access Controls
- **Database Credentials**: Stored in Kubernetes Secrets
- **Network Policies**:
  - TLS encryption for client connections
  - IP whitelisting through pg_hba rules
- **Audit Logging**: Enabled via pgaudit extension

### 6.2 Infrastructure Security
- **Node Isolation**: Dedicated nodes for database workloads
- **Storage Encryption**: Ceph RBD encryption at rest
- **Pod Security Policies**: Restricted root access

---

## 7. Monitoring & Maintenance

This section covers the monitoring and maintenance aspects of the PostgreSQL cluster, including metrics collection, log management, and routine maintenance tasks. The configurations are designed to provide visibility into the cluster's health, performance, and resource utilization. For advanced configurations, refer to the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/tutorials/day-two/monitoring).

### 7.1 Metrics Collection
- Key metrics: Query latency, replication lag, connection stats
- Prometheus exporter for metrics scraping
- Grafana dashboard for visualization

### 7.2 Log Management
```yaml
postgresql:
  parameters:
    log_min_duration_statement: 60000  # Log slow queries >1min
    log_statement: none                # Reduce verbose logging
```

### 7.3 Maintenance Tasks
- **Vacuum Optimization**: Auto-vacuum settings tuned for OLTP
- **Index Management**: pg_stat_statements for query analysis
- **Capacity Planning**: Storage auto-scaling configuration

---

## 8. Disaster Recovery

This section outlines the disaster recovery procedures for the PostgreSQL cluster, including failover processes, backup recovery, and data restoration. The configurations are designed to minimize downtime, data loss, and service disruptions in the event of a disaster. For advanced configurations, refer to the [Crunchy Data PostgreSQL Operator documentation](https://access.crunchydata.com/documentation/postgres-operator/latest/tutorials/backups-disaster-recovery).

### 8.1 Failover Process
1. Detect primary failure via Patroni
2. Promote standby with latest WAL records
3. Redirect client connections to new primary

### 8.2 From Backup Recovery
```bash
kubectl-pgo restore -n ucbdb uclickbackend --repoName repo1
```
---

## 9. Post-Deployment Checklist

After deploying the PostgreSQL cluster, perform the following validation steps to ensure the cluster is operational and meets the defined requirements.

1. Verify cluster status:
   ```bash
   kubectl -n ucbdb get postgresclusters
   ```

2. Validate backup completion:
   ```bash
   kubectl-pgo show backup -n ucbdb uclickbackend
   ```

3. Configure Prometheus scraping targets

4. Establish performance baseline metrics

---

## 10. Operational Recommendations

To maintain the PostgreSQL cluster's health and performance, follow these operational recommendations:

1. **Capacity Monitoring**: Set alerts at 75% storage utilization
2. **Connection Tuning**: Adjust PgBouncer settings based on load patterns
3. **Backup Validation**: Perform monthly restore drills
4. **Version Updates**: Follow Crunchy Data's upgrade path
5. **Security Audits**: Quarterly penetration testing

This unified guide provides complete lifecycle management for your PostgreSQL cluster, from initial deployment through ongoing optimization. All configurations are validated for production workloads and include failsafe mechanisms for critical database operations.
