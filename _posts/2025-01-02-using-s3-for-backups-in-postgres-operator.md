---
layout: post
title: Using S3 for Backups in Postgres Operator
date: 2025-01-02
category: PostgreSQL
tags: [backup, kubernetes, pgbackrest, postgresql, s3]
excerpt: "To set up backups in S3 for your PostgreSQL cluster, you need to make a few modifications to your custom resource (CR) spec. Additionally, you will need to either:"
read_time: 5
source_doc: 17_S3_Backups.md
draft_import: true
---
### Using S3 for Backups in Postgres Operator

To set up backups in S3 for your PostgreSQL cluster, you need to make a few modifications to your custom resource (CR) spec. Additionally, you will need to either:

1. Use a **Secret** to protect your S3 credentials, or
2. Set up AWS **identity providers** to allow pgBackRest to assume a role with the required permissions.

#### Using S3 Credentials

In your `PostgresCluster` spec, the S3 credentials can be provided through a secret. The secret will hold the AWS S3 key and secret key needed for pgBackRest backups. Below are the steps to configure your S3 backups.

1. **Create a Secret for S3 Credentials**  
   Create a Kubernetes Secret that stores your AWS S3 credentials. This can be done using the `kubectl create secret` command. Here's an example:

   ```bash
   kubectl create secret generic pgo-s3-creds \
     --from-literal=repo1-s3-key=YOUR_AWS_S3_KEY \
     --from-literal=repo1-s3-key-secret=YOUR_AWS_S3_KEY_SECRET \
     --namespace=postgres-operator
   ```

   Replace `YOUR_AWS_S3_KEY` and `YOUR_AWS_S3_KEY_SECRET` with your actual AWS credentials.

2. **PostgresCluster YAML Configuration**  
   In your `PostgresCluster` YAML file, under the `backups` section, configure the S3 backup repository by referencing the created secret.

   Here's an example based on your provided YAML:

   ```yaml
   apiVersion: postgres-operator.crunchydata.com/v1beta1
   kind: PostgresCluster
   metadata:
     name: hippo-s3
     namespace: postgres-operator
   spec:
     postgresVersion: 16
     instances:
       - dataVolumeClaimSpec:
           accessModes:
             - "ReadWriteOnce"
           resources:
             requests:
               storage: 1Gi
     backups:
       pgbackrest:
         configuration:
           - secret:
               name: pgo-s3-creds
         global:
           repo1-path: /pgbackrest/postgres-operator/hippo-s3/repo1
           repo1-s3-uri-style: path
           repo1-s3-key: XXXXX
           repo1-s3-key-secret: XXXXX
         repos:
           - name: repo1
             s3:
               bucket: crunchydb
               endpoint: s3.ap-southeast-1.amazonaws.com:443
               region: ap-southeast-1
   ```

   In this YAML file:
   - `secret.name` refers to the secret containing your S3 credentials (`pgo-s3-creds`).
   - The `repo1-s3-key` and `repo1-s3-key-secret` are set with actual values for your AWS S3 key and secret key. You can also reference these values from a secret instead of hardcoding them in the spec for enhanced security.
   - The `repo1-path` is the path where the backups will be stored.
   - The S3 configuration includes the bucket name (`crunchydb`), endpoint (`s3.ap-southeast-1.amazonaws.com`), and the region (`ap-southeast-1`).

3. **Configure URI Style for MinIO (Optional)**  
   If you are using MinIO or another S3-compatible storage system that requires a different URI style (e.g., path-style), you can configure it in the `global` section, as shown below:

   ```yaml
   global:
     repo1-s3-uri-style: path
   ```

4. **Deploy the PostgresCluster**  
   Once your `PostgresCluster` YAML is configured, apply the changes to your Kubernetes cluster:

   ```bash
   kubectl apply -f your-postgres-cluster.yaml
   ```

   This will configure your PostgreSQL cluster to use S3 for backups, with the specified credentials and storage location.

5. **Verify Backups**  
   Once the cluster is deployed, monitor the backup process. Your backups and archive logs will be stored in the specified S3 bucket (`crunchydb`), and the backups will be taken according to the configuration set in the `PostgresCluster` spec.

---

### CrunchyDB in IAM for PostgreSQL Backups

CrunchyDB refers to the custom implementation of PostgreSQL within the Crunchy Data ecosystem, which includes tools like **Postgres Operator** for Kubernetes. When setting up **pgBackRest** backups to AWS S3, CrunchyDB refers to the configuration and management of PostgreSQL clusters, including secure access to external storage systems (like S3).

In the context of IAM (Identity and Access Management), CrunchyDB works with AWS IAM policies to manage the permissions necessary for accessing S3 buckets securely. Specifically, you need to ensure that the **Postgres Operator** (running CrunchyDB) has the correct AWS IAM permissions to interact with the S3 storage for backup and restore operations.

This typically involves:
1. **Creating IAM policies** that allow access to the S3 bucket (like `crunchydb`) where backups are stored.
2. **Assigning these IAM policies** to the AWS user or role associated with the **Postgres Operator**, ensuring it has the required `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, and related permissions to manage backups.

In addition, leveraging **Secrets** or **identity providers** in Kubernetes helps securely store and use the credentials for authenticating with AWS services during backup operations.

---

### Required IAM Policies for AWS S3 Permissions

To allow pgBackRest to interact with your S3 storage, you need to ensure that the IAM role or user associated with the Postgres Operator has the necessary S3 permissions. Below are the two sets of IAM policies you can use:

#### Policy 1: Basic S3 Permissions

This policy grants permissions to list the S3 bucket and perform actions such as `GetObject`, `PutObject`, and `DeleteObject` for objects inside the bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::crunchydb"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::crunchydb/*"
      ]
    }
  ]
}
```

#### Policy 2: Advanced S3 Permissions with Conditions

This policy grants broader permissions, including the ability to list all buckets and get the bucket location. It also adds conditions for listing objects in subdirectories and controlling the root-level access to the bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGroupToSeeBucketListAndAlsoAllowGetBucketLocationRequiredForListBucket",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation"
      ],
      "Effect": "Allow",
      "Resource": [
        "arn:aws:s3:::*"
      ]
    },
    {
      "Action": [
        "s3:PutObject",
        "s3:ListBucket",
        "s3:PutObjectAcl"
      ],
      "Resource": [
        "arn:aws:s3:::crunchydb/*"
      ],
      "Effect": "Allow"
    },
    {
      "Sid": "AllowRootLevelListingOfCompanyBucket",
      "Action": [
        "s3:PutObject",
        "s3:ListBucket",
        "s3:PutObjectAcl"
      ],
      "Effect": "Allow",
      "Resource": [
        "arn:aws:s3:::crunchydb"
      ],
      "Condition": {
        "StringEquals": {
          "s3:prefix": [
            ""
          ],
          "s3:delimiter": [
            "/"
          ]
        }
      }
    },
    {
      "Sid": "AllowListingSubdirectoriesInBucket",
      "Action": [
        "s3:ListBucket"
      ],
      "Effect": "Allow",
      "Resource": [
        "arn:aws:s3:::crunchydb"
      ],
      "Condition": {
        "StringEquals": {
          "s3:delimiter": "/"
        }
      }
    }
  ]
}
```

Make sure these IAM policies are correctly associated with the AWS identity (user or role) that the Postgres Operator uses to interact with AWS S3. This ensures that the necessary S3 permissions are in place for backups to work correctly.

---

### Important Notes:
- Ensure your S3 bucket is correctly configured and accessible from your Kubernetes cluster.
- The `repo1-s3-key` and `repo1-s3-key-secret` should be stored securely, ideally in Kubernetes Secrets, to avoid exposing sensitive information.
- The region and endpoint are required for S3 configuration. If you are using a non-AWS S3-compatible service, ensure the region is configured appropriately (you can use a placeholder value if the region is not required).

With these steps completed, your PostgreSQL cluster will be configured to use S3 for backups, with all necessary permissions and security measures in place!
