---
layout: doc
title: "ELK Stack Setup and Configuration"
category: observability
order: 1
last_updated: 2026-06-20
tags: [elasticsearch, logstash, kibana, elk, monitoring]
---

## Architecture

```
Log Sources → Filebeat → Logstash → Elasticsearch → Kibana
```

## Installation

```bash
# Import Elastic GPG key
wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | sudo gpg --dearmor -o /usr/share/keyrings/elasticsearch-keyring.gpg

# Install Elasticsearch
sudo apt install elasticsearch
```
