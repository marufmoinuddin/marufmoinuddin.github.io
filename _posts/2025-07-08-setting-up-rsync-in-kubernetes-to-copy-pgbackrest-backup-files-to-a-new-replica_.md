---
layout: post
title: "Setting Up RSync in PGO Crunchy Database to Copy pgBackRest Backup Files to a New replica_ABC and install PostgreSQL, pgBackRest and Restore backups on that replica_ABC"
date: 2025-07-08
category: Backup
tags: [backup, kubernetes, pgbackrest, postgresql, rsync]
excerpt: This documentation provides detailed steps on how to set up RSync in Kubernetes (K8s) to copy pgBackRest backup files to a new replicaABC. It will aslo help you set up PostgreSQL (Percona-PostgreSQL-13) and pgBackRest…
read_time: 8
source_doc: 16_RSync_Backup_Recovery.md
draft_import: true
---
# Setting Up RSync in Kubernetes to Copy pgBackRest Backup Files to a New replica_ABC and install PostgreSQL, pgBackRest and Restore backups on that replica_ABC

## Overview

This documentation provides detailed steps on how to set up RSync in Kubernetes (K8s) to copy `pgBackRest` backup files to a new `replica_ABC`. It will aslo help you set up PostgreSQL (Percona-PostgreSQL-13) and pgBackRest (Percona-pgBackRest) on a machine (replica_ABC) to restore archived databases and make them live on different ports. We will cover the installation process and provide a script to automate the setup for multiple clusters.


## Prerequisites
1. Access to the primary database server and the replica server.
1. Kubernetes cluster access with permissions to create and update ConfigMaps.
1. Basic understanding of SSH and Kubernetes ConfigMaps.
1. A new cluster replica with a disk mounted as `/postgres`.
1. Kubernetes cluster up and running.
1. `pgBackRest` backup files available in the source cluster.
1. Proper access and permissions (postgres) to create directories and deploy Kubernetes resources.

## A Step-by-Step Guide

### Step 0: Install PostgreSQL and pgBackRest in Cluster Replica (replica_ABC)

1. **Set up the Percona repository:**
   ```bash
   wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
   sudo dpkg -i percona-release_latest.generic_all.deb
   sudo percona-release setup ppg13
   sudo apt update
   ```

2. **Install Percona PostgreSQL-13:**
   ```bash
   sudo apt install percona-postgresql-13
   ```

3. **Install Percona pgBackRest:**
   ```bash
   sudo apt install percona-pgbackrest
   ```

### Step 1: Login as postgres

1. Switch to the postgres user.
    ```bash
    su postgres
    ```
2. Confirm you are in the home directory of the postgres user.
    ```bash
    pwd
    ```

### Step 2: Generate SSH Keys
1. Generate SSH keys.
    ```bash
    ssh-keygen
    ```

### Step 3: Copy SSH Keys
1. Navigate to the `.ssh` directory.
    ```bash
    cd ~/.ssh
    ```
2. Copy the `id_rsa.pub` public key to `authorized_keys`.
    ```bash
    cp id_rsa.pub authorized_keys
    ```
3. Also, copy the `authorized_keys` to the home directory.
    ```bash
    cp id_rsa.pub ~/authorized_keys
    ```

###  Step 4: Create a Kubernetes ConfigMap
Navigate to our git's /monoinfra/auto-clusters/dc1/db-ns/db-ns-rsync/configmap and create a new .yml file named  `db_rsync_ssh_configs_<cluster-replica-name>.yml`.

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: db-rsync-config-<cluster-replica-name>
      namespace: db-ns

    data:
      privatekey: 
        
      publickey:
        
      knownhosts:
        
    ```
>Note: Edit the `<cluster-replica-name>`

1. Display the contents of `id_rsa` and copy the key to the `privatekey:` section of the Kubernetes ConfigMap.
    ```bash
    cat id_rsa
    ```
2. Display the contents of `id_rsa.pub` and copy the key to the `publickey:` section of the Kubernetes ConfigMap.
    ```bash
    cat id_rsa.pub
    ```
3. Scan the replica IP address (example: 192.168.0.101) to gather SSH host keys and copy the output to the `knownhosts:` section of the ConfigMap.
    ```bash
    ssh-keyscan -H <REDACTED_IP>

    #or try this as shortcut
    ssh-keyscan -H <REDACTED_IP> | awk '{print $2, $3}' | grep -E 'ecdsa-sha|ssh-rsa|ssh-ed' 

    ```
Copy the output and add the ecdsa, ssh-rsa, and ssh-ed25519 keys to the knownhosts section of the ConfigMap.

>Note: When configuring the `known_hosts` section of the ConfigMap, you need to copy the SSH key fingerprints that identify the replica server. This involves using the `ssh-keyscan` command to obtain the SSH key fingerprints and then adding these fingerprints to the ConfigMap. It is essential to copy only the key values (the strings after the key type, like `ecdsa`, `ssh-rsa`, and `ssh-ed25519`), excluding any unnecessary characters. As before that we will put the ip of the replica without encrypting it.

   Example output:
   ```plaintext
   # <REDACTED_IP>:22 SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10
   |1|BDg3CjQU9HK3S1cuJMn7UaeEJEc=|gaqYMBS9ky2QDijq9rJJWK7lI0s= ecdsa-sha2-nistp256 <some random characters>
   # <REDACTED_IP>:22 SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10
   |1|P43TGVd26OsRsGKqgTGsndHZlU=|7NyqjyqIiiN5V42eEmI+zEk9GPU= ssh-rsa <some random characters>
   # <REDACTED_IP>:22 SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10
   |1|kGk0FSn88aOO/mh1gI1gaGKUiYQ=|qmgSpNgTIVdVFUGU201ohFvjgWM= ssh-ed25519 <some random characters>
   ```

Skip these `|1|kGk0FSn88aOO/mh1gI1gaGKUiYQ=|qmgSpNgTIVdVFUGU201ohFvjgWM=` , `|1|BDg3CjQU9HK3S1cuJMn7UaeEJEc=|gaqYMBS9ky2QDijq9rJJWK7lI0s=`, `|1|P43TGVd26OsRsGKqgTGsndHZlU=|7NyqjyqIiiN5V42eEmI+zEk9GPU= `

Below is the final YAML file for the ConfigMap:

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: db-rsync-config-replica_ABC
      namespace: db-ns

    data:  
      privatekey: |
        <REDACTED_PRIVATE_KEY>
      publickey:
        ssh-rsa <REDACTED_PUBLIC_KEY>
      knownhosts:
        <REDACTED_IP> ssh-rsa <REDACTED_SSH_KEY>
        <REDACTED_IP> ecdsa-sha2-nistp256 <REDACTED_SSH_KEY>
        <REDACTED_IP> ssh-ed25519 <REDACTED_SSH_KEY>
    ```

### Step 5: Directory Setup on Cluster Replica

1. **Mount Disk:**
   Ensure the disk is mounted as `/postgres`.

2. **Create Directory Structure:**
   Run a shell script to create the necessary directory structure. The script will create the required directories and set permissions.

   ```sh
    #!/bin/bash

    # Base directory
    BASE_DIR="/postgres/rsyncbackrest/production"

    # Create base directory
    mkdir -p $BASE_DIR

    # Loop through the database names provided as arguments
    for DB in "$@"; do
        mkdir -p $BASE_DIR/$DB/archive
        mkdir -p $BASE_DIR/$DB/backup
    done

    # Change ownership and permissions
    chown -R postgres:postgres $BASE_DIR
    chmod -R 755 $BASE_DIR

   ```

   Save this script as `setup_directories.sh` and run it on the cluster replica:

   ```sh
   sudo bash setup_directories.sh db_name1 db_name2
   ```

### Step 6: Build the Docker Image for the RSync Service

Before you can deploy the RSync pod, you need to build a Docker image that contains the `rsync`, `ssh`, and `python3` tooling needed to continuously sync pgBackRest backup files from the Kubernetes pod to the remote replica server. This image uses a Python loop that periodically calls `rsync` over SSH.

> **Why a custom Docker image?** The Crunchy PostgreSQL Operator's backup repository pod has the backup data but does not include an `rsync` client or SSH daemon. Rather than modifying the operator's image, we build a lightweight sidecar container (based on `alpine`) dedicated solely to file transfer. It runs in a separate Deployment that mounts the same backup PVC.

#### 6.1 Project Structure

Create a directory for the Docker image source files:

```
backrest-sync/
├── Dockerfile
├── scripts/
│   ├── entry.sh
│   └── sync.py
└── config/
    └── sshd_config
```

#### 6.2 The Dockerfile

The `Dockerfile` defines the runtime environment. It starts from `alpine:latest` (small, security-focused) and installs `openssh`, `rsync`, `python3`, and supporting packages.

```dockerfile
# Dockerfile
FROM alpine:latest

# Install required packages
RUN apk add --no-cache \
    bash \
    openssh \
    rsync \
    python3 \
    py3-pip \
    augeas-libs \
    tzdata \
    augeas \
    rssh \
    bc \
    && rm -rf /var/cache/apk/*

# Create necessary directories
RUN mkdir -p /etc/ssh/keys \
    /etc/authorized_keys \
    /home/scripts \
    /var/run/sshd

# Copy scripts
COPY scripts/entry.sh /entry.sh
COPY scripts/sync.py /home/scripts/sync.py

# Set permissions
RUN chmod +x /entry.sh /home/scripts/sync.py

# Set working directory
WORKDIR /home/scripts

# Expose SSH port
EXPOSE 22

# Set entrypoint and default command
ENTRYPOINT ["/entry.sh"]
CMD ["python3", "/home/scripts/sync.py"]

# Health check
HEALTHCHECK --interval=5m --timeout=3s \
  CMD ps aux | grep "[s]shd" && ps aux | grep "[p]ython3 /home/scripts/sync.py" || exit 1
```

**What each section does:**

| Directive | Purpose |
|---|---|
| `FROM alpine:latest` | Minimal base image (~5 MB) with a small attack surface. |
| `RUN apk add ...` | Installs `openssh` (SSH daemon + client), `rsync` (file sync tool), `python3` (to run the sync loop), and utilities (`bash`, `tzdata`, `bc`). |
| `RUN mkdir -p ...` | Creates directories for SSH host keys, authorized keys, the Python script, and the SSH daemon PID file. |
| `COPY scripts/entry.sh` | Copies the entrypoint script that generates SSH keys and starts `sshd`. |
| `COPY scripts/sync.py` | Copies the Python sync loop script. |
| `EXPOSE 22` | Documents that the container listens on the default SSH port (so the replica can connect back if needed, though this setup is typically one-way). |
| `ENTRYPOINT ["/entry.sh"]` | The container always runs `entry.sh` first, which bootstraps SSH, then executes the `CMD`. |
| `CMD ["python3", ...]` | The default task: run the infinite rsync loop. |
| `HEALTHCHECK` | Every 5 minutes, verifies both `sshd` and `sync.py` are alive. If either is missing, Kubernetes restarts the pod. |

#### 6.3 The Entrypoint Script (`entry.sh`)

This script runs every time the container starts. Its job is to generate SSH host keys (if missing), configure the SSH daemon for key-only authentication, set up user accounts, start `sshd`, and then run the sync script.

```bash
#!/usr/bin/env bash

set -eo pipefail

[ "$DEBUG" == 'true' ] && set -x

DAEMON=sshd

generate_host_keys() {
    local key_dir="/etc/ssh/keys"
    mkdir -p "$key_dir"
    
    for type in rsa ecdsa ed25519; do
        if [ ! -f "$key_dir/ssh_host_${type}_key" ]; then
            ssh-keygen -t ${type} -f "$key_dir/ssh_host_${type}_key" -N ''
        fi
    done
}

configure_sshd() {
    # Set up host keys
    for type in rsa ecdsa ed25519; do
        if [ -f "/etc/ssh/keys/ssh_host_${type}_key" ]; then
            echo "HostKey /etc/ssh/keys/ssh_host_${type}_key" >> /etc/ssh/sshd_config
        fi
    done
    
    # Set secure defaults
    {
        echo "PasswordAuthentication no"
        echo "PermitRootLogin no"
        echo "AllowTcpForwarding no"
        echo "X11Forwarding no"
    } >> /etc/ssh/sshd_config
}

setup_users() {
    if [ -n "${SSH_USERS}" ]; then
        echo "Setting up users..."
        IFS=',' read -ra USERS <<< "$SSH_USERS"
        for user in "${USERS[@]}"; do
            IFS=':' read -ra USER_DATA <<< "$user"
            username="${USER_DATA[0]}"
            uid="${USER_DATA[1]:-1000}"
            gid="${USER_DATA[2]:-1000}"
            
            # Create user
            addgroup -g "$gid" "$username" 2>/dev/null || true
            adduser -D -u "$uid" -G "$username" "$username"
            
            # Set up SSH directory
            user_ssh_dir="/home/$username/.ssh"
            mkdir -p "$user_ssh_dir"
            chmod 700 "$user_ssh_dir"
            
            # Set up authorized keys
            if [ -f "/etc/authorized_keys/$username" ]; then
                cp "/etc/authorized_keys/$username" "$user_ssh_dir/authorized_keys"
                chmod 600 "$user_ssh_dir/authorized_keys"
                chown -R "$username:$username" "$user_ssh_dir"
            else
                echo "Warning: No authorized_keys found for $username"
            fi
        done
    fi
}

main() {
    # Initialize SSH
    generate_host_keys
    configure_sshd
    setup_users
    
    # Start SSHD
    echo "Starting SSHD..."
    /usr/sbin/sshd
    
    # Execute CMD
    echo "Running $@"
    exec "$@"
}

main "$@"
```

**Why each function exists:**

| Function | Why it's needed |
|---|---|
| `generate_host_keys` | SSH requires host keys to identify the server. Without them, SSH clients cannot verify the container's identity. The keys are persisted in `/etc/ssh/keys` so they survive container restarts (via a volume mount if desired). |
| `configure_sshd` | Hardens the SSH daemon: disables password login (key-only), forbids root login, and disables TCP/X11 forwarding to reduce attack surface. |
| `setup_users` | Reads the `SSH_USERS` environment variable (comma-separated `user:uid:gid` triples) and creates corresponding system users with their SSH authorized keys. This allows the replica server to SSH **into** the container if needed (e.g., for debugging). |
| `main` | Orchestrates the bootstrap: generate keys → configure → create users → start `sshd` → run the sync command. |

#### 6.4 The SSH Daemon Configuration (`sshd_config`)

Place this file at `config/sshd_config` in the build context. It is baked into the image by `entry.sh` (which appends to the default `/etc/ssh/sshd_config`).

```
Protocol 2
HostKey /etc/ssh/keys/ssh_host_rsa_key
HostKey /etc/ssh/keys/ssh_host_ecdsa_key
HostKey /etc/ssh/keys/ssh_host_ed25519_key

SyslogFacility AUTH
LogLevel INFO

PermitRootLogin no
StrictModes yes
MaxAuthTries 3

PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no

ChallengeResponseAuthentication no
UsePAM no

AllowTcpForwarding no
X11Forwarding no
PrintMotd no

AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
```

**Key settings explained:**

| Setting | Why |
|---|---|
| `Protocol 2` | Only SSH protocol 2 (more secure than protocol 1). |
| `PermitRootLogin no` | Blocks direct root SSH access. All operations run as the `postgres` (or specified) user. |
| `PubkeyAuthentication yes` | Only public key authentication is allowed. |
| `PasswordAuthentication no` | Disables password-based login — attackers cannot brute-force passwords. |
| `MaxAuthTries 3` | Limits authentication attempts to 3 before disconnecting. |
| `AllowTcpForwarding no` | Prevents port forwarding through this container (security hardening). |

#### 6.5 The Python Sync Script (`sync.py`)

This is the core engine. It runs in an infinite loop: every `SLEEP_DURATION` seconds, it uses `rsync` over SSH to copy backup and archive directories from the local mounted PVC to the remote replica server.

```python
#!/usr/bin/env python3
import os
import time
import subprocess
import logging
from datetime import datetime
from typing import Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class RsyncHandler:
    def __init__(self):
        # Required environment variables
        self.required_vars = [
            'RSYNC_REPO_NAME',
            'RSYNC_USER_NAME',
            'RSYNC_IP',
            'RSYNC_DESTINATION_PATH',
            'ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME',
            'SLEEP_DURATION'
        ]
        
        # Validate environment
        self.validate_environment()
        
        # Set configuration from environment
        self.config = {var: os.environ[var] for var in self.required_vars}
        self.sleep_duration = int(self.config['SLEEP_DURATION'])

    def validate_environment(self):
        """Validate all required environment variables are present."""
        missing = [var for var in self.required_vars if var not in os.environ]
        if missing:
            raise EnvironmentError(f"Missing required environment variables: {', '.join(missing)}")

    def run_rsync(self, source_path: str, dest_path: str) -> Tuple[int, float, int]:
        """Run rsync command and return exit code, duration, and file count."""
        start_time = time.time()
        
        # Ensure destination directories exist
        cmd_mkdir = f"ssh {self.config['RSYNC_USER_NAME']}@{self.config['RSYNC_IP']} 'mkdir -p {dest_path}'"
        subprocess.run(cmd_mkdir, shell=True, check=True)
        
        # Rsync command to sync files
        cmd = [
            'rsync',
            '-avzhe',
            'ssh',
            source_path,
            f"{self.config['RSYNC_USER_NAME']}@{self.config['RSYNC_IP']}:{dest_path}",
            '--delete'
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True)
            duration = time.time() - start_time
            
            if result.returncode != 0:
                logger.error(f"Rsync failed: {result.stderr}")
            else:
                # Parse the number of files synced from the rsync output
                num_files = result.stdout.count('\n') - 1
                logger.debug(f"Files synced: {num_files}")
                logger.debug(result.stdout)
                
            return result.returncode, duration, num_files
        except Exception as e:
            logger.error(f"Error running rsync: {str(e)}")
            return 1, time.time() - start_time, 0

    def sync_cycle(self):
        """Perform one complete sync cycle."""
        logger.info("Starting sync cycle")
        
        # Backup folder sync
        backup_source = f"/home/backrest/{self.config['RSYNC_REPO_NAME']}/backup/db/"
        backup_dest = f"{self.config['RSYNC_DESTINATION_PATH']}/backup/{self.config['ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME']}"
        backup_code, backup_time, backup_files = self.run_rsync(backup_source, backup_dest)
        
        # Archive folder sync
        archive_source = f"/home/backrest/{self.config['RSYNC_REPO_NAME']}/archive/db/"
        archive_dest = f"{self.config['RSYNC_DESTINATION_PATH']}/archive/{self.config['ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME']}"
        archive_code, archive_time, archive_files = self.run_rsync(archive_source, archive_dest)
        
        # Log summary
        logger.info("Sync Cycle Summary:")
        logger.info(f"Backup folder sync: {backup_time:.2f}s ({'Success' if backup_code == 0 else 'Failed'}), Files synced: {backup_files}")
        logger.info(f"Archive folder sync: {archive_time:.2f}s ({'Success' if archive_code == 0 else 'Failed'}), Files synced: {archive_files}")
        logger.info(f"Total duration: {backup_time + archive_time:.2f}s")
        
        return backup_code == 0 and archive_code == 0

    def run(self):
        """Main run loop."""
        logger.info("Starting rsync service")
        
        while True:
            try:
                self.sync_cycle()
            except Exception as e:
                logger.error(f"Error in sync cycle: {str(e)}")
            
            logger.info(f"Sleeping for {self.sleep_duration} seconds")
            time.sleep(self.sleep_duration)

if __name__ == "__main__":
    handler = RsyncHandler()
    handler.run()
```

**How the sync script works (step by step):**

1. **Validation** — On startup, the script checks that all six required environment variables are set. If any are missing, it exits immediately with a clear error message. This prevents a silent misconfiguration where the container runs but syncs nothing.

2. **Source paths** — The script looks for backup files under `/home/backrest/<RSYNC_REPO_NAME>/backup/db/` and archive (WAL) files under `/home/backrest/<RSYNC_REPO_NAME>/archive/db/`. These paths match the directory layout that `pgBackRest` creates inside the Crunchy PostgreSQL Operator's backup PVC.

3. **Destination paths** — On the replica server, files are placed under `<RSYNC_DESTINATION_PATH>/backup/<ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME>` and `<RSYNC_DESTINATION_PATH>/archive/<ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME>`. The `ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME` variable lets you nest multiple database clusters under a single destination root.

4. **Rsync with `--delete`** — The `--delete` flag ensures that files removed from the source are also removed from the destination. This keeps the replica in **exact sync** with the source. Without `--delete`, stale backup files would accumulate on the replica and waste disk space.

5. **SSH key authentication** — The script does not handle passwords. SSH keys are injected into the container via the ConfigMap volume mounts (see Step 4). The `rsync` command tunnels over SSH using those keys.

6. **Infinite loop** — After each sync cycle, the script sleeps for `SLEEP_DURATION` seconds, then repeats. This turns a one-shot `rsync` into a continuous replication loop.

#### 6.6 Required Environment Variables

These variables must be set when running the container (they are defined in the Deployment YAML's `env` section):

| Variable | What it does | Example |
|---|---|---|
| `RSYNC_REPO_NAME` | The name of the backup repository (matches the Crunchy PGO `pgbackrest` repo name). | `XYZ-backrest-shared-repo` |
| `RSYNC_USER_NAME` | The SSH user on the replica server that has write access to the destination path. | `postgres` |
| `RSYNC_IP` | IP address or hostname of the replica server. | `192.168.1.100` |
| `RSYNC_DESTINATION_PATH` | Base directory on the replica where files will be synced. | `/postgres/rsyncbackrest/production/XYZ` |
| `ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME` | A sub-folder name used to organize backups under the destination (often the database cluster name). | `XYZ` |
| `SLEEP_DURATION` | Seconds to wait between sync cycles. Shorter = tighter RPO but more network/CPU load. | `30` |

#### 6.7 Building and Pushing the Image

Once you have all four files in place, build and push the image to your container registry:

```bash
# Build the image (run from the backrest-sync/ directory)
docker build -t backrest-sync:1.0.2 .

# Tag for your registry (replace <your-registry> with your actual registry URL)
docker tag backrest-sync:1.0.2 <your-registry>/backrest-sync:1.0.2

# Push to the registry so Kubernetes can pull it
docker push <your-registry>/backrest-sync:1.0.2
```

> **Why push to a registry?** Kubernetes nodes need to pull the image from a registry (Docker Hub, GitLab Container Registry, Harbor, etc.) unless you pre-load the image on every node. Pushing to a registry is the standard approach for multi-node clusters.

#### 6.8 Testing the Image Locally (Optional)

You can test the container locally before deploying to Kubernetes:

```bash
docker run -d \
  --name test-rsync \
  -e RSYNC_REPO_NAME="XYZ-backrest-shared-repo" \
  -e RSYNC_USER_NAME="postgres" \
  -e RSYNC_IP="192.168.1.100" \
  -e RSYNC_DESTINATION_PATH="/postgres/rsyncbackrest/production/XYZ" \
  -e ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME="XYZ" \
  -e SLEEP_DURATION="30" \
  -v /path/to/local/backups:/home/backrest/XYZ-backrest-shared-repo \
  -v /path/to/ssh/id_rsa:/root/.ssh/id_rsa:ro \
  -v /path/to/ssh/id_rsa.pub:/root/.ssh/id_rsa.pub:ro \
  -v /path/to/ssh/known_hosts:/root/.ssh/known_hosts:ro \
  backrest-sync:1.0.2

# Check logs
docker logs -f test-rsync
```

Press `Ctrl+C` to stop following logs. The container runs until you stop it with `docker stop test-rsync`.

---

### Step 7: Kubernetes Deployment Setup

Now that the Docker image is built and available in your registry, you can create the Kubernetes Deployment that runs the RSync container alongside (or adjacent to) your pgBackRest repository pod.

1. **Create Deployment Directory:**
   In our monoinfra Git repository, navigate to `/auto-clusters/dc1/db-ns/db-ns-rsync/deployments/` and create a new directory named after your cluster, e.g., `replica_ABC`.

2. **Create Deployment YAML:**
   Inside the new directory, create a YAML file named `XYZ.yml`. Below is an example YAML file:
   >Note: XYZ is a imaginary pg cluster db name.

    ```yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      labels:
        name: rsync-XYZ-transfer-replica_ABC
      name: rsync-XYZ-transfer-replica_ABC
      namespace: db-ns
    spec:
      replicas: 1
      selector:
        matchLabels:
          name: rsync-XYZ-transfer-replica_ABC
      strategy:
        rollingUpdate:
          maxSurge: 1
          maxUnavailable: 1
        type: RollingUpdate
      template:
        metadata:
          labels:
            name: rsync-XYZ-transfer-replica_ABC
        spec:
          affinity:
            podAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchExpressions:
                  - key: name
                    operator: In
                    values:
                    - XYZ-backrest-shared-repo
                topologyKey: kubernetes.io/hostname
          containers:
          - env:
            - name: ARCHIVE_BACKUP_INTERNAL_FOLDER_NAME
              value: "XYZ"
            - name: RSYNC_REPO_NAME
              value: "XYZ-backrest-shared-repo"
            - name: RSYNC_USER_NAME
              value: "postgres"
            - name: RSYNC_DESTINATION_PATH
              value: /postgres/rsyncbackrest/production/XYZ
            - name: RSYNC_IP
              value: "<replica-server-ip>"
            - name: SLEEP_DURATION
              value: "30"
            image: <your-registry>/backrest-sync:1.0.2
            imagePullPolicy: Always
            name: rsync-XYZ-transfer-replica_ABC
            resources:
              requests:
                cpu: "100m"
                memory: "100Mi"
              limits:
                cpu: "500m"
                memory: "512Mi"
            volumeMounts:
            - mountPath: /home/backrest/
              name: XYZ-storage
            - mountPath: /root/.ssh/id_rsa
              name: sshconfig
              subPath: privatekey
            - mountPath: /root/.ssh/id_rsa.pub
              name: sshconfig
              subPath: publickey
            - mountPath: /root/.ssh/known_hosts
              name: sshconfig
              subPath: knownhosts
          volumes:
          - name: XYZ-storage
            persistentVolumeClaim:
              claimName: XYZ-pgbr-repo
          - name: sshconfig
            configMap:
              name: db-rsync-config-replica_ABC
              defaultMode: 0600
    ```
>Note the configMap name should replesent the configMap file you have made earlier.

### Explanation of the YAML File

- **apiVersion & kind:**
  Specifies the API version and type of Kubernetes object (Deployment).

- **metadata:**
  Contains metadata such as labels, deployment name, and namespace.

- **spec:**
  - **replicas:**
    Defines the number of pod replicas to be created (1 in this case).
  - **selector:**
    Selects pods based on matching labels.
  - **strategy:**
    Specifies the deployment strategy (RollingUpdate).
  - **template:**
    Defines the pod template, including metadata and specification.
    - **affinity:**
      Ensures the pod runs on nodes with specific labels.
    - **containers:**
      Defines the container specifications, including environment variables, image, resources, and volume mounts.
    - **volumes:**
      Specifies the volumes to be mounted in the pod, including PVC and ConfigMap for SSH configuration.

### Step 8: Apply the YAML File

1. **Deploy to Kubernetes:**
   Apply the YAML file to your Kubernetes cluster to start the RSync process:

    ```sh
    kubectl apply -f /path/to/XYZ.yml
    ```

2. **Verify Deployment:**
   Check the status of the deployment to ensure it is running correctly:

    ```sh
    kubectl get deployments -n db-ns
    kubectl get pods -n db-ns
    ```


### Restoring the backups to the replica_ABC Steps

### Prerequisites
- A cluster of machines with archived databases which are stored on `replica_ABC` node under `/postgres/rsyncbackrest/production/{pg_db_cluster_name}`.


#### Step 9: Prepare the Restoration Script

Save the following script as `restore_clusters.sh`:

    ```bash
    #!/bin/bash
    # Created by [Author Name] Modified by [Modifier Name]
    # The script restores the database for the given cluster name.
    # It creates a new PostgreSQL cluster, updates the pgBackRest configuration, updates the PostgreSQL configuration, restores the database using pgBackRest, sets appropriate permissions, and starts the PostgreSQL cluster.
    # It takes the cluster name as an argument and restores the database for the given cluster name.

    # Color variables
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    SKY_BLUE='\033[1;36m'
    PINK='\033[1;35m'
    RED='\033[0;31m'
    NC='\033[0m'

    # Script logic starts here
    if [ "$#" -lt 1 ]; then
        echo -e "${RED}Usage: $0 cluster_name1 [cluster_name2 ...]${NC}"
        exit 1
    fi

    for cluster_name in "$@"; do
        echo -e "${SKY_BLUE}Processing Cluster: $cluster_name${NC}"
        
        # Replace hyphens and underscores for directory names to avoid issues ex a-b_c >> abc (sed 's/[-_]//g')
        dir_name="$(echo "$cluster_name" | sed 's/[-_]//g')"
        
        # Check if the directory exists
        if [ ! -d "/postgres/rsyncbackrest/production/$dir_name" ]; then
            echo -e "${RED}Directory /postgres/rsyncbackrest/production/$dir_name does not exist.${NC}"
            continue
        fi
        
        # Change to the production directory
        cd /postgres/rsyncbackrest/production
        
        # Display the size of the cluster directory
        sudo -u postgres du -sh "$dir_name/"
        
        # Create a PostgreSQL cluster
        sudo pg_createcluster 13 "$dir_name" -d "/postgres/data/13/$dir_name"
        
        # Check if cluster creation was successful
        if [ $? -ne 0 ]; then
            echo -e "${RED}Error: Failed to create cluster $dir_name.${NC}"
            continue
        fi
        
        # Get the port of the created cluster
        cluster_port=$(pg_lsclusters 13 "$dir_name" | grep "$dir_name" | awk '{ print $3 }')
        echo -e "${SKY_BLUE}Cluster $dir_name created on port: $cluster_port${NC}"
        
        # Update pgBackRest configuration
        cat << EOF | sudo tee -a /etc/pgbackrest.conf
    [$cluster_name]
    db1-path=/postgres/data/13/$dir_name
    repo1-path=/postgres/rsyncbackrest/production/$dir_name
    pg1-port=$cluster_port

    EOF
        
        # Update PostgreSQL configuration
        cat << EOF | sudo tee -a /etc/postgresql/13/$dir_name/conf.d/postgresql.conf
    max_connections = 600
    listen_addresses= '*'
    restore_command = 'pgbackrest archive-get --stanza=$cluster_name %f %p'
    max_standby_archive_delay = -1
    hot_standby = on
    log_timezone = 'Asia/Dhaka'
    timezone = 'Asia/Dhaka'
    EOF
        
        # Restore the database using pgBackRest
        sudo -u postgres pgbackrest --stanza="$cluster_name" --delta --type=standby restore
        
        # Check if restore was successful
        if [ $? -ne 0 ]; then
            echo -e "${RED}Error: Failed to restore database for $dir_name.${NC}"
            continue
        fi
        
        # Set appropriate permissions
        sudo chmod -R 700 /postgres/data/13/$dir_name
        
        # Start the PostgreSQL cluster
        sudo systemctl start postgresql@13-"$dir_name".service
        
        echo -e "${GREEN}Cluster $cluster_name (directory: $dir_name) is live on port $cluster_port${NC}"
    done
    ```

#### Step 10: Make the Script Executable
    ```bash
    chmod +x restore_clusters.sh
    ```

### Running the Script
To restore multiple clusters, run the script with the cluster names as arguments:

    ```bash
    ./restore_clusters.sh cluster_1 cluster_2
    ```

### Explanation of the Script

1. **Input Validation:**
   - Checks if at least one cluster name is provided.
   
2. **Loop Through Each Cluster:**
   - For each cluster name provided as an argument:
     - Validates the existence of the cluster directory.
     - Changes to the directory where the archived databases are stored.
     - Displays the size of the cluster directory.
     - Creates a new PostgreSQL cluster.
     - Retrieves and displays the port of the newly created cluster.
     - Appends the pgBackRest configuration with the new cluster information.
     - Appends the PostgreSQL configuration with necessary settings.
     - Restores the database using pgBackRest.
     - Sets appropriate file permissions.
     - Starts the PostgreSQL cluster.
     - Confirms the cluster is live on the specified port.

## Conclusion
By following this guide, you can set up PostgreSQL and pgBackRest on the replica_ABC machine and restore archived databases to different ports. The provided script automates the setup process for multiple clusters, making it easier to manage and deploy your PostgreSQL instances.
