---
layout: post
title: "Rook Ceph RBD PVC Troubleshooting Guide for Multi-Attach and MountDevice Failures"
date: 2026-07-17
category: Kubernetes
tags: [ceph, container, high-availability, kubernetes, pvc, rbd, rook, tde]
excerpt: "This guide provides a detailed, step-by-step process to resolve stuck Rook Ceph RBD volumes in Kubernetes, particularly when pods encounter errors such as:"
read_time: 7
order: 20
---

# 🚑 Rook Ceph RBD PVC Troubleshooting Guide for Multi-Attach and MountDevice Failures

This guide provides a detailed, step-by-step process to resolve **stuck Rook Ceph RBD volumes** in Kubernetes, particularly when pods encounter errors such as:

- `Multi-Attach error: Volume is already exclusively attached to one node`
- `rpc error: code = Aborted desc = an operation with the given Volume ID already exists`
- `MountVolume.MountDevice failed: rbd image is still being used`

These issues typically arise due to stale Kubernetes or Ceph state, often caused by node failures, force-deleted pods, or improper node shutdowns. This document combines best practices for identifying and resolving these problems, ensuring minimal disruption to your cluster.

---

## 🔍 Context: What Causes These Issues?

The errors occur when:
- **Stale `VolumeAttachment` objects** reference outdated or unreachable nodes, preventing Kubernetes from attaching the volume to a new node.
- **Ceph RBD watchers** remain active from a previous client (e.g., a crashed node or deleted pod), locking the volume.
- **Node issues**, such as crashes, ungraceful terminations, or network disruptions, leave behind stale state in Kubernetes or Ceph.
- **RBD map errors**, such as `Cannot send after transport endpoint shutdown`, indicate communication issues between Ceph and the client.

This guide addresses both Kubernetes (`VolumeAttachment`) and Ceph (RBD watcher) issues systematically.

---

## ✅ Resolution Steps

Follow these steps in order to diagnose and resolve the issue. Each step builds on the previous one, ensuring thorough troubleshooting.

### 🧩 Step 1: Identify the Problem Pod and PVC

Start by examining the affected pod to confirm the issue and gather necessary details.

```bash
# List pods that are stuck in ContainerCreating or Pending
kubectl get pods -n <namespace> | grep -i -E 'ContainerCreating|Pending'

# Describe the specific stuck pod
kubectl describe pod -n <namespace> <pod-name>
```

Look for errors in the output, such as:
- `Multi-Attach error for volume "pvc-XXXX": Volume is already exclusively attached`
- `rpc error: code = Aborted desc = an operation with the given Volume ID already exists`
- `MountVolume.MountDevice failed: rbd image is still being used`

**What to note**:
- The **PVC name** (e.g., `pvc-febdd484-...`).
- Any **node names** mentioned in the error (indicating where the volume is incorrectly attached).
- The **PV name** or **volume ID** (e.g., `csi-vol-<UUID>`), which may appear in the error logs.

---

### 🔗 Step 2: Resolve Stale VolumeAttachments

Stale `VolumeAttachment` objects may incorrectly bind the PVC to a node that is no longer relevant (e.g., a crashed or unreachable node). This step provides two approaches, with the **Cordon Method** being the recommended primary approach for StatefulSets.

#### 2.1 Identify VolumeAttachments

Check for `VolumeAttachment` objects associated with the PVC:

```bash
kubectl get volumeattachments -A | grep <pvc-uid>
```

> Replace `<pvc-uid>` with the PVC UID or name from Step 1 (e.g., `pvc-febdd484-...`).

Example output:
```
csi-abc123   rook-ceph.rbd.csi.ceph.com   pvc-febdd484-...   <worker-node-1>   true   9m20s
csi-xyz789   rook-ceph.rbd.csi.ceph.com   pvc-de73f086-...   <worker-node-2>   true   41s
```

This output shows:
- **Attachment name**: `csi-abc123`
- **PV name**: `pvc-febdd484-...`
- **Node**: `<worker-node-hostname>`
- **Status**: Whether the attachment is active (`true`).

#### 2.2 Primary Method: Cordon Node and Scale Down (Recommended for StatefulSets)

This approach ensures the cleanest possible volume detachment by coordinating between Kubernetes scheduling and volume management. **Use this method first, especially for StatefulSets.**

**Why this method works better:**
- **Graceful shutdown**: Scaling to 0 replicas ensures the StatefulSet controller properly terminates the pod
- **Forced rescheduling**: Cordoning the node guarantees the pod will be scheduled on a different node
- **Cleaner state management**: The StatefulSet controller handles volume detachment more reliably than force-deleting pods
- **Prevents race conditions**: Avoids timing issues between pod deletion and volume detachment
- **Respects StatefulSet semantics**: Maintains proper ordinal identity and volume binding relationships

**Step-by-step process:**

1. **Cordon the node** where the VolumeAttachment is currently located:
   ```bash
   kubectl cordon <node-name>
   ```

2. **Scale down the StatefulSet** to 0 replicas:
   ```bash
   kubectl scale sts -n <namespace> --replicas=0 <statefulset-name>
   ```

3. **Delete the VolumeAttachment**:
   ```bash
   kubectl delete volumeattachment <volumeattachment-name>
   ```

4. **Scale the StatefulSet back up**:
   ```bash
   kubectl scale sts -n <namespace> --replicas=<original-replica-count> <statefulset-name>
   ```

5. **Uncordon the node** (optional, if you want to allow scheduling back to it):
   ```bash
   kubectl uncordon <node-name>
   ```


#### 2.3 Alternative Method: Direct VolumeAttachment Deletion

**Use this method for Deployments or when the cordon method is not suitable.**

If the PVC is attached to an outdated, unreachable, or incorrect node (i.e., not the node where the pod is scheduled), delete the `VolumeAttachment`:

```bash
kubectl delete volumeattachment <volumeattachment-name>
```

For example:
```bash
kubectl delete volumeattachment csi-abc123
```

> **CAUTION**: Only delete a `VolumeAttachment` if:
> - The node listed is down, unresponsive, or no longer hosting the pod.
> - The pod using the volume has been deleted or rescheduled.
> - You've confirmed the volume is not actively used by another pod.

#### 2.4 Restart the Pod (For Alternative Method)

After deleting the stale `VolumeAttachment`, restart the pod to trigger a reschedule and re-attach the volume:

```bash
# For a single pod
kubectl delete pod -n <namespace> <pod-name>

# For a deployment
kubectl rollout restart deployment -n <namespace> <deployment-name>

# For a StatefulSet (if not using the cordon method above)
kubectl delete pod -n <namespace> <pod-name>
```

---

### 📋 Step 3: Verify the Pod Status

Check if the pod is now running correctly after rescheduling:

```bash
kubectl get pod -n <namespace> <pod-name>
kubectl describe pod -n <namespace> <pod-name>
```

- **✅ Success**: If the pod is in the `Running` state and no errors appear in the description, the issue is resolved.
- **❌ Failure**: If the pod remains in `ContainerCreating` or `Pending`, or errors like `Multi-Attach` or `rbd image is still being used` persist, proceed to Step 4.

---

Here's the concise, direct-command version without variables:

---

### 🧩 **Step 4: Blacklist Stale RBD Watchers** 

#### **4.1 Get the RBD Image Name**
1. **Find the PV name from PVC**:
   ```bash
   kubectl get pvc -n <namespace> <pvc-name> -o jsonpath='{.spec.volumeName}'
   ```

2. **Extract the RBD image ID** (replace `<pv-name>` with output from above):
   ```bash
   kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeHandle}' | cut -d- -f6- | xargs -I {} echo "csi-vol-{}"
   ```

#### **4.2 Check Active Watchers**
Run this in **one line** (replace `<pv-name>`):
```bash
kubectl -n rook-ceph exec -it $(kubectl get pod -n rook-ceph -l app=rook-ceph-tools -o jsonpath='{.items[0].metadata.name}') -- rbd status replicapool/$(kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeHandle}' | cut -d- -f6- | xargs -I {} echo "csi-vol-{}")
```

*Expected Output*:
```
Watchers:
    watcher=<REDACTED_IP>:<REDACTED_PORT>/<REDACTED_ID> client.<REDACTED_CLIENT_ID> cookie=<REDACTED_COOKIE>
```

#### **4.3 Blacklist the Stale Watcher**
Copy the `watcher=IP:PORT/ID` from above and run:
```bash
kubectl -n rook-ceph exec -it $(kubectl get pod -n rook-ceph -l app=rook-ceph-tools -o jsonpath='{.items[0].metadata.name}') -- ceph osd blacklist add <REDACTED_IP>:<REDACTED_PORT>/<REDACTED_ID>
```

#### **4.4 Force Pod Restart**
```bash
kubectl delete pod -n <namespace> <pod-name>
```

---

**Key Notes**:
1. Replace `<namespace>`, `<pvc-name>`, `<pv-name>`, and `<pod-name>` with your actual values
2. For **fish shell**, replace `$(...)` with `(...)`
3. The `replicapool` name should match your Ceph pool (check StorageClass if unsure)

---

### 🔎 Step 5: Final Verification

Verify that the pod is now running correctly:

```bash
kubectl get pods -n <namespace>
kubectl describe pod -n <namespace> <pod-name>
```

The pod should now be in the `Running` state with no errors. If issues persist, consider:
- Checking for underlying network issues between nodes and the Ceph cluster.
- Ensuring the Rook Ceph CSI driver and Ceph cluster are running the latest stable versions.
- Reviewing node health and resource availability.

---

## 🧠 Summary Flowchart

```text
1. Identify stuck pod → Run `kubectl describe pod` → Note Multi-Attach or MountDevice errors
2. Check VolumeAttachments → Run `kubectl get volumeattachments` → Delete stale attachments
3. Restart pod → Verify with `kubectl describe pod`
4. If still stuck → Find RBD image ID → Check watchers with `rbd status` → Blacklist stale watchers
5. Restart pod → Confirm resolution with `kubectl get pods`
```

---

## 🛠 Technical Background

### Why Do These Issues Occur?

When a pod uses a Rook Ceph RBD-backed PVC:
1. **Kubernetes** creates a `VolumeAttachment` object to track which node the volume is mounted on.
2. **Ceph RBD** registers a "watcher" to monitor clients accessing the volume.

If a node crashes, a pod is force-deleted, or a node is improperly drained:
- The `VolumeAttachment` may remain, incorrectly indicating the volume is still attached to the old node.
- Ceph may retain a watcher for a client that no longer exists, locking the volume.

This guide resolves both issues by:
- Removing stale `VolumeAttachment` objects in Kubernetes.
- Blacklisting stale watchers in Ceph to release the volume.

---

## 🛡️ Tips to Prevent These Issues

1. **Avoid Force Deletions**: Allow pods to terminate gracefully to ensure proper cleanup of `VolumeAttachment` objects and Ceph watchers.
2. **Properly Drain Nodes**: Use `kubectl drain <node-name> --ignore-daemonsets` before shutting down or rebooting nodes to safely evict pods.
3. **Keep Rook Ceph Updated**: Newer versions of Rook and the Ceph CSI driver include improved handling of volume attachments and watcher cleanup.
4. **Monitor Node Health**: Use monitoring tools to detect and address node failures or network issues promptly.
5. **Enable Ceph Health Checks**: Configure Rook to monitor Ceph cluster health and alert on issues like OSD failures or network disruptions.

---

## 📜 Quick Reference Commands

```bash
# Step 1: Identify the problem
kubectl get pods -n <namespace> | grep -i -E 'ContainerCreating|Pending'
kubectl describe pod -n <namespace> <pod-name>

# Step 2: Check and delete stale VolumeAttachments
kubectl get volumeattachments -A | grep <pvc-uid>
kubectl delete volumeattachment <volumeattachment-name>

# Step 3: Verify pod status
kubectl get pod -n <namespace> <pod-name>
kubectl describe pod -n <namespace> <pod-name>

# Step 4: Handle stale RBD watchers
# Find RBD image ID
kubectl get pvc -n <namespace> <pvc-name> -o jsonpath='{.spec.volumeName}'
kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeHandle}'

# Check for watchers
kubectl -n rook-ceph exec -it $(kubectl get pod -n rook-ceph -l app=rook-ceph-tools -o jsonpath='{.items[0].metadata.name}') -- \
  rbd status replicapool/<rbd-image-id>

# Blacklist watcher
kubectl -n rook-ceph exec -it $(kubectl get pod -n rook-ceph -l app=rook-ceph-tools -o jsonpath='{.items[0].metadata.name}') -- \
  ceph osd blacklist add <watcher-address>

# Step 5: Restart pod
kubectl delete pod -n <namespace> <pod-name>
```

---

## ✅ Notes and Precautions

- **Avoid Hasty Deletions**: Do not delete `VolumeAttachment` objects unless you’re certain the volume is no longer needed by the referenced node or pod.
- **Blacklist Carefully**: Only blacklist watchers after confirming the client is stale (e.g., the pod is deleted, or the node is down).
- **Minimize Node Reboots**: The steps above resolve most issues without requiring node reboots, which can be disruptive.
- **Check Cluster Health**: If issues persist, verify the health of the Ceph cluster (`kubectl -n rook-ceph get pods`) and ensure no OSDs are down.
- **Log Errors**: Save error outputs and logs for debugging if the issue recurs or requires escalation.

---

## 📄 Additional Resources

- **Rook Ceph Documentation**: [https://rook.io/docs/rook/latest/](https://rook.io/docs/rook/latest/)
- **Ceph CSI Troubleshooting**: [https://github.com/ceph/ceph-csi](https://github.com/ceph/ceph-csi)
- **Kubernetes Storage SIG**: For advanced debugging, engage with the Kubernetes Storage SIG community.

---

Let me know if you’d like this guide in a different format (e.g., Markdown, PDF) or if you want assistance turning it into an automated script (e.g., Ansible role or bash script) for proactive monitoring and healing.
