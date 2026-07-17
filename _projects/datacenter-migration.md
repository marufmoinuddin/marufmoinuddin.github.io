---
layout: project
title: "Datacenter Migration of Core Application Services"
year: 2026
status: Completed
stack: [Kubernetes, PostgreSQL, Docker, HAProxy, Ansible, ELK]
excerpt: "Planned and executed a zero-downtime migration of 12 core services across datacenters."
problem_statement: "Legacy datacenter contract expiring. 12 critical application services needed to be migrated to a new facility with zero user-facing downtime, while maintaining compliance and audit trails."
outcome: "All 12 services migrated successfully with zero downtime. Cutover completed in 4 hours over a weekend window. Post-migration monitoring showed no degradation in response times or error rates."
lessons:
  - "Invest heavily in runbook automation before migration day"
  - "Use canary testing to validate connectivity before full cutover"
  - "Always have a rollback plan tested and ready"
---

## Architecture

The migration used a lift-and-shift approach with Kubernetes as the abstraction layer:

1. **Phase 1:** Establish VPN connectivity between old and new DCs
2. **Phase 2:** Deploy identical Kubernetes manifests in the new cluster
3. **Phase 3:** Replicate PostgreSQL using logical replication
4. **Phase 4:** Shift traffic gradually via DNS TTL manipulation and HAProxy

## Your Role

As the lead Operations Engineer, I designed the migration plan, wrote the Ansible playbooks for environment provisioning, coordinated the cutover window with stakeholders, and led the go-live execution.
