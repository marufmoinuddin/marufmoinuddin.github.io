---
layout: doc
title: "Patroni Cluster Maintenance Procedures"
category: postgresql
order: 1
last_updated: 2026-07-15
tags: [postgresql, patroni, maintenance, ha]
---

## Scheduled Switchover

Patroni makes switchovers painless:

```bash
patronictl -c /etc/patroni/patroni.yml switchover
```

Follow the prompts to select the target node.

## Manual Failover

```bash
patronictl -c /etc/patroni/patroni.yml failover
```

## Checking Cluster State

```bash
patronictl -c /etc/patroni/patroni.yml list

+ Cluster: pg-cluster (1234567890) +--------+----+-----------+
| Member  | Host       | Role    | State   | TL | Lag in MB |
+---------+------------+---------+---------+----+-----------+
| pg-node1| 10.0.0.1:5432| Leader  | running |  1 |           |
| pg-node2| 10.0.0.2:5432| Replica | running |  1 |         0 |
| pg-node3| 10.0.0.3:5432| Replica | running |  1 |         0 |
+---------+------------+---------+---------+----+-----------+
```
