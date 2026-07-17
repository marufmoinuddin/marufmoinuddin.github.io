---
layout: post
title: Fix Prometheus Pod Forbidden Errors
date: 2025-03-06
category: Kubernetes
tags: [kubernetes, postgresql, prometheus]
excerpt: "You’re seeing \"forbidden\" errors in the Prometheus pod logs, specifically for listing and watching pods. The service account used by Prometheus doesn’t have the necessary permissions to access cluster-wide resources."
read_time: 3
source_doc: 38_Fix_Prometheus.md
draft_import: true
---
# Fix Prometheus Pod Forbidden Errors

## Issue
You’re seeing "forbidden" errors in the Prometheus pod logs, specifically for listing and watching pods. The service account used by Prometheus doesn’t have the necessary permissions to access cluster-wide resources.

### What We See
1. **`kubectl get clusterrole -l app=crunchy-prometheus`**
   - Output: `No resources found`
   - This means there’s no `ClusterRole` labeled with `app=crunchy-prometheus`. Either it wasn’t created, or it doesn’t have the expected label.

2. **`kubectl get clusterrolebinding -l app=crunchy-prometheus`**
   - Output: `No resources found`
   - Similarly, there’s no `ClusterRoleBinding` with that label. This confirms that the `prometheus` service account isn’t bound to any cluster-wide permissions (at least not under this label).

3. **`kubectl describe serviceaccount prometheus -n postgres-operator`**
   - Output:
     ```
     Name:                prometheus
     Namespace:           postgres-operator
     Labels:              app.kubernetes.io/component=crunchy-prometheus
                          app.kubernetes.io/name=crunchy-monitoring
                          vendor=crunchydata
     Annotations:         <none>
     Image pull secrets:  <none>
     Mountable secrets:   <none>
     Tokens:              <none>
     Events:              <none>
     ```
   - The `prometheus` service account exists in the `postgres-operator` namespace, and it’s labeled as part of the Crunchy Data monitoring stack. However, it has no associated `Secrets` or `Tokens`, and more importantly, there’s no indication it’s linked to any RBAC roles yet.

### Why the Errors Persist
The logs you shared earlier show that the `prometheus` service account is trying to `list` and `watch` pods at the cluster scope, but it has no permissions to do so. The absence of a `ClusterRole` and `ClusterRoleBinding` explains this—it’s not misconfigured; the necessary RBAC resources simply don’t exist (or weren’t applied).

---

## Fixing the Issue
Since there’s no existing `ClusterRole` or `ClusterRoleBinding`, let’s create them as I suggested earlier, tailored to your setup. We’ll also add labels to match the Crunchy Data conventions for consistency.

#### Step 1: Create a ClusterRole
This will allow the service account to `list`, `get`, and `watch` pods cluster-wide. Save this as `prometheus-clusterrole.yaml`:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: crunchy-prometheus-pod-reader
  labels:
    app.kubernetes.io/component: crunchy-prometheus
    app.kubernetes.io/name: crunchy-monitoring
    vendor: crunchydata
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
```
Apply it:
```bash
kubectl apply -f prometheus-clusterrole.yaml
```

#### Step 2: Create a ClusterRoleBinding
This binds the `prometheus` service account to the `ClusterRole`. Save this as `prometheus-clusterrolebinding.yaml`:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: crunchy-prometheus-pod-reader-binding
  labels:
    app.kubernetes.io/component: crunchy-prometheus
    app.kubernetes.io/name: crunchy-monitoring
    vendor: crunchydata
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: postgres-operator
roleRef:
  kind: ClusterRole
  name: crunchy-prometheus-pod-reader
  apiGroup: rbac.authorization.k8s.io
```
Apply it:
```bash
kubectl apply -f prometheus-clusterrolebinding.yaml
```

#### Step 3: Verify the Resources
Check that they’re created:
```bash
kubectl get clusterrole -l app.kubernetes.io/component=crunchy-prometheus
kubectl get clusterrolebinding -l app.kubernetes.io/component=crunchy-prometheus
```
You should see `crunchy-prometheus-pod-reader` and `crunchy-prometheus-pod-reader-binding` listed.

#### Step 4: Restart the Pod
The Prometheus pod needs to pick up the new permissions. Delete it to force a restart:
```bash
kubectl delete pod crunchy-prometheus-6499f688c6-tvkvb -n postgres-operator
```
Kubernetes will recreate it. Get the new pod name:
```bash
kubectl get pods -n postgres-operator -l app.kubernetes.io/component=crunchy-prometheus
```
Then check the logs:
```bash
kubectl logs -n postgres-operator <new-pod-name> | tail -n 10
```

### What to Expect
If everything’s set up correctly, those "pods is forbidden" errors should stop appearing in the logs. Prometheus should now be able to list and watch pods without issues.

### If It Still Fails
If the errors persist:
1. **Confirm the Service Account**: Check the pod’s spec to ensure it’s using the `prometheus` service account:
   ```bash
   kubectl describe pod <new-pod-name> -n postgres-operator
   ```
   Look for `serviceAccountName: prometheus` under `spec`.

2. **Wider Permissions**: The logs only mention `pods`, but Prometheus might need access to other resources (e.g., `services`, `endpoints`). If you see new "forbidden" errors, we can expand the `ClusterRole`.

3. **Operator Docs**: Since this is part of the Crunchy PostgreSQL Operator, double-check their monitoring setup guide (e.g., on [Crunchy Data’s site](https://www.crunchydata.com) or GitHub). They might expect a specific RBAC config you didn’t apply.
