---
layout: post
title: "Setting Up RSync in Kubernetes to Copy pgBackRest Backup Files to a New replica_ABC and install PostgreSQL,…"
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
Navigate to our git's /monoinfra/auto-clusters/dc1/prod-db/prod-db-rsync/configmap and create a new .yml file named  `db_rsync_ssh_configs_<cluster-replica-name>.yml`.

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: db-rsync-config-<cluster-replica-name>
      namespace: prod-db

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
      namespace: prod-db

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

### Step 6: Kubernetes Deployment Setup

1. **Create Deployment Directory:**
   In our monoinfra Git repository, navigate to `/auto-clusters/dc1/prod-db/prod-db-rsync/deployments/` and create a new directory named after your cluster, e.g., `replica_ABC`.

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
      namespace: prod-db
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

### Step 7: Apply the YAML File

1. **Deploy to Kubernetes:**
   Apply the YAML file to your Kubernetes cluster to start the RSync process:

    ```sh
    kubectl apply -f /path/to/XYZ.yml
    ```

2. **Verify Deployment:**
   Check the status of the deployment to ensure it is running correctly:

    ```sh
    kubectl get deployments -n prod-db
    kubectl get pods -n prod-db
    ```


### Restoring the backups to the replica_ABC Steps

### Prerequisites
- A cluster of machines with archived databases which are stored on `replica_ABC` node under `/postgres/rsyncbackrest/production/{pg_db_cluster_name}`.


#### Seep 8: Prepare the Restoration Script

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

#### Step 9: Make the Script Executable
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
