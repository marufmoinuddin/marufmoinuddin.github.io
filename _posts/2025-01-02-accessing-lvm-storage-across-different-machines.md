---
layout: post
title: Accessing LVM Storage Across Different Machines
date: 2025-01-02
category: Backup
tags: [backup, linux, lvm, pvc]
excerpt: This research explores the practical and theoretical aspects of accessing Logical Volume Manager (LVM) storage across different machines by connecting physical volumes (PVs) from an existing LVM setup to a new system.…
read_time: 7
source_doc: 26_LVM_Storage_Portability.md
draft_import: true
---
# Accessing LVM Storage Across Different Machines

## Abstract

This research explores the practical and theoretical aspects of accessing Logical Volume Manager (LVM) storage across different machines by connecting physical volumes (PVs) from an existing LVM setup to a new system. The experiment demonstrates that data stored in LVM logical volumes (LVs) can be accessed on a different machine by simply connecting the required physical volumes. The paper highlights the role of LVM metadata, storage abstraction, and the flexibility of LVM in managing storage across multiple devices. Theoretical foundations are supported by a detailed experiment that shows the feasibility of accessing LVM storage from different systems.

## Introduction

The Logical Volume Manager (LVM) is a robust and flexible storage management system for Linux-based systems that abstracts physical storage devices into logical volumes, enabling easier management of disk space. The key components of LVM are Physical Volumes (PVs), Volume Groups (VGs), and Logical Volumes (LVs). LVM allows users to combine multiple physical storage devices into a single logical unit, which can then be formatted and used for data storage. In the event of a system crash or when switching to a different machine, LVM ensures that the data stored in logical volumes remains intact, provided the physical volumes are connected to the new system. This research investigates the possibility of accessing an LVM-managed logical volume across different machines by connecting the physical volumes to a new system.

## Theoritical Review

### Theoretical Framework: LVM Architecture

LVM comprises three main components: Physical Volumes (PVs), Volume Groups (VGs), and Logical Volumes (LVs). Physical Volumes represent the actual storage devices (e.g., hard drives or USB drives), and a Volume Group is a logical aggregation of PVs. Logical Volumes are partitions created within a Volume Group, and they can be formatted with any supported filesystem (e.g., ext4, xfs). Metadata for LVM configurations is stored on the PVs and describes the layout of the logical volumes within the volume group. If this metadata is intact, the logical volumes can be accessed on another machine by reactivating the volume group.

This theoretical flexibility of LVM allows users to move their storage between systems with minimal effort, provided the physical devices containing the data are available. LVM recovery methods ensure that, even in cases of system failure or OS corruption, the data stored in LVM-managed volumes can still be accessed by connecting the physical volumes to a new system. Various resources have demonstrated the practicality of accessing LVM volumes across machines, including tutorials and technical articles that explain how to activate and mount LVM volumes on a different system after transferring the physical volumes ([Red Hat Documentation](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/storage_administration_guide/creating-and-managing-logical-volumes_storage-administration-guide)).

### LVM Storage Location: No Data in the OS

One of the fundamental principles of LVM is that it does not store its data in the operating system itself. Instead, LVM manages the storage at a lower level, directly on the physical volumes. The data and the metadata that describe the LVM configuration (i.e., the physical volumes, volume groups, and logical volumes) are stored on the PVs. The operating system, while it uses LVM to manage the logical volumes, does not directly store any data for the logical volumes in its filesystem or memory.

The metadata for LVM includes information about the layout of logical volumes and the distribution of data across physical volumes. This allows LVM to remain flexible and portable. Even if the operating system becomes corrupt or inaccessible, the data can still be retrieved as long as the physical volumes are intact. This is because the metadata resides on the physical devices (PVs) themselves and can be accessed by another system with LVM support.

This separation of data and metadata from the operating system is essential for ensuring data availability across different machines, regardless of the state of the OS. When the physical volumes are transferred to another system, the volume group can be activated and the logical volume mounted on the new system. This has been discussed in several articles, such as the one provided by TechRepublic, which outlines the use of LVM for disaster recovery and the migration of data across systems ([TechRepublic](https://www.techrepublic.com/article/use-vgcfgbackup-and-vgcfgrestore-to-back-up-metadata-on-lvm/)).

### LVM Recovery and Flexibility

LVM's flexibility extends to external and removable media, such as USB flash drives. By using LVM, users can combine multiple USB drives into a single logical volume, simplifying the management of external storage. As demonstrated in the experiment, this configuration can be accessed from any system that supports LVM, making it an ideal solution for data recovery and storage migration ([Linux Mint Wiki](https://linuxmint.com/guide/usb-flash-drive-lvm-setup)).

## Experiment Overview: Accessing LVM Storage Across Different Machines

### Materials Needed

- **Two USB Flash Drives**: Each with a capacity of at least 64GB.
- **A Computer with Linux Installed**: Ensure that the system has LVM installed by checking with `lvm version` in the terminal.
- **Terminal Access**: Use the terminal to execute necessary commands.

### Step-by-Step Instructions

#### Step 1: Prepare the USB Drives
- **Insert the USB Drives**: Connect both USB flash drives to your computer.
- **Open the Terminal**: Access the terminal application from your system’s applications menu.

#### Step 2: Identify the USB Drives
- **List the Drives**: Run the following command to identify the connected drives:
  ```bash
  lsblk
  ```
  Look for your USB drives in the output, typically listed as `/dev/sdb` and `/dev/sdc` (the exact names may vary).

#### Step 3: Create Physical Volumes (PVs)
- **Initialize the USB Drives**: Use `pvcreate` to initialize each USB drive as a physical volume:
  ```bash
  sudo pvcreate /dev/sdb
  sudo pvcreate /dev/sdc
  ```

#### Step 4: Create a Volume Group (VG)
- **Create a Volume Group**: Combine the two physical volumes into a single volume group. In this example, name it `myvg`:
  ```bash
  sudo vgcreate myvg /dev/sdb /dev/sdc
  ```

#### Step 5: Create a Logical Volume (LV)
- **Create a Logical Volume**: Create a logical volume that uses the entire space of the volume group:
  ```bash
  sudo lvcreate -l 100%FREE -n mylv myvg
  ```

#### Step 6: Format the Logical Volume
- **Format the Logical Volume**: Format the logical volume with the ext4 filesystem:
  ```bash
  sudo mkfs.ext4 /dev/myvg/mylv
  ```

#### Step 7: Mount the Logical Volume
- **Create a Mount Point**: Create a directory where you will mount the logical volume:
  ```bash
  sudo mkdir /mnt/mylv
  ```
- **Mount the Logical Volume**: Mount the logical volume:
  ```bash
  sudo mount /dev/myvg/mylv /mnt/mylv
  ```

#### Step 8: Add Some Data
- **Add Files**: You can now add files to the mounted logical volume:
  ```bash
  echo "Hello, LVM!" > /mnt/mylv/hello.txt
  ```

#### Step 9: Unmount and Shut Down
- **Unmount the Logical Volume**: Before disconnecting the USB drives, unmount the logical volume:
  ```bash
  sudo umount /mnt/mylv
  ```
- **Shut Down the Computer**: Power off your computer safely.

#### Step 10: Connect to a New Machine
- **Connect the USB Drives**: Insert both USB drives into a different computer that also has Linux and LVM installed.
- **Open the Terminal**: Access the terminal on the new machine.

#### Step 11: Activate the Volume Group
- **Scan for Physical Volumes**: Run the following command to scan for the physical volumes:
  ```bash
  sudo pvscan
  ```
- **Activate the Volume Group**: Activate the volume group:
  ```bash
  sudo vgchange -ay myvg
  ```

#### Step 12: Mount the Logical Volume
- **Create a Mount Point**: Create a directory to mount the logical volume:
  ```bash
  sudo mkdir /mnt/mylv
  ```
- **Mount the Logical Volume**: Mount the logical volume:
  ```bash
  sudo mount /dev/myvg/mylv /mnt/mylv
  ```

#### Step 13: Access Your Data
- **Check the Files**: You can now access the files you created earlier:
  ```bash
  cat /mnt/mylv/hello.txt
  ```

## Discussion

The experiment demonstrates that LVM provides the flexibility to access storage across different systems by simply connecting the physical volumes. The metadata stored on the physical volumes allows the system to reconstruct the volume group and logical volume, ensuring data accessibility even when the physical volumes are moved to another machine. The absence of data access when only one physical volume is connected aligns with the LVM architecture, where the logical volume requires all physical volumes in the volume group to be present.

## Conclusion

This research validates the feasibility of accessing LVM storage across different machines by connecting the physical volumes. The flexibility and robustness of LVM, particularly in the context of removable media, make it a powerful tool for managing and recovering data across systems. The experiment has demonstrated the theoretical flexibility of LVM in practice and provides a concrete example of how it can be used to migrate and recover data stored in logical volumes.

## References

1. Red Hat Documentation. (2023). *Creating and Managing Logical Volumes*. Retrieved from [https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/storage_administration_guide/creating-and-managing-logical-volumes_storage-administration-guide](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/storage_administration_guide/creating-and-managing-logical-volumes_storage-administration-guide)

2. TechRepublic. (2023). *Backing Up and Restoring LVM Metadata*. Retrieved from [https://www.techrepublic.com/article/use-vgcfgbackup-and-vgcfgrestore-to-back-up-metadata-on-lvm/](https://www.techrepublic.com/article/use-vgcfgbackup-and-vgcfgrestore-to-back-up-metadata-on-lvm/)
3. Linux Mint Wiki. (2023). *Setting Up USB Flash Drives with LVM*. Retrieved from [https://linuxmint.com/guide/usb-flash-drive-lvm-setup](https://linuxmint.com/guide/usb-flash-drive-lvm-setup)
