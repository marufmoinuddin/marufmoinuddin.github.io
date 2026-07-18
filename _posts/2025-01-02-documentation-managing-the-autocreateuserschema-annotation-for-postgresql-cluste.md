---
layout: post
title: "Documentation: Managing the autoCreateUserSchema Annotation for PostgreSQL Clusters"
date: 2025-01-02
category: PostgreSQL
tags: [postgresql]
excerpt: The autoCreateUserSchema annotation for PostgreSQL clusters managed by the CrunchyData PostgreSQL Operator is a feature that automatically creates user schemas when a new database user is created. If this annotation is…
read_time: 2
source_doc: 05_AutoCreateUser_Schema.md
draft_import: true
---
# Documentation: Managing the `autoCreateUserSchema` Annotation for PostgreSQL Clusters

## Background

The `autoCreateUserSchema` annotation for PostgreSQL clusters managed by the CrunchyData PostgreSQL Operator is a feature that automatically creates user schemas when a new database user is created. If this annotation is not set to `true`, any data created by users will be stored in the default `public` schema. 

### Importance of User Schemas

When a database user creates objects (such as tables) without a dedicated schema, those objects reside in the `public` schema by default. This can lead to several issues:

1. **Data Isolation**: Without user schemas, different users share the same `public` schema, making it difficult to isolate data and enforce data security. For multi-tenant applications, this can create potential data access risks, where users might inadvertently access data belonging to others.

2. **Naming Conflicts**: Sharing a single schema increases the risk of naming conflicts between different users. If two users attempt to create a table with the same name, it will result in an error or overwrite existing data.

3. **Organizational Clarity**: Using user schemas improves organizational clarity within the database. Each user can have their own schema, which makes it easier to manage and maintain database objects.

## Adding the Annotation

### 1. For a Single Cluster

To add the `autoCreateUserSchema` annotation to a specific PostgreSQL cluster, use the following command:

```bash
kubectl annotate -n db-ns postgrescluster <cluster-name> \
  postgres-operator.crunchydata.com/autoCreateUserSchema=true
```

Replace `<cluster-name>` with the name of your PostgreSQL cluster (e.g., `dpdcbillpaymentdb`).

### 2. For All Clusters

To add the annotation to all PostgreSQL clusters in the `db-ns` namespace, run:

```bash
kubectl get postgrescluster -n db-ns -o name | xargs -I {} kubectl annotate -n db-ns {} postgres-operator.crunchydata.com/autoCreateUserSchema=true --overwrite
```

This command retrieves all clusters and applies the annotation to each one.

### 3. Adding the Annotation in YAML

To add the annotation in the YAML configuration for a PostgreSQL cluster, include it under the `metadata` section as follows:

```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: <cluster-name>
  namespace: db-ns
  annotations:
    postgres-operator.crunchydata.com/autoCreateUserSchema: "true"
spec:
  ...
```

Make sure to replace `<cluster-name>` with the name of your cluster. This configuration can be applied when creating or updating the cluster.

## Removing the Annotation

### 1. From a Single Cluster

To remove the `autoCreateUserSchema` annotation from a specific PostgreSQL cluster, use:

```bash
kubectl annotate -n db-ns postgrescluster <cluster-name> \
  postgres-operator.crunchydata.com/autoCreateUserSchema-
```

### 2. From All Clusters

To remove the annotation from all PostgreSQL clusters in the `db-ns` namespace, run:

```bash
kubectl get postgrescluster -n db-ns -o name | xargs -I {} kubectl annotate -n db-ns {} postgres-operator.crunchydata.com/autoCreateUserSchema-
```

## Verification

To verify the current annotations on your PostgreSQL clusters, you can execute:

```bash
kubectl get postgresclusters -n db-ns -o=jsonpath='{range .items[*]}{.metadata.name}: {.metadata.annotations.postgres-operator\.crunchydata\.com/autoCreateUserSchema}{"\n"}{end}'
```

This command will display the annotations for all clusters, allowing you to confirm whether the `autoCreateUserSchema` annotation has been added or removed successfully.

## Conclusion

Managing the `autoCreateUserSchema` annotation in PostgreSQL clusters is essential for maintaining data isolation and organizational clarity. By ensuring that users have dedicated schemas, you can avoid naming conflicts, enhance data security, and improve overall database management. Following the steps outlined in this document will help you effectively configure this annotation to meet your application needs.
