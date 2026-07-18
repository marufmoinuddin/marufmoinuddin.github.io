---
layout: post
title: "PostgreSQL 17 + Pgpool-II HA Cluster — Configuration Guide"
date: 2026-06-10
category: PostgreSQL
tags: [postgresql, pgpool, high-availability, clustering, streaming-replication, load-balancing, failover]
excerpt: "A comprehensive step-by-step guide to deploying a highly available PostgreSQL 17 cluster with Pgpool-II 4.5, including streaming replication, watchdog, virtual IP failover, and connection pooling."
read_time: 20
---

# PostgreSQL 17 + Pgpool-II HA Cluster — Configuration Guide

## Environment

### Cluster Topology

| Role | Hostname | IP |
|---|---|---|
| Backend Primary | `db-node-01` | `10.0.0.1` |
| Backend Standby 1 | `db-node-02` | `10.0.0.2` |
| Backend Standby 2 | `db-node-03` | `10.0.0.3` |
| Virtual IP (VIP) | — | `10.0.0.100` |

| Service | Port |
|---|---|
| Pgpool Port | `9999` |
| PCP Port | `9898` |

- **Network Interface:** `ens160`
- **Hardware:** 12 vCPU / 20 GB RAM / 80 GB Storage

---

## STEP 0 — Download and Install the RPMs (All 3 Nodes)

### PostgreSQL 17 Installation (All 3 Nodes)

```bash
# Add PostgreSQL repository (EL-9)
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# Disable built-in PostgreSQL module
sudo dnf -qy module disable postgresql

# Install PostgreSQL 17
sudo dnf install -y postgresql17-server postgresql17-contrib

# Prepare PGDATA directory
sudo mkdir -p /data/pgdata/17/data
sudo chown -R postgres:postgres /data/pgdata

# Set PGDATA in systemd
sudo systemctl edit postgresql-17.service
```

Add in the editor:
```ini
[Service]
Environment=PGDATA=/data/pgdata/17/data
```

```bash
sudo systemctl daemon-reload

# Initialize database cluster
sudo /usr/pgsql-17/bin/postgresql-17-setup initdb

# Enable and start PostgreSQL
sudo systemctl enable postgresql-17.service
sudo systemctl start postgresql-17.service

# Add Pgpool repository (4.5 for PG17)
sudo yum install -y https://www.pgpool.net/yum/rpms/4.5/redhat/rhel-9-x86_64/pgpool-II-release-4.5-1.noarch.rpm

# If GPG check issue arises
sudo vim /etc/yum.repos.d/pgpool-II-release-45.repo
# Set: gpgcheck=0

# Install Pgpool for PostgreSQL 17
sudo yum install -y pgpool-II-pg17 pgpool-II-pg17-extensions pgpool-II-pg17-devel

# If dependency issues arise
wget https://rpmfind.net/linux/centos-stream/9-stream/CRB/x86_64/os/Packages/libmemcached-awesome-1.1.0-12.el9.x86_64.rpm
wget https://rpmfind.net/linux/centos-stream/9-stream/BaseOS/x86_64/os/Packages/libcap-2.48-9.el9.x86_64.rpm
sudo yum install ./libmemcached-awesome-*.rpm ./libcap-*.rpm
```

---

## STEP 1 — Prepare Data Directory (All 3 Nodes)

Run on all three nodes before doing anything else.

```bash
# Create the PostgreSQL data directory
sudo mkdir -p /data/pgdata/17/data
sudo chown -R postgres:postgres /data/pgdata
sudo chmod 700 /data/pgdata/17/data

# Create log directories for Pgpool
sudo mkdir -p /var/log/pgpool_log/oiddir
sudo chown -R postgres:postgres /var/log/pgpool_log
sudo chmod 755 /var/log/pgpool_log

# Create Pgpool PID directory
sudo mkdir -p /var/run/pgpool-II
sudo chown postgres:postgres /var/run/pgpool-II
sudo chmod 755 /var/run/pgpool-II
```

---

## STEP 2 — Configure PGDATA in Systemd (All 3 Nodes)

```bash
sudo systemctl edit postgresql-17.service
```

Add the following block:
```ini
[Service]
Environment=PGDATA=/data/pgdata/17/data
```

```bash
sudo systemctl daemon-reload
```

---

## STEP 3 — Initialize PostgreSQL (Primary Node: 10.0.0.1 Only)

```bash
sudo /usr/pgsql-17/bin/postgresql-17-setup initdb
sudo systemctl enable postgresql-17.service
sudo systemctl start postgresql-17.service
```

---

## STEP 4 — PostgreSQL Tuning Config (All Nodes)

All custom PostgreSQL parameters go into `/data/pgdata/17/data/conf.d/` so the default `postgresql.conf` is never touched. PostgreSQL automatically reads all `*.conf` files in this directory via the `include_dir` directive.

### 4.1 — Enable conf.d include (once, on primary)

```bash
# Add include_dir to the bottom of postgresql.conf (one-time only)
echo "include_dir = 'conf.d'" | sudo tee -a /data/pgdata/17/data/postgresql.conf
sudo mkdir -p /data/pgdata/17/data/conf.d
sudo chown postgres:postgres /data/pgdata/17/data/conf.d
```

### 4.2 — Create the tuning file

> **Reference:** [https://pgtune.leopard.in.ua/](https://pgtune.leopard.in.ua/) — calculate exact values for your server.

```bash
sudo -u postgres tee /data/pgdata/17/data/conf.d/01-performance.conf << 'EOF'
# =============================================================
# PostgreSQL 17 Tuning — 12 vCPU / 20 GB RAM / 80 GB Storage
# =============================================================

# ============================================================
# Connection Settings
# ============================================================
max_connections = 3200
reserved_connections = 10
superuser_reserved_connections = 5
password_encryption = scram-sha-256

# ============================================================
# Memory
# ============================================================
shared_buffers = 8GB
huge_pages = try
work_mem = 4MB
maintenance_work_mem = 2GB
autovacuum_work_mem = 2GB
temp_buffers = 16MB
effective_cache_size = 24GB

# ============================================================
# Parallelism
# ============================================================
max_worker_processes = 16
max_parallel_workers_per_gather = 4
max_parallel_workers = 16
max_parallel_maintenance_workers = 4
parallel_setup_cost = 500

# ============================================================
# Query Planner
# ============================================================
random_page_cost = 1.1
effective_io_concurrency = 200
cpu_tuple_cost = 0.01
cpu_index_tuple_cost = 0.005
default_statistics_target = 100
jit = off

# ============================================================
# WAL & Checkpoints
# ============================================================
wal_level = replica
wal_buffers = 16MB
wal_compression = lz4
wal_keep_size = 4096
wal_sender_timeout = 60s
min_wal_size = 1GB
max_wal_size = 4GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
synchronous_commit = local

# ============================================================
# Replication
# ============================================================
max_wal_senders = 10
max_replication_slots = 10
hot_standby = on
hot_standby_feedback = on

# ============================================================
# Autovacuum
# ============================================================
autovacuum = on
autovacuum_max_workers = 4
autovacuum_naptime = 30s
autovacuum_vacuum_cost_delay = 2ms
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02
log_autovacuum_min_duration = 250ms

# ============================================================
# Logging
# ============================================================
log_destination = 'stderr'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_rotation_age = 1d
log_rotation_size = 1GB
log_truncate_on_rotation = on
log_min_duration_statement = 1000
log_checkpoints = on
log_connections = off
log_disconnections = off
log_lock_waits = on
log_temp_files = 10MB
log_error_verbosity = verbose
log_line_prefix = '%m [%p]: [%l-1] db=%d,user=%u,app=%a,client=%h'
log_statement = 'ddl'
log_replication_commands = on
log_timezone = 'Your/Timezone'

# ============================================================
# Session Behavior
# ============================================================
idle_in_transaction_session_timeout = 60000
lock_timeout = 0
statement_timeout = 0
track_io_timing = on
track_activity_query_size = 4096
EOF
```

---

## STEP 5 — pg_hba.conf (All 3 Nodes)

### 5.1 — On the primary, edit now. On standbys, this file will come from pg_basebackup.

```bash
sudo -u postgres tee /data/pgdata/17/data/conf.d/02-hba-rules.conf << 'EOF'
# This file does NOT override pg_hba.conf.
# HBA rules must be added directly to pg_hba.conf.
# This file documents what was added for reference only.
#
# Lines added to /data/pgdata/17/data/pg_hba.conf:
#   host replication repl_user 10.0.0.0/24 scram-sha-256
#   host all          pgpool   10.0.0.0/24 scram-sha-256
#   host all          app_user 10.0.0.0/24 scram-sha-256
EOF
```

Now actually edit `pg_hba.conf`:

```bash
sudo -u postgres tee -a /data/pgdata/17/data/pg_hba.conf << 'EOF'

# --- Custom rules ---
host replication repl_user 10.0.0.0/24 scram-sha-256
host all          pgpool   10.0.0.0/24 scram-sha-256
host all          app_user 10.0.0.0/24 scram-sha-256
EOF
```

Restart PostgreSQL to apply:

```bash
sudo systemctl restart postgresql-17.service
```

---

## STEP 6 — Create PostgreSQL Users and Database (Primary: 10.0.0.1 Only)

```bash
sudo su - postgres
psql
```

Run in `psql`:

```sql
-- Replication user
SET password_encryption = 'scram-sha-256';
CREATE ROLE repl_user WITH REPLICATION LOGIN;
\password repl_user
-- Enter: ChangeMe123!

-- Pgpool health/SR check user
CREATE ROLE pgpool WITH LOGIN;
\password pgpool
-- Enter: ChangeMe123!
GRANT pg_monitor TO pgpool;
GRANT CONNECT ON DATABASE postgres TO pgpool;

-- Application database and user
CREATE DATABASE appdb;
SET password_encryption = 'scram-sha-256';
CREATE ROLE app_user WITH LOGIN;
\password app_user
-- Enter: AppUserPass123!
GRANT CONNECT ON DATABASE appdb TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO app_user;

-- Verify
\du
```

```bash
exit
```

---

## STEP 7 — Initialize Standby Nodes (DB02 and DB03 Only)

Run the following on `10.0.0.2` and `10.0.0.3`:

```bash
# Stop PostgreSQL if running
sudo systemctl stop postgresql-17 || true

# Remove old data directory
sudo rm -rf /data/pgdata/17/data/*

# Take base backup from primary (includes conf.d, pg_hba.conf, everything)
sudo -u postgres pg_basebackup \
  -h 10.0.0.1 \
  -U repl_user \
  -p 5432 \
  -D /data/pgdata/17/data/ \
  -Fp -Xs -P -R
# Password: ChangeMe123!
# -R creates standby.signal and populates primary_conninfo automatically

# Start standby
sudo systemctl start postgresql-17
sudo systemctl enable postgresql-17
```

### 7.1 — Verify Replication (back on Primary: 10.0.0.1)

```bash
sudo -u postgres psql -c "SELECT client_addr, state, sync_state, sent_lsn, write_lsn, flush_lsn, replay_lsn FROM pg_stat_replication;"
```

Both standbys should appear with `state = streaming`.

---

## STEP 8 — Configure Firewall (All 3 Nodes)

```bash
# PostgreSQL
sudo firewall-cmd --permanent --add-port=5432/tcp

# Pgpool client port
sudo firewall-cmd --permanent --add-port=9999/tcp

# PCP admin port
sudo firewall-cmd --permanent --add-port=9898/tcp

# Watchdog
sudo firewall-cmd --permanent --add-port=9000/tcp

# Heartbeat (UDP)
sudo firewall-cmd --permanent --add-port=9694/udp

# Trust internal subnet
sudo firewall-cmd --permanent --zone=trusted --add-source=10.0.0.0/24

sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

---

## STEP 9 — Pgpool-II Configuration

### 9.1 — Set Node ID (Each Node — Different Per Node)

```bash
# On 10.0.0.1 (Node 0)
echo 0 | sudo tee /etc/pgpool-II/pgpool_node_id

# On 10.0.0.2 (Node 1)
echo 1 | sudo tee /etc/pgpool-II/pgpool_node_id

# On 10.0.0.3 (Node 2)
echo 2 | sudo tee /etc/pgpool-II/pgpool_node_id

# On ALL nodes after setting the ID:
sudo chown postgres:postgres /etc/pgpool-II/pgpool_node_id
sudo chmod 644 /etc/pgpool-II/pgpool_node_id
```

### 9.2 — Configure pool_hba.conf (All 3 Nodes)

```bash
sudo tee /etc/pgpool-II/pool_hba.conf << 'EOF'
# TYPE  DATABASE  USER       CIDR-ADDRESS  METHOD
local   all       all                      trust
host    all       postgres   0.0.0.0/0     trust
host    all       pgpool     0.0.0.0/0     scram-sha-256
host    all       app_user   0.0.0.0/0     scram-sha-256
EOF
```

### 9.3 — Create Pgpool Encryption Key and pool_passwd (All 3 Nodes)

```bash
sudo su - postgres

# Create decryption key file
cat > ~/.pgpoolkey << 'EOF'
YourEncryptionKey
EOF
chmod 600 ~/.pgpoolkey

# Encrypt pgpool user password
pg_enc -m -k ~/.pgpoolkey -u pgpool -p
# Enter: ChangeMe123!

# Encrypt application user password
pg_enc -m -k ~/.pgpoolkey -u app_user -p
# Enter: AppUserPass123!

# Verify both users appear
cat /etc/pgpool-II/pool_passwd
# Should show two AES-encrypted lines

exit
```

### 9.4 — Configure pcp.conf (All 3 Nodes)

```bash
# Generate MD5 hash of the PCP password
# Replace 'ChangeMe123!' with your actual PCP password
echo -n 'ChangeMe123!' | md5sum | awk '{print $1}'
# Example output: a7eb3760e8253f69f17dcfa5e0c3d0eb

# Add to pcp.conf
sudo tee /etc/pgpool-II/pcp.conf << 'EOF'
pgpool:a7eb3760e8253f69f17dcfa5e0c3d0eb
EOF
```

### 9.5 — Create .pcppass (All 3 Nodes)

```bash
sudo su - postgres
cat > ~/.pcppass << 'EOF'
*:*:pgpool:ChangeMe123!
EOF
chmod 600 ~/.pcppass
exit
```

### 9.6 — Configure Sudoers for VIP (All 3 Nodes)

```bash
sudo visudo
```

Add at the end:
```
postgres ALL = NOPASSWD: /sbin/ip, /usr/sbin/arping
Defaults:postgres !requiretty
```

### 9.7 — Configure Systemd File Limits (All 3 Nodes)

```bash
sudo systemctl edit pgpool.service
```

Add:
```ini
[Service]
LimitNOFILE=131072
LimitNPROC=131072
```

```bash
sudo systemctl daemon-reload
```

### 9.8 — Deploy pgpool.conf (All 3 Nodes)

Pgpool does not support a `conf.d` include by default. Place the full custom configuration in `/etc/pgpool-II/pgpool.conf` — back up the default first.

```bash
sudo cp /etc/pgpool-II/pgpool.conf /etc/pgpool-II/pgpool.conf.default
```

```bash
sudo tee /etc/pgpool-II/pgpool.conf << 'EOF'
# =============================================================
# Pgpool-II 4.5 Configuration — HA Cluster
# Generated for: 12 vCPU / 20GB RAM, 3-node watchdog
# =============================================================

# ---------------- CLUSTERING MODE ----------------
backend_clustering_mode = 'streaming_replication'

# ---------------- CONNECTIONS ----------------
listen_addresses = '*'
port = 9999
reserved_connections = 50
listen_backlog_multiplier = 2
serialize_accept = off
pcp_listen_addresses = '*'
pcp_port = 9898
unix_socket_directories = '/var/run/pgpool-II'
pcp_socket_dir = '/var/run/pgpool-II'
wd_ipc_socket_dir = '/var/run/pgpool-II'

# ---------------- CONNECTION POOLING ----------------
num_init_children = 1000
max_pool = 2
child_life_time = 5
minchild_max_connections = 1000
connection_life_time = 600
client_idle_limit = 5min
connection_cache = on
reset_query_list = 'ABORT; DISCARD ALL'

# ---------------- AUTHENTICATION ----------------
enable_pool_hba = on
pool_passwd = 'pool_passwd'
authentication_timeout = 1min

# ---------------- BACKEND (POSTGRESQL) NODES ----------------
backend_hostname0 = '10.0.0.1'
backend_port0 = 5432
backend_weight0 = 1
backend_data_directory0 = '/data/pgdata/17/data'
backend_flag0 = 'ALLOW_TO_FAILOVER'
backend_application_name0 = 'db-node-01'

backend_hostname1 = '10.0.0.2'
backend_port1 = 5432
backend_weight1 = 2
backend_data_directory1 = '/data/pgdata/17/data'
backend_flag1 = 'ALLOW_TO_FAILOVER'
backend_application_name1 = 'db-node-02'

backend_hostname2 = '10.0.0.3'
backend_port2 = 5432
backend_weight2 = 2
backend_data_directory2 = '/data/pgdata/17/data'
backend_flag2 = 'ALLOW_TO_FAILOVER'
backend_application_name2 = 'db-node-03'

# ---------------- REPLICATION MODE ----------------
replicate_select = off

# ---------------- LOGGING ----------------
log_destination = 'stderr'
logging_collector = on
log_hostname = on
log_connections = off
log_disconnections = off
log_pcp_processes = on
log_per_node_statement = off
log_statement = off
log_client_messages = off
log_standby_delay = 'if_over_threshold'
log_error_verbosity = default
log_min_messages = warning
log_directory = '/data/log/pgpool'
log_filename = 'pgpool-%Y-%m-%d.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
log_rotation_size = 0
pid_file_name = '/var/run/pgpool-II/pgpool.pid'

# ---------------- LOAD BALANCING ----------------
load_balance_mode = on
ignore_leading_white_space = on
allow_sql_comments = off
disable_load_balance_on_write = 'transaction'
statement_level_load_balance = on
black_function_list = 'currval,lastval,nextval,setval'

# ---------------- STREAMING REPLICATION CHECK ----------------
sr_check_period = 10
sr_check_user = 'pgpool'
sr_check_password = ''
sr_check_database = 'postgres'
delay_threshold = 10000000

# ---------------- HEALTH CHECK ----------------
health_check_period = 10
health_check_timeout = 20
health_check_user = 'pgpool'
health_check_password = ''
health_check_database = 'postgres'
health_check_max_retries = 3
health_check_retry_delay = 5
connect_timeout = 10000

# ---------------- FAILOVER ----------------
failover_on_backend_error = on
detach_false_primary = off
search_primary_node_timeout = 5min
auto_failback = off
auto_failback_interval = 1min

# ---------------- WATCHDOG ----------------
use_watchdog = on
trusted_servers = '10.0.0.1,10.0.0.2,10.0.0.3'
hostname0 = '10.0.0.1'
wd_port0 = 9000
pgpool_port0 = 9999
hostname1 = '10.0.0.2'
wd_port1 = 9000
pgpool_port1 = 9999
hostname2 = '10.0.0.3'
wd_port2 = 9000
pgpool_port2 = 9999
wd_priority = 1

# ---------------- VIRTUAL IP ----------------
delegate_ip = '10.0.0.100'
if_cmd_path = '/sbin'
if_up_cmd = '/usr/bin/sudo /sbin/ip addr add $_IP_$/23 dev ens160 label ens160:0'
if_down_cmd = '/usr/bin/sudo /sbin/ip addr del $_IP_$/23 dev ens160'
arping_cmd = '/usr/bin/sudo /usr/sbin/arping -U $_IP_$ -w 1 -I ens160'

# ---------------- WATCHDOG BEHAVIOR ----------------
clear_memqcache_on_escalation = on
failover_when_quorum_exists = on
failover_require_consensus = on
allow_multiple_failover_requests_from_node = off
enable_consensus_with_half_votes = on

# ---------------- WATCHDOG LIFECHECK ----------------
wd_monitoring_interfaces_list = 'ens160'
wd_lifecheck_method = 'heartbeat'
wd_interval = 10
heartbeat_hostname0 = '10.0.0.1'
heartbeat_port0 = 9694
heartbeat_device0 = 'ens160'
heartbeat_hostname1 = '10.0.0.2'
heartbeat_port1 = 9694
heartbeat_device1 = 'ens160'
heartbeat_hostname2 = '10.0.0.3'
heartbeat_port2 = 9694
heartbeat_device2 = 'ens160'
wd_life_point = 3
wd_lifecheck_query = 'SELECT 1'
wd_lifecheck_dbname = 'template1'
wd_lifecheck_user = 'pgpool'
wd_lifecheck_password = ''

# ---------------- MEMORY QUERY CACHE (disabled) ----------------
memory_cache_enabled = off
memqcache_method = 'shmem'
memqcache_total_size = 2GB
memqcache_max_num_cache = 1000000
memqcache_expire = 3600
memqcache_auto_cache_invalidation = on
memqcache_oiddir = '/data/log/pgpool/oiddir'
EOF
```

---

## STEP 10 — Start Pgpool Cluster (All 3 Nodes)

Start one node at a time, waiting for each to come up:

```bash
# Start Pgpool (do this on each node, one at a time)
sudo systemctl start pgpool.service
sudo systemctl enable pgpool.service

# Check status
sudo systemctl status pgpool.service
```

---

## STEP 11 — Verify the Cluster

```bash
# Show pool node status (run from any node or via VIP)
psql -h 10.0.0.100 -p 9999 -U pgpool postgres -c "SHOW POOL_NODES;"
# Password: ChangeMe123!

# Check watchdog status
sudo -u postgres pcp_watchdog_info -h 10.0.0.100 -U pgpool -p 9898 -v
# Password: ChangeMe123!

# Check which node holds the VIP
for ip in 10.0.0.1 10.0.0.2 10.0.0.3; do
  echo "=== $ip ==="
  ssh postgres@$ip "ip addr show ens160 | grep 10.0.0.100" 2>/dev/null || echo "VIP not here"
done
```

Expected `SHOW POOL_NODES` output: all 3 nodes with status `up`, one as primary, two as standbys.

---

## STEP 12 — Application Connection Test

```bash
# Test connection via VIP
psql -h 10.0.0.100 -p 9999 -U app_user appdb \
  -c "SELECT current_database(), inet_server_addr(), inet_server_port();"
# Password: AppUserPass123!

# Run 5 times to verify load balancing hits different backends
for i in {1..5}; do
  psql -h 10.0.0.100 -p 9999 -U app_user appdb \
    -c "SELECT inet_server_addr();" -t 2>/dev/null | tr -d ' '
done
```

---

## Quick Reference — Credentials (Replace with your own)

| User | Password | Purpose |
|---|---|---|
| `repl_user` | `ChangeMe123!` | PostgreSQL streaming replication |
| `pgpool` | `ChangeMe123!` | Pgpool health/SR check |
| `app_user` | `AppUserPass123!` | Application database user |

---

## Quick Reference — Common Monitoring Commands

```bash
# Node status
psql -h 10.0.0.100 -p 9999 -U pgpool postgres -c "SHOW POOL_NODES;"

# Active processes
psql -h 10.0.0.100 -p 9999 -U pgpool postgres -c "SHOW POOL_PROCESSES;"

# Connection pool state
psql -h 10.0.0.100 -p 9999 -U pgpool postgres -c "SHOW POOL_POOLS;"

# PCP node info
pcp_node_info -h 10.0.0.100 -U pgpool -p 9898 -n 0
pcp_node_info -h 10.0.0.100 -U pgpool -p 9898 -n 1
pcp_node_info -h 10.0.0.100 -U pgpool -p 9898 -n 2

# Replication lag (on primary)
psql -h 10.0.0.1 -U postgres -c \
  "SELECT client_addr, state, sent_lsn, replay_lsn, \
   (sent_lsn - replay_lsn) AS lag_bytes FROM pg_stat_replication;"

# Re-attach a detached node
pcp_attach_node -h 10.0.0.100 -U pgpool -n 1 -p 9898
pcp_attach_node -h 10.0.0.100 -U pgpool -n 2 -p 9898
```

---

## Troubleshooting

### VIP not assigned

```bash
pcp_watchdog_info -h 10.0.0.1 -U pgpool -p 9898 -v
sudo -u postgres sudo /sbin/ip addr show ens160

# Manual emergency VIP assignment on the primary node:
sudo /sbin/ip addr add 10.0.0.100/23 dev ens160 label ens160:0
sudo /usr/sbin/arping -U 10.0.0.100 -w 1 -I ens160
```

### Node stuck in detached state

```bash
systemctl status postgresql-17
pcp_attach_node -h 10.0.0.100 -U pgpool -p 9898 -n 1

# If still failing:
sudo systemctl restart pgpool
```

### pool_passwd errors / auth failures

```bash
sudo cat /etc/pgpool-II/pool_passwd

# Re-encrypt if missing:
sudo su - postgres
pg_enc -m -k ~/.pgpoolkey -u pgpool -p
pg_enc -m -k ~/.pgpoolkey -u app_user -p
exit
```

### Check pg_hba.conf is loaded

```bash
psql -h 10.0.0.1 -U postgres -c "SELECT pg_reload_conf();"
psql -h 10.0.0.1 -U postgres -c "SELECT * FROM pg_hba_file_rules;"
```
