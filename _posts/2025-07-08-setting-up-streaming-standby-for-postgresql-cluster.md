---
layout: post
title: Setting Up Streaming Standby for PostgreSQL Cluster
date: 2025-07-08
category: PostgreSQL
tags: [kubernetes, postgresql, streaming-replication]
excerpt: "- Introduction - Prerequisites - Step 1: Prepare TLS Certificates - Step 2: Create Kubernetes Secrets - Step 3: Configure Primary Cluster"
read_time: 5
source_doc: 09_Streaming_Standby_Setup.md
draft_import: true
---
# Setting Up Streaming Standby for PostgreSQL Cluster

## Table of Contents
- [Introduction](#introduction)
- [Prerequisites](#prerequisites)
- [Step 1: Prepare TLS Certificates](#step-1-prepare-tls-certificates)
- [Step 2: Create Kubernetes Secrets](#step-2-create-kubernetes-secrets)
- [Step 3: Configure Primary Cluster](#step-3-configure-primary-cluster)
- [Step 4: Expose Primary Cluster](#step-4-expose-primary-cluster-via-nodeport)
- [Step 5: Configure Standby Cluster](#step-5-configure-standby-cluster)
- [Step 6: Deploy and Verify](#step-6-deploy-and-verify-the-standby-cluster)
- [Troubleshooting](#troubleshooting)

## Introduction

### What is a Streaming Standby PostgreSQL Cluster?

A streaming standby PostgreSQL cluster is a high-availability configuration where a secondary (standby) database server continuously receives real-time updates from a primary database server. This setup provides several key benefits:
- **Disaster Recovery**: If the primary server fails, the standby can quickly take over
- **Read Scaling**: Standby servers can be used for read-heavy operations
- **Minimal Data Loss**: Continuous streaming replication ensures near-real-time data synchronization

### Understanding the Components
- **Primary Cluster**: The main database server handling write operations
- **Standby Cluster**: A replica server that receives continuous updates from the primary
- **TLS Certificates**: Ensure secure, encrypted communication between servers
- **Kubernetes**: Container orchestration platform managing the database clusters

## Prerequisites

Before beginning, ensure you have:
1. A running PostgreSQL primary cluster
2. Access to a Kubernetes cluster
3. Required tools:
   - `kubectl` command-line tool
   - `openssl` for certificate generation
   - Basic understanding of Kubernetes and PostgreSQL concepts

## Step 1: Prepare TLS Certificates

### Why TLS Certificates?
TLS (Transport Layer Security) certificates ensure:
- Encrypted communication between primary and standby clusters
- Authentication of servers
- Protection against man-in-the-middle attacks

### Detailed Certificate Generation Process

#### Create a Directory for Keys
```bash
mkdir keys && cd keys
```

#### Create a Certificate Authority (CA) Certificate
```bash
openssl genrsa -out ca.key 4096
openssl req -new -x509 -key ca.key -out ca.crt -days 365 -subj "/CN=amexpg-ca"
```
- Generates a root certificate authority key and certificate
- Valid for 365 days
- Used to sign other certificates

#### Create a Server Certificate for Primary Cluster
```bash
openssl genrsa -out amexpg-server.key 4096
openssl req -new -key amexpg-server.key -out amexpg-server.csr -subj "/CN=amexpg-primary"
openssl x509 -req -in amexpg-server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out amexpg-server.crt -days 365
```
- Generates a unique server certificate for the primary cluster
- Signed by the CA certificate for added security

#### Create a Replication Certificate
```bash
openssl genrsa -out amexpg-repl.key 4096
openssl req -new -key amexpg-repl.key -out amexpg-repl.csr -subj "/CN=_crunchyrepl"
openssl x509 -req -in amexpg-repl.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out amexpg-repl.crt -days 365
```
- Specifically for secure replication communication
- Also signed by the CA certificate

#### Copy Keys to Standby Cluster
- Use `scp` or `rsync` to transfer the `keys` directory
- Ensure secure transmission of sensitive certificate files

## Step 2: Create Kubernetes Secrets

### What are Kubernetes Secrets?
- Securely store sensitive information like certificates
- Prevent hardcoding credentials in deployment files
- Easily managed and rotated

#### Create Primary Cluster TLS Secret
```bash
kubectl create secret generic -n prod-db amexpg-cluster.tls \
  --from-file=ca.crt=ca.crt \
  --from-file=tls.key=amexpg-server.key \
  --from-file=tls.crt=amexpg-server.crt
```

#### Create Replication TLS Secret
```bash
kubectl create secret generic -n prod-db amexpg-replication.tls \
  --from-file=ca.crt=ca.crt \
  --from-file=tls.key=amexpg-repl.key \
  --from-file=tls.crt=amexpg-repl.crt
```

## Step 3: Configure Primary Cluster

### Configuring the Primary PostgreSQL Cluster
Add TLS secret references to your PostgreSQL cluster configuration:

```yaml
spec:
  customTLSSecret:
    name: amexpg-cluster.tls
  customReplicationTLSSecret:
    name: amexpg-replication.tls
```

Here is the full yaml file:

```yaml
---
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: amexpg
  namespace: prod-db
  labels:
    pg-cluster: amexpg
    pgo-version: 5.6.7
spec:
  #image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-15.7-1
  #image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-13.9-1
  image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-13.8-1
  postgresVersion: 13
  instances:
  - name: amexpg
    replicas: 1
    dataVolumeClaimSpec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 5Gi
      storageClassName: rook-ceph-block
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
  backups:
    pgbackrest:
      # image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbackrest:ubi8-2.51-1
      image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbackrest:ubi8-2.40-1
      repos:
      - name: repo1
        volume:
          volumeClaimSpec:
            accessModes: ["ReadWriteOnce"]
            resources:
              requests:
                storage: 5Gi
            storageClassName: rook-ceph-block
  monitoring:
    pgmonitor:
      exporter:
        image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-15.7-1
  users:
  - name: amexpguser
    databases: [amexpgdb]
  customTLSSecret:
    name: amexpg-cluster.tls
  customReplicationTLSSecret:
    name: amexpg-replication.tls
  patroni:
    dynamicConfiguration:
      postgresql:
        parameters:
          max_connections: "600"
          shared_buffers: "4GB"
          effective_cache_size: "6GB"
          maintenance_work_mem: "2GB"
          checkpoint_completion_target: "0.9"
          wal_buffers: "16MB"
          default_statistics_target: "100"
          random_page_cost: "1.1"
          effective_io_concurrency: "200"
          min_wal_size: "1GB"
          max_wal_size: "4GB"
          max_worker_processes: "8"
          max_parallel_workers_per_gather: "4"
          max_parallel_workers: "8"
          max_parallel_maintenance_workers: "4"
          wal_keep_size: "2048MB"
          max_standby_archive_delay: "-1"
          hot_standby: "on"
```

## Step 4: Expose Primary Cluster via NodePort

### Why Use NodePort?
- Allows external access to the PostgreSQL service
- Assigns a high-numbered port accessible from outside the cluster

```bash
kubectl expose svc amexpg-ha --port=5432 --target-port=5432 \
  --name=amexpg-ha-nodeport --type=NodePort \
  --selector=postgres-operator.crunchydata.com/patroni=amexpg-ha -n prod-db
```

#### Verify the Service
```bash
kubectl get svc amexpg-ha-nodeport -n prod-db
```

## Step 5: Configure Standby Cluster

### Standby Cluster Configuration
Key configuration elements for the standby cluster:

```yaml
spec:
  customTLSSecret:
    name: amexpg-cluster.tls
  customReplicationTLSSecret:
    name: amexpg-replication.tls
  standby:
    enabled: true
    host: <REDACTED_IP>  # Primary cluster's IP
    port: 5432
```

Here is the full yaml file:

```yaml
---
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: amexpg-standby
  namespace: prod-db
  labels:
    pg-cluster: amexpg
    pgo-version: 5.6.7
spec:
  image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-13.8-1
  postgresVersion: 13
  instances:
  - name: amexpg-standby
    replicas: 1
    dataVolumeClaimSpec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 5Gi
      storageClassName: rook-ceph-block
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
  backups:
    pgbackrest:      
      image: registry.developers.crunchydata.com/crunchydata/crunchy-pgbackrest:ubi8-2.40-1
      repos:
      - name: repo1
        volume:
          volumeClaimSpec:
            accessModes: ["ReadWriteOnce"]
            resources:
              requests:
                storage: 5Gi
            storageClassName: rook-ceph-block
  monitoring:
    pgmonitor:
      exporter:
        image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-15.7-1
  customTLSSecret:
    name: amexpg-cluster.tls
  customReplicationTLSSecret:
    name: amexpg-replication.tls
  standby:
    enabled: true
    host: <A node IP>
    port: <Exposed NodePort>
  users:
  - name: amexpguser
    databases: [amexpgdb]
  patroni:
    dynamicConfiguration:
      postgresql:
        parameters:
          max_connections: "600"
          shared_buffers: "4GB"
          effective_cache_size: "6GB"
          maintenance_work_mem: "2GB"
          checkpoint_completion_target: "0.9"
          wal_buffers: "16MB"
          default_statistics_target: "100"
          random_page_cost: "1.1"
          effective_io_concurrency: "200"
          min_wal_size: "1GB"
          max_wal_size: "4GB"
          max_worker_processes: "8"
          max_parallel_workers_per_gather: "4"
          max_parallel_workers: "8"
          max_parallel_maintenance_workers: "4"
          wal_keep_size: "2048MB"
          max_standby_archive_delay: "-1"
          hot_standby: "on"
```

## Step 6: Deploy and Verify the Standby Cluster

### Deployment
```bash
kubectl apply -f amexpg-standby.yaml
```

### Verification Steps

#### Check Pod Status
```bash
kubectl get pods -n prod-db
```

#### Review Replication Logs
```bash
kubectl logs <standby-pod-name> -n prod-db
```

## Troubleshooting

### Common Issues and Solutions

1. **Connection Problems**
   - Check firewall rules
   - Verify network connectivity
   - Confirm correct IP and port configurations

2. **TLS/Authentication Errors**
   - Verify certificate generation
   - Check secret creation
   - Ensure matching CN (Common Name) in certificates

3. **Replication Lag**
   - Monitor replication status
   - Check network bandwidth
   - Review PostgreSQL configuration parameters

## Conclusion

By following these steps, you've created a robust, secure streaming standby PostgreSQL cluster. This configuration provides high availability, disaster recovery, and scalability for your database infrastructure.

### Next Steps
- Implement regular backup strategies
- Set up monitoring and alerting
- Practice failover scenarios
- Continuously review and optimize configuration

---

**Note**: Always test in a staging environment before implementing in production.
