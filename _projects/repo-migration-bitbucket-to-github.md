---
layout: project
title: "Repository Migration — Bitbucket to GitHub"
year: 2025
status: Completed
stack: [Git, GitHub, Bitbucket, Jenkins, Python, Terraform]
excerpt: "Migrated 80+ repositories from self-hosted Bitbucket to GitHub Enterprise with full history and CI/CD rewiring."
problem_statement: "Self-hosted Bitbucket server reaching end-of-life. 80+ repositories, 40+ developers, and tightly coupled Jenkins pipelines needed to be migrated with zero development downtime."
outcome: "All 80+ repositories migrated with complete git history. Jenkins pipelines rewired to GitHub webhooks. Migration completed in 3 weeks with zero developer-reported issues."
lessons:
  - "Automate repository metadata migration (PRs, issues) using the GitHub API"
  - "Communicate the migration timeline clearly to all developers"
  - "Use feature flags to toggle CI/CD endpoints during cutover"
---
