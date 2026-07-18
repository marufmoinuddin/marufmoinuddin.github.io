---
layout: post
title: "ETL Server Setup to transfer data from Production to a Example. Data Warehouse Guide: Apache Airflow & PipelineWise"
date: 2025-07-29
category: Data Engineering
tags: [airflow, data-engineering, docker, linux, pipelinewise, postgresql, ubuntu]
excerpt: "This guide provides clear, step-by-step instructions for setting up Apache Airflow and PipelineWise to manage and orchestrate ETL (Extract, Transform, Load) pipelines. It is designed to be beginner-friendly, ensuring…"
read_time: 6
source_doc: 30_ETL_Setup_Airflow_Pipelinewise.md
draft_import: true
---
# ETL Server Setup Guide: Apache Airflow & PipelineWise

This guide provides clear, step-by-step instructions for setting up **Apache Airflow** and **PipelineWise** to manage and orchestrate ETL (Extract, Transform, Load) pipelines. It is designed to be beginner-friendly, ensuring interns and new users can follow along easily. Apache Airflow is used to schedule and monitor workflows, while PipelineWise simplifies data extraction and loading.

## Prerequisites
Before starting, ensure you have:
- **Operating System**: Ubuntu 20.04 LTS (or compatible Linux distribution)
- **Python**: Version 3.6 or higher
- **Docker** and **Docker Compose**: Installed and configured
- **Basic Knowledge**: Familiarity with command-line operations and ETL concepts
- **User Permissions**: A non-root user with `sudo` privileges

Run the following to verify prerequisites:
```bash
# Check Ubuntu version
lsb_release -a

# Check Python version
python3 --version

# Check Docker and Docker Compose
docker --version
docker-compose --version
```

## Table of Contents
1. [Apache Airflow Setup](#apache-airflow-setup)
   - [Step 1: Set Up Airflow Home Directory](#step-1-set-up-airflow-home-directory)
   - [Step 2: Create a Python Virtual Environment](#step-2-create-a-python-virtual-environment)
   - [Step 3: Install Apache Airflow](#step-3-install-apache-airflow)
   - [Step 4: Install Additional Providers (Optional)](#step-4-install-additional-providers-optional)
   - [Step 5: Configure PostgreSQL Database](#step-5-configure-postgresql-database)
   - [Step 6: Create an Admin User](#step-6-create-an-admin-user)
   - [Step 7: Configure Permissions](#step-7-configure-permissions)
   - [Step 8: Set Up Airflow as a Systemd Service](#step-8-set-up-airflow-as-a-systemd-service)
   - [Step 9: Manage the Airflow Service](#step-9-manage-the-airflow-service)
   - [Step 10: Manage DAGs](#step-10-manage-dags)
   - [Step 11: Troubleshoot Airflow](#step-11-troubleshoot-airflow)
2. [PipelineWise Setup](#pipelinewise-setup)
   - [Step 1: Pull and Tag the Docker Image](#step-1-pull-and-tag-the-docker-image)
   - [Step 2: Create Configuration Directory](#step-2-create-configuration-directory)
   - [Step 3: Create a Helper Script (`plw`)](#step-3-create-a-helper-script-plw)
   - [Step 4: Import Configurations](#step-4-import-configurations)
   - [Step 5: Common PipelineWise Commands](#step-5-common-pipelinewise-commands)
   - [Step 6: Troubleshoot PipelineWise](#step-6-troubleshoot-pipelinewise)
3. [Next Steps](#next-steps)

---

## Apache Airflow Setup

This section guides you through setting up Apache Airflow in **standalone mode** using a PostgreSQL database.

### Step 1: Set Up Airflow Home Directory
Create a directory to store Airflow configurations, logs, and DAGs (Directed Acyclic Graphs).

```bash
mkdir -p ~/airflow
export AIRFLOW_HOME=~/airflow
```

To make `AIRFLOW_HOME` persistent, add it to your shell configuration:
```bash
echo 'export AIRFLOW_HOME=~/airflow' >> ~/.bashrc  # or ~/.zshrc for Zsh users
source ~/.bashrc
```

### Step 2: Create a Python Virtual Environment
Using a virtual environment prevents package conflicts.

```bash
# Update package lists and install dependencies
sudo apt-get update
sudo apt-get install -y python3-pip python3-venv

# Create and activate a virtual environment
python3 -m venv ~/venv
source ~/venv/bin/activate
```

**Note**: Run all subsequent Airflow commands within this virtual environment. To confirm activation, your terminal prompt should show `(venv)`.

### Step 3: Install Apache Airflow
Install Airflow with version-specific constraints to ensure compatibility.

```bash
# Set version variables
export AIRFLOW_VERSION=2.10.1
export PYTHON_VERSION=$(python3 --version | cut -d " " -f 2 | cut -d "." -f 1-2)

# Install dependencies and Airflow
CONSTRAINT_URL="https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_VERSION}.txt"
pip install "psycopg2-binary==2.9.6"
pip install "apache-airflow==${AIRFLOW_VERSION}" --constraint "${CONSTRAINT_URL}"

# Verify installation
airflow version
```

If the `airflow version` command outputs the version (e.g., 2.10.1), the installation is successful.

### Step 4: Install Additional Providers (Optional)
Install provider packages for integrations like Slack, AWS, or GCP if needed.

```bash
pip install apache-airflow-providers-slack --constraint "${CONSTRAINT_URL}"
```

Replace `slack` with other providers (e.g., `amazon`, `google`) as required.

### Step 5: Configure PostgreSQL Database
Airflow requires a PostgreSQL database for production use.

1. **Install PostgreSQL**:
   ```bash
   sudo apt-get update
   sudo apt-get install -y postgresql postgresql-contrib
   ```

2. **Create a database and user**:
   ```bash
   sudo -u postgres psql
   ```
   Inside the PostgreSQL prompt, run:
   ```sql
   CREATE USER airflow WITH PASSWORD 'your_secure_password';
   CREATE DATABASE airflowdb;
   GRANT ALL PRIVILEGES ON DATABASE airflowdb TO airflow;
   \q
   ```
   Replace `your_secure_password` with a strong password.

3. **Add Airflow configuration**:
   Edit `~/airflow/airflow.cfg` with a text editor (e.g., `nano`):
   ```bash
   nano ~/airflow/airflow.cfg
   ```
   And set:
   ```ini
   [core]
   sql_alchemy_conn = postgresql+psycopg2://airflow:your_secure_password@localhost:5432/airflowdb
   ```

4. **Initialize the database**:
   ```bash
   airflow db init
   ```

This creates the necessary metadata tables in `airflowdb`.

### Step 6: Create an Admin User
Create an admin user for the Airflow web interface.

```bash
airflow users create \
  --username admin \
  --password your_secure_password \
  --firstname Admin \
  --lastname User \
  --role Admin \
  --email admin@example.com
```

Use a strong password and update the email as needed.

### Step 7: Configure Permissions
Ensure the Airflow directory has correct ownership and permissions.

```bash
sudo chown -R <YOUR-USERNAME>:<YOUR-USERNAME> ~/airflow
sudo chmod -R 755 ~/airflow
```

### Step 8: Set Up Airflow as a Systemd Service
Run Airflow as a single `systemd` service in standalone mode, which includes both the scheduler and webserver.

1. **Create the service file**:
   ```bash
   sudo nano /etc/systemd/system/airflow.service
   ```
   Add the following, replacing `<YOUR-USERNAME>` with your actual username:
   ```ini
   [Unit]
   Description=Apache Airflow (Standalone)
   After=network.target

   [Service]
   User=<YOUR-USERNAME>
   Environment="PATH=/home/<YOUR-USERNAME>/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
   Environment="AIRFLOW_HOME=/home/<YOUR-USERNAME>/airflow"
   ExecStart=/home/<YOUR-USERNAME>/venv/bin/airflow standalone
   Restart=always
   Type=simple

   [Install]
   WantedBy=multi-user.target
   ```

2. **Enable and start the service**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable airflow
   sudo systemctl start airflow
   ```

3. **Verify the service**:
   ```bash
   sudo systemctl status airflow
   ```

The Airflow webserver will be accessible at `http://localhost:8080`.

### Step 9: Manage the Airflow Service
Use these commands to control the Airflow service:

```bash
# Start the service
sudo systemctl start airflow

# Stop the service
sudo systemctl stop airflow

# Restart the service
sudo systemctl restart airflow

# View real-time logs
journalctl -u airflow -f
```

### Step 10: Manage DAGs
DAGs define your workflows and are stored in `~/airflow/dags/`.

1. **Add a DAG**:
   ```bash
   cp your_dag.py ~/airflow/dags/
   ```
   Or extract multiple DAGs:
   ```bash
   tar -xzvf airflow_dags.tar.gz -C ~/airflow/dags/
   ```

2. Airflow automatically detects new DAGs. Adjust the scanning interval in `airflow.cfg` under `[scheduler]` if needed.

### Step 11: Troubleshoot Airflow
- **Reinstall Airflow** (if dependencies break):
  ```bash
  pip install "apache-airflow==${AIRFLOW_VERSION}" --constraint "${CONSTRAINT_URL}" --force-reinstall
  ```
- **Check logs**:
  ```bash
  journalctl -u airflow -f
  ```
- **Database issues**:
  - Verify `sql_alchemy_conn` in `~/airflow/airflow.cfg`.
  - Ensure PostgreSQL is running (`sudo systemctl status postgresql`).
  - Check the `airflow` user’s password and database access.
- **Webserver access**:
  - Confirm port `8080` is open and not blocked by a firewall.

---

## PipelineWise Setup

This section explains how to set up PipelineWise using Docker to extract and load data.

### Step 1: Pull and Tag the Docker Image
1. **Pull the PipelineWise image**:
   ```bash
   docker pull docker.io/transferwiseworkspace/pipelinewise:latest
   ```

2. **Tag the image**:
   ```bash
   docker tag transferwiseworkspace/pipelinewise:latest pipelinewise:latest
   ```

### Step 2: Create Configuration Directory
PipelineWise stores configurations in `~/.pipelinewise`.

```bash
mkdir -p ~/.pipelinewise
sudo chown -R <YOUR-USERNAME>:<YOUR-USERNAME> ~/.pipelinewise
```

### Step 3: Create a Helper Script (`plw`)
The `plw` script simplifies running PipelineWise commands via Docker.

1. **Create the script**:
   ```bash
   sudo nano /usr/bin/plw
   ```
   Add the following:
   ```bash
   #!/usr/bin/env bash
   # Helper script to run PipelineWise in Docker
   IMAGE=pipelinewise
   VERSION=latest

   # Mount current directory and PipelineWise config
   HOST_DIR=$(pwd)
   CONT_WORK_DIR=/app/wrk
   HOST_CONFIG_DIR=${HOME}/.pipelinewise
   CONT_CONFIG_DIR=/app/.pipelinewise

   # Process --dir argument for custom working directory
   ARGS=""
   while [[ $# -gt 0 ]]; do
       case $1 in
           --dir)
               HOST_DIR=$(cd "$(dirname "$2")"; pwd)/$(basename "$2")
               ARGS="$ARGS --dir $CONT_WORK_DIR"
               shift
               shift
               ;;
           *)
               ARGS="$ARGS $1"
               shift
               ;;
       esac
   done

   # Validate directories
   if [ ! -d "${HOST_DIR}" ]; then
       echo "Error: Directory ${HOST_DIR} does not exist"
       exit 1
   fi

   if [ ! -d "${HOST_CONFIG_DIR}" ]; then
       mkdir -p "${HOST_CONFIG_DIR}"
   fi

   # Run Docker container
   docker run \
       --rm \
       -v "${HOST_CONFIG_DIR}:${CONT_CONFIG_DIR}" \
       -v "${HOST_DIR}:${CONT_WORK_DIR}" \
       "${IMAGE}:${VERSION}" \
       ${ARGS}
   ```

2. **Make the script executable**:
   ```bash
   sudo chmod +x /usr/bin/plw
   ```

3. **Verify the script**:
   ```bash
   plw --help
   ```
   You should see PipelineWise’s help text.

### Step 4: Import Configurations
Import existing PipelineWise configurations if available.

```bash
plw import --dir /path/to/warehouse_configs/
```

This merges configurations into `~/.pipelinewise`.

### Step 5: Common PipelineWise Commands
- **List available taps and targets**:
  ```bash
  plw list
  plw list_taps
  plw status
  ```
- **Run a tap**:
  ```bash
  plw run_tap --tap <tap_name> --target <target_name> --extra_log --debug
  ```
  Use `--extra_log` for verbose output and `--debug` for detailed debugging.
- **Import configurations**:
  ```bash
  plw import --dir /home/<YOUR-USERNAME>/warehouse_configs/
  ```

### Step 6: Troubleshoot PipelineWise
- **Verify script**:
  ```bash
  which plw
  ```
- **Docker permissions**:
  Ensure your user can run Docker without `sudo`:
  ```bash
  sudo usermod -aG docker <YOUR-USERNAME>
  ```
  Log out and back in for changes to take effect.
- **Check logs**:
  Logs appear in the console. For persistent logs, check `~/.pipelinewise/<target>/<tap>/log/`.
- **Configuration errors**:
  Validate YAML/JSON files in `~/.pipelinewise` for syntax errors.

---

## Next Steps
You now have:
- **Apache Airflow** running in standalone mode with a PostgreSQL database (`airflowdb`), accessible at `http://localhost:8080`.
- **PipelineWise** set up with a Docker-based helper script (`plw`) for managing ETL tasks.

Use Airflow to schedule and monitor PipelineWise tasks, which extract data from sources and load it into targets like data warehouses. For advanced setups (e.g., distributed Airflow executors or high-availability configurations), refer to:
- [Apache Airflow Documentation](https://airflow.apache.org/docs/)
- [PipelineWise Documentation](https://transferwise.github.io/pipelinewise/)
