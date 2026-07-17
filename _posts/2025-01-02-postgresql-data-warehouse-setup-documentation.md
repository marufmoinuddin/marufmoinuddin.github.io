---
layout: post
title: PostgreSQL Data Warehouse Setup Documentation
date: 2025-01-02
category: PostgreSQL
tags: [postgresql]
excerpt: 1. Introduction 2. System Preparation 3. PostgreSQL Installation 4. Database Configuration 5. Network Configuration and Firewall Setup
read_time: 6
source_doc: 03_PostgreSQL_Warehouse.md
draft_import: true
---
# PostgreSQL Data Warehouse Setup Documentation

## Table of Contents
1. [Introduction](#introduction)
2. [System Preparation](#system-preparation)
3. [PostgreSQL Installation](#postgresql-installation)
4. [Database Configuration](#database-configuration)
5. [Network Configuration and Firewall Setup](#network-configuration-and-firewall-setup)
6. [Disk Configuration](#disk-configuration)
7. [PostgreSQL Data Storage Configuration](#postgresql-data-storage-configuration)
8. [Log Configuration](#log-configuration)
9. [Final Checks and Restart](#final-checks-and-restart)

---

## 1. Introduction

This guide provides a detailed walk-through for setting up a PostgreSQL-based data warehouse. The focus is on configuring PostgreSQL for large datasets and optimizing storage. Ensuring that the system is well-prepared and the PostgreSQL instance is optimized for performance will result in faster query processing and higher efficiency in handling large data sets.

---

## 2. System Preparation

This step involves preparing the system for PostgreSQL installation and configuration by ensuring the hostname is set up for easy identification and ensuring that all system packages are up-to-date. Additionally, required packages like `curl` and `wget` are installed, which are essential for downloading and installing PostgreSQL and other utilities.

### 2.1 Hostname Configuration

```bash
sudo hostnamectl set-hostname cls-dwh
```
Setting a clear hostname (`cls-dwh`) helps identify the server on the network. This is useful in larger environments where multiple servers are running, ensuring each server can be identified easily.

### 2.2 System Update and Package Installation

```bash
sudo apt update
sudo apt -y install curl wget
```
Updating the system ensures you're using the latest security patches. `curl` and `wget` are used to download necessary packages. These utilities help fetch files from the internet, including the necessary PostgreSQL release and related tools.

---

## 3. PostgreSQL Installation

The PostgreSQL installation step involves setting up Percona PostgreSQL, an optimized version designed for high performance, particularly for data warehouse environments. By installing this version, you ensure the system is optimized for large-scale data processing.

### 3.1 Installing Percona PostgreSQL

```bash
wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
sudo apt -y install gnupg2 lsb-release ./percona-release_latest.generic_all.deb
sudo percona-release setup ppg15
sudo apt -y install percona-postgresql-15
```
Percona PostgreSQL is an optimized version suitable for data warehouses. Here, we install version 15. This setup ensures that the system is configured to use the correct version of PostgreSQL for handling large datasets.

---

## 4. Database Configuration

This step outlines how to configure PostgreSQL after installation. It includes connecting to the PostgreSQL instance and setting up users and databases to structure the environment for managing data effectively. Proper configuration ensures the database system is secure and functional.

### 4.1 Connecting to PostgreSQL

```bash
psql -U etl -d warehouse -p 5432
```
This command connects to the `warehouse` database using the `etl` user and the default PostgreSQL port `5432`. It allows you to start working with the database immediately.

Example:
- To connect as a different user:
  ```bash
  psql -U postgres -d warehouse -p 5432
  ```

### 4.2 User and Database Configuration

```bash
sudo -u postgres psql -U postgres
```
Switch to the `postgres` user to perform administrative tasks such as creating databases and users. This step also includes commands to grant access and configure users properly.

Example:
- Creating a new user:
  ```bash
  CREATE USER new_user WITH PASSWORD 'password';
  ```
- Granting privileges:
  ```bash
  GRANT ALL PRIVILEGES ON DATABASE warehouse TO new_user;
  ```

---

## 5. Network Configuration and Firewall Setup

Network configuration ensures that PostgreSQL can be accessed from other machines if necessary. Proper firewall configuration ensures that only authorized connections can access PostgreSQL, securing the database from unauthorized access.

### 5.1 Verifying PostgreSQL Port Accessibility

```bash
telnet <IP> 5432
```
Check if the PostgreSQL port is accessible over the network. This step is important to ensure that the database can accept incoming connections from client applications or other servers.

### 5.2 Checking Firewall Status

```bash
sudo ufw status
```
Ensure PostgreSQL's port (`5432`) is open in the firewall. If necessary, allow traffic:
```bash
sudo ufw allow 5432
```
This step is crucial to allow proper communication with the database from other servers or clients on the network.

---

## 6. Disk Configuration

Disk configuration prepares your storage system for handling large volumes of data efficiently. This involves partitioning disks, creating logical volumes, and mounting them to the correct directories where PostgreSQL data will be stored. Optimizing disk space ensures fast read/write operations for PostgreSQL.

### 6.1 Partitioning and Formatting Disks

```bash
sudo fdisk -l
sudo mkfs.ext4 -L pgdata /dev/vdb1
```
Prepare a disk by partitioning and formatting it as `ext4`. This disk will be used for PostgreSQL data storage. Ensuring the disk is formatted correctly is essential for long-term performance and compatibility.

Example:
- If you have multiple disks, choose the correct one (e.g., `/dev/vdb1`).

### 6.2 Logical Volume Management (LVM)

```bash
sudo pvcreate /dev/vdb1
sudo vgcreate vg_pgdata /dev/vdb1
sudo lvcreate -l 100%FREE -n lv_pgdata vg_pgdata
sudo mkfs.ext4 /dev/vg_pgdata/lv_pgdata
```
LVM allows flexible disk management. Here, we create a physical volume (`pvcreate`), volume group (`vg_pgdata`), and logical volume (`lv_pgdata`). This approach allows dynamic resizing of storage, which is beneficial for scaling as data grows.

Example:
- If you need to expand storage later, you can increase the logical volume size using `lvextend`:
  ```bash
  sudo lvextend -l +100%FREE /dev/vg_pgdata/lv_pgdata
  ```

### 6.3 Mounting Disks

```bash
sudo mount /dev/vg_pgdata/lv_pgdata /postgres/pgdata
```
Mount the formatted logical volume to a directory (`/postgres/pgdata`) where PostgreSQL will store its data. This step ensures that the PostgreSQL data will be stored on the new disk partition with optimized storage.

Example:
- To ensure this mount persists after reboot, add it to `/etc/fstab`:
  ```bash
  /dev/vg_pgdata/lv_pgdata /postgres/pgdata ext4 defaults 0 0
  ```

---

## 7. PostgreSQL Data Storage Configuration

This step focuses on ensuring that PostgreSQL uses the newly configured storage location for its data. It involves modifying PostgreSQL’s configuration files and moving existing data to the new storage to optimize performance and accommodate large datasets.

### 7.1 Configuring PostgreSQL to Use New Storage

```bash
sudo nano /etc/postgresql/15/main/postgresql.conf
```
Edit PostgreSQL's configuration to use the new data storage location by updating the `data_directory` setting. This ensures PostgreSQL knows where to find and store its data.

Example:
- Set the `data_directory` to:
  ```bash
  data_directory = '/postgres/pgdata'
  ```

### 7.2 Moving PostgreSQL Data Directory

```bash
sudo rsync -av --remove-source-files /var/lib/postgresql/15/main/ /postgres/pgdata/
sudo chown -R postgres:postgres /postgres/pgdata
```
Use `rsync` to copy PostgreSQL data files to the new storage location, and ensure the `postgres` user has proper ownership of the files. This ensures that the database continues to function seamlessly after the data migration.

Example:
- To check if the data has been moved correctly:
  ```bash
  ls /postgres/pgdata
  ```

---

## 8. Log Configuration

Log configuration ensures that PostgreSQL’s logs are stored in a designated directory, keeping the main storage optimized and allowing for easy monitoring of the system’s performance.

### 8.1 Configuring PostgreSQL Logs

```bash
sudo nano /etc/postgresql/15/main/postgresql.conf
```
In PostgreSQL's configuration file, configure the log settings. You can enable logging by setting the following:
```bash
logging_collector = on
log_directory = '/postgres/pglog'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'
```

### 8.2 Moving PostgreSQL Logs to New Location

```bash
sudo mv /var/log/postgresql/* /postgres/pglog/
```
Move PostgreSQL's log files to the new log storage location to keep the main storage optimized. This step ensures that logs are stored separately, freeing up space for data storage.

Example:
- To

 monitor logs in real-time, use:
  ```bash
  tail -f /postgres/pglog/postgresql-*.log
  ```

---

## 9. Final Checks and Restart

This final step ensures that all changes are applied and that PostgreSQL is functioning correctly after all configurations. Restarting PostgreSQL applies the changes, and checking the status ensures there are no issues after the modifications.

### 9.1 Restarting PostgreSQL

```bash
sudo systemctl restart postgresql
```
Restart PostgreSQL to apply all the changes, including the new storage and logging configurations. This ensures the system is using the updated settings.

### 9.2 Monitoring PostgreSQL Logs

```bash
tail -f /postgres/pglog/postgresql-*.log
```
Monitor the logs to ensure that PostgreSQL is working correctly after the restart. This step helps confirm that no errors were introduced during the configuration changes.

### 9.3 System Status

```bash
sudo systemctl status postgresql
```
Check the status of PostgreSQL to confirm it is running properly. If the status indicates any issues, troubleshooting can be done using the logs or system status.

---

## Conclusion

Following this guide, you've successfully configured PostgreSQL for a data warehouse setup, ensuring it is optimized for handling large datasets. You’ve set up a new storage location, moved the data and logs, and configured PostgreSQL for high performance. Now your system is ready to handle significant workloads efficiently.
