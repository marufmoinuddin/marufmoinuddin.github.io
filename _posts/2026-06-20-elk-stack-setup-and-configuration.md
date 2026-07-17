---
layout: post
title: "ELK Stack Setup and Configuration"
date: 2026-06-20
category: Observability
tags: [elasticsearch, logstash, kibana, elk, monitoring, observability]
excerpt: "Log Sources → Filebeat → Logstash → Elasticsearch → Kibana"
read_time: 1
order: 1
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
