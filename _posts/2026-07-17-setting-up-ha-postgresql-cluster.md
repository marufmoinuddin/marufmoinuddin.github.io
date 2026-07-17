---
layout: post
title: "Setting Up a Highly Available PostgreSQL Cluster"
date: 2026-07-17
category: PostgreSQL
tags: [postgresql, patroni, haproxy, ha, replication]
excerpt: "A field-tested approach to zero-downtime PostgreSQL failover using Patroni, etcd, and HAProxy."
featured: true
read_time: 8
---

## Why High Availability for PostgreSQL?

In production environments, database downtime means revenue loss, customer trust erosion, and late-night incident calls. A highly available PostgreSQL cluster ensures that if your primary node fails, a standby promotes automatically with minimal to zero downtime.

## Architecture Overview

The stack we'll use:

- **Patroni** — the brain. Manages PostgreSQL instance state, handles failover, and exposes a REST API.
- **etcd** — the distributed configuration store. Patroni uses it for leader election and cluster state.
- **HAProxy** — the traffic router. Proxies connections to the current primary based on Patroni's health checks.
- **PostgreSQL streaming replication** — keeps standby nodes in sync.

## Prerequisites

- 3+ Linux servers (VMs or bare metal)
- Ubuntu 22.04 LTS recommended
- Network connectivity between all nodes (ports 5432, 2379, 8008)
- `postgresql-common` and `python3` installed

## Step 1: Install PostgreSQL

```bash
# On all nodes
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16 python3-pip
sudo systemctl stop postgresql
sudo systemctl disable postgresql
```

## Step 2: Install and Configure etcd

```bash
# On etcd nodes (at least 3 for quorum)
sudo apt install -y etcd
```

Configure `/etc/default/etcd`:

```ini
ETCD_NAME="node1"
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_INITIAL_CLUSTER="node1=http://10.0.0.1:2380,node2=http://10.0.0.2:2380,node3=http://10.0.0.3:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="pg-cluster"
ETCD_LISTEN_CLIENT_URLS="http://0.0.0.0:2379"
ETCD_ADVERTISE_CLIENT_URLS="http://10.0.0.1:2379"
ETCD_LISTEN_PEER_URLS="http://0.0.0.0:2380"
ETCD_ADVERTISE_PEER_URLS="http://10.0.0.1:2380"
```

> **Callout — Note:** Ensure `ETCD_INITIAL_CLUSTER` is identical on all nodes. A mismatch here will prevent the cluster from forming.

## Step 3: Install and Configure Patroni

```bash
pip3 install patroni[etcd]
```

Create `/etc/patroni/patroni.yml`:

```yaml
scope: pg-cluster
namespace: /db/
name: pg-node1

restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.0.1:8008

etcd:
  host: 127.0.0.1:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    postgresql:
      use_pg_rewind: true
      parameters:
        wal_level: replica
        hot_standby: "on"
        max_wal_senders: 10
        max_replication_slots: 10
        wal_log_hints: "on"

  initdb:
    - encoding: UTF8
    - data-checksums

  pg_hba:
    - host replication replicator 10.0.0.0/8 md5
    - host all all 10.0.0.0/8 md5

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.0.1:5432
  data_dir: /var/lib/postgresql/16/main
  bin_dir: /usr/lib/postgresql/16/bin
  authentication:
    replication:
      username: replicator
      password: strong-password-here
    superuser:
      username: postgres
      password: strong-password-here
```

## Step 4: Configure HAProxy

```haproxy
frontend pg_frontend
    bind *:5000
    option tcplog
    mode tcp
    default_backend pg_backend

backend pg_backend
    mode tcp
    option tcp-check
    option httpchk OPTIONS /primary
    http-check expect status 200

    server pg-node1 10.0.0.1:5432 check port 8008 inter 3000 rise 2 fall 3
    server pg-node2 10.0.0.2:5432 check port 8008 inter 3000 rise 2 fall 3
    server pg-node3 10.0.0.3:5432 check port 8008 inter 3000 rise 2 fall 3
```

## Step 5: Start the Cluster

```bash
# On each node, start Patroni
sudo systemctl enable patroni
sudo systemctl start patroni
```

Check cluster status:

```bash
patronictl -c /etc/patroni/patroni.yml list
```

## Failover Testing

To test automatic failover:

```bash
# Simulate primary failure
sudo systemctl stop patroni  # on the current leader
```

Watch as Patroni promotes a standby to primary. HAProxy will automatically route traffic to the new primary within seconds.

## Conclusion

You now have a production-grade HA PostgreSQL cluster with:

- Automatic failover under 30 seconds
- No data loss (synchronous replication mode optional)
- Centralized management via Patroni CLI
- Connection routing via HAProxy health checks
