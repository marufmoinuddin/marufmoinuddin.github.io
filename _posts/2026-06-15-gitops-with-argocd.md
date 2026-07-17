---
layout: post
title: "GitOps with ArgoCD"
date: 2026-06-15
category: CI/CD
tags: [gitops, argocd, kubernetes, cicd]
excerpt: "GitOps is a paradigm where the desired state of infrastructure is declared in Git repositories, and automated operators continuously reconcile the live state with the declared stat"
read_time: 1
order: 1
---

## What is GitOps?

GitOps is a paradigm where the desired state of infrastructure is declared in Git repositories, and automated operators continuously reconcile the live state with the declared state.

## ArgoCD Installation

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```
