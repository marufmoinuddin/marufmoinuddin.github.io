---
layout: post
title: Logical Replication Tutorial
date: 2025-07-08
category: PostgreSQL
tags: [backup, high-availability, logical-replication, patroni, postgresql]
excerpt: "1. Introduction 2. Step 1: Export Schema from Old Master 3. Step 2: Copy Schema Backup to Local Machine 4. Step 3: Copy Schema Backup to New Master"
read_time: 8
source_doc: 13_Logical_Replication_Tutorial.md
draft_import: true
---
# Logical Replication Tutorial

## Table of Contents
1. [Introduction](#introduction)
2. [Step 1: Export Schema from Old Master](#step-1-export-schema-from-old-master)
3. [Step 2: Copy Schema Backup to Local Machine](#step-2-copy-schema-backup-to-local-machine)
4. [Step 3: Copy Schema Backup to New Master](#step-3-copy-schema-backup-to-new-master)
5. [Step 4: Restore Schema to New Master](#step-4-restore-schema-to-new-master)
6. [Step 5: Enable Logical Replication in New Master](#step-5-enable-logical-replication-in-new-master)
7. [Step 6: Create Publication on Old Master](#step-6-create-publication-on-old-master)
8. [Step 7: Create Subscription on New Master](#step-7-create-subscription-on-new-master)
9. [Step 8: Verify Replication](#step-8-verify-replication)
10. [Drawbacks and Troubleshooting](#drawbacks-and-troubleshooting)

## Introduction

Logical replication allows you to replicate data between PostgreSQL databases at the table level. This is useful for migrating data, synchronizing databases, and setting up high availability. It helps in scenarios where you need a live copy of your data, without the need for physical replication, which might be more complex or unsuitable for certain use cases.

## Step 1: Export Schema from Old Master

First, we need to export the schema from the old master PostgreSQL cluster.

### Command
```bash
kubectl exec -it -n db-ns -c database $(kubectl get pods -n db-ns --selector='postgres-operator.crunchydata.com/cluster=mydatabase,postgres-operator.crunchydata.com/role=master' -o jsonpath='{.items[0].metadata.name}') -- pg_dump -s -U postgres -d mydb -f /tmp/mydatabase_schema_bkp_old.sql
```

**Explanation:** This command runs `pg_dump` inside the old master pod to export the schema (`-s`) of the `mydb` database to a file `/tmp/mydatabase_schema_bkp_old.sql`.

## Step 2: Copy Schema Backup to Local Machine

Next, copy the schema backup file from the pod to your local machine.

### Commands

1. **Set the Old Master Pod Variable:**
   ```bash
   OLD_MASTER_POD=$(kubectl get pods -n db-ns --selector='postgres-operator.crunchydata.com/cluster=mydatabase,postgres-operator.crunchydata.com/role=master' -o jsonpath='{.items[0].metadata.name}')
   ```

2. **Copy the File from the Pod to Your Local Machine:**
   ```bash
   kubectl cp db-ns/$OLD_MASTER_POD:/tmp/mydatabase_schema_bkp_old.sql /tmp/mydatabase_schema_bkp_old.sql
   ```

**Explanation:** The `kubectl cp` command copies the backup file from the old master pod to your local machine, which is necessary for restoring the schema on the new master.

## Step 3: Copy Schema Backup to New Master and Prepare the New Master Cluster (Target)

Make sure that the new master has similar configuration of postgres or patroni settings as the old master for replication.

**Sample `postgresql.conf` settings:**

```conf
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
```

**Copy the schema backup file from your local machine to the new master PostgreSQL pod.**

### Commands

1. **Set the New Master Pod Variable:**
   ```bash
   NEW_MASTER_POD=$(kubectl get pods -n db-ns --selector='postgres-operator.crunchydata.com/cluster=mydatabase-new,postgres-operator.crunchydata.com/role=master' -o jsonpath='{.items[0].metadata.name}')
   ```

2. **Copy the File to the New Master Pod:**
   ```bash
   kubectl cp /tmp/mydatabase_schema_bkp_old.sql db-ns/$NEW_MASTER_POD:/tmp/mydatabase_schema_bkp_old.sql
   ```

**Explanation:** This command uploads the schema backup file to the new master pod where it can be restored.

## Step 4: Restore Schema to New Master

Restore the schema on the new master PostgreSQL cluster.

### Command
```bash
kubectl exec -it -n db-ns -c database $NEW_MASTER_POD -- psql -U postgres -d mydb -f /tmp/mydatabase_schema_bkp_old.sql
```

**Explanation:** This command restores the schema from the backup file to the new master database. If there are errors related to missing roles, you may need to manually create these roles.

**Create Missing Roles:**
```sql
CREATE ROLE missing_role_name;
```

## Step 5: Enable Logical Replication in Old Master

Modify the YAML configuration of the old master PostgreSQL cluster to enable logical replication.

### With YAML Configuration
Add the following section under `spec` in the old master's YAML configuration:

```yaml
users:
  - name: mydatabaseuser
    databases:
      - mydb
    options: "REPLICATION"
```

Log into the old master PostgreSQL cluster and create a publication.

### Commands
```bash
   bash -c 'kubectl exec -it -n db-ns -c database \
  $(kubectl get pods -n db-ns --selector='postgres-operator.crunchydata.com/cluster=mydatabase,postgres-operator.crunchydata.com/role=master' -o name) -- psql mydb'
```

Run this inside the PostgreSQL session:
```sql
CREATE PUBLICATION mydatabase_pub FOR ALL TABLES;
\q
```
**Explanation:** This command creates a publication on the old master, which will send changes to the new master.

### Without YAML Configuration
If you dont want to edit the yaml, do this:

Log into the old master PostgreSQL cluster and create a publication.

### Commands
```bash
   bash -c 'kubectl exec -it -n db-ns -c database \
  $(kubectl get pods -n db-ns --selector='postgres-operator.crunchydata.com/cluster=mydatabase,postgres-operator.crunchydata.com/role=master' -o name) -- psql mydb'
```

Run this inside the PostgreSQL session:
```sql
ALTER ROLE mydatabaseuser WITH REPLICATION;
CREATE PUBLICATION mydatabase_pub FOR ALL TABLES;

```

**Explanation:** This command promotes the user to replication user and creates a publication on the old master, which will send changes to the new master


## Step 6: Create Subscription on New Master

Get the connection information for the old master and create a subscription on the new master. Or if you have those already, you can directly insert them by Skipping below 1.

### Commands

1. **Get Connection Information:**
   ```bash
   kubectl -n db-ns get secrets mydatabase-pguser-mydatabaseuser -o jsonpath={.data.host} | base64 -d 
   echo
   kubectl -n db-ns get secrets mydatabase-pguser-mydatabaseuser -o jsonpath={.data.user} | base64 -d 
   echo
   kubectl -n db-ns get secrets mydatabase-pguser-mydatabaseuser -o jsonpath={.data.password} | base64 -d 
   echo
   ```

2. **Create Subscription:**
   ```bash
   bash -c 'kubectl exec -it -n db-ns -c database \
   $(kubectl get pods -n db-ns --selector='postgres-operator.crunchydata.com/cluster=mydatabase-new,postgres-operator.crunchydata.com/role=master' -o name) -- psql mydb'
   ```

   Inside the PostgreSQL session:
   ```sql
   CREATE SUBSCRIPTION mydatabase_sub CONNECTION 'host=<REDACTED_IP> port=<REDACTED_PORT> user=<REDACTED_USERNAME> dbname=mydb password=<REDACTED_PASSWORD>' PUBLICATION mydatabase_pub;
   ```

**Explanation:** This sets up a subscription on the new master to receive changes from the publication created on the old master.

>Note: Replace `<OLD_MASTER_HOST>` with the IP address, `<OLD_MASTER_EXPOSED_PORT>` with the exposed port, `<OLD_MASTER_USER>` with the db replication user (you must make the schema user as replication user) and `<OLD_MASTER_PASSWORD>` with the password you have. 
>Note: If you dont want to edit the yaml, enter to your pod  `ALTER ROLE mydatabaseuser WITH REPLICATION;`

## Step 7: Verify Replication

Ensure that data is being replicated from the old master to the new master.

### Insert Record on Old Master
```sql
INSERT INTO mydatabaseuser.ecommerce_payment_ecommercepaymentaddmoney (
    id, to_wallet, to_wallet_id, amount, currency, source, description, 
    initiated_by, trx_id, batch_id, order_id, session_id, create_order_url, 
    status, medium, initiated_at, completed_at, card_number, card_brand, 
    reason_description, confirm_response, service_charge_details, 
    sys_update_datetime, rrn_number
) VALUES (
    '5f6d52b6-0a22-44b8-8c4c-fbde9e2b38b8', '0987654321', 987654, 1500.00, 'EUR', 'promotion', 
    'summer sale', 'customer', 'trx_2027', 'batch_2027', 987654321, 
    'session_2027', 'https://example.com/sale', 'completed', 'mobile app', 
    NOW(), NOW(), '8765-4321-0987-6543', 'Visa', 'seasonal discount', 
    'confirmed', '{"details": "discount applied"}', NOW(), 'rrn_2027'
);
```

### Verify on New Master
```sql
SELECT * FROM mydatabaseuser.ecommerce_payment_ecommercepaymentaddmoney 
WHERE id = '5f6d52b6-0a22-44b8-8c4c-fbde9e2b38b8';
```

## Drawbacks and Troubleshooting

### Drawbacks
- **Sequential Numbering:** Logical replication uses a sequence number to track changes. If the sequence number isn't managed properly, it can lead to data inconsistencies or missing changes.
- **Replication Lag:** Logical replication may experience lag, especially with large volumes of data or high update rates.
- **Schema Changes:** Changes to the schema in the source database (e.g., adding/removing columns) need to be carefully managed as they can affect replication.

### Troubleshooting
- **Check Replication Status:**
  ```sql
  SELECT * FROM pg_stat_subscription;
  ```
  This view shows the status of subscriptions and can help identify issues.

- **Examine Logs:** Look at the PostgreSQL logs on both the source and destination servers for errors or warnings related to replication.

- **Verify Roles and Permissions:** Ensure that the replication user has the necessary permissions to access and replicate data.

- **Monitor Replication Lag:** Use tools like `pg_stat_replication` to monitor replication lag and ensure it is within acceptable limits.

### Troubleshooting: Replication Slot Error in PostgreSQL Subscription Management

#### Scenario

In a PostgreSQL environment, you encountered issues with managing a replication subscription between an old master and a new master. The specific problem involved a replication slot error when attempting to drop a subscription. Here's a detailed description of the scenario:

1. **Subscription and Replication Slot Details:**
   - **Old Master Logs:**
     ```
     2024-09-06 15:38:06,638 INFO: Lock owner: mydatabase-5c7875bf8d-zppgg; I am mydatabase-5c7875bf8d-zppgg
     2024-09-06 15:38:06,649 INFO: no action.  i am the leader with the lock
     2024-09-06 15:38:09.855 UTC [24782] ERROR:  replication slot "mydatabase_sub" does not exist
     2024-09-06 15:38:14.890 UTC [24800] ERROR:  replication slot "mydatabase_sub" does not exist
     ```

   - **New Master Logs:**
     ```
     postgres=# \c mydb 
     You are now connected to database "mydb" as user "postgres".
     mydb=# select * from pg_subscription;
       oid  | subdbid |  subname   | subowner | subenabled |                                         subconninfo                                          | subslotname | subsynccommit | subpublications 
     -------+---------+------------+----------+------------+----------------------------------------------------------------------------------------------+-------------+---------------+-----------------
       16801 |   16406 | mydatabase_sub |       10 | t          | host=<REDACTED_IP> port=<REDACTED_PORT> user=<REDACTED_USERNAME> dbname=mydb password=<REDACTED_PASSWORD> | mydatabase_sub  | off           | {mydatabase_pub}
     (1 row)
     
     mydb=# drop subscription mydatabase_sub;
     ERROR:  could not drop the replication slot "mydatabase_sub" on publisher
     DETAIL:  The error was: ERROR:  replication slot "mydatabase_sub" does not exist
     ```

2. **Troubleshooting Steps Taken:**
   - **Direct Query Attempts:**
     ```sql
     mydb=# DELETE FROM pg_subscription WHERE subname = 'mydatabase_sub';
     DELETE 1
     mydb=# SELECT * FROM pg_subscription;
      oid | subdbid | subname | subowner | subenabled | subconninfo | subslotname | subsynccommit | subpublications 
     -----+---------+---------+----------+------------+-------------+-------------+---------------+-----------------
     (0 rows)
     ```

#### Troubleshooting Steps and Resolutions

1. **Verify Replication Slot Existence:**
   - On the old master, check if the replication slot `mydatabase_sub` still exists. This can be done by querying the `pg_replication_slots` view:
     ```sql
     SELECT * FROM pg_replication_slots;
     ```

   - If the replication slot does not exist on the old master, it is likely that the slot was manually removed or the old master has not been correctly updated.

2. **Manually Remove Subscription Metadata:**
   - Since the `pg_subscription` table entry was successfully removed, verify that there are no remnants of the subscription in other related catalog tables such as `pg_publication` if you plan to clean up completely:
     ```sql
     SELECT * FROM pg_publication;
     DELETE FROM pg_publication WHERE pubname = 'mydatabase_pub';
     ```

3. **Check for Subscription and Slot Cleanup on New Master:**
   - On the new master, ensure that all subscription-related metadata is cleaned up. Confirm that no orphaned subscription entries or replication slots exist.

4. **Recreate Subscription if Needed:**
   - If you plan to recreate the subscription, ensure that the replication slots are properly set up and there are no conflicts. Create the subscription again with the correct configurations.

5. **Validate Configuration and Permissions:**
   - Ensure that the user roles and permissions are correctly set up for both the new master and the old master. Verify that the connection settings and credentials are correct.

6. **Monitor Logs for Additional Errors:**
   - Continue to monitor the PostgreSQL logs on both master and standby nodes for any additional errors or warnings that may indicate underlying issues.


Following these steps and guidelines should help you set up and troubleshoot logical replication between PostgreSQL clusters effectively.
