---
layout: doc
title: "Creating a Debian 12 Cloud-Init Template in Proxmox"
category: virtualization
order: 99
last_updated: 2025-02-11
tags: [proxmox, debian, cloud-init, virtualization, template]
---

# Creating a Debian 12 Cloud-Init Template in Proxmox: A Step-by-Step Guide

## Introduction
This guide will walk you through creating a **Debian 12 (Bookworm)** cloud-init template in Proxmox using BIOS boot (seabios) and Q35 machine type. We’ll start from downloading the image and end with a reusable template that you can use to create new virtual machines quickly.

## Prerequisites
- A working Proxmox installation
- Root access to your Proxmox server
- Basic knowledge of using terminal/SSH

## Step 1: Download Debian Cloud Image
First, we need to download the official **Debian 12 cloud image**. Cloud images are special versions of Debian designed to work with cloud-init.

```bash
# Connect to your Proxmox server as root
ssh root@your_proxmox_ip

# Download the Debian 12 cloud image
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2
```
The `-q` flag makes wget run quietly (without showing progress).

## Step 2: Resize the Image
The default cloud image is relatively small. We’ll resize it to 48GB to make it more useful for VM deployments.

```bash
qemu-img resize debian-12-generic-amd64.qcow2 48G
```

## Step 3: Create a New Virtual Machine
Now we’ll create a new VM with ID `100000`. Each command parameter is explained below:

```bash
qm create 100000 \
  --name "debian-12-cloudinit-template" \
  --ostype l26 \
  --memory 2048 \
  --agent 1 \
  --bios seabios \
  --machine q35 \
  --cpu host \
  --socket 1 \
  --cores 2 \
  --vga serial0 \
  --serial0 socket \
  --net0 virtio,bridge=vmbr0
```

Let’s break down the options:
- `100000`: The VM ID (you can choose any unused number).
- `--name`: A descriptive name for your template.
- `--ostype l26`: Indicates this is a Linux 2.6/3.x/4.x kernel.
- `--memory 2048`: Allocates 2GB of RAM (adjustable depending on your needs).
- `--agent 1`: Enables QEMU guest agent.
- `--bios seabios`: Uses BIOS boot (legacy).
- `--machine q35`: Uses a modern machine type (Q35 chipset).
- `--cpu host`: Uses host CPU type.
- `--socket 1 --cores 2`: Creates 1 CPU socket with 2 cores.
- `--net0`: Sets up networking using the default bridge (`vmbr0`).

## Step 4: Import the Disk
Import the downloaded image to your VM:

```bash
qm importdisk 100000 debian-12-generic-amd64.qcow2 local-lvm -format qcow2
```

This converts the downloaded image into a format Proxmox can use.

## Step 5: Configure the Virtual Machine
Now we’ll configure the disk and boot settings:

```bash
# Configure the SCSI controller and disk
qm set 100000 --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-100000-disk-0,discard=on

# Set boot order to use the imported disk
qm set 100000 --boot c --bootdisk scsi0

# Add cloud-init drive
qm set 100000 --ide2 local-lvm:cloudinit

# Configure Serial console for debugging
qm set 100000 --serial0 socket --vga serial0
```

### Disk Configuration:
- `scsihw virtio-scsi-pci`: Sets up the SCSI controller type.
- `scsi0`: Refers to the disk attached to the VM. This should match the imported disk name (`local-lvm:vm-100000-disk-0`).

### Boot Order:
- The boot order is set to boot from `scsi0` (`--boot c --bootdisk scsi0`).

### Cloud-Init Configuration:
- The `--ide2 local-lvm:cloudinit` is added to enable cloud-init functionality for configuration.

## Step 6: Create Cloud-Init Configuration
We’ll create a custom cloud-init configuration that handles the initial setup for Debian 12.

```bash
# Create the snippets directory if it doesn't exist
mkdir -p /var/lib/vz/snippets/

# Create and edit the cloud-init configuration file
cat > /var/lib/vz/snippets/vendor.yaml << 'EOF'
#cloud-config
runcmd:
    - apt update
    - apt install -y qemu-guest-agent
    - systemctl enable --now qemu-guest-agent
    - sed -i '/^PasswordAuthentication/d' /etc/ssh/sshd_config
    - sed -i '/^#PasswordAuthentication/d' /etc/ssh/sshd_config
    - echo 'PasswordAuthentication yes' | tee -a /etc/ssh/sshd_config
    - echo 'ChallengeResponseAuthentication no' | tee -a /etc/ssh/sshd_config
    - echo 'UsePAM yes' | tee -a /etc/ssh/sshd_config
    - systemctl restart sshd
    - reboot

ssh_pwauth: true
EOF
```

This configuration:
1. Updates the system using `apt`.
2. Installs and enables the QEMU guest agent.
3. Configures SSH to allow password authentication.
4. Ensures proper authentication settings.
5. Restarts the SSH service.
6. Reboots to apply all changes.

## Step 7: Configure VM Cloud-Init Settings
Now we’ll set up the basic VM configuration:

```bash
# Apply the custom cloud-init configuration
qm set 100000 --cicustom "vendor=local:snippets/vendor.yaml"

# Add helpful tags
qm set 100000 --tags debian-template,12,cloudinit

# Set the default user (replace 'your_username' with your preferred username)
qm set 100000 --ciuser ubuntu

# Set a password (replace 'your_password' with your desired password)
qm set 100000 --cipassword $(openssl passwd -6 'ubuntu')

# If you have SSH keys, add them (optional)
qm set 100000 --sshkeys ~/.ssh/authorized_keys

# Configure networking to use DHCP
qm set 100000 --ipconfig0 ip=dhcp
```

## Step 8: Convert to Template
Finally, convert the VM into a template:

```bash
qm template 100000
```

## Using Your New Template
To create a new VM from this template:
1. Go to your Proxmox web interface.
2. Select your template (ID: 100000).
3. Click "Clone".
4. Choose between linked clone (saves space) or full clone (independent copy).
5. Give the new VM an ID and name.
6. Start your new VM!

## Troubleshooting
1. If SSH password authentication doesn’t work:
   - Verify the cloud-init configuration was applied correctly.
   - Check `/etc/ssh/sshd_config` in the VM.
   - Ensure the VM has completed its initial boot sequence.

2. If the VM doesn’t get an IP:
   - Check your network configuration.
   - Verify DHCP is available on your network.

3. If the guest agent isn’t working:
   - Log into the VM and check its status: `systemctl status qemu-guest-agent`.
   - Verify it was installed: `dpkg -l | grep qemu-guest-agent`.

## Conclusion
You now have a reusable **Debian 12 (Bookworm)** template that you can use to quickly create new VMs. Each VM created from this template will:
- Have password authentication enabled for SSH.
- Use DHCP for networking.
- Have the QEMU guest agent installed and enabled.
- Be updated with the latest packages at creation.

Remember to replace any example values (usernames, passwords) with your own secure values when using this guide.

--- 

### Summary of Changes:
- The storage pool is `local-lvm` instead of `vms-vg`.
- VM creation uses different ID `100000`.
- The cloud-init configuration now includes specific Debian 12 setup.
