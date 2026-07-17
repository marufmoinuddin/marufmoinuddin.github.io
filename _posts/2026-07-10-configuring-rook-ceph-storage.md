---
layout: post
title: "Configuring Rook Ceph Storage"
date: 2026-07-10
category: Kubernetes
tags: [kubernetes, rook, ceph, storage, pvc]
excerpt: "Rook Ceph brings Ceph storage into Kubernetes as a native operator. This guide covers deploying a production-ready Rook Ceph cluster and using it for PVCs."
read_time: 1
order: 1
---

## Overview

Rook Ceph brings Ceph storage into Kubernetes as a native operator. This guide covers deploying a production-ready Rook Ceph cluster and using it for PVCs.

## Prerequisites

- Kubernetes cluster v1.19+
- Raw storage devices on nodes (unformatted)
- `kubectl` and `helm` configured

## Deployment

```bash
# Deploy the Rook Operator
kubectl create -f https://raw.githubusercontent.com/rook/rook/master/deploy/examples/common.yaml
kubectl create -f https://raw.githubusercontent.com/rook/rook/master/deploy/examples/crds.yaml
kubectl create -f https://raw.githubusercontent.com/rook/rook/master/deploy/examples/operator.yaml

# Deploy the Ceph cluster
kubectl create -f https://raw.githubusercontent.com/rook/rook/master/deploy/examples/cluster.yaml
```

## StorageClass Configuration

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Retain
allowVolumeExpansion: true
```

## Verification

```bash
# Check cluster health
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph status
```
