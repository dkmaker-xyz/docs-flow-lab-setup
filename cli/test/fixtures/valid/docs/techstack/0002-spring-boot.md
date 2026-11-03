---
id: TECH-0002
title: Spring Boot
description: Java application framework; a BOM that manages its starters.
intent: Which Spring Boot line and starters are approved.
when: When a Java service adds or upgrades Spring dependencies.
state: accepted
category: framework
ecosystem: maven
version: "3.5.*"
packages:
  - name: org.springframework.boot:spring-boot-starter-web
  - name: org.springframework.boot:spring-boot-starter-data-jpa
rationale: Standard framework for the Java services.
license: Apache-2.0
last_review: 2026-10-01
review_interval_months: 6
---
Managed by the Spring Boot BOM.
