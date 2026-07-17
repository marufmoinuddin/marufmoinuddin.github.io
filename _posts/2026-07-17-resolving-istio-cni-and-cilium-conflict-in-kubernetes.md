---
layout: post
title: "Resolving Istio CNI and Cilium Conflict in Kubernetes"
date: 2026-07-17
category: Kubernetes
tags: [cilium, container, envoy, high-availability, istio, kubernetes]
excerpt: "This document provides a step-by-step guide to resolve a reconciliation loop issue in the Istio CNI plugin when used alongside Cilium as the primary Container Network Interface (CN"
read_time: 7
order: 10
---

# Resolving Istio CNI and Cilium Conflict in Kubernetes

## Overview
This document provides a step-by-step guide to resolve a reconciliation loop issue in the Istio CNI plugin when used alongside Cilium as the primary Container Network Interface (CNI) plugin in a Kubernetes cluster. The issue manifests as repetitive log entries from the `istio-cni-node` pods, where the Istio CNI agent continuously updates the CNI configuration file (`/host/etc/cni/net.d/05-cilium.conflist`) and reinstalls binaries, leading to high CPU usage, excessive logging, and unhealthy pods. The root cause is a conflict between Cilium’s exclusive CNI mode (`cni-exclusive: true`) and Istio CNI’s need to modify the same configuration file to enable service mesh networking.

The solution involves disabling Cilium’s exclusive mode, verifying the integration between Cilium and Istio CNI, and ensuring the `istio-cni-node` DaemonSet reaches a healthy state. This issue occurred because Cilium’s exclusive mode assumes it is the sole CNI plugin, reverting changes made by Istio CNI, which triggers a continuous reconciliation loop as Istio CNI attempts to reapply its configuration. Disabling exclusive mode allows both plugins to coexist, resolving the loop and stabilizing the cluster’s networking.

## Prerequisites
- Administrative access to the Kubernetes cluster.
- `kubectl` configured with cluster access.
- Basic knowledge of Kubernetes, Istio, and Cilium.
- Access to the node(s) for installing monitoring tools (e.g., `inotify-tools`).
- Cluster details:
  - Istio version: 1.23.2
  - Cilium version: Verify via `kubectl get ds -n kube-system cilium -o yaml | grep image`
  - Kubernetes version: Any compatible with Istio 1.23.2 and Cilium
  - 22 nodes (as per the `istio-cni-node` DaemonSet status)

## Symptoms
- **Repetitive Logs**: The `istio-cni-node` pods in the `istio-system` namespace log frequent updates (multiple times per second) to `/host/etc/cni/net.d/05-cilium.conflist`, copying `istio-cni` binaries to `/host/opt/cni/bin`, and writing kubeconfig files to `/var/run/istio-cni/istio-cni-kubeconfig`. Example log snippet:
  ```
  2025-05-19T04:20:04.809762Z info cni-agent configuration requires updates, (re)writing CNI config file at "/host/etc/cni/net.d/05-cilium.conflist"
  2025-05-19T04:20:04.810173Z info cni-agent created CNI config /host/etc/cni/net.d/05-cilium.conflist
  ```
- **Unhealthy DaemonSet**: The `istio-cni-node` DaemonSet shows a significant number of unavailable pods (e.g., 14 out of 22 pods unavailable).
- **IstioOperator Error**: The `IstioOperator` resource in the `istio-system` namespace reports an `ERROR` status for the CNI component with the message:
  ```
  failed to wait for resource: resources not ready after 5m0s: context deadline exceeded
  ```
- **Performance Impact**: High CPU usage on nodes due to the reconciliation loop and potential network disruptions for pods relying on Istio’s service mesh.

## Root Cause and Solution Mechanism
The issue stems from a conflict between Cilium’s `cni-exclusive: true` setting in the `cilium-config` ConfigMap and Istio CNI’s requirement to append its plugin configuration to the `05-cilium.conflist` file. Cilium, as the primary CNI, writes and manages this file to configure pod networking. When `cni-exclusive` is enabled, Cilium assumes it is the only plugin allowed to modify the CNI configuration and reverts any external changes, such as those made by Istio CNI to enable Envoy sidecar networking for Istio’s service mesh. Istio CNI detects these reverts via file system watches and attempts to reapply its configuration, creating a continuous loop that overwhelms the `istio-cni-node` pods and causes many to fail readiness checks, resulting in the `IstioOperator` error.

The solution disables Cilium’s exclusive mode by setting `cni-exclusive: false`, allowing Istio CNI to coexist and modify the CNI configuration. This stops the reconciliation loop by ensuring Cilium does not revert Istio’s changes. Additional steps verify the chained configuration, monitor file changes, and ensure all `istio-cni-node` pods are healthy, addressing the symptoms and stabilizing the cluster. The solution works because it resolves the fundamental conflict, enabling both plugins to operate harmoniously while maintaining Istio’s service mesh functionality and Cilium’s network policy enforcement.

## Solution Steps

### Step 1: Verify the Issue
1. **Check Istio CNI Logs**:
   - Retrieve logs from an `istio-cni-node` pod to confirm the reconciliation loop:
     ```bash
     kubectl logs -n istio-system istio-cni-node-4chgs | tail -n 100
     ```
   - Look for repetitive entries indicating updates to `/host/etc/cni/net.d/05-cilium.conflist` and binary installations.

2. **Inspect DaemonSet Status**:
   - Verify the `istio-cni-node` DaemonSet health:
     ```bash
     kubectl get ds -n istio-system istio-cni-node
     ```
   - Note the number of ready vs. unavailable pods (e.g., `8/22` ready).

3. **Check IstioOperator Status**:
   - Confirm the CNI component error:
     ```bash
     kubectl get istiooperator -n istio-system istio-default -o yaml
     ```
   - Look for `status: ERROR` and the `context deadline exceeded` message under `componentStatus.Cni`.

4. **Verify Cilium Configuration**:
   - Inspect the `cilium-config` ConfigMap to confirm `cni-exclusive: true`:
     ```bash
     kubectl get cm -n kube-system cilium-config -o yaml
     ```
   - Locate the `cni-exclusive` key in the `data` section.

### Step 2: Disable Cilium’s Exclusive CNI Mode
1. **Edit Cilium ConfigMap**:
   - Modify the `cilium-config` ConfigMap to set `cni-exclusive: false`:
     ```bash
     kubectl edit cm -n kube-system cilium-config
     ```
   - In the editor, change:
     ```yaml
     cni-exclusive: "true"
     ```
     to:
     ```yaml
     cni-exclusive: "false"
     ```
   - Save and exit the editor.

2. **Restart Cilium Pods**:
   - Apply the configuration change by restarting the Cilium DaemonSet:
     ```bash
     kubectl rollout restart daemonset -n kube-system cilium
     ```
   - Monitor the rollout:
     ```bash
     kubectl rollout status daemonset -n kube-system cilium
     ```

### Step 3: Verify Istio CNI Integration
1. **Inspect Istio CNI ConfigMap**:
   - Check the `istio-cni-config` ConfigMap for proper chaining settings:
     ```bash
     kubectl get cm -n istio-system istio-cni-config -o yaml
     ```
   - Ensure it includes:
     ```yaml
     data:
       chained: "true"
       cni_network_config: |-
         {
           "cniVersion": "0.3.1",
           "name": "istio-cni",
           "type": "istio-cni",
           ...
         }
     ```
   - If `chained: true` is missing, edit the ConfigMap to add it:
     ```bash
     kubectl edit cm -n istio-system istio-cni-config
     ```

2. **Check CNI Configuration File**:
   - View the `05-cilium.conflist` file to confirm both Cilium and Istio CNI plugins are present:
     ```bash
     kubectl exec -n istio-system istio-cni-node-4chgs -c install-cni -- cat /host/etc/cni/net.d/05-cilium.conflist
     ```
   - Verify the file contains a `plugins` array with both Cilium and Istio CNI configurations, e.g.:
     ```json
     {
       "cniVersion": "0.3.1",
       "name": "cilium",
       "plugins": [
         { "type": "cilium-cni", ... },
         { "type": "istio-cni", ... }
       ]
     }
     ```
   - If Istio CNI is missing, reapply the IstioOperator (see Step 5).

### Step 4: Monitor File System Changes
1. **Install inotify-tools**:
   - On the node (e.g., `flc-mstr-48-vm`), install `inotify-tools` to monitor file changes:
     ```bash
     sudo apt update && sudo apt install inotify-tools
     ```
   - If the node is minimal, run this on a node with `apt` access or use an alternative monitoring method.

2. **Monitor CNI Directory**:
   - Watch for modifications to `/host/etc/cni/net.d`:
     ```bash
     inotifywait -m /host/etc/cni/net.d -e modify -e create -e delete
     ```
   - Confirm that after disabling `cni-exclusive`, no unexpected reverts occur to `05-cilium.conflist`. Stop monitoring with `Ctrl+C` after verifying stability (e.g., 5-10 minutes).

3. **Alternative Monitoring**:
   - Check Cilium logs for CNI-related activity:
     ```bash
     kubectl logs -n kube-system -l k8s-app=cilium | grep "cni"
     ```
   - Ensure no logs indicate Cilium overwriting the CNI configuration.

### Step 5: Ensure DaemonSet Health
1. **Check Pod Status**:
   - List `istio-cni-node` pods to identify non-ready instances:
     ```bash
     kubectl get pods -n istio-system -l k8s-app=istio-cni-node -o wide
     ```
   - For non-ready pods, investigate events or logs:
     ```bash
     kubectl describe pod -n istio-system istio-cni-node-<pod-name>
     kubectl logs -n istio-system istio-cni-node-<pod-name>
     ```

2. **Increase Log Verbosity (Optional)**:
   - If logs lack detail, set the log level to `debug`:
     ```bash
     kubectl edit ds -n istio-system istio-cni-node
     ```
   - Update the `args` section:
     ```yaml
     args:
     - --log_output_level=debug
     ```
   - Restart the DaemonSet:
     ```bash
     kubectl rollout restart ds -n istio-system istio-cni-node
     ```

3. **Verify DaemonSet Status**:
   - Confirm all pods are ready:
     ```bash
     kubectl get ds -n istio-system istio-cni-node
     ```
   - Ensure `numberReady` equals `desiredNumberScheduled` (e.g., `22/22`).

### Step 6: Resolve IstioOperator Error
1. **Check IstioOperator Status**:
   - Verify the CNI component status:
     ```bash
     kubectl get istiooperator -n istio-system istio-default -o yaml
     ```
   - If still in `ERROR`, proceed to reapply.

2. **Reapply IstioOperator**:
   - Reapply the `IstioOperator` to reset reconciliation:
     ```bash
     kubectl apply -f - <<EOF
     apiVersion: install.istio.io/v1alpha1
     kind: IstioOperator
     metadata:
       name: istio-default
       namespace: istio-system
     spec:
       $(kubectl get istiooperator -n istio-system istio-default -o jsonpath='{.spec}')
     EOF
     ```
   - Monitor the status until `componentStatus.Cni.status` becomes `HEALTHY`:
     ```bash
     kubectl get istiooperator -n istio-system istio-default -o yaml
     ```

### Step 7: Validate Cluster Networking
1. **Test Pod Networking**:
   - Deploy a test pod with Istio sidecar injection enabled:
     ```bash
     kubectl apply -f - <<EOF
     apiVersion: v1
     kind: Pod
     metadata:
       name: test-pod
       namespace: default
       labels:
         sidecar.istio.io/inject: "true"
     spec:
       containers:
       - name: test
         image: nginx
         ports:
         - containerPort: 80
     EOF
     ```
   - Verify the sidecar is injected and networking works:
     ```bash
     kubectl get pod test-pod -n default -o yaml | grep istio
     kubectl exec -it test-pod -n default -- curl localhost
     ```

2. **Check Network Policies**:
   - Ensure Cilium network policies are enforced:
     ```bash
     kubectl get cnp -A
     ```
   - Validate Istio policies (e.g., VirtualServices, DestinationRules) are applied correctly:
     ```bash
     kubectl get virtualservice -A
     ```

### Step 8: Optimize and Monitor
1. **Reduce Logging Noise**:
   - If logs remain excessive, set the log level to `warn`:
     ```bash
     kubectl edit ds -n istio-system istio-cni-node
     ```
   - Change:
     ```yaml
     args:
     - --log_output_level=info
     ```
     to:
     ```yaml
     args:
     - --log_output_level=warn
     ```
   - Restart the DaemonSet:
     ```bash
     kubectl rollout restart ds -n istio-system istio-cni-node
     ```

2. **Ongoing Monitoring**:
   - Monitor `istio-cni-node` logs for stability:
     ```bash
     kubectl logs -n istio-system istio-cni-node-4chgs --tail 100
     ```
   - Use Prometheus metrics (exposed on port 15014) to track CNI health:
     ```bash
     kubectl port-forward -n istio-system istio-cni-node-4chgs 15014:15014
     ```
   - Access metrics at `http://localhost:15014/metrics`.

3. **Backup Configurations**:
   - Save the `cilium-config` and `istio-cni-config` ConfigMaps:
     ```bash
     kubectl get cm -n kube-system cilium-config -o yaml > cilium-config-backup.yaml
     kubectl get cm -n istio-system istio-cni-config -o yaml > istio-cni-config-backup.yaml
     ```

## Potential Risks and Mitigations
- **Configuration Conflicts**: Multiple CNI plugins modifying `05-cilium.conflist` may cause misconfigurations. Mitigate by validating the file contents after changes and testing in a non-production environment.
- **Downtime During Restart**: Restarting the Cilium DaemonSet may briefly disrupt pod networking. Schedule changes during a maintenance window and monitor pod status:
  ```bash
  kubectl get pods -A -o wide
  ```
- **Compatibility Issues**: Ensure Istio 1.23.2 and the installed Cilium version are compatible. Check:
  - Istio CNI documentation: https://istio.io/latest/docs/setup/additional-setup/cni/
  - Cilium Istio integration: https://docs.cilium.io/en/stable/network/servicemesh/istio/
- **Resource Constraints**: Unhealthy `istio-cni-node` pods may indicate node resource issues. Monitor node health:
  ```bash
  kubectl describe node <node-name>
  ```

## Verification
- **No Reconciliation Loop**: Logs show no repetitive updates to `05-cilium.conflist` within a short timeframe (e.g., 5 minutes).
- **Healthy DaemonSet**: `kubectl get ds -n istio-system istio-cni-node` shows `numberReady` equals `desiredNumberScheduled`.
- **Healthy IstioOperator**: `kubectl get istiooperator -n istio-system istio-default` shows `componentStatus.Cni.status: HEALTHY`.
- **Functional Networking**: Test pods with Istio sidecars communicate correctly, and Cilium network policies are enforced.

## Troubleshooting
- **Persistent Loop**:
  - Revert `cni-exclusive: true` and check Cilium logs:
    ```bash
    kubectl logs -n kube-system -l k8s-app=cilium | grep "cni"
    ```
  - Verify `istio-cni-config` settings and reapply the IstioOperator.
- **Unhealthy Pods**:
  - Check node resources and logs for specific pods:
    ```bash
    kubectl logs -n istio-system istio-cni-node-<pod-name>
    ```
  - Ensure `NET_ADMIN`, `NET_RAW`, and `SYS_ADMIN` capabilities are granted.
- **Community Support**:
  - Istio GitHub: https://github.com/istio/istio/issues
  - Cilium Slack: https://cilium.io/slack
  - Istio Discuss: https://discuss.istio.io/

## Conclusion
By disabling Cilium’s exclusive CNI mode and verifying the integration with Istio CNI, the reconciliation loop is resolved, stabilizing the `istio-cni-node` DaemonSet and restoring the IstioOperator to a healthy state. This solution ensures that both Cilium and Istio CNI can coexist, providing robust pod networking and service mesh functionality. Regular monitoring and validation are recommended to prevent future conflicts.

**Last Updated**: May 19, 2025
