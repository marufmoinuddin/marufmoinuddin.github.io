---
layout: doc
title: "GitOps with ArgoCD"
category: cicd
order: 1
last_updated: 2026-06-15
tags: [gitops, argocd, kubernetes, cicd]
---

## What is GitOps?

GitOps is a paradigm where the desired state of infrastructure is declared in Git repositories, and automated operators continuously reconcile the live state with the declared state.

## ArgoCD Installation

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```
