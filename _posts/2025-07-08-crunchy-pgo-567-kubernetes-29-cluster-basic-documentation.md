---
layout: post
title: Crunchy PGO 5.6.7 Kubernetes 29 Cluster Basic Documentation
date: 2025-07-08
category: Kubernetes
tags: [ceph, cilium, kubernetes, linux, postgresql, rbd, rook]
excerpt: "This documentation provides step-by-step instructions for setting up a Kubernetes 29 cluster, installing necessary components such as Cilium, Rook Ceph storage, and Crunchy PGO, and deploying a PostgreSQL cluster."
read_time: 4
source_doc: 02_PGO_Cluster_Setup.md
draft_import: true
---
# Crunchy PGO 5.6.7 Kubernetes 29 Cluster Basic Documentation

This documentation provides step-by-step instructions for setting up a Kubernetes 29 cluster, installing necessary components such as Cilium, Rook Ceph storage, and Crunchy PGO, and deploying a PostgreSQL cluster.

## Table of Contents

1. [Setup Kubernetes 29 Cluster](#setup-kubernetes-29-cluster)
2. [Initialize Kubernetes and Install Cilium](#initialize-kubernetes-and-install-cilium)
3. [Setup and Install Rook Ceph Storage](#setup-and-install-rook-ceph-storage)
4. [Setup Crunchy PGO](#setup-crunchy-pgo)
5. [Setup kubectl-pgo Client](#setup-kubectl-pgo-client)
6. [Setup Namespace and Install Database Cluster](#setup-namespace-and-install-database-cluster)

### 1. Setup Kubernetes 29 Cluster

Use the provided auto script to set up the Kubernetes 29 cluster.

#### Command

```bash
# Clone the repository and run the installation script
git clone <your-git-repository-url>
cd cluster-doc
bash install-k8s-1.29.sh
```

#### Explanation

- This script automates the setup of a Kubernetes 29 cluster. Ensure you have the necessary permissions to execute the script.

### 2. Initialize Kubernetes and Install Cilium

Initialize the Kubernetes cluster and install Cilium for networking.

#### Commands

```bash
# Initialize Kubernetes with a specific pod network CIDR
sudo kubeadm init --pod-network-cidr=<REDACTED_POD_NETWORK_CIDR>

# Download and install Cilium CLI
wget https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
sudo tar xzvfC cilium-linux-amd64.tar.gz /usr/local/bin

# Install Cilium
cilium install

# Monitor Cilium status
watch 'cilium status'
```

#### Explanation

- `sudo kubeadm init --pod-network-cidr=<REDACTED_POD_NETWORK_CIDR>`: Initializes the Kubernetes cluster with a specified pod network CIDR.
- `wget ...`: Downloads the latest Cilium CLI.
- `sudo tar xzvfC ...`: Extracts the downloaded Cilium CLI to `/usr/local/bin`.
- `cilium install`: Installs Cilium in the Kubernetes cluster.
- `watch 'cilium status'`: Monitors the status of Cilium.

### 3. Setup and Install Rook Ceph Storage

Install Rook Ceph storage to provide persistent storage for your Kubernetes cluster.

#### Commands

```bash
# Clone the Rook repository and checkout the specific version
git clone --single-branch --branch v1.14.8 https://github.com/rook/rook.git
cd rook/deploy/examples

# Deploy Rook Ceph components
kubectl create -f crds.yaml -f common.yaml -f operator.yaml
sleep 5
kubectl create -f cluster.yaml

# Create the Rook Ceph storage class
kubectl apply -f csi/rbd/storageclass.yaml

# Patch the storage class to make it the default
kubectl patch storageclass rook-ceph-block -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

#### Explanation

- `git clone ... --branch v1.14.8`: Clones the Rook repository and checks out version 1.14.8.
- `kubectl create -f ...`: Creates Rook Ceph components in the cluster.
- `kubectl apply -f csi/rbd/storageclass.yaml`: Applies the Rook Ceph storage class configuration.
- `kubectl patch storageclass ...`: Patches the storage class to make it the default storage class.

### 4. Setup Crunchy PGO

Install the Crunchy PostgreSQL Operator (PGO) to manage PostgreSQL clusters.

#### Commands

```bash
# Step 1: Clone the operator repo (not the examples repo) for the installer
git clone https://github.com/CrunchyData/postgres-operator.git
cd postgres-operator
git checkout v6.0.1   # pin to a released tag, main branch may have unreleased images

# Step 2: Install PGO (creates CRDs + controller) via kustomize
kubectl apply -k config/namespace
kubectl apply --server-side -k config/default

# Step 3: Verify the operator pod is running
kubectl -n postgres-operator get pods --selector=postgres-operator.crunchydata.com/control-plane=postgres-operator

# Step 4: Now go back to the examples repo to create the actual cluster
cd ../postgres-operator-examples
kubectl apply -k kustomize/postgres
```

#### Explanation

- `git clone ...`: Clones the Crunchy PostgreSQL Operator examples repository.
- `kubectl apply --server-side -k ...`: Applies the Crunchy PostgreSQL Operator configurations using Kustomize.

### 5. Setup kubectl-pgo Client

Install the `kubectl-pgo` client to interact with the Crunchy PostgreSQL Operator.

#### Commands

```bash
# Download and install the kubectl-pgo client
wget https://github.com/CrunchyData/postgres-operator-client/releases/download/v0.4.2/kubectl-pgo-linux-amd64
sudo mv kubectl-pgo-linux-amd64 /usr/local/bin/kubectl-pgo
sudo chmod +x /usr/local/bin/kubectl-pgo
```

#### Explanation

- `wget ...`: Downloads the `kubectl-pgo` client binary.
- `sudo mv ...`: Moves the binary to `/usr/local/bin`.
- `sudo chmod +x ...`: Makes the binary executable.

### 6. Setup Namespace and Install Database Cluster

Create the namespace and deploy your PostgreSQL cluster.

#### Commands

```bash
# Create the db-ns namespace
kubectl create ns db-ns

# Create a directory for your cluster configuration
mkdir mydatabase-k8s/

# Save the following YAML configuration to a file named mydatabase-13-demo.yaml
cat <<EOF > mydatabase-13-demo.yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: mydatabase
  namespace: db-ns
  labels:
    pg-cluster: mydatabase
    pgo-version: 5.6.7
spec:
  image: registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-13.8-1
  postgresVersion: 13
  instances:
  - name: mydatabase
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
  users:
  - name: mydatabaseuser
    databases: [mydb]
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
EOF

# Apply the YAML configuration to create the PostgreSQL cluster
kubectl apply -f mydatabase-13-demo.yaml
```

#### Explanation

- `kubectl create ns db-ns`: Creates a new namespace named `db-ns`.
- `mkdir mydatabase-k8s/`: Creates a directory for the PostgreSQL cluster configuration.
- `cat <<EOF > mydatabase-13-demo.yaml ... EOF`: Saves the PostgreSQL cluster configuration to a file named `mydatabase-13-demo.yaml`.
- `kubectl apply -f mydatabase-13-demo.yaml`: Applies the configuration to create the PostgreSQL cluster.

By following these detailed steps, you can set up a Kubernetes 29 cluster with Crunchy PGO 5.6.7, install necessary components, and deploy a PostgreSQL cluster.
