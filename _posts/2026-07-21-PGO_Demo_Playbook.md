---
layout: post
title: "PGO Hands-On Demo & Operations Playbook"
date: 2026-07-21
category: PostgreSQL
tags: [postgresql, kubernetes, pgo, crunchy-data, patroni, pgbackrest, operator, high-availability, backup, disaster-recovery, monitoring, playbook]
excerpt: ""
read_time: 17
---

# PGO Hands-On Demo & Operations Playbook
### From "Operator Installed" to Production-Ready PostgreSQL on Kubernetes

> Audience: Platform engineers, SREs, DBAs presenting a live PGO capability demo.
> Primary source: https://access.crunchydata.com/documentation/postgres-operator/latest — official guidance is prioritized wherever community sources (Reddit, Stack Overflow, GitHub issues) conflict; such sources are explicitly labeled "Community note."
> Assumption: PGO operator pod is already `Running` in namespace `postgres-operator`; CRDs are registered. Demo namespace used throughout: `demo-db`. Cluster name used: `shopdb`. DB: `shopdb`. App user: `shopuser`.

---

## How to Use This Document

Each phase is a self-contained lab: Objective → Background → Architecture → Commands/YAML → Expected Output → Validation → Internals → Common Mistakes → Troubleshooting → Best Practices → Cleanup. Run phases in order for a first full pass; each can also be re-run independently once `shopdb` exists.

Create the demo namespace once, up front:
```bash
kubectl create namespace demo-db
```

---

## Phase 1 — Verify Operator Installation

**Objective:** Prove PGO is healthy before touching any cluster — this is the "first slide" of the demo.

**Background:** PGO is a single controller Deployment watching `PostgresCluster`/`PGUpgrade`/`PGAdmin` CRDs cluster-wide (or namespace-scoped).

**Commands:**
```bash
# Operator deployment health
kubectl -n postgres-operator get deployment pgo
kubectl -n postgres-operator get pods -l postgres-operator.crunchydata.com/control-plane=postgres-operator

# CRDs registered
kubectl get crd | grep postgres-operator.crunchydata.com

# RBAC
kubectl get clusterrole postgres-operator
kubectl get clusterrolebinding postgres-operator
kubectl -n postgres-operator get serviceaccount pgo

# Namespace
kubectl get ns postgres-operator

# Operator logs (reconciliation activity)
kubectl -n postgres-operator logs deploy/pgo --tail=50

# Events
kubectl -n postgres-operator get events --sort-by=.lastTimestamp

# Version verification (image tag = operator version)
kubectl -n postgres-operator get deployment pgo -o jsonpath='{.spec.template.spec.containers[0].image}'
```

**Expected Output:** `pgo` deployment `1/1` ready; three CRDs (`postgresclusters`, `pgupgrades`, `pgadmins`) listed; no `Warning` events.

**Note:** PGO does not use admission webhooks by default in the kustomize install path — if `kubectl get validatingwebhookconfigurations | grep postgres` returns nothing, that is expected, not an error.

**Validation:** All commands above return non-empty, healthy results with no `CrashLoopBackOff`/`Error` states.

**Common Mistakes:** Assuming a missing webhook means installation failed (it's optional); checking the wrong namespace.

**Cleanup:** None — this phase is read-only.

---

## Phase 2 — Deploy the First PostgreSQL Cluster

**Objective:** Go from zero to a running, production-shaped 3-node HA cluster, explaining every field live.

**Step 2a — Minimal single-instance cluster** (fastest first win):
```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: shopdb
  namespace: demo-db
spec:
  postgresVersion: 16
  instances:
    - name: instance1
      replicas: 1
      dataVolumeClaimSpec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: rook-ceph-block
        resources:
          requests:
            storage: 5Gi
  backups:
    pgbackrest:
      repos:
        - name: repo1
          volume:
            volumeClaimSpec:
              accessModes: ["ReadWriteOnce"]
              storageClassName: rook-ceph-block
              resources:
                requests:
                  storage: 5Gi
```
```bash
kubectl apply -f shopdb-basic.yaml
kubectl -n demo-db get pods -w
```
**Expected Output:** `shopdb-instance1-xxxx-0` reaches `2/2 Running` (database + pgBackRest containers) within ~60-90s; a `shopdb-repo-host-0` pod also appears.

**Step 2b — Evolve to production-grade HA** (edit in place, `kubectl apply` again):
```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: shopdb
  namespace: demo-db
  labels:
    environment: demo
spec:
  postgresVersion: 16
  instances:
    - name: instance1
      replicas: 3
      resources:
        requests: { cpu: "1", memory: "2Gi" }
        limits: { cpu: "2", memory: "2Gi" }
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  postgres-operator.crunchydata.com/cluster: shopdb
                  postgres-operator.crunchydata.com/instance-set: instance1
      dataVolumeClaimSpec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: rook-ceph-block
        resources:
          requests: { storage: 10Gi }
  users:
    - name: shopuser
      databases: ["shopdb"]
  proxy:
    pgBouncer:
      replicas: 2
  monitoring:
    pgmonitor:
      exporter: {}
  backups:
    pgbackrest:
      repos:
        - name: repo1
          schedules:
            full: "0 1 * * 0"
          volume:
            volumeClaimSpec:
              accessModes: ["ReadWriteOnce"]
              storageClassName: rook-ceph-block
              resources:
                requests: { storage: 10Gi }
```
```bash
kubectl apply -f shopdb-ha.yaml
kubectl -n demo-db get pods -l postgres-operator.crunchydata.com/cluster=shopdb -w
```
**Expected Output:** Scales to 3 instance pods + 2 pgBouncer pods + 1 repo-host pod, rolled out one at a time.

**What's happening internally:** PGO diffs the new spec against generated StatefulSets/Services, adds two new instance pods via Patroni's bootstrap-from-primary path (`pg_basebackup`-equivalent), and updates the pgBouncer Deployment replica count.

**Common Mistakes:** Forgetting `storageClassName` (leaves PVC unbound — see Phase 16); setting CPU `limits` equal to `requests` and expecting no throttling under load spikes.

**Cleanup (end of demo only):** `kubectl -n demo-db delete postgrescluster shopdb`

---

## Phase 3 — Explore Generated Resources

**Objective:** Show the supervisor *everything* PGO created from that one CR — this is usually the most impressive part of a live demo.

```bash
kubectl -n demo-db get all -l postgres-operator.crunchydata.com/cluster=shopdb
kubectl -n demo-db get statefulset,pod,svc,endpoints,configmap,secret,pvc,job,cronjob -l postgres-operator.crunchydata.com/cluster=shopdb
kubectl -n demo-db get secrets -o custom-columns=NAME:.metadata.name | grep shopdb
kubectl -n demo-db describe postgrescluster shopdb
```

| Resource type | Name pattern | Why it exists |
|---|---|---|
| Pods | `shopdb-instance1-xxxx-0/1/2` | Patroni-managed Postgres instances |
| Pod | `shopdb-repo-host-0` | pgBackRest repository host (local PVC repo) |
| Pods | `shopdb-pgbouncer-xxxx` | Connection pooling layer |
| Service | `shopdb-ha` | Routes to current Patroni leader |
| Service | `shopdb-replicas` | Load-balances across ready replicas |
| Service | `shopdb-pgbouncer` | Pooled connection entrypoint |
| Service (headless) | `shopdb-pods` | Direct pod DNS for Patroni/replication |
| Secret | `shopdb-pguser-shopuser` | App connection credentials + URI |
| Secret | `shopdb-cluster-cert` | TLS server cert (auto-generated) |
| ConfigMap | (Patroni DCS keys, via Endpoints/Leases) | Distributed leader-election state |
| Job | `shopdb-repo1-stanza-create` | One-time pgBackRest stanza initialization |
| CronJob | `shopdb-repo1-full` (if scheduled) | Automated backup trigger |
| PVC | `shopdb-instance1-xxxx-pgdata` | PGDATA storage per instance |
| PVC | `shopdb-repo-host-0-repo1` | Local backup repository storage |

**Validation:** Decode a secret to prove real credentials exist:
```bash
kubectl -n demo-db get secret shopdb-pguser-shopuser -o jsonpath='{.data.password}' | base64 -d
```

**Cleanup:** None — read-only exploration.

---

## Phase 4 — Database Operations & Client Connectivity

**Objective:** Demonstrate DBA tasks and connect via psql, pgAdmin, and DBeaver — this is the section your supervisor will care most about seeing live.

### 4.1 Common DBA tasks via psql

```bash
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -c database -- \
  psql -h 127.0.0.1 -U shopuser -d shopdb
```

**Note:** The `-h 127.0.0.1` flag forces a TCP connection instead of the Unix domain socket. PGO’s generated `pg_hba.conf` does not include a `local` socket entry for application users, so omitting `-h` produces: `no pg_hba.conf entry for host "[local]"`.
```sql
CREATE TABLE products (id serial PRIMARY KEY, name text, price numeric);
INSERT INTO products (name, price) VALUES ('Demo Widget', 9.99);
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT SELECT ON products TO shopuser;
\copy products TO '/tmp/products.csv' CSV HEADER;   -- export
\copy products FROM '/tmp/products.csv' CSV HEADER; -- import
```

### 4.2 Connecting externally: port-forward (fastest for a live demo)

```bash
kubectl -n demo-db port-forward svc/shopdb-ha 5432:5432
psql "host=localhost port=5432 dbname=shopdb user=shopuser sslmode=require"
```

### 4.3 NodePort / LoadBalancer / Ingress

```bash
# NodePort (works on bare-metal/on-prem, like this Dhaka-based cluster)
kubectl -n demo-db expose svc shopdb-ha --type=NodePort --name=shopdb-ha-nodeport \
  --port=5432 --target-port=5432 --selector=postgres-operator.crunchydata.com/patroni=shopdb-ha
```
**Community note:** Ingress controllers designed for HTTP (e.g. NGINX Ingress) do **not** natively proxy raw Postgres TCP traffic — an EKS user on Reddit hit exactly this and had to switch to TCP-mode/HAProxy Ingress or a `LoadBalancer` Service instead [web:65]. This is a very common first-time mistake worth calling out live.

### 4.4 pgAdmin (PGO-managed, browser-based)

```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PGAdmin
metadata:
  name: shopdb-pgadmin
  namespace: demo-db
spec:
  dataVolumeClaimSpec:
    accessModes: ["ReadWriteOnce"]
    resources:
      requests: { storage: 1Gi }
  serverGroups:
    - name: demo
      postgresClusterSelector:
        matchLabels:
          postgres-operator.crunchydata.com/cluster: shopdb
```
```bash
kubectl apply -f shopdb-pgadmin.yaml
kubectl -n demo-db port-forward svc/shopdb-pgadmin 5050:5050
# Browse http://localhost:5050 — login with the pguser Secret credentials
```
[image:1]

**Community note:** Several users report the pgAdmin pod comes up but the login page 404s/won't authenticate — GitHub issue #3672 traces this to a missing `userInterface.pgAdmin` block on older PGO versions vs. the newer standalone `PGAdmin` CRD shown above; using the standalone CRD (current official approach) avoids this [web:67].

### 4.5 DBeaver / DataGrip

Use the same port-forwarded `localhost:5432`, database `shopdb`, user `shopuser`, and the password from the `shopdb-pguser-shopuser` Secret. Enable SSL mode "require" in the connection's SSL tab since PGO enforces TLS by default.

**Troubleshooting connectivity:**

| Symptom | Likely cause | Fix |
|---|---|---|
| `password authentication failed` | Stale cached password after rotation | Re-fetch Secret value |
| `SSL connection required` | Client SSL mode set to `disable` | Set `sslmode=require` or higher |
| Connection refused via Ingress | HTTP-only Ingress can't proxy TCP [web:65] | Use NodePort/LoadBalancer/TCP-mode ingress |
| Timeout via NodePort | Firewall/security group blocking node port | Open port range in cloud security group |

**Cleanup:** `kubectl -n demo-db delete pgadmin shopdb-pgadmin; kubectl -n demo-db delete svc shopdb-ha-nodeport`

---

## Phase 5 — PostgreSQL Configuration

**Objective:** Show live parameter tuning and explain reload vs. restart behavior.

```yaml
spec:
  patroni:
    dynamicConfiguration:
      postgresql:
        parameters:
          shared_buffers: "512MB"      # requires restart
          work_mem: "16MB"             # reload only
          maintenance_work_mem: "256MB" # reload only
          max_connections: "200"       # requires restart
          wal_level: "replica"         # requires restart
          log_min_duration_statement: "500" # reload only
          autovacuum_max_workers: "4"  # requires restart
```
```bash
kubectl apply -f shopdb-ha.yaml
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -- patronictl show-config
```
**Internals:** Patroni classifies each parameter as reload-safe or restart-required internally; for restart-required params, PGO/Patroni performs a **rolling restart**, one pod at a time, always preserving quorum (never restarts a majority simultaneously).

**Validation:** `SHOW shared_buffers;` in psql after rollout completes.

**Common Mistakes:** Expecting `shared_buffers` changes to apply without any pod restart — always check `patronictl show-config` "pending restart" flag.

---

## Phase 6 — Patroni Demonstrations

**Objective:** This is the core HA story — spend real demo time here.

```bash
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -- patronictl list
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -- curl -s localhost:8008/health
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -- curl -s localhost:8008/cluster | jq
```

**Manual switchover (planned, safe):**
```bash
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -- \
  patronictl switchover --master shopdb-instance1-xxxx-0 --candidate shopdb-instance1-yyyy-0 --force
```

**Manual failover (forces promotion even if leader reachable — riskier):**
```bash
kubectl -n demo-db exec -it shopdb-instance1-xxxx-0 -- \
  patronictl failover --candidate shopdb-instance1-yyyy-0
```

| | Switchover | Failover |
|---|---|---|
| Trigger | Manual, planned | Manual (forced) or automatic (leader lost) |
| Downtime | Seconds, coordinated | Can be longer, uncoordinated |
| Risk | Low — old leader demoted cleanly | Higher — possible split-brain if misused on a reachable leader |
| When to use | Maintenance, node drains | True primary failure only |

**Synchronous vs asynchronous:**
```yaml
patroni:
  dynamicConfiguration:
    synchronous_mode: true   # zero data loss, higher write latency
```

**Automatic failover demo:** delete the current leader pod and watch Patroni elect a new one live:
```bash
kubectl -n demo-db delete pod shopdb-instance1-xxxx-0
watch kubectl -n demo-db exec -it shopdb-instance1-yyyy-0 -- patronictl list
```

**Cleanup:** None needed; cluster self-heals.

---

## Phase 7 — Scaling

```bash
# Add/remove replicas
kubectl -n demo-db patch postgrescluster shopdb --type='json' \
  -p='[{"op":"replace","path":"/spec/instances/0/replicas","value":4}]'

# Vertical scaling (edit resources in YAML, reapply)
# Storage resize (requires allowVolumeExpansion: true on StorageClass)
kubectl -n demo-db patch postgrescluster shopdb --type='merge' \
  -p='{"spec":{"instances":[{"name":"instance1","dataVolumeClaimSpec":{"resources":{"requests":{"storage":"20Gi"}}}}]}}'
```
Measure downtime during scaling: time a continuous `psql -c "select 1"` loop against `shopdb-ha` service while scaling — for replica-only changes, expect **zero write downtime**.

---

## Phase 8 — Backup Demonstrations

```bash
# Manual full backup
kubectl -n demo-db annotate postgrescluster shopdb \
  postgres-operator.crunchydata.com/pgbackrest-backup="$(date +%s)" --overwrite

# View CronJobs created by schedules
kubectl -n demo-db get cronjob
kubectl -n demo-db logs job/<backup-job-name>

# Verify repository contents
kubectl -n demo-db exec -it shopdb-repo-host-0 -- pgbackrest info --stanza=db
```
For S3/MinIO repos, add a second repo (`repo2`) as shown in the Production Guide's Section 8 — demo both a local PVC repo and an S3 repo side-by-side to show redundancy live.

---

## Phase 9 — Restore Demonstrations

**Restore to a brand-new cluster (safe, non-destructive — ideal for live demo):**
```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: shopdb-restore-demo
  namespace: demo-db
spec:
  postgresVersion: 16
  instances:
    - name: instance1
      dataVolumeClaimSpec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: rook-ceph-block
        resources: { requests: { storage: 10Gi } }
  backups:
    pgbackrest:
      repos:
        - name: repo1
          volume:
            volumeClaimSpec:
              accessModes: ["ReadWriteOnce"]
              storageClassName: rook-ceph-block
              resources: { requests: { storage: 10Gi } }
  dataSource:
    postgresCluster:
      clusterName: shopdb
      repoName: repo1
      options: ["--type=immediate"]
```
For PITR, replace `options` with `["--type=time", "--target=<timestamp>"]`. Verify with `SELECT * FROM products;` in the restored cluster to prove data fidelity.

**Cleanup:** `kubectl -n demo-db delete postgrescluster shopdb-restore-demo`

---

## Phase 10 — Disaster Recovery Simulations

| Simulated failure | Command | Expected PGO/Patroni behavior | Expected RTO |
|---|---|---|---|
| Delete primary pod | `kubectl delete pod shopdb-instance1-xxxx-0` | Automatic failover, new leader elected | ~10-30s |
| Delete replica pod | `kubectl delete pod shopdb-instance1-yyyy-0` | Pod recreated, resyncs from primary | ~30-60s |
| Delete PVC (destructive!) | `kubectl delete pvc <pvc-name>` | Pod stuck; requires manual PVC recreation or replica reinit | Minutes |
| Node failure (drain) | `kubectl drain <node> --ignore-daemonsets` | Pod reschedules if PVC topology allows; failover if primary | Minutes |
| Corrupted database | Simulate via bad write, then restore | Full restore-to-new-cluster from Phase 9 | Depends on data size |

**RPO/RTO discussion for the demo:** streaming replication gives near-zero RPO/fast RTO; PITR-only recovery has RPO bounded by WAL archive push frequency and RTO scaling with data volume — present both live for contrast.

---

## Phase 11 — Kubernetes Failure Scenarios

Demonstrate PGO's resilience to generic K8s issues: pod eviction (`kubectl drain`), resource pressure (`kubectl top pod` before/after a stress test), image pull failure (temporarily typo an image tag and observe `ImagePullBackOff`, then revert), and PVC Multi-Attach errors after a forced node loss (see Troubleshooting catalog, Phase 16, for the full resolution runbook).

---

## Phase 12 — Monitoring

```yaml
spec:
  monitoring:
    pgmonitor:
      exporter: {}
```
```bash
kubectl -n demo-db port-forward svc/shopdb-instance1-xxxx 9187:9187
curl localhost:9187/metrics | grep pg_up
```
Deploy Prometheus + Grafana (via your existing cluster monitoring stack) and import Crunchy's official pgMonitor dashboards. Key panels to show live: replication lag, connections, backup age, checkpoint frequency, WAL generation rate.

---

## Phase 13 — Application Integration

### Django
```python
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'shopdb',
        'USER': 'shopuser',
        'PASSWORD': os.environ['DB_PASSWORD'],
        'HOST': 'shopdb-pgbouncer',
        'PORT': '5432',
        'OPTIONS': {'sslmode': 'require'},
    }
}
```
```yaml
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef: { name: shopdb-pguser-shopuser, key: password }
```
Run `python manage.py migrate` against the pgBouncer endpoint, then perform CRUD via the app while triggering a switchover (Phase 6) to demonstrate the app reconnecting transparently.

### Laravel (.env)
```
DB_CONNECTION=pgsql
DB_HOST=shopdb-pgbouncer
DB_PORT=5432
DB_DATABASE=shopdb
DB_USERNAME=shopuser
DB_PASSWORD=${DB_PASSWORD}
```
Run `php artisan migrate` the same way. The same Secret-injection pattern applies to Spring Boot (`application.yml` datasource), Node/Express (`pg` client config), and Go (`database/sql` + `lib/pq`/`pgx`).

**Failover behavior demo:** run a simple write-loop script against the app while triggering `patronictl switchover`; observe brief connection errors (expected — clients must reconnect) then successful resumption, illustrating that PGO gives HA at the *database* layer, but applications still need connection retry logic for true zero-downtime.

---

## Phase 14 — Security

- **TLS:** Default operator-managed certs, or supply `customTLSSecret`; demo verifying `sslmode=require` is enforced by testing `sslmode=disable` fails.
- **Password rotation:** `kubectl -n demo-db delete secret shopdb-pguser-shopuser` — PGO regenerates on next reconcile.
- **RBAC:** Show the `postgres-operator` ClusterRole scope; contrast with a namespace-scoped install.
- **NetworkPolicy:** Add a policy restricting ingress to `shopdb-ha`/`shopdb-pgbouncer` from only the app namespace.
- **Least privilege:** Use `readonlyuser` (from the Production Guide) for reporting connections instead of the app's write user.

---

## Phase 15 — Day-2 Operations

Cover PostgreSQL major version upgrade via `PGUpgrade` CRD, PGO operator upgrade (reapply newer `config/default`), pod/cluster restarts via annotation, storage class changes, adding a second backup repo, and certificate/config rotation — all detailed with commands in the companion Production Guide (Sections 13 and 15).

---

## Phase 16 — Troubleshooting Workshop

| Issue | Symptoms | Root Cause | Diagnostic | Resolution | Prevention |
|---|---|---|---|---|---|
| Cluster won't start | No pods appear | CRDs not ready when CR applied (race condition) | `kubectl get crd \| grep postgres-operator` | Wait, reapply | Add delay/wait step in scripts |
| Pods stuck Pending | `describe pod` shows unbound PVC | Wrong/missing StorageClass | `kubectl get pvc`, `kubectl get sc` | Fix `storageClassName` | Validate SC exists pre-deploy |
| CrashLoopBackOff | Repeated restarts | Bad config param, OOMKill | `kubectl logs --previous` | Revert config, raise memory limits | Test config in staging first |
| Failed backups | Job `Error`/stuck | PVC full, S3 auth failure | `pgbackrest info`, job logs | Fix creds/free space | Alert on backup age |
| Restore failures | Restore job never completes | Wrong `clusterName`/`repoName`, version mismatch | Job logs | Correct `dataSource` fields | Validate before demo |
| Replication lag | `patronictl list` shows high lag | Slow replica I/O, long queries | `patronictl list`, `pg_stat_replication` | `patronictl reinit` | Match replica sizing to primary |
| Leader election problems | No promotion after failure | All replicas exceed `maximum_lag_on_failover` | `patronictl history` | Manual `failover` once safe | Tune lag threshold appropriately |
| PVC full | Write errors, alerts | Undersized volume, WAL bloat | `df -h` in pod, `kubectl exec` | Expand PVC | Monitor disk usage proactively |
| WAL growth unbounded | Disk fills despite normal traffic | **Community-reported**: stale replication slot for an offline standby retains WAL indefinitely [web:69] | `pg_replication_slots` | Drop stale slot | Alert on slot lag, remove decommissioned standbys' slots |
| High CPU | Sustained load | Missing indexes, bad query plans | `pg_stat_activity` | Kill/optimize query | Query review, `pg_stat_statements` |
| High memory | OOM risk | `work_mem` too high × many connections | `kubectl top pod` | Lower `work_mem`, add pgBouncer | Pool connections |
| Slow queries | App latency | Missing indexes, lock contention | `EXPLAIN ANALYZE`, `pg_stat_activity` | Add index, tune query | Regular query audits |
| Authentication failures | `password authentication failed` | Stale cached credential | App logs | Refetch Secret | Rolling restart on rotation |
| TLS issues | Handshake failure | CA mismatch across primary/standby | `openssl s_client` | Ensure common CA | Standardize cert issuance |
| pgBackRest failures | `stanza-create` job fails | Repo storage/permission issue | Job logs | Fix PVC/IAM perms | Pre-validate repo config |
| Patroni failures | DCS unreachable | RBAC/network issue to Endpoints/Leases API | `patronictl list` errors | Fix RBAC | Test failover in staging |
| S3 auth errors | `could not connect to S3 bucket` | Wrong keys/region/endpoint | Job/pod logs | Fix Secret/IAM policy | Rotate & test creds regularly |
| MinIO connectivity | Same as S3 but self-hosted | Wrong URI style (`path` vs `host`) | Job logs | Set `repo1-s3-uri-style: path` | Document MinIO-specific config |
| Ingress can't proxy Postgres | Connection refused via HTTP Ingress | HTTP-only Ingress used for TCP traffic **(Community note, Reddit)** [web:65] | Ingress logs | Switch to NodePort/LB or TCP-mode Ingress (HAProxy) | Use LB/NodePort for DB traffic by default |
| pgAdmin login fails | 404/auth failure on pgAdmin UI | Using deprecated `userInterface.pgAdmin` field **(Community note, GitHub #3672)** [web:67] | pgAdmin pod logs | Migrate to standalone `PGAdmin` CRD | Use current CRD API from the start |
| Custom image deploy errors | Pod fails to start with custom image | Missing required binaries/labels expected by PGO in custom builds **(Community note, Stack Overflow)** [web:66] | Pod logs, `describe pod` | Rebuild image from Crunchy's base UBI image | Always base custom images on official Crunchy images |

---

## Phase 17 — Demo Scenarios Checklist (Live Presentation Script)

1. ☐ Show operator health (Phase 1)
2. ☐ Deploy `shopdb` HA cluster live (Phase 2)
3. ☐ Walk through generated resources (Phase 3)
4. ☐ Connect via `psql` (Phase 4.1)
5. ☐ Connect via pgAdmin in browser (Phase 4.4)
6. ☐ Connect via DBeaver (Phase 4.5)
7. ☐ Deploy sample Django app, run migration, verify CRUD (Phase 13)
8. ☐ Kill primary pod → show automatic failover (Phase 6/10)
9. ☐ Perform planned manual switchover (Phase 6)
10. ☐ Trigger manual backup, show in `pgbackrest info` (Phase 8)
11. ☐ Restore to new cluster, verify data (Phase 9)
12. ☐ Scale replicas live, measure zero write downtime (Phase 7)
13. ☐ Change a PostgreSQL parameter, show rolling restart (Phase 5)
14. ☐ Show Grafana dashboard with live metrics (Phase 12)
15. ☐ Rotate app user's password, show app picks up new Secret (Phase 14)
16. ☐ (Optional, if time) PostgreSQL minor version upgrade (Phase 15)
17. ☐ Clone `shopdb` into a "staging" copy from backups (Phase 9)

---

## Reference Links

- Official docs: https://access.crunchydata.com/documentation/postgres-operator/latest
- pgAdmin CRD blog: https://www.crunchydata.com/blog/cpk-5-5-a-new-pgadmin-experience [web:61]
- Patroni docs: https://patroni.readthedocs.io
- pgBackRest docs: https://pgbackrest.org/user-guide.html
- Community pgAdmin issue: https://github.com/CrunchyData/postgres-operator/issues/3672 [web:67]
- Community Ingress/TCP discussion: https://www.reddit.com/r/kubernetes/comments/1jd6e3f/ [web:65]
- Open community issues catalog: https://github.com/crunchydata/postgres-operator/issues [web:69]
