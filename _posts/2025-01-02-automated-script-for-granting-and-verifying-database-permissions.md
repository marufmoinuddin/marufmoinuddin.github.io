---
layout: post
title: Automated Script for Granting and Verifying Database Permissions
date: 2025-01-02
category: PostgreSQL
tags: [postgresql]
excerpt: "This documentation will explain how to use two automation scripts for managing PostgreSQL database permissions: one for granting permissions to a user (role) and one for verifying those permissions."
read_time: 6
source_doc: 07_Grant_Verify_Permissions.md
draft_import: true
---
# Documentation: Automated Script for Granting and Verifying Database Permissions

## Introduction

This documentation will explain how to use two automation scripts for managing PostgreSQL database permissions: one for **granting** permissions to a user (role) and one for **verifying** those permissions.

The goal of these scripts is to:
1. **Grant Permissions** to a user (`serviceops`) to access certain schemas and tables in multiple databases.
2. **Verify Permissions** to make sure that the user (`serviceops`) actually has the correct permissions on schemas and tables.

### What Are Permissions?

In a database, permissions control who can access and modify the data. In PostgreSQL, permissions are granted to users (roles) for certain actions like reading data (`SELECT`), modifying data (`INSERT`, `UPDATE`, `DELETE`), or accessing schemas and tables (`USAGE`).

In this case:
- The user `serviceops` needs to be able to read data from certain tables (`SELECT` permission) and access schemas (`USAGE` permission).

### Key Concepts

- **Schema**: A schema is like a folder in a database that contains tables, views, and other objects.
- **Table**: A table is like a spreadsheet where data is stored.
- **Granting Permissions**: Giving someone permission to do something, like reading data from a table or accessing a schema.
- **Verifying Permissions**: Checking whether the permissions you gave are actually in place.

---

## Script 1: Granting Permissions

### Purpose

The **Granting Permissions** script automatically grants the necessary permissions to the `serviceops` user for accessing all schemas and tables in a set of databases.

### How It Works

1. **List All Databases**: First, the script will list all databases in the PostgreSQL system except for system databases like `template0`, `template1`, and `postgres`. These system databases are reserved for PostgreSQL itself and should not be altered.
  
2. **Grant Permissions for Schemas**: 
   - The script will look at all the schemas in each database (schemas are like folders containing tables).
   - It will check if the schema is a system schema (like `pg_catalog` or `information_schema`). If not, it grants `USAGE` permission on the schema to the `serviceops` user. This permission allows `serviceops` to access objects inside the schema.

3. **Grant Permissions for Tables**: 
   - The script will check all the tables in each schema (tables are like spreadsheets).
   - It will grant `SELECT` permission to the `serviceops` user for each table that is not part of a system schema. This permission allows `serviceops` to read data from the table.

### The Code

```bash
#!/bin/bash

# Loop through all databases
for db in $(psql -t -c "SELECT datname FROM pg_database WHERE datname NOT IN ('template0', 'template1', 'postgres');"); do
    echo "Granting permissions for database: $db"
    
    # Grant USAGE on schemas
    psql -d "$db" -c "
    DO \$\$
    DECLARE 
        r RECORD;
    BEGIN
        FOR r IN (SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema')) 
        LOOP
            EXECUTE 'GRANT USAGE ON SCHEMA ' || quote_ident(r.schema_name) || ' TO serviceops';
        END LOOP;
    END;
    \$\$;"
    
    # Grant SELECT on tables
    psql -d "$db" -c "
    DO \$\$
    DECLARE 
        r RECORD;
    BEGIN
        FOR r IN (SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema'))
        LOOP
            EXECUTE 'GRANT SELECT ON ' || quote_ident(r.table_schema) || '.' || quote_ident(r.table_name) || ' TO serviceops';
        END LOOP;
    END;
    \$\$;"
    
    echo "Permissions granted for database: $db"
    echo "--------------------------------------------------"
done
```

### Step-by-Step Breakdown

1. **psql command**: 
   - This command is used to interact with PostgreSQL. It's like asking the database to do something. We use it to execute SQL queries from the script.

2. **FOR loop**: 
   - The `FOR r IN ...` loop goes through each schema and table in the database and applies the permission to it.

3. **Granting USAGE on Schemas**:
   - This means allowing the `serviceops` user to use the schema (but not modify the schema's contents).

4. **Granting SELECT on Tables**:
   - This means allowing the `serviceops` user to read data from tables (i.e., SELECT data from the tables).

---

## Script 2: Verifying Permissions

### Purpose

The **Verifying Permissions** script checks whether the `serviceops` user has the appropriate permissions on schemas and tables. It will confirm if the `serviceops` user can access the necessary schemas and tables for reading data.

### How It Works

1. **Check USAGE on Schemas**:
   - The script checks if the `serviceops` user has `USAGE` permission on each schema in the database. If the permission is granted, it prints a success message.

2. **Check SELECT on Tables**:
   - The script checks if the `serviceops` user has `SELECT` permission on each table. If the permission is granted, it prints a success message.

3. **Clean Output**:
   - If there are no permissions granted, the script does **not** print anything for that particular schema or table, keeping the output clean and readable.

### The Code

```bash
#!/bin/bash

# Loop over all databases
for db in $(psql -t -c "SELECT datname FROM pg_database WHERE datname NOT IN ('template0', 'template1', 'postgres');"); do
    echo "Verifying grants for database: $db"
    
    # Check for USAGE on schemas
    psql -d "$db" -t -c "
    SELECT schema_name 
    FROM information_schema.schemata 
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema') 
    AND has_schema_privilege('serviceops', schema_name, 'USAGE');
    " | while read schema; do
        if [ -n "$schema" ]; then
            echo "    [OK] serviceops has USAGE on schema: $schema"
        fi
    done
    
    # Check for SELECT on tables
    psql -d "$db" -t -c "
    SELECT table_schema || '.' || table_name AS full_table
    FROM information_schema.tables 
    WHERE table_type = 'BASE TABLE' 
    AND table_schema NOT IN ('pg_catalog', 'information_schema') 
    AND has_table_privilege('serviceops', table_schema || '.' || table_name, 'SELECT');
    " | while read table; do
        if [ -n "$table" ]; then
            echo "    [OK] serviceops has SELECT on table: $table"
        fi
    done
    
    echo "Verification completed for database: $db"
    echo "--------------------------------------------------"
done
```

### Step-by-Step Breakdown

1. **psql command**:
   - Just like in the granting script, `psql` is used to interact with the PostgreSQL database.

2. **Checking Permissions**:
   - The script checks each schema and table for the required permissions (`USAGE` for schemas and `SELECT` for tables).
   - If the user has the required permissions, it prints a success message with the name of the schema or table.

3. **Clean Output**:
   - The script only prints results for schemas and tables that have the required permissions. Empty results are ignored.

---

## Running the Scripts

To run both scripts, follow these steps:

1. Save the script files on your server, for example as `grant_permissions.sh` and `verify_permissions.sh`.
   
2. Make the scripts executable by running:

   ```bash
   chmod +x grant_permissions.sh verify_permissions.sh
   ```

3. Run the scripts like this:

   ```bash
   ./grant_permissions.sh  # This will grant the permissions
   ./verify_permissions.sh  # This will verify the permissions
   ```

---

## Why Use These Scripts?

1. **Automates a Repetitive Task**: 
   - If you manage a lot of databases, manually granting permissions can take time. These scripts do it for you automatically.

2. **Ensures Consistency**:
   - The scripts ensure that the same permissions are applied to the same user across all databases, avoiding human errors.

3. **Verifies Permissions**:
   - After granting permissions, it’s important to confirm that everything was set up correctly. The verification script helps with that.

---

## Conclusion

With these two automation scripts, you can easily **grant** and **verify** database permissions for the `serviceops` user across multiple databases. The process is automated, making it faster and less error-prone, so you don't need to worry about manually assigning and checking permissions for every table and schema.

Let me know if you have any questions or need further explanations!
