---
layout: doc
title: "Creating an Ubuntu 24.04 Cloud-Init Template in Proxmox"
category: virtualization
order: 50
last_updated: 2026-07-17
tags: ['cloud-init', 'high-availability', 'proxmox', 'qemu', 'ubuntu', 'virtualization']
---
# Creating an Ubuntu 24.04 Cloud-Init Template in Proxmox: A Step-by-Step Guide

## Introduction
This guide will walk you through creating an Ubuntu 24.04 cloud-init template in Proxmox. We'll start from downloading the image and end with a reusable template that you can use to create new virtual machines quickly.

## Prerequisites
- A working Proxmox installation
- Root access to your Proxmox server
- Basic knowledge of using terminal/SSH

## Step 1: Download Ubuntu Cloud Image
First, we'll download the official Ubuntu 24.04 (Noble) cloud image. Cloud images are special versions of Ubuntu designed to work with cloud-init.

```bash
# Connect to your Proxmox server as root
ssh root@your_proxmox_ip

# Download the Ubuntu 24.04 cloud image
wget -q https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```
The `-q` flag makes wget run quietly (without showing progress).

## Step 2: Resize the Image
The default cloud image is quite small. We'll resize it to 32GB to make it more useful.

```bash
qemu-img resize noble-server-cloudimg-amd64.img 48G
```

## Step 3: Create a New Virtual Machine
Now we'll create a new VM with ID 8001. Each command parameter is explained below:

```bash
qm create 8001 \
  --name "ubuntu-2404-cloudinit-template" \
  --ostype l26 \
  --memory 1024 \
  --agent 1 \
  --bios ovmf \
  --machine q35 \
  --efidisk0 vms-vg:0,pre-enrolled-keys=0 \
  --cpu host \
  --socket 1 \
  --cores 2 \
  --vga serial0 \
  --serial0 socket \
  --net0 virtio,bridge=vmbr0
```

Let's break down what each option means:
- `8001`: The VM ID (you can choose any unused number)
- `--name`: A descriptive name for your template
- `--ostype l26`: Indicates this is a Linux 2.6/3.x/4.x kernel
- `--memory 1024`: Allocates 1GB RAM
- `--agent 1`: Enables QEMU guest agent
- `--bios ovmf`: Uses UEFI boot
- `--machine q35`: Uses a modern machine type
- `--efidisk0`: Creates an EFI disk
- `--cpu host`: Uses host CPU type
- `--socket 1 --cores 2`: Creates 1 CPU socket with 2 cores
- `--net0`: Sets up networking using the default bridge

## Step 4: Import the Disk
Import the downloaded image to your VM:

```bash
qm importdisk 8001 noble-server-cloudimg-amd64.img vms-vg
```
This converts the downloaded image into a format Proxmox can use.

## Step 5: Configure the Virtual Machine
Now we'll configure the disk and boot settings:

```bash
# Configure the SCSI controller and disk
qm set 8001 --scsihw virtio-scsi-pci --virtio0 vms-vg:vm-8001-disk-1,discard=on

# Set boot order to use the imported disk
qm set 8001 --boot order=virtio0

# Add cloud-init drive
qm set 8001 --scsi1 vms-vg:cloudinit
```

## Step 6: Create Cloud-Init Configuration
We'll create a custom cloud-init configuration that handles initial setup:

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
1. Updates the system
2. Installs and enables the QEMU guest agent
3. Configures SSH to allow password authentication
4. Ensures proper authentication settings
5. Restarts SSH service
6. Reboots to apply all changes

## Step 7: Configure VM Cloud-Init Settings
Now we'll set up the basic VM configuration:

```bash
# Apply the custom cloud-init configuration
qm set 8001 --cicustom "vendor=local:snippets/vendor.yaml"

# Add helpful tags
qm set 8001 --tags ubuntu-template,24.04,cloudinit

# Set the default user (replace 'your_username' with your preferred username)
qm set 8001 --ciuser your_username

# Set a password (replace 'your_password' with your desired password)
qm set 8001 --cipassword $(openssl passwd -6 'your_password')

# If you have SSH keys, add them (optional)
qm set 8001 --sshkeys ~/.ssh/authorized_keys

# Configure networking to use DHCP
qm set 8001 --ipconfig0 ip=dhcp
```

## Step 8: Convert to Template
Finally, convert the VM into a template:

```bash
qm template 8001
```

## Using Your New Template
To create a new VM from this template:
1. Go to your Proxmox web interface
2. Select your template (ID: 8001)
3. Click "Clone"
4. Choose between linked clone (saves space) or full clone (independent copy)
5. Give the new VM an ID and name
6. Start your new VM!

## Troubleshooting
1. If SSH password authentication doesn't work:
   - Verify the cloud-init configuration was applied
   - Check /etc/ssh/sshd_config in the VM
   - Ensure the VM has completed its initial boot sequence

2. If the VM doesn't get an IP:
   - Check your network configuration
   - Verify DHCP is available on your network

3. If the guest agent isn't working:
   - Log into the VM and check its status: `systemctl status qemu-guest-agent`
   - Verify it was installed: `dpkg -l | grep qemu-guest-agent`

## Conclusion
You now have a reusable Ubuntu 24.04 template that you can use to quickly create new VMs. Each VM created from this template will:
- Have password authentication enabled for SSH
- Use DHCP for networking
- Have the QEMU guest agent installed and enabled
- Be updated with the latest packages at creation

Remember to replace any example values (usernames, passwords) with your own secure values when using this guide.
