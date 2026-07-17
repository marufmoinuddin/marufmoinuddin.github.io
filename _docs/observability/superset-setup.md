---
layout: doc
title: "Apache Superset Setup with PostgreSQL 15"
category: observability
order: 70
last_updated: 2026-07-17
tags: ['superset', 'docker', 'postgresql', 'observability', 'analytics']
---
To set up **Apache Superset** using Docker along with a **PostgreSQL 15** container, follow the steps outlined below. This guide assumes you have Docker installed on your machine.

### Prerequisites

1. Docker installed on your machine. If you don’t have it installed, you can find installation instructions [here](https://docs.docker.com/get-docker/).
2. Basic understanding of Docker commands.

### Step-by-Step Guide

---

#### 1. **Pull the Docker Images**

First, pull the official Docker images for Superset and PostgreSQL.

```bash
# Pull Superset image
docker pull apache/superset:latest

# Pull PostgreSQL image (version 15)
docker pull postgres:15
```

---

#### 2. **Create a Docker Network (Optional but Recommended)**

Creating a custom network ensures that the Superset and PostgreSQL containers can communicate securely and reliably.

```bash
docker network create superset-network
```

---

#### 3. **Run PostgreSQL 15 Docker Container**

Run the PostgreSQL container on the same network. Adjust the database credentials (`POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB`) as needed.

```bash
docker run -d \
  --name superset-postgres \
  --network superset-network \
  -e POSTGRES_USER=superset \
  -e POSTGRES_PASSWORD=supersetpassword \
  -e POSTGRES_DB=superset \
  -p 5432:5432 \
  postgres:15
```

This command will:
- Create a PostgreSQL container with the name `superset-postgres`.
- Set up environment variables for the username, password, and database name.
- Expose PostgreSQL on port `5432`.

---

#### 4. **Run Superset Docker Container**

Now, run the Superset container and link it to the PostgreSQL container using the custom Docker network. Replace the values for the `SUPERSET_SECRET_KEY` and database credentials with your own.

```bash
docker run -d \
  --name superset \
  --network superset-network \
  -p 8088:8088 \
  -e "DATABASE_URL=postgresql+psycopg2://superset:supersetpassword@superset-postgres:5432/superset" \
  -e SUPERSET_SECRET_KEY=your-secret-key \
  -e LOAD_EXAMPLES=no \
  apache/superset:latest
```

Explanation:
- `--name superset`: Names the Superset container as `superset`.
- `--network superset-network`: Connects the Superset container to the previously created Docker network.
- `-p 8088:8088`: Exposes the Superset web UI on port 8088.
- `-e DATABASE_URL=postgresql+psycopg2://superset:supersetpassword@superset-postgres:5432/superset`: Connects Superset to the PostgreSQL database.
- `-e SUPERSET_SECRET_KEY=your-secret-key`: Sets a secret key for Superset, which is required for session management and CSRF protection.
- `-e LOAD_EXAMPLES=no`: Disables loading example data.

---

#### 5. **Initialize the Superset Database**

After running the containers, we need to initialize Superset’s database schema. You can do this by running the following commands inside the Superset container.

First, execute a shell in the Superset container:

```bash
docker exec -it superset bash
```

Then, inside the container, run the following commands to initialize the database:

```bash
# Initialize the database (creates tables, etc.)
superset db upgrade

# Create an admin user
export FLASK_APP=superset
superset fab create-admin \
  --username admin \
  --firstname Admin \
  --lastname User \
  --email admin@superset.com \
  --password adminpassword

# Initialize Superset
superset init
```

- `superset db upgrade`: Applies any database migrations (important to run after pulling the Superset image).
- `superset fab create-admin`: Creates an administrative user for logging into the Superset UI.
- `superset init`: Initializes the Superset instance, making it ready to use.

---

#### 6. **Access Superset Web UI**

Now that the containers are running and Superset has been initialized, you can access the Superset web UI by navigating to:

```
http://localhost:8088
```

Login using the admin credentials created during the `superset fab create-admin` step:
- **Username**: `admin`
- **Password**: `adminpassword`

---

#### 7. **(Optional) Troubleshooting and Logs**

If you run into any issues, you can check the logs of the Superset container by running:

```bash
docker logs -f superset
```

This will display logs in real time, and you can watch for errors or information to help troubleshoot any issues.

---

### Optional: Docker Compose Setup

For convenience, you might want to use Docker Compose to automate the process of spinning up both containers. Here’s a basic example of a `docker-compose.yml` file:

```yaml
version: "3.7"
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: superset
      POSTGRES_PASSWORD: supersetpassword
      POSTGRES_DB: superset
    networks:
      - superset-network
    ports:
      - "5432:5432"

  superset:
    image: apache/superset:latest
    environment:
      - DATABASE_URL=postgresql+psycopg2://superset:supersetpassword@postgres:5432/superset
      - SUPERSET_SECRET_KEY=your-secret-key
      - LOAD_EXAMPLES=no
    ports:
      - "8088:8088"
    depends_on:
      - postgres
    networks:
      - superset-network

networks:
  superset-network:
    driver: bridge
```

To use it, save the YAML file as `docker-compose.yml` and run:

```bash
docker-compose up -d
```

This will set up both the PostgreSQL and Superset containers, automatically configuring the network and container dependencies.

---

### Conclusion

You’ve now set up Apache Superset with PostgreSQL 15 using Docker! This setup allows you to explore data visualization and dashboarding features, and you can further customize Superset with your own datasets and dashboards. If you need to add more functionality or scale your deployment, you can easily modify these steps and integrate additional services.
