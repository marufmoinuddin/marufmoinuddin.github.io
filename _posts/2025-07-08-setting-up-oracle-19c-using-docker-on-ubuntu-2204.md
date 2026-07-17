---
layout: post
title: Setting Up Oracle 19c Using Docker on Ubuntu 22.04
date: 2025-07-08
category: Linux
tags: [debian, docker, linux, oracle, ubuntu]
excerpt: "This documentation provides a detailed step-by-step guide to help you set up Oracle 19c using Docker on an Ubuntu 22.04 system.Whether you are a beginner or an experienced user, this document ensures you can set up and…"
read_time: 11
source_doc: 29_Oracle19c_Docker.md
draft_import: true
---
# Documentation: Setting Up Oracle 19c Using Docker on Ubuntu 22.04 

This documentation provides a detailed step-by-step guide to help you set up Oracle 19c using Docker on an Ubuntu 22.04 system.Whether you are a beginner or an experienced user, this document ensures you can set up and manage the Oracle 19c database in a Docker container without difficulty.

---

## Table of Contents

1. [Setting Up Oracle 19c Using Docker](#setting-up-oracle-19c-using-docker)
   - [Step 1: Install Docker](#step-1-install-docker)
   - [Step 2: Pull the Oracle 19c Docker Image](#step-2-pull-the-oracle-19c-docker-image)
   - [Step 3: Run the Oracle 19c Container](#step-3-run-the-oracle-19c-container)
2. [Access the Oracle Database with SQL*Plus](#access-the-oracle-database-with-sqlplus)
   - [Remote Connection (from outside the container)](#remote-connection-from-outside-the-container)
   - [Local Connection (from inside the container)](#local-connection-from-inside-the-container)
3. [Setting Oracle Environment Variables](#setting-oracle-environment-variables)
   - [Check Oracle Instance Status](#check-oracle-instance-status)
   - [Starting the Oracle Instance](#starting-the-oracle-instance)
4. [Create a New Database User and Grant Permissions](#create-a-new-database-user-and-grant-permissions)
   - [Step 1: Set Oracle Script Parameter](#step-1-set-oracle-script-parameter)
   - [Step 2: Create a New User](#step-2-create-a-new-user)
   - [Step 3: Grant Privileges to the User](#step-3-grant-privileges-to-the-user)
   - [Step 4: Set Storage Quota for the User](#step-4-set-storage-quota-for-the-user)
5. [Access the Oracle Database with SQL*Plus (Using Container's IP Address)](#access-the-oracle-database-with-sqlplus-using-containers-ip-address)
   - [Step 1: Get the Container’s IP Address](#step-1-get-the-containers-ip-address)
   - [Step 2: Remote Connection Using the Container's IP Address](#step-2-remote-connection-using-the-containers-ip-address)
   - [Bonus: Installing Oracle SQL Developer on Debian/Ubuntu](#bonus-installing-oracle-sql-developer-on-debianubuntu)
6. [Connect to Oracle Database Using Oracle SQL Developer (Using Container's IP Address)](#connect-to-oracle-database-using-oracle-sql-developer-using-containers-ip-address)
   - [Step 1: Create a New Database Connection](#step-1-create-a-new-database-connection)
   - [Step 2: Test the Connection](#step-2-test-the-connection)
7. [Additional Note: Local Connection Inside the Container](#additional-note-local-connection-inside-the-container)
8. [Conclusion](#conclusion)

---

## 1. Setting Up Oracle 19c Using Docker

Oracle 19c is a powerful database that can be easily deployed using Docker on Ubuntu 22.04. Docker offers a simple and efficient way to run Oracle databases in isolated environments, ensuring faster deployments and minimal configuration. The following steps will guide you through the process of installing Docker, pulling the Oracle 19c image, and running the Oracle container.

### Step 1: Install Docker

Docker is an essential tool for running containerized applications, and it is required to deploy Oracle 19c in a containerized environment. To install Docker, follow these steps:

1. **Update the System Package Index:**
   Before installing Docker, ensure that your system’s package list is up-to-date by running the following command:

   ```bash
   sudo apt update
   ```

2. **Install Docker:**
   Next, install Docker on your system by running the following command. The `-y` flag will automatically approve any prompts during installation:

   ```bash
   sudo apt install docker.io -y
   ```

3. **Enable Docker Service:**
   After Docker is installed, enable the Docker service so that it automatically starts when the system boots:

   ```bash
   sudo systemctl enable docker
   ```

4. **Start Docker Service:**
   Start Docker manually using this command:

   ```bash
   sudo systemctl start docker
   ```

5. **Verify Docker Installation:**
   To confirm that Docker is installed and running correctly, use the following command to check the Docker version:

   ```bash
   docker --version
   ```

   This will output the version of Docker installed on your system, confirming that the installation was successful.

---

### Step 2: Pull the Oracle 19c Docker Image

To run Oracle 19c in Docker, you need to pull an Oracle 19c image from a Docker registry. Oracle offers both community-maintained and official images for Oracle 19c.

1. **Pull the Community-Maintained Oracle 19c Image:**
   For a simpler setup, you can use the community-maintained Oracle 19c image. Run the following command to download it:

   ```bash
   docker pull doctorkirk/oracle-19c
   ```

2. **Pull the Official Oracle 19c Image:**
   For production environments, Oracle recommends using the official Oracle image. You will need to log into Oracle’s container registry to access it:

   ```bash
   docker pull container-registry.oracle.com/database/enterprise:19.3.0.0
   ```

   To pull the official Oracle image, you will need an Oracle account. If you don't have one, visit Oracle’s website to create an account.

---

### Step 3: Run the Oracle 19c Container

After pulling the Oracle image, you can run it in a Docker container. The following command starts the Oracle 19c container and exposes the default Oracle database ports (1521) and the Enterprise Manager port (5500):

```bash
docker run --name oracle_db -p 1521:1521 -p 5500:5500 doctorkirk/oracle-19c
```

This command starts the Oracle 19c container, which can be accessed remotely through port 1521 (for the database) and port 5500 (for Enterprise Manager). 

1. **Check the Status of the Running Container:**
   After starting the container, check that it is running correctly by listing all Docker containers:

   ```bash
   docker ps -a
   ```

   You should see the `oracle_db` container in the list with a status of "Up."

---

## 2. Access the Oracle Database with SQL*Plus

SQL*Plus is Oracle's command-line interface for interacting with Oracle databases. There are two main ways to access Oracle running inside a Docker container: remotely from your Ubuntu host machine or locally from within the container.

### Remote Connection (from outside the container)

To connect to Oracle 19c from outside the container (e.g., from your host machine), you can use SQL*Plus with the following command:

```bash
docker exec -it oracle-db sqlplus sys/<REDACTED_PASSWORD>@ORCLCDB as sysdba
```

Here:
- Replace `<REDACTED_PASSWORD>` with the <REDACTED_PASSWORD> you set for the `sys` user when creating the container.
- `ORCLCDB` is the default service name for the Oracle database in the Docker container.

### Local Connection (from inside the container)

If you are inside the Docker container and want to connect to Oracle locally (without needing an IP address), you can use OS-level authentication. First, enter the container:

```bash
docker exec -it oracle_db bash
```

Then, use the following command to connect as `sysdba`:

```bash
sqlplus / as sysdba
```

This method leverages Oracle's OS authentication mechanism, allowing you to connect to the database without needing a <REDACTED_PASSWORD>.

---

## 3. Setting Oracle Environment Variables

Oracle databases require certain environment variables to be set in order to function properly. These variables are typically set in the container when it is started, but if you encounter any issues, you can manually configure them.

### Setting Oracle Environment Variables

Set the following Oracle-specific environment variables to ensure smooth operation:

```bash
# Set the Oracle System Identifier (SID)
export ORACLE_SID=ORCLCDB

# Specify the Oracle home directory
export ORACLE_HOME=/opt/oracle/product/19c/dbhome_1

# Update the PATH variable to include Oracle binaries
export PATH=$ORACLE_HOME/bin:$PATH
```

These variables are crucial for Oracle to locate necessary binaries and configuration files. To make sure they are set every time you log into the container, add them to the `~/.bashrc` file.

---

### Check Oracle Instance Status

To verify that your Oracle database is running, use the following query in SQL*Plus:

```sql
SELECT status FROM v$instance;
```

This query will return the status of the Oracle instance. If everything is running smoothly, the status will be `STARTED`.

### Starting the Oracle Instance

If the Oracle instance is not running, you can start it by running:

```sql
STARTUP;
```

If the instance is already running, this command will display a message indicating that the instance is up.

To exit SQL*Plus, simply type:

```sql
EXIT;
```

---

## 4. Create a New Database User and Grant Permissions

For creating a new user and granting them permissions in Oracle, follow these detailed steps.

### Step 1: Set Oracle Script Parameter

If you're encountering errors like `ORA-65096: invalid common user or role name`, you need to enable the `_ORACLE_SCRIPT` parameter. This will allow you to create users in a non-CDB environment.

```sql
ALTER SESSION SET "_ORACLE_SCRIPT"=true;
```

### Step 2: Create a New User

To create a new user, use the following command:

```sql
CREATE USER admin IDENTIFIED BY <REDACTED_PASSWORD>;
```

Replace `admin` with the desired username and `<REDACTED_PASSWORD>` with the user's <REDACTED_PASSWORD>.

### Step 3: Grant Privileges to the User

Now, grant the necessary privileges to the newly created user. The following commands will grant the user the ability to create sessions, tables, triggers, sequences, and procedures:

```sql
GRANT CREATE SESSION TO admin;
GRANT CREATE TABLE TO admin;
GRANT CREATE TRIGGER TO admin;
GRANT CREATE SEQUENCE TO admin;
GRANT CREATE PROCEDURE TO admin;
```

### Step 4: Set Storage Quota for the User

To manage the space the user can consume in the Oracle database, set a storage quota. For instance, to allocate a 100MB quota to the `admin` user, use the following command:

```sql
ALTER USER admin QUOTA 100M ON USERS;
```

This will limit the amount of space the `admin` user can consume on the `USERS` tablespace.

---

## 5. Access the Oracle Database with SQL*Plus (Using Container's IP Address)

You can also access the Oracle database remotely by connecting to the container’s IP address. This method is useful when you need to connect from outside the container, for example, from another machine or a different Docker container.

### Step 1: Get the Container’s IP Address

To get the IP address of the Oracle container, run the following command:

```bash
docker inspect oracle_db | grep "IPAddress"
```

This will return an IP address similar to:

```json
"IPAddress": "<REDACTED_IP>"
```

### Step 2: Remote Connection Using the Container's IP Address

Once you have the container's IP address, use SQL*Plus to connect to the database using the following command:

```bash
sqlplus sys/<REDACTED_PASSWORD>@<REDACTED_IP>:1521/ORCLCDB as sysdba
```

Make sure to replace `<REDACTED_PASSWORD>` with the <REDACTED_PASSWORD> for the `sys` user and the IP address with the one retrieved in the previous step.

---


## Bonus: Installing Oracle SQL Developer on Debian/Ubuntu

Oracle SQL Developer is a free graphical tool for database development that simplifies database management tasks. This guide will help you install SQL Developer on Debian or Ubuntu Linux systems.

## Prerequisites

- Debian or Ubuntu Linux distribution
- Administrative (sudo) privileges
- Internet connection to download required packages

## Installation Steps

### 1. Install Required Dependencies

First, install the necessary dependencies:

```bash
sudo apt install alien openjdk-17-jdk
```

> **Note for Debian users**: This may require alien >= 8.95.5. If you're on Debian and encounter errors, you may need to update the alien package:
> 
> ```bash
> apt remove --purge alien
> wget --quiet -O /tmp/alien.deb http://ftp.de.debian.org/debian/pool/main/a/alien/alien_8.95.6_all.deb
> dpkg -i /tmp/alien.deb
> ```

### 2. Download Oracle SQL Developer

Download the Linux RPM package from the Oracle website:
- Visit [Oracle SQL Developer Downloads](https://www.oracle.com/tools/downloads/sqldev-downloads.html)
- Select the Linux RPM package (version 19.2 or later recommended)
- You'll need an Oracle account to download the software

>Note: You may need to install jdk according to the version of SQL Developer you are installing. Just make sure you have the correct version of jdk installed. For example, if you need jdk 17, you can install it using `sudo apt install openjdk-17-jdk`.

### 3. Install SQL Developer

Convert and install the RPM package using alien:

```bash
sudo alien -i sqldeveloper-*.rpm
```

> **Note**: This process may take several minutes to complete.

If the above method fails on Debian with a "dh_usrlocal" error, try this alternative approach:
```bash
# Extract the RPM without installing
rpm2cpio sqldeveloper-*.rpm | cpio -idmv
# Then run SQL Developer directly using
opt/sqldeveloper/sqldeveloper.sh
```

### 4. Create a Desktop Entry (Optional)

Create a desktop launcher for easier access:

```bash
echo "[Desktop Entry]
Type=Application
Name=Oracle SQL Developer
Exec=sqldeveloper
Icon=/opt/sqldeveloper/icon.png
Terminal=false" >> ~/.local/share/applications/sqldeveloper.desktop
```

### 5. Configure SQL Developer

#### Disable the Welcome Page (Optional)
- If the welcome page appears when you start SQL Developer, scroll to the bottom and uncheck "Show on startup"
- Alternatively, you can disable it through preferences

#### Disable Unnecessary Features (Optional)
1. Open SQL Developer
2. Go to Tools > Features
3. Uncheck features you don't need
4. For minimal non-DBA development, keep only:
   - Oracle SQL Developer - Schema Browser
   - Oracle SQL Developer - Snippet
   - Oracle SQL Developer - SSH Support
   - Oracle SQL Developer - XML Schema
5. Click "Apply Changes"

## Troubleshooting

If you encounter issues with installation:

- For Debian users experiencing "dh_usrlocal" errors, make sure you have alien version 8.95.5 or higher
- If conversion fails, try the direct extraction method mentioned above
- Verify that you have OpenJDK 11 installed correctly
- Check that the downloaded RPM file is not corrupted

## Starting SQL Developer

After installation, you can start SQL Developer by:
- Using the desktop launcher if you created one
- Running `sqldeveloper` in a terminal
- Or executing `/opt/sqldeveloper/sqldeveloper.sh` directly

---

## 6. Connect to Oracle Database Using Oracle SQL Developer (Using Container's IP Address)

Oracle SQL Developer is a powerful graphical tool for managing Oracle databases. To connect to Oracle 19c running in a Docker container, you can follow these steps.

### Step 1: Create a New Database Connection

1. Open Oracle SQL Developer.
2. Click on the **Connections** tab.
3. Click on the **+** icon to create a new connection.
4. Enter the connection details:
   - **Connection Name**: Any name you prefer.
   - **Username**: `sys`
   - **Password**: The <REDACTED_PASSWORD> for the `sys` user.
   - **Host**: The IP address of the Oracle container (e.g., `<REDACTED_IP>`).
   - **Port**: `1521` (default Oracle port).
   - **SID**: `ORCLCDB` (default SID).
5. Click **Test** to verify the connection, then click **Save**.

### Step 2: Test the Connection

Click **Connect** to initiate the connection. If all the details are correct, Oracle SQL Developer should successfully connect to your Oracle 19c instance running in Docker.

---

## 7. Additional Note: Local Connection Inside the Container

If you're working within the container itself and want to connect to the Oracle database locally, you can skip the network configuration. Use the following SQL*Plus command to connect to the database:

```bash
sqlplus / as sysdba
```

This method uses the local Oracle user to authenticate the connection, eliminating the need for a <REDACTED_PASSWORD>.

## Conclusion

By following this comprehensive guide, you should now have Oracle 19c up and running in a Docker container on your Ubuntu 22.04 system. You have learned how to install Docker, pull the Oracle 19c image, run the container, access the database using SQL*Plus, set environment variables, create new users, and connect to the database using Oracle SQL Developer. This setup provides a convenient way to work with Oracle databases in a containerized environment, offering flexibility and ease of management.
