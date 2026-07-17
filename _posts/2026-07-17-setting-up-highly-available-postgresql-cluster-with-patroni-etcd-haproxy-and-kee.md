---
layout: post
title: "Setting Up Highly Available PostgreSQL Cluster with Patroni, etcd, HAProxy, and Keepalived"
date: 2026-07-17
category: PostgreSQL
tags: [backup, etcd, haproxy, high-availability, patroni, pgbackrest, postgresql]
excerpt: 1. Overview 2. Architecture 3. Prerequisites 4. Initial Setup - Hostname Configuration - Package Installation
read_time: 19
source_doc: 27_KYC_DB_Environment_Setup.md
draft_import: true
---
# Setting Up Highly Available PostgreSQL Cluster with Patroni, etcd, HAProxy, and Keepalived

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Initial Setup](#initial-setup)
    - [Hostname Configuration](#hostname-configuration)
    - [Package Installation](#package-installation)
5. [etcd Cluster Setup](#etcd-cluster-setup)
    - [Configuration Steps](#configuration-steps)
6. [Keepalived Setup](#keepalived-setup)
    - [Configuration Steps](#configuration-steps)
7. [Patroni Configuration](#patroni-configuration)
    - [Environment Setup](#environment-setup)
    - [Create Patroni Configuration](#create-patroni-configuration)
    - [Create Patroni Service](#create-patroni-service)
    - [Start Patroni Service](#start-patroni-service)
8. [HAProxy Configuration](#haproxy-configuration)
    - [Installation](#installation)
    - [Configuration](#configuration)
    - [Start HAProxy](#start-haproxy)
9. [Connection Testing](#connection-testing)
    - [Test Primary Connection](#test-primary-connection)
10. [Verification and Testing](#verification-and-testing)
    - [Check Cluster Status](#check-cluster-status)
11. [Restoring Old Data to New Cluster](#restoring-old-data-to-new-cluster)
    - [Backup the Data from the Previous Cluster](#backup-the-data-from-the-previous-cluster)
    - [Create users and restore the data in the new cluster](#create-users-and-restore-the-data-in-the-new-cluster)
    - [Test and verify the data in the new cluster](#test-and-verify-the-data-in-the-new-cluster)
12. [pgBackRest Setup](#pgbackrest-setup)
    - [Host Configuration](#host-configuration)
    - [PostgreSQL Node Configuration for pgBackRest](#postgresql-node-configuration-for-pgbackrest)
13. [Monitoring PostgreSQL with Percona Monitoring and Management (PMM)](#monitoring-postgresql-with-percona-monitoring-and-management-<REDACTED_USERNAME>)
    - [PMM Server Installation](#<REDACTED_USERNAME>-server-installation)
    - [PMM Client Installation](#<REDACTED_USERNAME>-client-installation)
    - [PMM Configuration](#<REDACTED_USERNAME>-configuration)
14. [Conclusion](#conclusion)
15. [Resources](#resources)


## Overview

In this guide, we are setting up a highly available PostgreSQL cluster using several key components: Patroni, etcd, HAProxy, and Keepalived. Patroni is a template for PostgreSQL high availability, allowing us to manage PostgreSQL clusters with automatic failover. etcd is a distributed key-value store that provides a reliable way to store data across a cluster of machines, ensuring that Patroni can maintain consensus on the state of the cluster. HAProxy is a high-performance TCP/HTTP load balancer that will distribute database connections across the PostgreSQL nodes, ensuring that read and write operations are directed appropriately. Finally, Keepalived is used to manage a virtual IP (VIP) that provides a single, consistent endpoint for database connections, even in the event of node failures. By following this guide, you will learn how to configure and integrate these components to create a robust and resilient PostgreSQL cluster suitable for production environments.

## Architecture

The cluster consists of:
- 3 PostgreSQL nodes with Patroni
- Distributed etcd cluster
- HAProxy on each node
- Keepalived for VIP management
- Virtual IP (VIP) for high availability

| Node Name | Role | IP Address |
|-----------|------|------------|
| <REDACTED_HOSTNAME> | PostgreSQL + Patroni + etcd | <REDACTED_IP> |
| <REDACTED_HOSTNAME> | PostgreSQL + Patroni + etcd | <REDACTED_IP> |
| <REDACTED_HOSTNAME> | PostgreSQL + Patroni + etcd | <REDACTED_IP> |
| <REDACTED_HOSTNAME> | pgBackRest + PMM Server | <REDACTED_IP> |
| Virtual IP | High Availability Endpoint | <REDACTED_IP> |

> Note: The VIP is used as the primary connection endpoint for applications.

## Architecture Diagram

The following diagram illustrates the complete node architecture of our PostgreSQL high availability setup:

![PostgreSQL High Availability Architecture](pg-docs/2025-03-09_02-44.png)

*Figure 1: PostgreSQL HA Cluster Node Architecture showing all components distributed across nodes*

The diagram shows how each component is distributed across the different nodes:

- **<REDACTED_HOSTNAME>, <REDACTED_HOSTNAME>, <REDACTED_HOSTNAME>**: Each database node contains PostgreSQL, Patroni, etcd, HAProxy, Keepalived, and PMM Client
- **<REDACTED_HOSTNAME>**: Dedicated backup node running pgBackRest and PMM Server
- **Virtual IP (<REDACTED_IP>)**: Floating IP that provides a stable connection endpoint for applications

This architecture ensures high availability with automatic failover capabilities, comprehensive backup solutions, and performance monitoring.

> **Note:** To regenerate this diagram if needed, you can use the [Mermaid Live Editor](https://mermaid.live/) with the diagram code available in the documentation source.

## Prerequisites

Before starting the setup, ensure you have the following:

- Ubuntu 22.04 or later
- Sudo privileges on all nodes
- Network connectivity between nodes
- Required ports:
  - PostgreSQL: 5432
  - Patroni: 8008
  - etcd: 2379, 2380
  - HAProxy: 5433
  - Keepalived: VRRP (112)


## Initial Setup

In this part, we will configure the basic environment settings, including hostname configuration and package installation. These are needed to prepare the nodes for the subsequent steps.

### Hostname Configuration
1. Set the hostname on each node:
```bash
# On respective nodes
    sudo hostnamectl set-hostname <REDACTED_HOSTNAME>  # For node 1

    sudo hostnamectl set-hostname <REDACTED_HOSTNAME>  # For node 2
    
    sudo hostnamectl set-hostname <REDACTED_HOSTNAME>  # For node 3
```
> Note: Replace `<REDACTED_HOSTNAME>`, `<REDACTED_HOSTNAME>`, and `<REDACTED_HOSTNAME>` with the actual hostnames.

2. Update `/etc/hosts` on all nodes:
```
    # Add to /etc/hosts
    <REDACTED_IP> <REDACTED_HOSTNAME>
    <REDACTED_IP> <REDACTED_HOSTNAME>
    <REDACTED_IP> <REDACTED_HOSTNAME>
```
> Note: Replace IP addresses with the actual IP addresses of the nodes.

### Package Installation
Install required packages on all nodes:
```bash
    # Add Percona repository
    sudo percona-release setup ppg12

    # Install required packages
    sudo apt update
    sudo apt install -y \
        percona-postgresql-12 \
        percona-patroni \
        etcd \
        percona-haproxy \
        keepalived \
        python3-pip \
        python3-dev
```

## etcd Cluster Setup

The etcd cluster is a critical component in the Patroni architecture, serving as the distributed key-value store that enables high availability and automatic failover capabilities for PostgreSQL.

#### Key Functions
- Maintains cluster state information
- Handles leader election processes
- Stores configuration data
- Enables distributed consensus among nodes

#### Configuration Requirements
1. Each node in the cluster requires:
    - Unique etcd instance
    - Individual configuration file
    - Distinct network endpoints
    - Specific cluster membership settings

#### Important Considerations
- Minimum of 3 nodes recommended for fault tolerance
- Network connectivity between all nodes is essential
- Proper security configuration (TLS certificates if needed)
- Adequate storage for etcd data

#### Best Practices
- Use dedicated hosts for etcd when possible
- Implement proper backup strategies
- Monitor etcd cluster health
- Configure appropriate timeouts and heartbeat intervals
The etcd cluster provides the distributed consensus mechanism required for Patroni. Each node needs its own etcd configuration. 

### Configuration Steps
1. Create etcd service file on each node:

For <REDACTED_HOSTNAME> (`/etc/systemd/system/etcd.service`):
```ini
    [Unit]
    Description=etcd key-value store
    Documentation=https://etcd.io/docs/
    After=network.target

    [Service]
    Environment="TOKEN=demo-cluster-token"
    Environment="CLUSTER_STATE=new"
    Environment="NAME_1=<REDACTED_HOSTNAME>"
    Environment="NAME_2=<REDACTED_HOSTNAME>"
    Environment="NAME_3=<REDACTED_HOSTNAME>"
    Environment="HOST_1=<REDACTED_IP>"
    Environment="HOST_2=<REDACTED_IP>"
    Environment="HOST_3=<REDACTED_IP>"
    Environment="CLUSTER=${NAME_1}=http://${HOST_1}:2380,${NAME_2}=http://${HOST_2}:2380,${NAME_3}=http://${HOST_3}:2380"
    Environment="THIS_NAME=<REDACTED_HOSTNAME>"
    Environment="THIS_IP=<REDACTED_IP>"

    ExecStart=/usr/bin/etcd \
    --data-dir=/var/lib/etcd \
    --name ${THIS_NAME} \
    --initial-advertise-peer-urls http://${THIS_IP}:2380 \
    --listen-peer-urls http://${THIS_IP}:2380 \
    --advertise-client-urls http://${THIS_IP}:2379 \
    --listen-client-urls http://${THIS_IP}:2379 \
    --initial-cluster ${CLUSTER} \
    --initial-cluster-state ${CLUSTER_STATE} \
    --initial-cluster-token ${TOKEN}

    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
```
> Note: Replace `<REDACTED_HOSTNAME>`, `<REDACTED_IP>`, and other values with the actual values for the node.

Repeat for other nodes with appropriate THIS_NAME and THIS_IP values.

2. Start etcd service:
```bash
    sudo systemctl daemon-reload
    sudo systemctl enable etcd
    sudo systemctl start etcd
```

## Keepalived Setup

Keepalived is a Linux-based routing software that provides:
- High availability (HA)
- Load balancing
- Automatic failover capabilities

The Virtual IP (VIP) works like this:

```plaintext
Client → Virtual IP (192.168.1.100)
                ↙               ↘
    Database Server 1    Database Server 2
    (192.168.1.101)     (192.168.1.102)
```

#### Key Points:
- The VIP acts as a floating IP address that can move between servers
- If the primary database server fails, Keepalived automatically moves the VIP to the backup server
- Applications connect to the VIP instead of physical server IPs
- This provides seamless failover without requiring application reconfiguration

#### Benefits:
- **High Availability**: No single point of failure
- **Transparency**: Client applications don't need to know about the underlying server changes
- **Zero-downtime maintenance**: Servers can be maintained without service interruption

Think of it like having a single phone number (VIP) that can ring different phones (database servers) based on availability.

### Configuration Steps
1. Create Keepalived configuration (`/etc/keepalived/keepalived.conf`):
```
    vrrp_script check_haproxy {
        script "pgrep haproxy"
        interval 2
        weight 2
    }

    vrrp_instance VI_1 {
        state MASTER
        interface enp1s0
        virtual_router_id 51
        priority 101
        advert_int 1
        authentication {
            auth_type PASS
            auth_pass <REDACTED_PASSWORD>
        }
        virtual_ipaddress {
            <REDACTED_IP>
        }
        track_script {
            check_haproxy
        }
    }
```

> Note: Replace `enp1s0`, `<REDACTED_PASSWORD>`, and `<REDACTED_IP>` with the actual values.

2. Start Keepalived:
```bash
    sudo systemctl enable keepalived
    sudo systemctl restart keepalived
```

[Previous sections remain the same up to Patroni Configuration]

## Patroni Configuration

Patroni, is a robust PostgreSQL high-availability solution. 

#### Technical Details
Patroni provides:
1. Real-time replication monitoring
2. Automatic primary-replica synchronization
3. Health check mechanisms
4. Dynamic configuration management

#### Implementation Significance
The system ensures continuous database availability through:
- Seamless failover processes
- Consistent data replication
- Reliable cluster state management

This configuration is essential for maintaining robust database operations in production environments.

### Environment Setup
First, set up environment variables on each node:

```bash
    # Set node name and IP
    export NODE_NAME=$(hostname -f)
    export NODE_IP=$(hostname -i | awk '{print $1}')

    # Set PostgreSQL paths
    export DATA_DIR="/var/lib/postgresql/12/main"
    export PG_BIN_DIR="/usr/lib/postgresql/12/bin"

    # Set cluster information
    export NAMESPACE="kyc"
    export SCOPE="kyc"
```
> Note: Replace the values with your own.

### Create Patroni Configuration
Create the Patroni configuration file (`/etc/patroni/patroni.yml`):

```bash
    echo "
    namespace: ${NAMESPACE}
    scope: ${SCOPE}
    name: ${NODE_NAME}

    restapi:
        listen: 0.0.0.0:8008
        connect_address: ${NODE_IP}:8008

    etcd3:
        host: ${NODE_IP}:2379

    bootstrap:
    # this section will be written into Etcd:/<namespace>/<scope>/config after initializing new cluster
    dcs:
        ttl: 30
        loop_wait: 10
        retry_timeout: 10
        maximum_lag_on_failover: 1048576

        postgresql:
            use_pg_rewind: true
            use_slots: true
            parameters:
                wal_level: replica
                hot_standby: "on"
                wal_keep_segments: 10
                max_wal_senders: 5
                max_replication_slots: 10
                wal_log_hints: "on"
                logging_collector: 'on'
                max_wal_size: '10GB'
                archive_mode: "on"
                archive_timeout: 600s
                archive_command: "cp -f %p /home/postgres/archived/%f"

    # some desired options for 'initdb'
    initdb: # Note: It needs to be a list (some options need values, others are switches)
        - encoding: UTF8
        - data-checksums

    pg_hba: # Add following lines to pg_hba.conf after running 'initdb'
        - host replication replicator 127.0.0.1/32 trust
        - host replication replicator 0.0.0.0/0 md5
        - host all all 0.0.0.0/0 md5
        - host all all ::0/0 md5

    # Some additional users which needs to be created after initializing new cluster
    users:
        admin:
            password: <REDACTED_PASSWORD>
            options:
                - createrole
                - createdb
        percona:
            password: <REDACTED_PASSWORD>
            options:
                - createrole
                - createdb 

    postgresql:
        cluster_name: kyc
        listen: 0.0.0.0:5432
        connect_address: ${NODE_IP}:5432
        data_dir: ${DATA_DIR}
        bin_dir: ${PG_BIN_DIR}
        pgpass: /tmp/pgpass0
        authentication:
            replication:
                username: replicator
                password: <REDACTED_PASSWORD>
            superuser:
                username: postgres
                password: <REDACTED_PASSWORD>
        parameters:
            unix_socket_directories: "/var/run/postgresql/"
        create_replica_methods:
            - basebackup
        basebackup:
            checkpoint: 'fast'

    tags:
        nofailover: false
        noloadbalance: false
        clonefrom: false
        nosync: false
    " | sudo tee -a /etc/patroni/patroni.yml
```

> Note: Replace the passwords and other values with your own. Also, ensure that the `archive_command` path exists on the system.

### Create Patroni Service
Create the systemd service file (`/etc/systemd/system/patroni.service`):

```ini
    [Unit]
    Description=Runners to orchestrate a high-availability PostgreSQL
    After=syslog.target network.target

    [Service]
    Type=simple

    User=postgres
    Group=postgres

    ExecStart=/bin/patroni /etc/patroni/patroni.yml
    ExecReload=/bin/kill -s HUP $MAINPID

    KillMode=process
    TimeoutSec=30
    Restart=no

    [Install]
    WantedBy=multi-user.target
```

### Start Patroni Service
Start the Patroni service in sequence, beginning with the first node:

```bash
    sudo systemctl daemon-reload
    sudo systemctl enable patroni
    sudo systemctl start patroni
```

Monitor the service:
```bash
    sudo journalctl -fu patroni
```

## HAProxy Configuration

HAProxy provides load balancing between PostgreSQL nodes, directing write operations to the primary and distributing read operations among replicas.

#### Key Functions

- Routes all write operations (INSERT, UPDATE, DELETE) to the primary node
- Maintains data consistency through single-point write operations
- Distributes SELECT queries across multiple replica nodes
- Implements load balancing algorithms (round-robin, least-connections)
- Prevents individual node overload


Ideal for applications with read-heavy workloads and moderate write operations, such as typical web applications.

### Installation
```bash
    sudo apt install percona-haproxy
```

### Configuration
Create the HAProxy configuration (`/etc/haproxy/haproxy.cfg`):
```ini
    global
        log 127.0.0.1 local0
        maxconn 4096
        user haproxy
        group haproxy
        daemon

    defaults
        log     global
        option  tcplog
        timeout connect 10s
        timeout client  30s
        timeout server  30s

    frontend postgres
        bind *:5433
        default_backend patroni_cluster

    backend patroni_cluster
        option httpchk OPTIONS /master
        http-check expect status 200
        default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
        server patroni1 <REDACTED_IP>:5432 check port 8008
        server patroni2 <REDACTED_IP>:5432 check port 8008
        server patroni3 <REDACTED_IP>:5432 check port 8008
```

> Note: Replace IP addresses with the actual IP addresses of the nodes.

### Start HAProxy
```bash
    sudo systemctl restart haproxy
    sudo systemctl enable haproxy
```

Monitor HAProxy:
```bash
    sudo journalctl -u haproxy.service -n 100 -f
```

## Connection Testing

Now that the cluster is set up, we can test the connection to the primary node and verify the cluster status.

### Test Primary Connection
```bash
    psql -h <REDACTED_IP> -p 5433 -U postgres -d postgres
```

## Verification and Testing

### Check Cluster Status
1. Verify Patroni cluster:
```bash
    patronictl -c /etc/patroni/patroni.yml list
```

Expected output:
```
    + Cluster: kyc (7454297404487036569)+-----------+----+-----------+
    | Member  | Host          | Role    | State     | TL | Lag in MB |
    +---------+---------------+---------+-----------+----+-----------+
    | <REDACTED_HOSTNAME> | <REDACTED_IP> | Replica | streaming |  1 |         0 |
    | <REDACTED_HOSTNAME> | <REDACTED_IP> | Leader  | running   |  1 |           |
    | <REDACTED_HOSTNAME> | <REDACTED_IP> | Replica | streaming |  1 |         0 |
    +---------+---------------+---------+-----------+----+-----------+
```

2. Verify etcd cluster:
```bash
    export ETCDCTL_API=3
    etcdctl --endpoints=http://<REDACTED_IP>:2379,http://<REDACTED_IP>:2379,http://<REDACTED_IP>:2379 member list
```

3. Test VIP accessibility:
```bash
    ping <REDACTED_IP>
    psql -h <REDACTED_IP> -p 5433 -U postgres
```

## Restoring Old Data to New Cluster

You need to restore the some data from a backup of the previous PostgreSQL cluster to the new cluster. Here are the steps to do that.

### Backup the Data from the Previous Cluster

1. Login as postgres user in bash and backup the <REDACTED_USERNAME> schema data and schema only data of kyc, <REDACTED_USERNAME> and <REDACTED_USERNAME>.

```bash
    # Log into the previous PostgreSQL cluster and switch to postgres bash user.
    sudo su - postgres

    # Backup the <REDACTED_USERNAME> schema data
    pg_dump -h localhost -U kyc -d postgres -f <REDACTED_USERNAME>_full.sql

    # Backup the schema only data of kyc, <REDACTED_USERNAME> and <REDACTED_USERNAME>
    pg_dump -h localhost -U kyc -d postgres -s -f kyc_schema.sql
    pg_dump -h localhost -U kyc -d postgres -s -f <REDACTED_USERNAME>_schema.sql
    pg_dump -h localhost -U kyc -d postgres -s -f <REDACTED_USERNAME>_schema.sql
```
2. Backup 2 tables (kyc.asp_config, kyc.asp_config_id_seq) in kyc schema, as these tables are not part of the schema only data.

```bash
    # Backup the kyc.asp_config and kyc.asp_config_id_seq tables
    pg_dump -h localhost -U kyc -d postgres -t kyc.asp_config -t kyc.asp_config_id_seq -f kyc_tables.sql
```

3. Copy the backup files to the new cluster nodes. Using your preferred method, copy the backup files to the new cluster nodes.

### Create users and restore the data in the new cluster

We need this three user in our new cluster. Those are `<REDACTED_USERNAME>`, `<REDACTED_USERNAME>`, `kyc` and `<REDACTED_USERNAME>`. Lets create these users in the new cluster.

1. Create the users in the new cluster.
    
    ```bash
        # Log into the new cluster and switch to postgres bash user.
        sudo su - postgres
    
        # Create the users
        psql -d postgres -c "CREATE USER <REDACTED_USERNAME> SUPERUSER CREATEDB CREATEROLE;"
        psql -d postgres -c "CREATE USER <REDACTED_USERNAME> SUPERUSER CREATEDB CREATEROLE;"
        psql -d postgres -c "CREATE USER <REDACTED_USERNAME> SUPERUSER CREATEDB CREATEROLE;"
        psql -d postgres -c "CREATE USER <REDACTED_USERNAME> SUPERUSER CREATEDB CREATEROLE PASSWORD '<REDACTED_PASSWORD>';"
    ```

2. Restore the data in the new cluster.

    ```bash
        # Log into the new cluster and switch to postgres bash user.
        sudo su - postgres

        # Restore the <REDACTED_USERNAME> schema data
        psql -d postgres -f <REDACTED_USERNAME>_full.sql

        # Restore the schema only data of kyc, <REDACTED_USERNAME> and <REDACTED_USERNAME>
        psql -d postgres -f kyc_schema.sql
        psql -d postgres -f <REDACTED_USERNAME>_schema.sql
        psql -d postgres -f <REDACTED_USERNAME>_schema.sql

        # Restore the kyc.asp_config and kyc.asp_config_id_seq tables
        psql -d postgres -f kyc_tables.sql
    ```
3. Test and verify the data in the new cluster.

    ```bash
        # Log into the new cluster and switch to postgres bash user.
        sudo su - postgres

        # Connect to the database and verify the data
        psql -d postgres -c "\dt"
        psql -d postgres -c "SELECT * FROM kyc.asp_config;"
        psql -d postgres -c "SELECT * FROM kyc.asp_config_id_seq;"

        # Check if the schema data is restored correctly
        psql -d postgres -c "\dt <REDACTED_USERNAME>.*"
        psql -d postgres -c "\dt kyc.*"
        psql -d postgres -c "\dt <REDACTED_USERNAME>.*"
        psql -d postgres -c "\dt <REDACTED_USERNAME>.*"
    ```

## pgBackRest Setup

This section covers setting up pgBackRest on a dedicated backup server to provide backup and recovery capabilities for your PostgreSQL cluster. The prerequisites are given below.

- A dedicated server for pgBackRest (referred to as <REDACTED_HOSTNAME>)
- SSH access between PostgreSQL nodes and the backup server
- Sufficient storage space for backups on <REDACTED_HOSTNAME>


### Host Configuration

1. Update the hosts file on the backup server:

```bash
# Add to /etc/hosts on <REDACTED_HOSTNAME>
<REDACTED_IP> <REDACTED_HOSTNAME>
<REDACTED_IP> <REDACTED_HOSTNAME>
<REDACTED_IP> <REDACTED_HOSTNAME>
<REDACTED_IP> <REDACTED_HOSTNAME>
```

### Package Installation

1. Install pgBackRest on the backup server:

```bash
sudo apt update
sudo apt install -y percona-pgbackrest
```

### Directory Setup

1. Create the repository directory:

```bash
sudo mkdir -p /var/lib/postgresql/pgbackup
sudo chown postgres:postgres /var/lib/postgresql/pgbackup
sudo chmod 750 /var/lib/postgresql/pgbackup
```

### SSH Configuration

1. Set up SSH for the postgres user:

```bash
# Create SSH directory
sudo mkdir -p /var/lib/postgresql/.ssh
sudo chown postgres:postgres /var/lib/postgresql/.ssh
sudo chmod 700 /var/lib/postgresql/.ssh

# Generate SSH key pair (as postgres user)
sudo -u postgres ssh-keygen -t rsa -b 4096 -f /var/lib/postgresql/.ssh/id_rsa -N ""

# Set proper permissions
sudo chmod 600 /var/lib/postgresql/.ssh/id_rsa
sudo chmod 600 /var/lib/postgresql/.ssh/id_rsa.pub
```

2. Save the public key for later use:

```bash
# Display public key (save this for configuring PostgreSQL nodes)
sudo cat /var/lib/postgresql/.ssh/id_rsa.pub
```

### pgBackRest Configuration

1. Create the pgBackRest configuration file:

```bash
# Create configuration file
sudo bash -c "cat > /etc/pgbackrest.conf << 'EOL'
[global]
# Repository configuration
repo1-path=/var/lib/postgresql/pgbackup
repo1-retention-archive-type=full
repo1-retention-full=1

# Server options
process-max=12
log-level-console=info
log-level-file=info
start-fast=y
delta=y
backup-standby=y

[kyc]
pg1-host=<REDACTED_HOSTNAME>
pg1-host-user=postgres
pg1-port=5432
pg1-path=/var/lib/postgresql/12/main
pg1-socket-path=/var/run/postgresql

pg2-host=<REDACTED_HOSTNAME>
pg2-host-user=postgres
pg2-port=5432
pg2-path=/var/lib/postgresql/12/main
pg2-socket-path=/var/run/postgresql

pg3-host=<REDACTED_HOSTNAME>
pg3-host-user=postgres
pg3-port=5432
pg3-path=/var/lib/postgresql/12/main
pg3-socket-path=/var/run/postgresql
EOL"

sudo chown postgres:postgres /etc/pgbackrest.conf
sudo chmod 640 /etc/pgbackrest.conf
```

### Create Systemd Service

1. Create a systemd service for pgBackRest:

```bash
sudo bash -c "cat > /etc/systemd/system/pgbackrest.service << 'EOL'
[Unit]
Description=pgBackRest Server
After=network.target

[Service]
Type=simple
User=postgres
Restart=always
RestartSec=1
ExecStart=/usr/bin/pgbackrest server
ExecReload=/bin/kill -HUP \$MAINPID

[Install]
WantedBy=multi-user.target
EOL"
```

2. Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pgbackrest
sudo systemctl start pgbackrest
```

## PostgreSQL Node Configuration for pgBackRest

Perform these steps on each PostgreSQL node (<REDACTED_HOSTNAME>, <REDACTED_HOSTNAME>, <REDACTED_HOSTNAME>).

### Host Configuration

1. Update the hosts file:

```bash
# Add to /etc/hosts on each PostgreSQL node
<REDACTED_IP> <REDACTED_HOSTNAME>
```

### Package Installation

1. Install pgBackRest on each node:

```bash
sudo apt update
sudo apt install -y percona-pgbackrest
```

### SSH Configuration

1. Set up SSH for the postgres user:

```bash
# Create SSH directory
sudo mkdir -p /var/lib/postgresql/.ssh
sudo chown postgres:postgres /var/lib/postgresql/.ssh
sudo chmod 700 /var/lib/postgresql/.ssh

# Create authorized_keys file
sudo touch /var/lib/postgresql/.ssh/authorized_keys
sudo chown postgres:postgres /var/lib/postgresql/.ssh/authorized_keys
sudo chmod 600 /var/lib/postgresql/.ssh/authorized_keys
```

2. Add the pgBackRest server's public key to authorized_keys:

```bash
# Add the pgBackRest server's public key
sudo bash -c "echo 'PASTE_PGBACKREST_PUBLIC_KEY_HERE' >> /var/lib/postgresql/.ssh/authorized_keys"
```

3. Generate SSH key for the postgres user on each PostgreSQL node:

```bash
# Generate SSH key pair (as postgres user)
sudo -u postgres ssh-keygen -t rsa -b 4096 -f /var/lib/postgresql/.ssh/id_rsa -N ""
```

4. Add the PostgreSQL node's public key to the pgBackRest server:

```bash
# Display public key (to add to pgBackRest server)
sudo cat /var/lib/postgresql/.ssh/id_rsa.pub
```

5. Add the PostgreSQL node's public key to the pgBackRest server's authorized_keys file (perform this on <REDACTED_HOSTNAME> for each PostgreSQL node):

```bash
# On <REDACTED_HOSTNAME>
sudo bash -c "echo 'PASTE_POSTGRES_NODE_PUBLIC_KEY_HERE' >> /var/lib/postgresql/.ssh/authorized_keys"
```

6. Set up SSH known_hosts to prevent interactive prompts:

```bash
# Add pgBackRest host to known_hosts
sudo -u postgres ssh-keyscan -t rsa <REDACTED_HOSTNAME> >> /var/lib/postgresql/.ssh/known_hosts
sudo chmod 600 /var/lib/postgresql/.ssh/known_hosts
```

### pgBackRest Client Configuration

1. Create the pgBackRest configuration file on each PostgreSQL node:

```bash
sudo bash -c "cat > /etc/pgbackrest.conf << 'EOL'
[global]
repo1-host=<REDACTED_HOSTNAME>
repo1-host-user=postgres

# General options
process-max=16
log-level-console=info
log-level-file=debug

[kyc]
pg1-path=/var/lib/postgresql/12/main
EOL"

sudo chown postgres:postgres /etc/pgbackrest.conf
sudo chmod 640 /etc/pgbackrest.conf
```

## Patroni Integration

Configure Patroni to use pgBackRest for WAL archiving on the primary PostgreSQL node.

1. Update Patroni configuration (on the primary node):

```bash
patronictl -c /etc/patroni/patroni.yml edit-config -s postgresql.parameters.archive_mode=on \
-s postgresql.parameters.archive_command="pgbackrest --stanza=kyc archive-push %p" \
-s postgresql.recovery_conf.restore_command="pgbackrest --config=/etc/pgbackrest.conf --stanza=kyc archive-get %f %p" \
--force
```

2. Reload Patroni configuration:

```bash
patronictl -c /etc/patroni/patroni.yml reload kyc --force
```

## Stanza Creation and Initial Backup

After setting up all components, create the pgBackRest stanza and perform an initial backup.

1. Create the pgBackRest stanza (on <REDACTED_HOSTNAME>):

```bash
sudo -iu postgres pgbackrest --stanza=kyc stanza-create
```

2. Create a full backup:

```bash
sudo -iu postgres pgbackrest --stanza=kyc --type=full backup
```

3. Check the backup status:

```bash
sudo -iu postgres pgbackrest --stanza=kyc info
```

## Verification

Verify that pgBackRest is properly configured and that backups are working correctly.

1. Check the status of the pgBackRest service on the backup server:

```bash
sudo systemctl status pgbackrest
```

2. Verify that WAL archiving is working by checking the log files:

```bash
sudo -u postgres pgbackrest --stanza=kyc check
```

3. Create a test backup and verify that it completes successfully:

```bash
sudo -u postgres pgbackrest --stanza=kyc --type=full backup
sudo -u postgres pgbackrest --stanza=kyc info
```
4. Add cron job for regular backups:

```bash
# Edit the crontab for the postgres user
sudo crontab -u postgres -e
# Add the following line to schedule a daily backup at 2 AM
0 2 * * * /usr/bin/pgbackrest --stanza=kyc --type=full backup
```
5. Monitor the backup logs:

```bash
# Check the backup logs
sudo tail -f /var/log/pgbackrest/pgbackrest.log
```
6. Test the restore process:

```bash
# Stop the PostgreSQL service on the primary node
sudo systemctl stop patroni
# Restore the backup
sudo -u postgres pgbackrest --stanza=kyc restore
# Start the PostgreSQL service
sudo systemctl start patroni
# Check the status of the Patroni cluster
patronictl -c /etc/patroni/patroni.yml list
```

## Monitoring PostgreSQL with Percona Monitoring and Management (PMM)

This section covers setting up Percona Monitoring and Management (PMM) to monitor your PostgreSQL cluster, providing insights into performance, health, and resource utilization. The prerequisites are given below.

- A dedicated server for PMM Server (can be installed on <REDACTED_HOSTNAME>)
- Network connectivity between PostgreSQL nodes and PMM server
- Minimum requirements for PMM server:
  - 2 CPU cores
  - 4 GB RAM
  - 100 GB disk space

### PMM Server Installation on <REDACTED_HOSTNAME>

1. Install Docker prerequisites:

```bash
# Update package lists
sudo apt update

# Install prerequisites
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common gnupg
```

2. Add Docker repository:

```bash
# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -

# Add Docker repository
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"
```

3. Install Docker:

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io
sudo systemctl enable docker
sudo systemctl start docker
```

4. Install PMM Server using the easy install script:

```bash
curl -fsSL https://raw.githubusercontent.com/percona/<REDACTED_USERNAME>/refs/heads/v3/get-<REDACTED_USERNAME>.sh | sudo bash
```

5. Wait for PMM Server to become available (this may take a few minutes):

```bash
# You can monitor the container status
sudo docker ps | grep <REDACTED_USERNAME>-server
```

6. Change the default admin password:

```bash
sudo docker exec -t <REDACTED_USERNAME>-server change-admin-password <REDACTED_PASSWORD>
```

7. Record your PMM Server access information:
   - URL: https://YOUR_SERVER_IP:443
   - Username: admin
   - Password: <REDACTED_PASSWORD> (use your chosen password)

### Install PMM Client on PostgreSQL Nodes

Perform these steps on each PostgreSQL node (<REDACTED_HOSTNAME>, <REDACTED_HOSTNAME>, <REDACTED_HOSTNAME>):

1. Add Percona repository:

```bash
wget -O - https://repo.percona.com/apt/percona-release_latest.generic_all.deb > /tmp/percona-release.deb
sudo dpkg -i /tmp/percona-release.deb
```

2. Enable PMM client repository:

```bash
sudo percona-release enable <REDACTED_USERNAME>3-client release
```

3. Install PMM Client:

```bash
sudo apt update
sudo apt install -y <REDACTED_USERNAME>-client
```

4. Install pg_stat_monitor package:

```bash
sudo apt install -y percona-pg-stat-monitor12
```

### Configure PostgreSQL for Monitoring

Perform these steps on each PostgreSQL node:

1. Create PostgreSQL monitoring user:

```bash
sudo -u postgres psql -c "CREATE USER <REDACTED_USERNAME> WITH SUPERUSER PASSWORD '<REDACTED_PASSWORD>';" || sudo -u postgres psql -c "ALTER USER <REDACTED_USERNAME> WITH SUPERUSER PASSWORD '<REDACTED_PASSWORD>';"
```

2. Update pg_hba.conf to allow PMM user local access:

```bash
# Add this line to /var/lib/postgresql/12/main/pg_hba.conf
echo "local   all             <REDACTED_USERNAME>                                     md5" | sudo tee -a /var/lib/postgresql/12/main/pg_hba.conf
```

3. Enable pg_stat_monitor in shared_preload_libraries:

```bash
# Update Patroni configuration
sudo patronictl -c /etc/patroni/patroni.yml edit-config -s postgresql.parameters.shared_preload_libraries="pg_stat_monitor" \
-s postgresql.parameters.pg_stat_monitor.pgsm_query_max_len=2048 \
--force
```

4. Apply configuration changes:

```bash
# Reload Patroni configuration
sudo patronictl -c /etc/patroni/patroni.yml reload kyc --force
```

5. Create the pg_stat_monitor extension:

```bash
sudo -u postgres psql -d postgres -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_monitor;'
```

### Configure PMM Client on PostgreSQL Nodes

Perform these steps on each PostgreSQL node:

1. Configure PMM Client to connect to the PMM Server:

```bash
sudo <REDACTED_USERNAME>-admin config --server-insecure-tls --server-url=https://admin:<REDACTED_PASSWORD>@PMM_SERVER_IP:443 --force
```

2. Add PostgreSQL monitoring:

```bash
# Remove any existing PostgreSQL monitoring (optional)
sudo <REDACTED_USERNAME>-admin remove postgresql || true

# Add PostgreSQL monitoring
sudo <REDACTED_USERNAME>-admin add postgresql --username=<REDACTED_USERNAME> --password=<REDACTED_PASSWORD>
```

3. Verify PMM Client status:

```bash
sudo <REDACTED_USERNAME>-admin status
```

## Verify Monitoring Setup

1. Access the PMM Web UI at `https://[PMM-Server-IP]` using the credentials you set.

2. Navigate to the PostgreSQL dashboards to verify that your nodes are being monitored:
   - PostgreSQL Instance Summary
   - PostgreSQL Database Activity
   - PostgreSQL Query Analytics
   - High Availability dashboard

3. Check that all PostgreSQL nodes are properly reporting metrics:

```bash
sudo <REDACTED_USERNAME>-admin list
```

## Setting Up Alerts

1. Navigate to the PMM web interface
2. Go to Configuration → Alert Rules
3. Create alert rules for:
   - Replication lag
   - High CPU/Memory usage
   - Disk space utilization
   - Connection pool saturation

## Maintenance Tips

1. Create a maintenance script for regular cleanup:

```bash
sudo bash -c "cat > /usr/local/bin/<REDACTED_USERNAME>-maintenance.sh << 'EOL'
#!/bin/bash
# Purge old monitoring data (adjust retention as needed)
<REDACTED_USERNAME>-admin maintenance --retention 14d

# Check PMM client status
<REDACTED_USERNAME>-admin list
EOL"

sudo chmod +x /usr/local/bin/<REDACTED_USERNAME>-maintenance.sh
```

2. Add a weekly cron job:

```bash
(crontab -l 2>/dev/null; echo "0 2 * * 0 /usr/local/bin/<REDACTED_USERNAME>-maintenance.sh > /var/log/<REDACTED_USERNAME>-maintenance.log 2>&1") | crontab -
```

# Conclusion

By following this guide, you have successfully set up a highly available PostgreSQL cluster using Patroni, etcd, HAProxy, and Keepalived. This configuration provides automatic failover, load balancing, and high availability for PostgreSQL databases, ensuring that your applications can rely on a robust and resilient database infrastructure. You can now deploy your applications with confidence, knowing that your database cluster is capable of handling failures and maintaining consistent performance under various conditions.
