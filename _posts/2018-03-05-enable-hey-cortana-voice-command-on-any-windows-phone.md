---
layout: post
title: Enable "Hey Cortana" Voice Command on Any Windows Phone
date: 2018-03-05
category: Windows
tags: [windows, windows-phone, cortana, registry, trick]
excerpt: "A step-by-step guide to enable the Hey Cortana voice activation feature on any Windows Phone device using Interop Tools and a registry tweak."
read_time: 3
---

# Enable "Hey Cortana" Voice Command on Any Windows Phone

**Originally posted on:** Microsoft Windows Users Community Bangladesh (MUCB)

---

**Requirements:**

1. **Interop Tools 1.9** — [Download Link](https://db.tt/fpKcil6TPZ)
2. **Hey Cortana Registry File** — [Download Link](https://db.tt/LuDzx9avFS)

---

# Caution:
 - This is a community-developed tweak and is not officially supported by Microsoft. Use it at your own risk.

## Step-by-Step Instructions

### Method 1: Using the Registry File (Recommended)

1. Uninstall any previous version of Interop Tools you may have installed, then install **Interop Tools 1.9**.
2. Open Interop Tools after installation.
3. Navigate to **This Device**.
4. Press the Windows button to minimize Interop Tools and exit to the Start screen.
5. Open the downloaded **heycortana.itreg** file from File Explorer.
6. Interop Tools will open automatically and prompt you to import the registry entries — tap the **Import** button.

### Method 2: Manual Registry Configuration

If you prefer to do it manually, navigate to the following registry path and set the values as specified:

**Registry Path:**
`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\AudioPolicy`

**Registry Type:** Integer

**Values to set:**
| Value Name | Data |
|---|---|
| `Duplex` | `2` |
| `HardwareVoiceActivationInSKU` | `0` |
| `SoftwareSpeakerIDInSKU` | `1` |
| `SoftwareVoiceActivationInSKU` | `1` |
| `VoiceActivationAlwaysUseHWKWS` | `1` |
| `VoiceActivationEnableWoV` | `1` |

---

## Activating Hey Cortana

1. Open **Cortana** and go to its **Settings**.
2. Turn on the **Hey Cortana** option.
3. Say **"Hey Cortana"** aloud. Your phone should respond and start listening for your voice commands.
4. If it doesn't work on the first try, manually tap the microphone button and give a voice command. Try saying "Hey Cortana" again afterward — it should start responding automatically from then on.

---

## Notes

- The Hey Cortana feature was previously exclusive to high-end Lumia devices such as the **Lumia 950**. After applying this tweak, it will be available on any Windows Phone device.
- **Battery warning:** It is recommended to keep this feature disabled when not needed, as it consumes a significant amount of battery power due to continuous voice listening.
- Screenshots are available in the first comment of the original post.
