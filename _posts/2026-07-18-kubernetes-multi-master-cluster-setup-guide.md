---
layout: post
title: A Secure Kubernetes Multi-Master Cluster Setup Guide
date: 2026-07-18
category: Kubernetes
tags: [cilium, haproxy, high-availability, keepalived, kubeadm, kubernetes, linux]
excerpt: "A comprehensive, secure, step-by-step manual guide for setting up a production-grade multi-master Kubernetes cluster. Covers architecture planning, OS prerequisites, cluster initialization with kubeadm, high availability with Keepalived and HAProxy, Cilium CNI, certificate management, and troubleshooting."
read_time: 25
---

# Kubernetes Multi-Master Cluster Setup Guide

> **Purpose:** This guide provides **manual, step-by-step instructions** for setting up a production-grade, multi-master Kubernetes cluster. It is designed for operators who want to understand **what** each step does and **why** it is necessary — without relying on Ansible or any automation tool.
>
> **OS Support:** Ubuntu/Debian (apt) and CentOS/RHEL (yum/dnf)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Node Planning & Prerequisites](#2-node-planning--prerequisites)
3. [Phase 0 — Cluster Cleanup (Nuke)](#3-phase-0--cluster-cleanup-nuke)
4. [Phase 1 — Hostname & Hosts File](#4-phase-1--hostname--hosts-file)
5. [Phase 2 — OS Prerequisites](#5-phase-2--os-prerequisites)
6. [Phase 3 — OS Hardening (CIS Compliance)](#6-phase-3--os-hardening-cis-compliance)
7. [Phase 4 — Initialize the First Master Node](#7-phase-4--initialize-the-first-master-node)
8. [Phase 5 — Join Additional Master Nodes](#8-phase-5--join-additional-master-nodes)
9. [Phase 6 — Join Worker Nodes](#9-phase-6--join-worker-nodes)
10. [Phase 7 — High Availability with Keepalived + HAProxy](#10-phase-7--high-availability-with-keepalived--haproxy)
11. [Phase 8 — Certificate Management](#11-phase-8--certificate-management)
12. [Phase 9 — Reset Worker Nodes (for Re-joining)](#12-phase-9--reset-worker-nodes-for-re-joining)
13. [Phase 10 — Reboot All Nodes](#13-phase-10--reboot-all-nodes)
14. [Appendix — Verification & Troubleshooting](#14-appendix--verification--troubleshooting)

---

## 1. Architecture Overview

### What we are building

A **multi-master Kubernetes cluster** with:

| Component | Description |
|-----------|-------------|
| **3 Master Nodes** (control plane) | Run `kube-apiserver`, `kube-controller-manager`, `kube-scheduler`, `etcd` |
| **N Worker Nodes** | Run your application workloads |
| **Virtual IP (VIP)** | A floating IP that HAProxy + Keepalived manage for high availability |
| **HAProxy** | Load-balances the Kubernetes API server across all master nodes |
| **Keepalived** | Provides the Virtual IP (VIP) that floats between master nodes |
| **Cilium CNI** | Container Network Interface for pod networking |

### Traffic flow

```
         ┌──────────────────────────────────────────┐
         │          Virtual IP (VIP)                 │
         │         e.g., 192.168.1.100               │
         └──────────────┬───────────────────────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
     ┌─────────┐  ┌─────────┐  ┌─────────┐
     │ HAProxy │  │ HAProxy │  │ HAProxy │
     │ Master1 │  │ Master2 │  │ Master3 │
     └────┬────┘  └────┬────┘  └────┬────┘
          │            │            │
          └────────────┼────────────┘
                       ▼
              ┌─────────────────┐
              │  kube-apiserver │  (on each master)
              │  :6443          │
              └─────────────────┘
```

### Network assumptions

| Setting | Example Value | Notes |
|---------|--------------|-------|
| Pod CIDR | `10.244.0.0/16` | Used by Cilium — must not overlap with host networks |
| Service CIDR | `10.96.0.0/12` | Default Kubernetes service range |
| Docker bridge | `172.30.0.1/24` | Isolated bridge for Docker |
| Cluster domain | `cluster.local` | Default Kubernetes internal DNS domain |

---

## 2. Node Planning & Prerequisites

### 2.1 Node requirements

Before you begin, decide on your node layout. Here is a minimum recommended setup:

| Node Role | Hostname | IP Address | RAM | CPU | Disk |
|-----------|----------|------------|-----|-----|------|
| Master 1 | `k8s-master-01` | `192.168.1.10` | 4 GB | 2 vCPU | 40 GB |
| Master 2 | `k8s-master-02` | `192.168.1.11` | 4 GB | 2 vCPU | 40 GB |
| Master 3 | `k8s-master-03` | `192.168.1.12` | 4 GB | 2 vCPU | 40 GB |
| Worker 1 | `k8s-worker-01` | `192.168.1.20` | 8 GB | 4 vCPU | 80 GB |
| Worker 2 | `k8s-worker-02` | `192.168.1.21` | 8 GB | 4 vCPU | 80 GB |
| Worker N | `k8s-worker-NN` | `192.168.1.2X` | 8 GB | 4 vCPU | 80 GB |
| **VIP**  | `k8s-api.example.com` | `192.168.1.100` | — | — | — |

> **Key decisions to make before starting:**
>
> 1. **Virtual IP (VIP):** Choose a free IP on your subnet that will float between masters. This is the address `kubectl` and workers will use to reach the API server.
> 2. **Hostnames:** Decide on a consistent naming scheme. All nodes must be able to resolve each other by hostname.
> 3. **Kubernetes version:** Pick a stable version (e.g., `1.29`, `1.30`, `1.31`). All nodes must run the same version.
> 4. **Network interface:** Know the primary network interface name (e.g., `eth0`, `enp1s0`, `ens192`). You will need this for Keepalived.

### 2.2 What to have ready

- **SSH access** to all nodes as a user with `sudo` privileges
- **All nodes can ping each other** (network connectivity)
- **Internet access** on all nodes (to download packages)
- A **DNS server** or entries in `/etc/hosts` for name resolution (we will set this up)

---

## 3. Phase 0 — Cluster Cleanup (Nuke)

> ⚠️ **Only run this if you are tearing down an existing cluster and starting fresh.**
> This will **completely remove** Kubernetes, Docker, containerd, and all their data.

### 3.1 Reset Kubernetes

Run this on **every node** (all masters and workers):

```bash
# Force reset Kubernetes — removes all pods, configs, and local data
sudo kubeadm reset -f

# Remove CNI configuration
sudo rm -rf /etc/cni/net.d

# Remove kubeconfig from root and your user
sudo rm -rf ~/.kube
rm -rf $HOME/.kube

# Remove Kubernetes package sources
sudo rm -f /etc/apt/sources.list.d/kubernetes.list    # Debian/Ubuntu
sudo rm -f /etc/yum.repos.d/kubernetes.repo            # CentOS/RHEL
```

### 3.2 Unhold and remove Kubernetes packages (Debian/Ubuntu)

```bash
# Unhold packages so they can be removed
sudo apt-mark unhold kubeadm kubelet kubectl

# Remove Kubernetes binaries
sudo apt remove --purge -y kubeadm kubelet kubectl
sudo apt autoremove -y
```

### 3.3 Remove Docker and containerd

```bash
# Remove Docker packages
sudo apt remove --purge -y docker-ce docker-ce-cli containerd.io       # Debian/Ubuntu
sudo yum remove -y docker-ce docker-ce-cli containerd.io               # CentOS/RHEL
sudo rm -rf /var/lib/docker /var/lib/containerd

# Remove Docker configuration
sudo rm -rf /etc/docker
sudo rm -rf /etc/containerd
```

### 3.4 Remove Kubernetes directories

```bash
sudo rm -rf /etc/kubernetes
sudo rm -rf /var/lib/kubelet
sudo rm -rf /var/lib/etcd
sudo rm -rf /etc/cni
```

### 3.5 Remove Kubernetes binaries from /usr/local/bin

```bash
sudo rm -f /usr/local/bin/kubeadm /usr/local/bin/kubelet /usr/local/bin/kubectl
```

### 3.6 Clean iptables

```bash
sudo iptables -F
sudo iptables -X
sudo iptables -t nat -F
sudo iptables -t mangle -F
```

### 3.7 Remove Kubernetes-related sysctl settings

```bash
# Remove the kubernetes sysctl config file
sudo rm -f /etc/sysctl.d/kubernetes.conf

# Apply the change
sudo sysctl --system
```

### 3.8 (Optional) Reboot

```bash
sudo reboot
```

> **Why clean up so thoroughly?** A fresh install over a previous cluster can fail with cryptic errors. Certificates, configuration, and CNI state can conflict. It is safer to start clean.

---

## 4. Phase 1 — Hostname & Hosts File

> **Why:** Kubernetes uses hostnames to identify nodes. Each node must have a unique, resolvable hostname. The `/etc/hosts` file ensures all nodes can find each other even without DNS.

### 4.1 Set hostname

Run on **each node** with its unique hostname:

```bash
# Replace with the actual hostname for this node
sudo hostnamectl set-hostname k8s-master-01   # On master 1
sudo hostnamectl set-hostname k8s-master-02   # On master 2
sudo hostnamectl set-hostname k8s-worker-01   # On worker 1, etc.
```

Verify it changed:

```bash
hostnamectl status
```

### 4.2 Configure /etc/hosts

Edit `/etc/hosts` on **every node** to include ALL nodes and the VIP. This way every node can resolve every other node without a DNS server.

```bash
sudo vi /etc/hosts
```

Add entries like this (adapt IPs and hostnames to your environment):

```
# Kubernetes cluster nodes
192.168.1.10  k8s-master-01
192.168.1.11  k8s-master-02
192.168.1.12  k8s-master-03
192.168.1.20  k8s-worker-01
192.168.1.21  k8s-worker-02

# Kubernetes VIP (used as API endpoint)
192.168.1.100 k8s-api.example.com

# Local hostname mapping
127.0.1.1     k8s-master-01   # On each node, this should be its own hostname
```

Also ensure `127.0.1.1` points to the node's own hostname (this is needed for correct name resolution):

```bash
# Ensure 127.0.1.1 points to the current node's hostname (NOT localhost)
echo "127.0.1.1 $(hostname)" | sudo tee -a /etc/hosts
```

> **Note:** If you have a working DNS server, you can skip the `/etc/hosts` entries and use DNS A records instead. But `/etc/hosts` is simpler and more reliable for small clusters.

---

## 5. Phase 2 — OS Prerequisites

> **Why:** Kubernetes and Docker require specific kernel parameters, modules, and settings to function correctly. This phase prepares the operating system on ALL nodes (masters and workers).

### 5.1 Update system packages (Debian/Ubuntu)

```bash
sudo apt update
sudo apt upgrade -y
sudo apt autoremove -y
```

### 5.2 Update system packages (CentOS/RHEL)

```bash
sudo yum update -y
```

### 5.3 Set SELinux to permissive (CentOS/RHEL only)

Kubernetes does not fully support SELinux enforcing mode. Set it to permissive:

```bash
# Temporarily set
sudo setenforce 0

# Permanently set in config
sudo sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
sudo sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/sysconfig/selinux

# Verify
getenforce   # Should show "Permissive"
```

### 5.4 Disable swap

> **Why:** The Kubernetes kubelet requires swap to be disabled. With swap enabled, the kubelet will fail to start. Swap can cause unpredictable performance for pods.

```bash
# Disable swap immediately
sudo swapoff -a

# Remove or comment out swap entries in /etc/fstab so it stays off after reboot
sudo sed -i '/ swap / s/^\(.*\)$/#\1/' /etc/fstab

# Verify
free -m        # Swap should show 0
```

### 5.5 Load required kernel modules

> **Why:** Kubernetes networking relies on `br_netfilter` for bridge-netfilter communication, and `overlay` for container filesystems. If you use Ceph/Rook storage, you also need `rbd` and `ceph` modules.

```bash
# Load modules immediately
sudo modprobe overlay
sudo modprobe br_netfilter
sudo modprobe bridge

# Create a config file so they load on boot
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
bridge
EOF

# If using Ceph/Rook, also load these:
sudo modprobe rbd
sudo modprobe ceph

cat <<EOF | sudo tee /etc/modules-load.d/rbd.conf
rbd
EOF

cat <<EOF | sudo tee /etc/modules-load.d/ceph.conf
ceph
EOF

# Verify modules are loaded
lsmod | grep -E "br_netfilter|overlay|bridge"
```

### 5.6 Configure sysctl for Kubernetes networking

> **Why:** These sysctl settings enable IP forwarding (required for pod-to-pod communication across nodes) and bridge-netfilter (required for iptables rules to apply to bridged traffic, which is how Kubernetes Services work).

```bash
cat <<EOF | sudo tee /etc/sysctl.d/kubernetes.conf
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF

# Also set in /etc/sysctl.conf for persistence
sudo sed -i '/^net.bridge.bridge-nf-call-iptables=/d' /etc/sysctl.conf
echo "net.bridge.bridge-nf-call-iptables=1" | sudo tee -a /etc/sysctl.conf
sudo sed -i '/^net.bridge.bridge-nf-call-ip6tables=/d' /etc/sysctl.conf
echo "net.bridge.bridge-nf-call-ip6tables=1" | sudo tee -a /etc/sysctl.conf

# Apply sysctl settings
sudo sysctl --system

# Verify
sysctl net.bridge.bridge-nf-call-iptables net.bridge.bridge-nf-call-ip6tables net.ipv4.ip_forward
```

### 5.7 Configure inotify limits (for large clusters)

> **Why:** Kubernetes and many applications (e.g., file watchers) use inotify. The default limits are too low for production clusters.

```bash
cat <<EOF | sudo tee /etc/sysctl.d/99-inotify-limits.conf
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 1024
fs.inotify.max_queued_events = 16384
EOF

sudo sysctl --system
```

### 5.8 Configure file descriptor limits

> **Why:** Kubernetes and Docker handle many concurrent connections. High file descriptor limits prevent "too many open files" errors.

```bash
# Increase system-wide file descriptors
sudo sed -i '/^fs.file-max=/d' /etc/sysctl.conf
echo "fs.file-max=999999" | sudo tee -a /etc/sysctl.conf
sudo sysctl --system

# Add security limits
cat <<EOF | sudo tee -a /etc/security/limits.conf
*    hard    nofile    999999
*    soft    nofile    256000
EOF

# Enable PAM limits (Debian/Ubuntu)
grep -q "pam_limits.so" /etc/pam.d/common-session || echo "session required pam_limits.so" | sudo tee -a /etc/pam.d/common-session
grep -q "pam_limits.so" /etc/pam.d/common-session-noninteractive || echo "session required pam_limits.so" | sudo tee -a /etc/pam.d/common-session-noninteractive

# Enable PAM limits (CentOS/RHEL)
grep -q "pam_limits.so" /etc/pam.d/system-auth || echo "session required pam_limits.so" | sudo tee -a /etc/pam.d/system-auth
```

### 5.9 Configure systemd service limits

> **Why:** Individual systemd services (docker, kubelet, containerd) need their own file descriptor limits.

```bash
# Global systemd limits
sudo sed -i 's/^#DefaultLimitNOFILE=/DefaultLimitNOFILE=999999/' /etc/systemd/system.conf
sudo sed -i 's/^#DefaultLimitNOFILE=/DefaultLimitNOFILE=999999/' /etc/systemd/user.conf

# Docker service override
sudo mkdir -p /etc/systemd/system/docker.service.d
cat <<EOF | sudo tee /etc/systemd/system/docker.service.d/override.conf
[Service]
LimitNOFILE=999999
EOF

# Kubelet service override
sudo mkdir -p /etc/systemd/system/kubelet.service.d
cat <<EOF | sudo tee /etc/systemd/system/kubelet.service.d/override.conf
[Service]
LimitNOFILE=999999
EOF

# Containerd service override
sudo mkdir -p /etc/systemd/system/containerd.service.d
cat <<EOF | sudo tee /etc/systemd/system/containerd.service.d/override.conf
[Service]
LimitNOFILE=999999
EOF

# Reload systemd
sudo systemctl daemon-reexec
```

### 5.10 Disable firewalls

> **Why:** Kubernetes manages its own networking rules via iptables/nftables. Having a separate firewall (firewalld, ufw) can conflict and cause connectivity issues.

```bash
# CentOS/RHEL — disable firewalld
sudo systemctl stop firewalld
sudo systemctl disable firewalld

# Debian/Ubuntu — disable ufw
sudo systemctl stop ufw
sudo systemctl disable ufw
sudo ufw disable

# Flush all iptables rules
sudo iptables -F
sudo iptables -t nat -F
sudo iptables -t mangle -F
sudo ip6tables -F
```

> ⚠️ **Security note:** In a production environment, you should configure firewall rules that align with Kubernetes requirements instead of fully disabling the firewall. The required ports are: TCP 6443 (API server), 2379-2380 (etcd), 10250 (kubelet), 30000-32767 (NodePort services). However, for initial setup, disabling the firewall avoids complexity.

### 5.11 Install Docker

#### Debian/Ubuntu

```bash
# Install prerequisites
sudo apt install -y curl ca-certificates

# Create keyrings directory
sudo install -m 0755 -d /etc/apt/keyrings

# Add Docker's GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Update and install
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

#### CentOS/RHEL

```bash
# Install dependencies
sudo yum install -y dnf-plugins-core

# Add Docker repository
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# Install Docker
sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 5.12 Configure Docker daemon

> **Why:** The Docker daemon configuration isolates the Docker bridge network, disables iptables management (Kubernetes will handle that), and sets log rotation to prevent disks from filling up.

```bash
sudo mkdir -p /etc/docker
cat <<EOF | sudo tee /etc/docker/daemon.json
{
  "bip": "172.30.0.1/24",
  "iptables": false,
  "ip-masq": false,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}
EOF
```

### 5.13 Start and enable Docker and containerd

```bash
sudo systemctl enable containerd
sudo systemctl start containerd
sudo systemctl enable docker
sudo systemctl start docker
```

### 5.14 Configure containerd to use systemd cgroup driver

> **Why:** Kubernetes recommends the `systemd` cgroup driver. By default, containerd uses `cgroupfs`. They must match.

```bash
# Generate default containerd config
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml

# Enable SystemdCgroup
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# Restart containerd
sudo systemctl restart containerd
```

### 5.15 (CentOS/RHEL only) Configure systemd resolver

```bash
sudo mkdir -p /run/systemd/resolve/
sudo ln -sf /run/NetworkManager/resolv.conf /run/systemd/resolve/resolv.conf
```

### 5.16 Install Kubernetes components (kubeadm, kubelet, kubectl)

> **Why:** These three tools form the foundation of a Kubernetes cluster:
> - `kubeadm` — bootstraps the cluster
> - `kubelet` — the node agent that runs on every node
> - `kubectl` — the command-line tool to interact with the cluster

#### Debian/Ubuntu

```bash
# Choose your Kubernetes version
K8S_VERSION="1.31"

# Create keyrings directory
sudo mkdir -p /etc/apt/keyrings

# Add Kubernetes GPG key
curl -fsSL https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
sudo chmod a+r /etc/apt/keyrings/kubernetes-apt-keyring.gpg

# Add Kubernetes repository
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/deb/ /" | sudo tee /etc/apt/sources.list.d/kubernetes.list

# Update and install
sudo apt update
sudo apt install -y kubelet kubeadm kubectl

# Hold packages to prevent accidental upgrades
sudo apt-mark hold kubelet kubeadm kubectl
```

#### CentOS/RHEL

```bash
K8S_VERSION="1.31"

# Add Kubernetes repository
cat <<EOF | sudo tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/rpm/repodata/repomd.xml.key
exclude=kubelet kubeadm kubectl cri-tools kubernetes-cni
EOF

# Install
sudo yum install -y kubelet kubeadm kubectl --disableexcludes=kubernetes
```

### 5.17 Enable kubelet service

> **Note:** The kubelet will restart repeatedly until the cluster is initialized. This is normal.

```bash
sudo systemctl enable kubelet
sudo systemctl start kubelet
```

### 5.18 Verify the installation

```bash
# Check Docker
docker --version

# Check Kubernetes components
kubelet --version
kubeadm version
kubectl version --client

# Check file descriptor limits
ulimit -n
grep "nofile" /etc/security/limits.conf

# Check modules
lsmod | grep -E "br_netfilter|overlay"
```

---

## 6. Phase 3 — OS Hardening (CIS Compliance)

> **Why:** This phase applies security hardening based on CIS (Center for Internet Security) benchmarks. It should be done on ALL master and worker nodes.

### 6.1 Install and configure AppArmor (CIS 1.3.1)

```bash
sudo apt install -y apparmor apparmor-utils

# Enable AppArmor in GRUB
sudo sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 apparmor=1 security=apparmor"/' /etc/default/grub
sudo update-grub
```

### 6.2 Restrict core dumps (CIS 1.5.3)

```bash
# Prevent core dumps via limits.conf
echo "* hard core 0" | sudo tee -a /etc/security/limits.conf

# Disable suid core dumps
echo "fs.suid_dumpable = 0" | sudo tee -a /etc/sysctl.d/99-cis.conf
sudo sysctl -w fs.suid_dumpable=0
```

### 6.3 Configure SSH access restrictions (CIS 5.1.4)

> **Why:** Restrict SSH access to specific groups so that only authorized users can SSH into the cluster nodes.

```bash
# Create admin groups
sudo groupadd --force sudo
sudo groupadd --force kubernetes-admin

# Restrict SSH to these groups
echo "AllowGroups sudo kubernetes-admin" | sudo tee -a /etc/ssh/sshd_config

# Configure strong SSH MAC algorithms
echo "MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,hmac-sha2-512,hmac-sha2-256" | sudo tee -a /etc/ssh/sshd_config

# Disable root login
sudo sed -i 's/^#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config

# Also check and update included configs
for f in /etc/ssh/sshd_config.d/*.conf; do
  [ -f "$f" ] && sudo sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' "$f"
done

# Restart SSH
sudo systemctl restart sshd
```

### 6.4 Configure login warning banner (CIS 1.6.3)

```bash
echo "Authorized users only. All activity may be monitored and reported." | sudo tee /etc/issue.net
```

### 6.5 Configure sudo logging (CIS 5.2.3)

```bash
echo "Defaults logfile=/var/log/sudo.log" | sudo EDITOR='tee -a' visudo
```

### 6.6 Configure password quality (CIS 5.3.3.2)

```bash
# Install pwquality
sudo apt install -y libpam-pwquality

# Configure password quality rules
cat <<EOF | sudo tee -a /etc/security/pwquality.conf
difok = 3
minlen = 14
dcredit = -1
ucredit = -1
lcredit = -1
ocredit = -1
maxrepeat = 3
maxsequence = 3
dictcheck = 1
EOF

# Ensure PAM enforces password quality
grep -q "pam_pwquality.so" /etc/pam.d/common-password || echo "password requisite pam_pwquality.so retry=3 enforce_for_root" | sudo tee -a /etc/pam.d/common-password
```

### 6.7 Remove nullok from PAM (CIS 5.3.3.4.1)

```bash
sudo sed -i 's/\(pam_unix\.so.*\)nullok\(.*\)/\1\2/' /etc/pam.d/common-password
```

### 6.8 Configure secure root PATH (CIS 5.4.2.5)

```bash
echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' | sudo tee /etc/environment
```

### 6.9 Configure shell session timeout (CIS 5.4.3.2)

```bash
cat <<EOF | sudo tee -a /etc/profile

# Set session timeout (15 minutes)
readonly TMOUT=900
export TMOUT
EOF
```

### 6.10 Install and configure AIDE (CIS 6.1.1)

> **Why:** AIDE (Advanced Intrusion Detection Environment) monitors file integrity. It detects unauthorized changes to critical system files.

```bash
sudo apt install -y aide aide-common

# Initialize AIDE database (this may take a while)
sudo aideinit

# Move the new database into place
sudo mv /var/lib/aide/aide.db.new /var/lib/aide/aide.db

# Configure daily AIDE checks
echo "0 5 * * * /usr/bin/aide.wrapper --check" | sudo crontab -
```

### 6.11 Configure remote logging (CIS 6.2.1.2)

> **Why:** Forward system logs to a central log server for audit and compliance.

```bash
sudo apt install -y systemd-journal-remote

# Configure journal upload
cat <<EOF | sudo tee /etc/systemd/journal-upload.conf
[Upload]
URL=http://<YOUR-LOG-SERVER-IP>:19532
ServerKeyFile=/etc/ssl/private/journal-upload.pem
ServerCertificateFile=/etc/ssl/certs/journal-upload.pem
TrustedCertificateFile=/etc/ssl/ca/trusted.pem
EOF

# Enable and start the upload service
sudo systemctl enable systemd-journal-upload.service
sudo systemctl start systemd-journal-upload.service
```

> **Note:** Replace `<YOUR-LOG-SERVER-IP>` with the actual IP of your central log server. The certificate files should be obtained from your CA.

### 6.12 Set permissions on kubelet service files (after cluster init)

Once the cluster is initialized (Phase 4+), come back and run:

```bash
# Restrict permissions on kubelet service files
sudo chmod 0600 /etc/systemd/system/kubelet.service
sudo chmod 0600 /etc/systemd/system/kubelet.service.d/10-kubeadm.conf

# Restrict kubelet config
sudo chmod 0600 /var/lib/kubelet/config.yaml

# Restrict proxy kubeconfig
sudo chmod 0600 /etc/kubernetes/proxy.conf

# Restrict CA certificate
sudo chmod 0600 /etc/kubernetes/pki/ca.crt

# Restrict kubelet TLS certs
sudo chmod 0600 /var/lib/kubelet/pki/kubelet.crt
sudo chmod 0600 /var/lib/kubelet/pki/kubelet.key
```

---

## 7. Phase 4 — Initialize the First Master Node

> **Why:** This is the core step — it creates the first control plane node. The `kubeadm init` command bootstraps the cluster: it generates certificates, starts the control plane components (`api-server`, `controller-manager`, `scheduler`), and configures `etcd`.

### 7.1 Prepare containerd (on all nodes)

```bash
# Remove any existing containerd config and regenerate
sudo rm -f /etc/containerd/config.toml
sudo containerd config default | sudo tee /etc/containerd/config.toml

# Enable SystemdCgroup
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# Restart containerd and kubelet
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

### 7.2 Create kubeadm configuration

On the **first master node** only, create a kubeadm config file:

```bash
# Create config directory
sudo mkdir -p /etc/kubernetes

# Create kubeadm config
cat <<EOF | sudo tee /etc/kubernetes/kubeadm-config.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
networking:
  podSubnet: 10.244.0.0/16
controlPlaneEndpoint: "k8s-api.example.com:6443"
EOF
```

> **What is `controlPlaneEndpoint`?** This is the address (hostname or IP + port) that all nodes will use to reach the API server. In a multi-master cluster, this should be the **VIP** or the first master's IP. Using a hostname here is better because it allows the VIP to change in the future.

### 7.3 Initialize the cluster

```bash
# Initialize certificates CA phase first
sudo kubeadm init phase certs ca

# Then initialize the cluster
sudo kubeadm init \
  --config=/etc/kubernetes/kubeadm-config.yaml \
  --upload-certs 2>&1 | tee cluster_initialized.log
```

> **What does `--upload-certs` do?** It uploads the control plane certificates to the cluster so that additional master nodes can automatically download them when they join.

### 7.4 Set up kubeconfig for your user

```bash
# Create kube directory
mkdir -p $HOME/.kube

# Copy admin config
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# Verify access
kubectl get nodes
```

> **Why:** By default, `kubectl` uses `~/.kube/config`. The admin.conf file contains the cluster CA certificate and admin credentials.

### 7.5 Install Cilium CNI

> **Why:** Cilium is the Container Network Interface (CNI) plugin that provides pod networking, network policies, and load balancing. We use Cilium version 1.16.4.

```bash
# Set architecture
ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
CILIUM_VERSION="v0.18.2"

# Download Cilium CLI
curl -L "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_VERSION}/cilium-linux-${ARCH}.tar.gz" -o /tmp/cilium.tar.gz
curl -L "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_VERSION}/cilium-linux-${ARCH}.tar.gz.sha256sum" -o /tmp/cilium.sha256sum

# Verify checksum
cd /tmp && sha256sum -c cilium.sha256sum

# Extract
sudo tar xzvf /tmp/cilium.tar.gz -C /usr/local/bin

# Clean up
rm -f /tmp/cilium.tar.gz /tmp/cilium.sha256sum

# Install Cilium in the cluster (may take 2-3 minutes)
cilium install --version 1.16.4

# Verify Cilium is running
cilium status --wait
```

### 7.6 Wait for cluster readiness

```bash
# Wait a moment for everything to settle
sleep 30

# Check cluster status
kubectl get nodes
kubectl get pods -A
```

### 7.7 Generate join commands for additional masters and workers

```bash
# Generate worker join command (valid for 2 hours)
echo "--- Worker Join Command ---"
sudo kubeadm token create --print-join-command

# Generate master join command (includes certificate key)
echo "--- Master Join Command ---"
CERT_KEY=$(sudo kubeadm init phase upload-certs --upload-certs | grep -A 1 'certificate key' | tail -n 1)
sudo kubeadm token create --print-join-command --certificate-key $CERT_KEY
echo ""
echo "Add --control-plane flag to the master join command above"
```

> **Save these commands!** You will use them in Phases 5 and 6. The token expires after 2 hours — if it expires, generate a new one with the same commands.

---

## 8. Phase 5 — Join Additional Master Nodes

> **Why:** For high availability, you need at least 3 master nodes. This ensures that if one master fails, the cluster can still operate (etcd requires a majority: 2 out of 3).

### 8.1 On each additional master node

On **each additional master** (master-02, master-03, ...), run the **master join command** you saved from Phase 7.7.

It will look something like:

```bash
sudo kubeadm join k8s-api.example.com:6443 \
  --token <your-token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane \
  --certificate-key <cert-key>
```

> **What does `--control-plane` do?** It tells kubeadm to install control plane components (api-server, controller-manager, scheduler, etcd) on this node, making it a master.

### 8.2 Set up kubeconfig on the new master

```bash
mkdir -p $HOME/.kube
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### 8.3 Verify from the first master

On the **first master**, verify the new master has joined:

```bash
kubectl get nodes
```

You should see all master nodes listed.

---

## 9. Phase 6 — Join Worker Nodes

### 9.1 Prepare worker node (skip if already done in Phase 2)

If the worker node has not gone through the OS prerequisites, run through Phase 2 first (Docker, containerd, kubelet, sysctl, etc.).

### 9.2 On each worker node

Run the **worker join command** you saved from Phase 7.7:

```bash
sudo kubeadm join k8s-api.example.com:6443 \
  --token <your-token> \
  --discovery-token-ca-cert-hash sha256:<hash>
```

> **Tip:** If you get errors, try adding `--ignore-preflight-errors=all` to bypass non-critical warnings.

### 9.3 Verify from a master

```bash
kubectl get nodes -o wide
```

You should see all nodes listed with status `Ready`.

---

## 10. Phase 7 — High Availability with Keepalived + HAProxy

> **Why:** Without HA, if the first master fails, the API server becomes unreachable. HAProxy load-balances traffic across all healthy masters, and Keepalived provides a floating Virtual IP (VIP) that automatically moves to a surviving master.

### 10.1 Architecture

```
                     ┌──────────────────┐
                     │   Virtual IP     │
                     │  192.168.1.100   │
                     └────────┬─────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │  Keepalived  │   │  Keepalived  │   │  Keepalived  │
   │  + HAProxy   │   │  + HAProxy   │   │  + HAProxy   │
   │  Master 1    │   │  Master 2    │   │  Master 3    │
   │  Priority:100│   │  Priority:90 │   │  Priority:80 │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ▼
                    ┌─────────────────┐
                    │ kube-apiserver  │
                    │ :6443           │
                    └─────────────────┘
```

Keepalived uses VRRP to elect a **MASTER** — the node with the highest priority owns the VIP. If it fails, the next highest priority takes over.

### 10.2 Install Keepalived and HAProxy on all masters

```bash
# Debian/Ubuntu
sudo apt install -y keepalived haproxy

# CentOS/RHEL
sudo yum install -y keepalived haproxy
```

### 10.3 Configure Keepalived

Create the configuration on **each master node**. The priority determines which node becomes the initial MASTER.

#### On Master 1 (highest priority — initial MASTER)

```bash
cat <<EOF | sudo tee /etc/keepalived/keepalived.conf
vrrp_instance VI_1 {
    state MASTER
    interface enp1s0                  # Replace with your network interface
    virtual_router_id 51
    priority 100                      # Highest priority
    advert_int 1
    virtual_ipaddress {
        192.168.1.100                 # Replace with your chosen VIP
    }
}
EOF
```

#### On Master 2

```bash
cat <<EOF | sudo tee /etc/keepalived/keepalived.conf
vrrp_instance VI_1 {
    state BACKUP
    interface enp1s0                  # Replace with your network interface
    virtual_router_id 51
    priority 90                       # Lower than master 1
    advert_int 1
    virtual_ipaddress {
        192.168.1.100                 # Replace with your chosen VIP
    }
}
EOF
```

#### On Master 3

```bash
cat <<EOF | sudo tee /etc/keepalived/keepalived.conf
vrrp_instance VI_1 {
    state BACKUP
    interface enp1s0                  # Replace with your network interface
    virtual_router_id 51
    priority 80                       # Lower than master 2
    advert_int 1
    virtual_ipaddress {
        192.168.1.100                 # Replace with your chosen VIP
    }
}
EOF
```

> **What do these settings mean?**
> - `interface`: The network interface that will hold the VIP. Find yours with `ip link show` (common names: `eth0`, `enp1s0`, `ens192`).
> - `virtual_router_id`: Must be the same across all nodes (51 is a safe default).
> - `priority`: Higher number = more likely to be master. Subtract 10 for each additional master.
> - `advert_int`: How often (in seconds) the master advertises its health.
> - `virtual_ipaddress`: The VIP that will float between masters.

### 10.4 Configure HAProxy on all masters

```bash
# Get the list of master IPs
# In this example: 192.168.1.10, 192.168.1.11, 192.168.1.12

cat <<EOF | sudo tee /etc/haproxy/haproxy.cfg
global
    log /dev/log local0
    maxconn 2000
    user haproxy
    group haproxy

defaults
    log     global
    mode    tcp
    timeout connect 10s
    timeout client  1m
    timeout server  1m

frontend kube-apiserver
    bind 192.168.1.100:6443           # VIP:port
    default_backend kube-apiserver-backend

backend kube-apiserver-backend
    mode tcp
    server master-1 192.168.1.10:6443 check
    server master-2 192.168.1.11:6443 check
    server master-3 192.168.1.12:6443 check
EOF
```

> **How HAProxy works:** It listens on the VIP:6443 and forwards traffic to the real API servers on each master. The `check` option means HAProxy will automatically remove a master from the pool if it fails.

### 10.5 Start and enable Keepalived and HAProxy

```bash
sudo systemctl enable keepalived
sudo systemctl start keepalived
sudo systemctl enable haproxy
sudo systemctl start haproxy

# Verify they are running
sudo systemctl status keepalived
sudo systemctl status haproxy
```

### 10.6 Verify the VIP is assigned

```bash
# Check which master currently owns the VIP
ip addr show | grep 192.168.1.100

# You should see the VIP on the MASTER node
```

### 10.7 Update the kubeadm ConfigMap with the VIP

On the **first master**, update the cluster configuration to use the VIP/hostname:

```bash
# Get the current ClusterConfiguration
kubectl get cm kubeadm-config -n kube-system -o jsonpath='{.data.ClusterConfiguration}' > /tmp/current-config.yaml

# Update controlPlaneEndpoint to use the VIP hostname
sed -i "s/controlPlaneEndpoint: .*/controlPlaneEndpoint: k8s-api.example.com:6443/" /tmp/current-config.yaml

# Patch the ConfigMap
kubectl patch configmap kubeadm-config -n kube-system --patch "{\"data\":{\"ClusterConfiguration\":\"$(cat /tmp/current-config.yaml | sed ':a;N;$!ba;s/\n/\\n/g')\"}}"

# Clean up
rm /tmp/current-config.yaml
```

### 10.8 Update kubeconfig files on ALL nodes

#### On master nodes

```bash
# Update all kubeconfig files to use the VIP hostname
sudo sed -i 's|server: https://.*:6443|server: https://k8s-api.example.com:6443|' /etc/kubernetes/admin.conf
sudo sed -i 's|server: https://.*:6443|server: https://k8s-api.example.com:6443|' /etc/kubernetes/controller-manager.conf
sudo sed -i 's|server: https://.*:6443|server: https://k8s-api.example.com:6443|' /etc/kubernetes/scheduler.conf
sudo sed -i 's|server: https://.*:6443|server: https://k8s-api.example.com:6443|' $HOME/.kube/config
```

#### On worker nodes

```bash
# Update kubelet configs to use the VIP hostname
sudo sed -i 's|server: https://.*:6443|server: https://k8s-api.example.com:6443|' /etc/kubernetes/kubelet.conf
sudo sed -i 's|server: https://.*:6443|server: https://k8s-api.example.com:6443|' /var/lib/kubelet/kubeconfig
```

### 10.9 Restart kubelet on ALL nodes

```bash
sudo systemctl restart kubelet
```

### 10.10 Regenerate API server certificates with SANs

On the **first master**, regenerate certificates to include the VIP and all master IPs as Subject Alternative Names (SANs):

```bash
# Backup existing certificates
sudo cp /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.crt.bak-$(date +%Y%m%d%H%M%S)
sudo cp /etc/kubernetes/pki/apiserver.key /etc/kubernetes/pki/apiserver.key.bak-$(date +%Y%m%d%H%M%S)

# Remove old certificates
sudo rm -f /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key

# Create certificate config with SANs
cat <<EOF | sudo tee /root/kubeadm-cert-config.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: stable
controlPlaneEndpoint: "k8s-api.example.com:6443"
apiServer:
  certSANs:
    - "192.168.1.100"            # VIP
    - "k8s-api.example.com"       # VIP hostname
    - "10.96.0.1"                 # Kubernetes service IP
    - "kubernetes"
    - "kubernetes.default"
    - "kubernetes.default.svc"
    - "kubernetes.default.svc.cluster.local"
    - "localhost"
    - "127.0.0.1"
    - "192.168.1.10"              # Master 1 IP
    - "192.168.1.11"              # Master 2 IP
    - "192.168.1.12"              # Master 3 IP
EOF

# Regenerate certificates
sudo kubeadm init phase certs apiserver --config /root/kubeadm-cert-config.yaml

# Verify the new certificate includes the VIP
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -text | grep -A1 "Subject Alternative Name"
```

> **Why do we need certSANs?** The API server certificate must list all valid names/IPs that clients use to connect. Without the VIP in the SANs, TLS verification will fail when connecting through the VIP.

### 10.11 Restart kubelet and verify from a master

On the **first master**:

```bash
# Restart kubelet
sudo systemctl restart kubelet

# Wait for API server to be ready
sleep 10

# Test connectivity via the VIP
kubectl get nodes --server=https://k8s-api.example.com:6443

# If that works, test VIP failover by temporarily stopping keepalived on the master
# sudo systemctl stop keepalived
# Then check that the VIP moves to another master
```

---

## 11. Phase 8 — Certificate Management

> **Why:** Kubernetes certificates expire (typically after 1 year). You may also need to add new IPs or hostnames to the certificate SANs as your cluster grows.

### 11.1 Check certificate expiry

```bash
# Check expiry of all certificates
sudo kubeadm certs check-expiration
```

### 11.2 Renew all certificates

```bash
# Renew all certificates
sudo kubeadm certs renew all

# Restart control plane components
sudo systemctl restart kubelet
```

### 11.3 Update certificates with new SANs (for HA)

If you need to add new IPs/hostnames to the API server certificate (e.g., after adding a new master), follow the steps in [Section 10.10](#1010-regenerate-api-server-certificates-with-sans).

### 11.4 Full certificate regeneration with kubeadm

If the certificates are problematic, you can fully regenerate them:

```bash
# On all masters:
# 1. Backup old certificates
sudo cp -r /etc/kubernetes/pki /etc/kubernetes/pki.bak-$(date +%Y%m%d%H%M%S)

# 2. Remove the apiserver cert and key
sudo rm -f /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key

# 3. Regenerate with your config
sudo kubeadm init phase certs apiserver --config /root/kubeadm-cert-config.yaml

# 4. Restart kubelet
sudo systemctl restart kubelet

# 5. On the first master only — update the admin kubeconfig
sudo kubeadm init phase kubeconfig all --control-plane-endpoint k8s-api.example.com:6443
```

---

## 12. Phase 9 — Reset Worker Nodes (for Re-joining)

> **Why:** If a worker node becomes corrupted, or you need to reinstall it, you must completely clean it before re-joining.

### 12.1 On the worker node

```bash
# Stop kubelet
sudo systemctl stop kubelet

# Kill any processes on port 10250 (kubelet port)
sudo lsof -t -i:10250 | xargs -r sudo kill -9

# Force reset
sudo kubeadm reset --force

# Remove CNI and Kubernetes configs
sudo rm -rf /etc/cni/net.d
sudo rm -f /etc/kubernetes/kubelet.conf
sudo rm -f /etc/kubernetes/pki/ca.crt
sudo rm -f /etc/kubernetes/bootstrap-kubelet.conf
sudo rm -rf /etc/kubernetes/pki
sudo rm -rf /var/lib/kubelet/pki
sudo rm -f /var/lib/kubelet/config.yaml

# Reset iptables
sudo iptables -F
sudo iptables -t nat -F
sudo iptables -t mangle -F
sudo iptables -X

# Restart services
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

### 12.2 On the first master — delete the old worker node

```bash
# Get the name of the worker node
kubectl get nodes

# Delete the worker node (replace with actual name)
kubectl delete node k8s-worker-01
```

### 12.3 Re-join the worker

Now generate a new join token and re-join following [Phase 6](#9-phase-6--join-worker-nodes).

---

## 13. Phase 10 — Reboot All Nodes

If you need to reboot all nodes after the setup (e.g., after kernel updates):

```bash
# Reboot all nodes (masters and workers)
sudo reboot
```

After the reboot, verify the cluster recovers:

```bash
# On any master:
kubectl get nodes
kubectl get pods -A
cilium status
```

Kubernetes is designed to automatically recover after reboots. All nodes should rejoin and pods should be rescheduled automatically.

---

## 14. Appendix — Verification & Troubleshooting

### 14.1 Useful verification commands

```bash
# Cluster status
kubectl cluster-info
kubectl get nodes -o wide
kubectl get pods -A
kubectl get svc -A

# Cilium status
cilium status
cilium connectivity test

# Certificate expiry
sudo kubeadm certs check-expiration

# HAProxy status
sudo systemctl status haproxy
sudo haproxy -f /etc/haproxy/haproxy.cfg -c   # Check config

# Keepalived status
sudo systemctl status keepalived
ip addr show | grep <VIP>    # Check which node has the VIP

# System checks
free -m                       # Memory
df -h                         # Disk
uptime                        # How long running
sudo sysctl net.ipv4.ip_forward  # Verify IP forwarding
```

### 14.2 Common issues and solutions

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| `kubeadm init` fails with "port 6443 already in use" | Previous cluster not cleaned | Run `sudo kubeadm reset -f` and retry |
| Node shows `NotReady` | CNI not installed or containerd issue | Check `kubectl get pods -n kube-system`, verify containerd is running |
| `kubectl` connection refused | API server down or wrong kubeconfig | Check kube-apiserver pod, verify `controlPlaneEndpoint` |
| TLS handshake error with VIP | VIP not in certificate SANs | Regenerate certificates with the VIP in certSANs |
| Keepalived VIP not appearing | Interface name wrong or VRRP blocked | Check `ip link show` for correct interface, check firewall |
| `kubeadm join` token expired | Token lifetime exceeded | Generate a new token with `kubeadm token create --print-join-command` |
| Pods stuck in `ContainerCreating` | CNI not ready or network issues | Check Cilium pods, verify `br_netfilter` module |
| kubelet constantly restarting | Not yet joined to cluster | This is normal until `kubeadm join` or `kubeadm init` is run |

### 14.3 Node port range

Kubernetes uses ports 30000–32767 for NodePort services. Ensure these are open if you need external access to services.

### 14.4 Required ports reference

| Port | Component | Description |
|------|-----------|-------------|
| 6443 | kube-apiserver | Kubernetes API (HTTPS) |
| 2379-2380 | etcd | etcd server/client |
| 10250 | kubelet | Kubelet API |
| 10259 | kube-scheduler | Scheduler health |
| 10257 | kube-controller-manager | Controller manager health |
| 30000-32767 | NodePorts | Service NodePort range |
| 8472 | Cilium | VXLAN overlay (if used) |
| 4244 | Cilium | Hubble relay |

---

> **Document Version:** 1.0
> **Last Updated:** 2026-07-18
>
> This guide replaces automation (Ansible) with detailed manual steps so operators understand what each command does and why it is needed. Adapt IP addresses, hostnames, interface names, and versions to match your environment.
