---
layout: doc
title: "Resize and Expand a QCOW2 Disk Image"
category: virtualization
order: 99
last_updated: 2025-01-02
tags: [qcow2, disk-resize, kvm, qemu, virtualization, centos]
---

# Simple Guide to Resize and Expand a QCOW2 Disk Image for CentOS Stream 9

This guide will walk you through the steps to resize a QCOW2 disk image on CentOS Stream 9. By following these instructions, you'll be able to create a new, larger disk image and expand the partition inside it to take advantage of the new space. Don’t worry—everything is explained step by step!

## What You Need

Before you start, make sure you have the following tools installed on your computer:

- **qemu-img** (for creating and managing disk images)
- **virt-resize** (for resizing partitions)
- **virt-filesystems** (for checking the disk image)

Also, you'll need **sudo** (administrator) access to run some of these commands.

---

## Steps

### Step 1: Go to the Folder with the Disk Image

First, you need to make sure you're in the right folder where your disk image is stored. This way, all the commands you run will work on the right files.

```bash
sudo cd /var/lib/libvirt/osdisk/
```

This command will take you to the folder that contains your virtual disk images.

### Step 2: Check the Disk Information

Before resizing, you should take a look at the current disk image to see its partitions and file system layout. This will help you understand the structure of the disk image.

```bash
sudo virt-filesystems --long -h --all -a CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2
```

**What this does:**
- `--long`: Gives more detailed information about the disk.
- `-h`: Shows sizes in human-readable formats (like GB, MB).
- `--all`: Shows all the partitions on the disk.
- `-a`: Specifies the disk image you're working with.

This command will help you confirm the current partition and file system setup.

### Step 3: Create a New, Larger Disk Image

Next, you'll create a new disk image that is larger than the original. This new image will be used to copy the data from the old disk, while giving you more space.

```bash
sudo qemu-img create -f qcow2 -o preallocation=metadata CentOS-Stream-9-BaseImage.qcow2 100G
```

**What this does:**
- `-f qcow2`: Creates a QCOW2 disk image (a special format for virtual disks).
- `-o preallocation=metadata`: Helps manage space more efficiently.
- `100G`: The size of the new disk image (in this case, 100GB).

This will create a new disk image named `CentOS-Stream-9-BaseImage.qcow2` with 100GB of space.

### Step 4: Resize the Disk Image

Now, use the `virt-resize` tool to copy everything from the old disk image to the new one. This will also expand the main partition (`/dev/sda1`) to take up the new space in the resized disk image.

```bash
sudo virt-resize --expand /dev/sda1 CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2 CentOS-Stream-9-BaseImage.qcow2
```

**What this does:**
- `--expand /dev/sda1`: Expands the root partition (`/dev/sda1`) to use the full space in the new image.
- `CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2`: The original disk image.
- `CentOS-Stream-9-BaseImage.qcow2`: The new, resized disk image.

This will copy all the data from the original disk to the new one, while also expanding the root partition to fill the extra space.

### Step 5: Verify the New Disk Image

Once the resizing is done, you can check the new disk image to make sure everything worked correctly.

```bash
sudo virt-filesystems --long -h --all -a CentOS-Stream-9-BaseImage.qcow2
```

This will show the partitions and file systems of the new disk image, so you can confirm that the resizing worked as expected.

---

## What Each Command Does

### `qemu-img create`

This command creates a new virtual disk image. The `-o preallocation=metadata` option helps optimize how space is used on the disk.

### `virt-resize`

This tool helps resize and copy data between disk images. The `--expand` flag tells it to make the root partition bigger to fill the new space in the resized disk.

### `virt-filesystems`

This command shows detailed information about the partitions and file systems inside a disk image. It's useful for verifying that everything looks correct after resizing.

---

## Recap

By following this guide, you will:
- Create a new, larger disk image.
- Resize and expand the root partition to use the extra space.
- Verify that everything has been resized correctly.

**Remember:** You'll need **sudo** access for all of these steps, as modifying disk images requires administrator permissions.

With these steps, you should be able to resize your QCOW2 disk image and expand the available space in CentOS Stream 9. Enjoy your newly expanded disk!
