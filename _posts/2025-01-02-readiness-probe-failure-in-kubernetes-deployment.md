---
layout: post
title: Readiness Probe Failure in Kubernetes Deployment
date: 2025-01-02
category: PostgreSQL
tags: [kubernetes, postgresql]
excerpt: "In a Kubernetes environment, a PostgreSQL deployment was experiencing issues with its readiness probe, leading to frequent failures. The readiness probe is a critical mechanism that helps Kubernetes determine whether a…"
read_time: 2
source_doc: 11_Readiness_Probe_Troubleshooting.md
draft_import: true
---
# Document: Readiness Probe Failure in Kubernetes Deployment

## Problem Overview

In a Kubernetes environment, a PostgreSQL deployment was experiencing issues with its readiness probe, leading to frequent failures. The readiness probe is a critical mechanism that helps Kubernetes determine whether a pod is ready to handle traffic. If the readiness probe fails, Kubernetes stops routing traffic to that pod, which can impact application availability.

### Symptoms
- The PostgreSQL pod (`avcs-rep-01-579fb5695d-5vnn7`) was consistently failing its readiness probe.
- The pod status showed as `1/2`, indicating that only one of the two containers in the pod was ready.
- Pod metrics indicated high CPU and memory usage, suggesting potential performance issues.

## Diagnosis

The readiness probe was configured to execute a health check script located at `/opt/crunchy/bin/postgres-ha/health/pgha-readiness.sh`. After running the script manually, it returned a success status code (200), indicating that the script itself was functioning properly. However, the readiness probe settings appeared to be too aggressive for the current load and initialization time of the PostgreSQL instance.

### Key Parameters in Readiness Probe
- `initialDelaySeconds`: Time to wait before the probe starts checking.
- `timeoutSeconds`: Maximum time to wait for the probe to respond.
- `failureThreshold`: Number of consecutive failures before the pod is marked as not ready.

## Solution

To resolve the readiness probe failures, the following adjustments were made to the deployment configuration:

### Changes Made
1. **Increased `initialDelaySeconds`**: This was changed from `15` to `60` seconds, allowing more time for the PostgreSQL instance to initialize before readiness checks begin.
2. **Increased `timeoutSeconds`**: This was modified from `1` to `5` seconds, providing more time for the health check to complete under load.

### Updated Readiness Probe Configuration
```yaml
readinessProbe:
  exec:
    command:
    - /opt/crunchy/bin/postgres-ha/health/pgha-readiness.sh
  failureThreshold: 3
  initialDelaySeconds: 60  # Increased delay
  periodSeconds: 10
  successThreshold: 1
  timeoutSeconds: 5        # Increased timeout
```

## Implementation Steps

1. **Direct Edit**: Used `kubectl edit` command to modify the deployment directly in the Kubernetes cluster.
   ```bash
   kubectl edit deployment avcs -n db-ns
   ```

2. **Alternative Method**: Exported the current deployment YAML, edited it locally, and then re-applied it.
   ```bash
   kubectl get deployment avcs -n db-ns -o yaml > avcs-deployment.yaml
   # Edit avcs-deployment.yaml and apply changes
   kubectl apply -f avcs-deployment.yaml
   ```

## Outcome

After implementing the changes, the PostgreSQL pod successfully passed its readiness probe checks. The adjustments allowed the pod to properly initialize and handle traffic, resulting in improved application availability. The pod status changed from `1/2` to `2/2`, indicating that both containers were now ready.

## Conclusion

The readiness probe failures were resolved by adjusting the probe's configuration parameters to better accommodate the initialization and load characteristics of the PostgreSQL instance. Regular monitoring and adjustments of readiness and liveness probes are essential for maintaining application reliability in a Kubernetes environment.
