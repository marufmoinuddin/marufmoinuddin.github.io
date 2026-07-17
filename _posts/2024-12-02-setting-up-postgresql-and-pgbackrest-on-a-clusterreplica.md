---
layout: post
title: Setting Up PostgreSQL and pgBackRest on a ClusterReplica
date: 2024-12-02
category: PostgreSQL
tags: [pgbackrest, postgresql, rsync]
excerpt: This guide will help you set up PostgreSQL (Percona-PostgreSQL-13) and pgBackRest (Percona-pgBackRest) on a machine (clusterreplica) to restore archived databases and make them live on different ports. We will cover…
read_time: 2
source_doc: pg-docs/pg13-pgbackrest-clusterreplica.md
draft_import: true
---
## Setting Up PostgreSQL and pgBackRest on a ClusterReplica

### Overview
This guide will help you set up PostgreSQL (Percona-PostgreSQL-13) and pgBackRest (Percona-pgBackRest) on a machine (clusterreplica) to restore archived databases and make them live on different ports. We will cover the installation process and provide a script to automate the setup for multiple clusters.

### Prerequisites
- A cluster of machines with archived databases which are stored on `clusterreplica` node under `/postgres/rsyncbackrest/production/{cluster_name}`.

### Installation Steps

#### 1. Install PostgreSQL and pgBackRest

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

#### 2. Prepare the Restoration Script

Save the following script as `restore_clusters.sh`:

```bash
#!/bin/bash

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 cluster_name1 [cluster_name2 ...]"
    exit 1
fi

for cluster_name in "$@"; do
    echo "Processing Cluster: $cluster_name"
    
    # Check if the directory exists
    if [ ! -d "/postgres/rsyncbackrest/production/$cluster_name" ]; then
        echo "Directory /postgres/rsyncbackrest/production/$cluster_name does not exist."
        continue
    fi
    
    # Change to the production directory
    cd /postgres/rsyncbackrest/production
    
    # Display the size of the cluster directory
    sudo -u postgres du -sh "$cluster_name/"
    
    # Create a PostgreSQL cluster
    sudo pg_createcluster 13 "$cluster_name" -d "/postgres/data/13/$cluster_name"
    
    # Get the port of the created cluster
    cluster_port=$(pg_lsclusters 13 "$cluster_name" | grep "$cluster_name" | awk '{ print $3 }')
    echo "Cluster $cluster_name created on port: $cluster_port"
    
    # Update pgBackRest configuration
    cat << EOF | sudo tee -a /etc/pgbackrest.conf
[$cluster_name]
db1-path=/postgres/data/13/$cluster_name
repo1-path=/postgres/rsyncbackrest/production/$cluster_name
pg1-port=$cluster_port

EOF
    
    # Update PostgreSQL configuration
    cat << EOF | sudo tee -a /etc/postgresql/13/$cluster_name/conf.d/postgresql.conf
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
    
    # Set appropriate permissions
    sudo chmod -R 700 /postgres/data/13/$cluster_name
    
    # Start the PostgreSQL cluster
    sudo systemctl start postgresql@13-"$cluster_name".service
    
    echo "Cluster $cluster_name is live on port $cluster_port"
done
```

#### 3. Make the Script Executable
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

### Conclusion
By following this guide, you can set up PostgreSQL and pgBackRest on the clusterreplica machine and restore archived databases to different ports. The provided script automates the setup process for multiple clusters, making it easier to manage and deploy your PostgreSQL instances.
