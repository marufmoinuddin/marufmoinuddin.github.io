---
layout: post
title: "PostgreSQL 15 High Availability Cluster with Patroni"
date: 2026-07-17
category: PostgreSQL
tags: [etcd, haproxy, high-availability, kvm, libvirt, patroni, postgresql, qemu, ubuntu]
excerpt: "This documentation provides a comprehensive guide to setting up a high availability PostgreSQL cluster using Patroni on Ubuntu 22.04.4. The architecture includes three PostgreSQL n"
read_time: 12
order: 5
---

# PostgreSQL 15 High Availability Cluster with Patroni

This documentation provides a comprehensive guide to setting up a high availability PostgreSQL cluster using Patroni on Ubuntu 22.04.4. The architecture includes three PostgreSQL nodes (one master and two replicas), an etcd node, and an HAProxy node for load balancing.

## Architecture Overview

- **OS:** Ubuntu 22.04.4
- **Postgres version:** 15

## Considerations

1. This is the example deployment suitable to be used for testing purposes in non-production environments. 
2. In this setup ETCD resides on the same hosts as Patroni. In production, consider deploying ETCD cluster on dedicated hosts or at least have separate disks for ETCD and PostgreSQL. This is because ETCD writes every request from the cluster to disk which can be CPU intensive and affects disk performance. See [hardware recommendations](https://etcd.io/docs/v3.6/op-guide/hardware/) for details.
3. For this setup, we will use the nodes running on Ubuntu 22.04 as the base operating system:

    | Node name     | Application       | IP address
    |---------------|-------------------|--------------------
    | node1         | Patroni, PostgreSQL, ETCD    | 10.0.0.1
    | node2         | Patroni, PostgreSQL, ETCD    | 10.0.0.2
    | node3         | Patroni, PostgreSQL, ETCD     | 10.0.0.3
    | HAProxy-demo  | HAProxy           | 10.0.0.100


> **Note**: Ideally, in a production (or even non-production) setup, the PostgreSQL nodes will be within a private subnet without any public connectivity to the Internet, and the HAProxy will be in a different subnet that allows client traffic coming only from a selected IP range. To keep things simple, we have implemented this architecture in a private environment, and each node can access the other by its internal, private IP. 


## Step 1 – Setup your VM Environment

For this tutorial, we will use QEMU KVM with virt-manager. Follow these steps to install and configure the necessary tools.

1. **Install and configure Virt-Manager**
    ```bash
    sudo apt update
    sudo apt install -y qemu-kvm virt-manager virt-viewer libvirt-daemon-system virtinst libvirt-clients bridge-utils
    sudo systemctl enable --now libvirtd
    sudo systemctl start libvirtd
    sudo usermod -aG kvm $USER
    sudo usermod -aG libvirt $USER
    sudo virsh net-autostart default
    sudo virsh net-start default
    ```

## Step 2 – Create and Clone VMs

1.  **Download the Ubuntu Server ISO**
    ```bash
    wget -O ~/Downloads/ubuntu-22.04.4-live-server-amd64.iso https://releases.ubuntu.com/22.04.4/ubuntu-22.04.4-live-server-amd64.iso
    ```

   1. **Create the First VM (node1)**
	    ```bash
	    sudo virt-install --name ubuntu-node1 \
	                      --os-variant ubuntu22.04 \
	                      --memory 1024 \
	                      --vcpus 2 \
	                      --disk size=10,path=/var/lib/libvirt/images/ubuntu-node1.qcow2,format=qcow2,bus=virtio \
	                      --cdrom ~/Downloads/ubuntu-22.04.4-live-server-amd64.iso \
	                      --network default
	    ```


2. **Set Up Ubuntu on node1**
    Setup your Ubuntu VM to configure the server. Then Power off your this VM.
    If you wish, you can follow this [PDF](<your-documentation-repository-url>)

3. **Clone node1 to Create node2 and node3**
    ```bash
    sudo virt-clone --original ubuntu-node1 --name ubuntu-node2 --file /var/lib/libvirt/images/ubuntu-node2.qcow2
    sudo virt-clone --original ubuntu-node1 --name ubuntu-node3 --file /var/lib/libvirt/images/ubuntu-node3.qcow2
    sudo virt-clone --original ubuntu-node1 --name HAProxy-demo --file /var/lib/libvirt/images/HAProxy-demo.qcow2
    ```
4. **Start All the VMs and Login**

	
    ```bash
	sudo virsh --connect qemu:///system start ubuntu-node1 && sudo virt-manager --connect qemu:///system --show-domain-console ubuntu-node1
	sudo virsh --connect qemu:///system start ubuntu-node2 && sudo virt-manager --connect qemu:///system --show-domain-console ubuntu-node2
	sudo virsh --connect qemu:///system start ubuntu-node3 && sudo virt-manager --connect qemu:///system --show-domain-console ubuntu-node3
	sudo virsh --connect qemu:///system start HAProxy-demo && sudo virt-manager --connect qemu:///system --show-domain-console HAProxy-demo
    ```
    
## Step 3 – Configure VMs

Check the IP address assigned in every VM.
```bash
ip a | grep 'inet ' | awk '{ print $2 }'
```
You may get a single IP or a list of IP. The IP we are looking for must start with `10.0.0`. Now use that IP to login with ssh from your own terminal.

Suppose we have got IP `10.0.0.200` from `node1`. Then our ssh command would be,
```bash
ssh <username>@10.0.0.200
```
> Note: Please use the username you have given while setting up Ubuntu and the IP you have just got. Do this for all the nodes.

### Netplan Static IP Configuration

> **Disclaimer:** We used the `10.0.0.0/24` IP range as it's the default network in virt-manager and libvirt for virtual machines.  ***If the IP range ever changes in the future for libvirt, please update it accordingly.***

For each node, you'll need to create or edit the netplan configuration file located at `/etc/netplan/00-installer-config.yaml`.

#### Editing Netplan Configuration Files
On each node, run and then edit the file. 
```bash
sudo nano /etc/netplan/00-installer-config.yaml
```
To save press `ctrl+x` and then `y` to confirm:

#### node1 (10.0.0.1)
```yaml
# This is the network config written by 'subiquity'
network:
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - 10.0.0.1/24
      gateway4: 10.0.0.254
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
  version: 2
```

#### node2 (10.0.0.2)
```yaml
# This is the network config written by 'subiquity'
network:
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - 10.0.0.2/24
      gateway4: 10.0.0.254
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
  version: 2
```

#### node3 (10.0.0.3)
```yaml
# This is the network config written by 'subiquity'
network:
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - 10.0.0.3/24
      gateway4: 10.0.0.254
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
  version: 2
```

#### HAProxy-demo (10.0.0.100)
```yaml
# This is the network config written by 'subiquity'
network:
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - 10.0.0.100/24
      gateway4: 10.0.0.254
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
  version: 2
```

After editing the netplan configuration files, apply the changes with:
```bash
sudo netplan apply
```
> **Note:** You may need to reconnect to your ssh
### Configure Hostnames in the `/etc/hosts` File

It's not necessary to have name resolution, but it makes the setup more readable and less error-prone. Instead of configuring a DNS, we use local name resolution by updating the `/etc/hosts` file. By resolving their hostnames to their IP addresses, we ensure seamless communication between nodes.

1. Run the following command on each node, changing the node name to `node1`, `node2`, and `node3` respectively:
    ```bash
    sudo hostnamectl set-hostname node1
    ```
    For HAProxy-demo:
    ```bash
    sudo hostnamectl set-hostname HAProxy-demo
	```
    

2. Modify the `/etc/hosts` file of each PostgreSQL node to include the hostnames and IP addresses of the remaining nodes. Add the following at the end of the `/etc/hosts` file on all nodes:

	Let's edit the file:
	For the PostgreSQL nodes (node1, node2, node3):
	
	```bash
	echo -e "# Cluster IP and names\n10.0.0.1 node1\n10.0.0.2 node2\n10.0.0.3 node3" | sudo tee -a /etc/hosts

	```

	The HAProxy instance should have the name resolution for all three nodes in its /etc/hosts file. Lets's add the following lines at the end of the file by this command:

	```bash
	echo -e "# Cluster IP and names\n10.0.0.100 HAProxy-demo\n10.0.0.1 node1\n10.0.0.2 node2\n10.0.0.3 node3" | sudo tee -a /etc/hosts
	```

## Step 4 - Install the software

### Install Percona Distribution in all VMs (node1, node2, node3, HAProxy-demo)

1. Install the `curl` and `wget` download utility if it's not installed already:
    ```bash
    sudo apt update
    sudo apt -y install curl wget
    ```

2. Download the `percona-release` repository package:
    ```bash
    wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
    ```

3. Install the downloaded repository package and its dependencies using `apt`:
    ```bash
    sudo apt -y install gnupg2 lsb-release ./percona-release_latest.generic_all.deb
    ```

4. Refresh the local cache to update the package information:
    ```bash
    sudo apt update
    ```

5. After installation, the Percona software repositories are available. If you want you can check the repository setup for the Percona original release list in the `/etc/apt/sources.list.d/percona-original-release.list` file.
    > **Note:** If you have enabled another repository, the file name will be different.

6. Enable the repository for all nodes:
    ```bash
    sudo percona-release setup ppg15
    ```
    
### Install Patroni and ETCD in node1, node2, node3

1. Install Percona Distribution for PostgreSQL packages:
    ```bash
    sudo apt -y install percona-postgresql-15
    ```

1. Install Python and auxiliary packages to help with Patroni and ETCD:
    ```bash
    sudo apt -y install python3-pip python3-dev binutils
    ```

1. Install ETCD, Patroni, and pgBackRest packages:
    ```bash
    sudo apt -y install percona-patroni etcd etcd-server etcd-client percona-pgbackrest
    ```

1. Stop and disable all installed services:
    ```bash
    sudo systemctl stop etcd patroni postgresql
    sudo systemctl disable etcd patroni postgresql
    ```

1. Remove the existing Postgres data directory to force Patroni to initialize a new Postgres cluster instance:
    ```bash
    sudo rm -rf /var/lib/postgresql/15/main
    ```
## Configure ETCD distributed store  

The distributed configuration store provides a reliable way to store data that needs to be accessed by large scale distributed systems. The most popular implementation of the distributed configuration store is ETCD. ETCD is deployed as a cluster for fault-tolerance and requires an odd number of members (n/2+1) to agree on updates to the cluster state. An ETCD cluster helps establish a consensus among nodes during a failover and manages the configuration for the three PostgreSQL instances.

The `etcd` cluster is first started in one node and then the subsequent nodes are added to the first node using the `add `command. The configuration is stored in the `/etc/default/etcd` file.



#### Configure Node1

1. **Back up the Configuration File**:

   ```bash
   sudo mv /etc/default/etcd /etc/default/etcd.orig
   ```

2. **Export Environment Variables**:

   ```bash
   export NODE_NAME=$(hostname -f)
   export NODE_IP=$(hostname -i | awk '{print $1}')
   export ETCD_TOKEN='demo-cluster-token'
   export ETCD_DATA_DIR='/var/lib/etcd/postgresql'
   ```

3. **Modify the Configuration File**:

   ```bash
   echo "
   ETCD_NAME=${NODE_NAME}
   ETCD_INITIAL_CLUSTER=\"${NODE_NAME}=http://${NODE_IP}:2380\"
   ETCD_INITIAL_CLUSTER_STATE=\"new\"
   ETCD_INITIAL_CLUSTER_TOKEN=\"${ETCD_TOKEN}\"
   ETCD_INITIAL_ADVERTISE_PEER_URLS=\"http://${NODE_IP}:2380\"
   ETCD_DATA_DIR=\"${ETCD_DATA_DIR}\"
   ETCD_LISTEN_PEER_URLS=\"http://${NODE_IP}:2380\"
   ETCD_LISTEN_CLIENT_URLS=\"http://${NODE_IP}:2379,http://localhost:2379\"
   ETCD_ADVERTISE_CLIENT_URLS=\"http://${NODE_IP}:2379\"
   " | sudo tee -a /etc/default/etcd
   ```

4. **Start the etcd Service**:

   ```bash
   sudo systemctl enable --now etcd
   ```

5. **Check the etcd Cluster Members**:

   ```bash
   sudo etcdctl member list
   ```

#### Configure Node2
1. **On Node1**, run the following command to add Node2 to the cluster:

   ```bash
   sudo etcdctl member add node2 http://10.0.0.2:2380
   ```

   The output will resemble the following:

```
Added member named node2 with ID 10042578c504d052 to cluster

ETCD_NAME="node2"
   ETCD_INITIAL_CLUSTER="node2=http://10.0.0.2:2380,node1=http://10.0.0.1:2380"
   ETCD_INITIAL_CLUSTER_STATE="existing"
   ```
   
2. **Back up the Configuration File** and **Export Environment Variables**:

   ```bash
   sudo mv /etc/default/etcd /etc/default/etcd.orig
   export NODE_NAME=$(hostname -f)
   export NODE_IP=$(hostname -i | awk '{print $1}')
   export ETCD_TOKEN='demo-cluster-token'
   export ETCD_DATA_DIR='/var/lib/etcd/postgresql'
   ```

3. **Modify the Configuration File**:

   ```bash
	echo "
	ETCD_NAME=${NODE_NAME}
	ETCD_INITIAL_CLUSTER="node1=http://10.0.0.1:2380,node2=http://${NODE_IP}:2380"
	ETCD_INITIAL_CLUSTER_STATE="existing"
	ETCD_INITIAL_CLUSTER_TOKEN="${ETCD_TOKEN}"
	ETCD_INITIAL_ADVERTISE_PEER_URLS="http://${NODE_IP}:2380"
	ETCD_DATA_DIR="${ETCD_DATA_DIR}"
	ETCD_LISTEN_PEER_URLS="http://${NODE_IP}:2380"
	ETCD_LISTEN_CLIENT_URLS="http://${NODE_IP}:2379,http://localhost:2379"
	ETCD_ADVERTISE_CLIENT_URLS="http://${NODE_IP}:2379"
	" | sudo tee -a /etc/default/etcd

   ```

4. **Start the etcd Service**:

   ```bash
   sudo systemctl enable --now etcd
   ```


#### Configure Node3
1. **On Node1**, run the following command to add Node3 to the cluster:

   ```bash
   sudo etcdctl member add node3 http://10.0.0.3:2380
   ```

   The output will resemble the following:

   ```
   Added member named node3 with ID 10042578c504d052 to cluster

   ETCD_NAME="node3"
   ETCD_INITIAL_CLUSTER="node1=http://10.0.0.1:2380,node2=http://10.0.0.2:2380,node3=http://10.0.0.3:2380"
   ETCD_INITIAL_CLUSTER_STATE="existing"
   ```
   
2. **Back up the Configuration File** and **Export Environment Variables**:

   ```bash
   sudo mv /etc/default/etcd /etc/default/etcd.orig
   export NODE_NAME=$(hostname -f)
   export NODE_IP=$(hostname -i | awk '{print $1}')
   export ETCD_TOKEN='demo-cluster-token'
   export ETCD_DATA_DIR='/var/lib/etcd/postgresql'
   ```

3. **Modify the Configuration File**:

   ```bash
	echo "
	ETCD_NAME=${NODE_NAME}
	ETCD_INITIAL_CLUSTER="node1=http://10.0.0.1:2380,node2=http://10.0.0.2:2380,node3=http://${NODE_IP}:2380"
	ETCD_INITIAL_CLUSTER_STATE="existing"
	ETCD_INITIAL_CLUSTER_TOKEN="${ETCD_TOKEN}"
	ETCD_INITIAL_ADVERTISE_PEER_URLS="http://${NODE_IP}:2380"
	ETCD_DATA_DIR="${ETCD_DATA_DIR}"
	ETCD_LISTEN_PEER_URLS="http://${NODE_IP}:2380"
	ETCD_LISTEN_CLIENT_URLS="http://${NODE_IP}:2379,http://localhost:2379"
	ETCD_ADVERTISE_CLIENT_URLS="http://${NODE_IP}:2379"
	" | sudo tee -a /etc/default/etcd

   ```

4. **Start the etcd Service**:

   ```bash
   sudo systemctl enable --now etcd
   ```


## Configure Patroni

Run the following commands on all nodes. You can do this in parallel:

1. Export and create environment variables to simplify the config file creation:


      ```bash
      export NODE_NAME=`hostname -f`
      export NODE_IP=`hostname -i | awk '{print $1}'`
      sudo mkdir -p /var/lib/postgresql/15/main
      export DATA_DIR="/var/lib/postgresql/15/main"
      export PG_BIN_DIR="/usr/lib/postgresql/15/bin"
      ```

	>**NOTE**: Please check the path to the data and bin folders on your operating system and change it for the variables accordingly. For this tutorial we put data directory to `main`.

    Create variables for Patroni information:

      ```bash
      export NAMESPACE="percona_lab"
      export SCOPE="cluster_1"
      ```

2. Create the `/etc/patroni/patroni.yml` configuration file. Add the following configuration for `node1`:

    ```bash
    echo "
	namespace: ${NAMESPACE}
	scope: ${SCOPE}
	name: ${NODE_NAME}
	
	restapi:
	  listen: 0.0.0.0:8008
	  connect_address: ${NODE_IP}:8008
	
	etcd:
	  host: ${NODE_IP}:2379
	
	bootstrap:
	  # This section will be written into Etcd:/<namespace>/<scope>/config after initializing new cluster
	  dcs:
	    ttl: 30
	    loop_wait: 10
	    retry_timeout: 10
	    maximum_lag_on_failover: 1048576
	    slots:
	      percona_cluster_1:
	        type: physical
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
	  # Some desired options for 'initdb'
	  initdb: # Note: It needs to be a list (some options need values, others are switches)
	    - encoding: UTF8
	    - data-checksums
	
	  pg_hba: # Add following lines to pg_hba.conf after running 'initdb'
	    - host replication replicator 127.0.0.1/32 trust
	    - host replication replicator 0.0.0.0/0 md5
	    - host all all 0.0.0.0/0 md5
	    - host all all ::0/0 md5
	
	  # Some additional users which need to be created after initializing new cluster
	  users:
	    admin:
	      password: DemoPass123
	      options:
	        - createrole
	        - createdb
	    percona:
	      password: DemoPass123
	      options:
	        - createrole
	        - createdb 
	
	postgresql:
	  cluster_name: cluster_1
	  listen: 0.0.0.0:5432
	  connect_address: ${NODE_IP}:5432
	  data_dir: ${DATA_DIR}
	  bin_dir: ${PG_BIN_DIR}
	  pgpass: /tmp/pgpass
	  authentication:
	    replication:
	      username: replicator
      password: DemoReplPass
    superuser:
      username: postgres
      password: DemoPass123
	  parameters:
	    unix_socket_directories: "/var/run/postgresql/"
	  create_replica_methods:
	    - basebackup
	  basebackup:
	    checkpoint: 'fast'
	  recovery_conf: {}        
	
	tags:
	  nofailover: false
	  noloadbalance: false
	  clonefrom: false
	  nosync: false

    " | sudo tee -a /etc/patroni/patroni.yml
    ```

	Let’s take a moment to understand the contents of the `patroni.yml` file. 

	The first section provides the details of the node and its connection ports. After that, we have the `etcd` service and its port details.

	Following these, there is a `bootstrap` section that contains the PostgreSQL configurations and the steps to run once the database is initialized. The `pg_hba.conf` entries specify all the other nodes that can connect to this node and their authentication mechanism.
	Now let's validate it. If you get no message in reply means your yml file is OK.
	```bash
	sudo patroni --validate-config /etc/patroni/patroni.yml
	```

4. Check that the systemd unit file `patroni.service` is created in `/etc/systemd/system` or `/usr/lib/systemd/system`. You can also check it like this.
	```bash
	sudo find /etc /usr/lib/systemd -name 'patroni.service'
	```

	If it exists open the file and verify yml location `/etc/patroni/patroni.yml`, fix it if needed, if the location is correct skip this step. 

	If it's **not** created, create it manually and specify the following contents within:

    ```ini title="/etc/systemd/system/patroni.service"
	echo "
	[Unit]
	Description=Runners to orchestrate a high-availability PostgreSQL
	After=syslog.target network.target

	[Service]
	Type=simple

	User=postgres
	Group=postgres

	# Start the patroni process
	ExecStart=/bin/patroni /etc/patroni/patroni.yml

	# Send HUP to reload from patroni.yml
	ExecReload=/bin/kill -s HUP \$MAINPID

	# only kill the patroni process, not its children, so it will gracefully stop postgres
	KillMode=process

	# Give a reasonable amount of time for the server to start up/shut down
	TimeoutSec=30

	# Do not restart the service if it crashes, we want to manually inspect database on failure
	Restart=no

	[Install]
	WantedBy=multi-user.target
	" | sudo tee /etc/systemd/system/patroni.service

    ```

5. Make systemd aware of the new service:

    ```bash
    sudo systemctl daemon-reload
    ```

6. Now it's time to start Patroni. You need the following commands on all nodes but not in parallel. Start with the `node1` first, wait for the service to come to live, and then proceed with the other nodes one-by-one, always waiting for them to sync with the primary node:

    ```bash
    sudo systemctl enable --now patroni
   sudo systemctl restart patroni
    ```
   
	When Patroni starts, it initializes PostgreSQL (because the service is not currently running and the data directory is empty) following the directives in the bootstrap section of the configuration file. 

7. Check the service to see if there are errors:

    ```bash
    sudo journalctl -fu patroni
    ```

    A common error is Patroni complaining about the lack of proper entries in the pg_hba.conf file. If you see such errors, you must manually add or fix the entries in that file and then restart the service.

    Changing the patroni.yml file and restarting the service will not have any effect here because the bootstrap section specifies the configuration to apply when PostgreSQL is first started in the node. It will not repeat the process even if the Patroni configuration file is modified and the service is restarted.

8. Check the cluster:
 
    ```bash
    patronictl -c /etc/patroni/patroni.yml list $SCOPE
    ```

    The output on `node1` resembles the following:

    ```{.text .no-copy}
    + Cluster: cluster_1 --+---------+---------+----+-----------+
    | Member | Host        | Role    | State   | TL | Lag in MB |
    +--------+-------------+---------+---------+----+-----------+
    | node-1 | 10.0.0.1  | Leader  | running |  1 |           |
    +--------+-------------+---------+---------+----+-----------+  
    ```

    On the remaining nodes:
    
    ```{.text .no-copy}
    + Cluster: cluster_1 --+---------+---------+----+-----------+
    | Member | Host        | Role    | State   | TL | Lag in MB |
    +--------+-------------+---------+---------+----+-----------+
    | node-1 | 10.0.0.1  | Leader  | running |  1 |           |
    | node-2 | 10.0.0.2  | Replica | running |  1 |         0 |
    +--------+-------------+---------+---------+----+-----------+  
    ```

If Patroni has started properly, you should be able to locally connect to a PostgreSQL node using the following command:

```bash
sudo psql -U postgres
```

The command output is the following:

```
psql (15.4)
Type "help" for help.

postgres=#
```

## Configure HAProxy

HAproxy is the load balancer and the single point of entry to your PostgreSQL cluster for client applications. A client application accesses the HAPpoxy URL and sends its read/write requests there. Behind-the-scene, HAProxy routes write requests to the primary node and read requests - to the secondaries in a round-robin fashion so that no secondary instance is unnecessarily loaded. To make this happen, provide different ports in the HAProxy configuration file. In this deployment, writes are routed to port 5000 and reads  - to port 5001

This way, a client application doesn’t know what node in the underlying cluster is the current primary. HAProxy sends connections to a healthy node (as long as there is at least one healthy node available) and ensures that client application requests are never rejected. 

1. Install HAProxy on the `HAProxy-demo` node:

    ```bash
    sudo apt -y install percona-haproxy
    ```

2. The HAProxy configuration file path is: `/etc/haproxy/haproxy.cfg`. Specify the following configuration in this file.

    ```
    global
        maxconn 100

    defaults
        log global
        mode tcp
        retries 2
        timeout client 30m
        timeout connect 4s
        timeout server 30m
        timeout check 5s

    listen stats
        mode http
        bind *:7000
        stats enable
        stats uri /

    listen primary
        bind *:5000
        option httpchk /primary 
        http-check expect status 200
        default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
        server node1 node1:5432 maxconn 100 check port 8008
        server node2 node2:5432 maxconn 100 check port 8008
        server node3 node3:5432 maxconn 100 check port 8008

    listen standbys
        balance roundrobin
        bind *:5001
        option httpchk /replica 
        http-check expect status 200
        default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
        server node1 node1:5432 maxconn 100 check port 8008
        server node2 node2:5432 maxconn 100 check port 8008
        server node3 node3:5432 maxconn 100 check port 8008
    ```


    HAProxy will use the REST APIs hosted by Patroni to check the health status of each PostgreSQL node and route the requests appropriately. 

3. Restart HAProxy:
    
    ```bash
    sudo systemctl restart haproxy
    ```

4. Check the HAProxy logs to see if there are any errors:
   
    ```bash
    sudo journalctl -u haproxy.service -n 100 -f
    ```

## Next steps

[Configure pgBackRest](pgbackrest.md){.md-button}
