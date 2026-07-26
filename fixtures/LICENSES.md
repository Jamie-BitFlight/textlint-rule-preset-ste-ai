# Fixture Licences and Attributions

This corpus (`fixtures/original/*.md`) is the ORIGINAL half of a technical-documentation
fixture set built for evaluating a technical-writing linter. Every fixture is a short,
verbatim excerpt copied from a real, publicly published piece of technical documentation, chosen
because it exercises a specific linting-relevant feature (passive voice, nested conditions,
tables, code blocks, safety-imperative language, and so on). The corpus is ordinary technical
documentation drawn from database engines, web servers, embedded/compiler toolchains, container
orchestration, web frameworks, CLI tools, and U.S. federal safety regulations.

Every source was selected because its licence permits redistribution and is **not**
copyleft/share-alike (no GPL, LGPL, AGPL, GFDL, or CC-BY-SA material is included). Each section
below gives the fixture's title, the organisation that publishes the source, the exact URL the
excerpt was read from, the retrieval date, the upstream licence, a verbatim quote of the licence
statement (with the URL that statement was read from), and the reproduction class
(`excerpted` = a verbatim, contiguous or clearly-bounded selection copied unmodified from the
source). The machine-readable, hash-verified record of every fetch (HTTP status, SHA-256, byte
count, timestamp) lives in `fixtures/provenance.lock.json`, produced by
`scripts/fetch-sources.mjs`.

---

## sqlite-vacuum-space-reclaim

- **Title:** SQLite VACUUM: reasons to reclaim database space
- **Organisation:** SQLite Development Team
- **Source URL:** <https://sqlite.org/lang_vacuum.html>
- **Retrieved:** 2026-07-26
- **Licence:** Public Domain
- **Licence evidence URL:** <https://sqlite.org/copyright.html> (licence-page)
- **Licence statement (verbatim):** "All of the code and documentation in SQLite has been dedicated to the public domain by the authors."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** maintenance / dev
- **Fixture file:** `fixtures/original/sqlite-vacuum-space-reclaim.md`

## postgres-vacuum-overview

- **Title:** PostgreSQL VACUUM: reclaiming storage from dead tuples
- **Organisation:** PostgreSQL Global Development Group
- **Source URL:** <https://raw.githubusercontent.com/postgres/postgres/master/doc/src/sgml/ref/vacuum.sgml>
- **Retrieved:** 2026-07-26
- **Licence:** PostgreSQL Licence
- **Licence evidence URL:** <https://raw.githubusercontent.com/postgres/postgres/master/COPYRIGHT> (repository-licence-file)
- **Licence statement (verbatim):** "Permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and without a written agreement is hereby granted, provided that the above copyright notice and this paragraph and the following two paragraphs appear in all copies."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** maintenance / heldout
- **Fixture file:** `fixtures/original/postgres-vacuum-overview.md`

## zephyr-dependency-setup

- **Title:** Zephyr Getting Started: selecting an OS and updating packages
- **Organisation:** Zephyr Project (Linux Foundation)
- **Source URL:** <https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/doc/develop/getting_started/index.rst>
- **Retrieved:** 2026-07-26
- **Licence:** Apache-2.0
- **Licence evidence URL:** <https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** ""License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** installation / dev
- **Fixture file:** `fixtures/original/zephyr-dependency-setup.md`

## llvm-getting-started-build

- **Title:** LLVM Getting Started: cloning and configuring the source tree
- **Organisation:** LLVM Project
- **Source URL:** <https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/docs/GettingStarted.md>
- **Retrieved:** 2026-07-26
- **Licence:** Apache-2.0 WITH LLVM-exception
- **Licence evidence URL:** <https://raw.githubusercontent.com/llvm/llvm-project/main/LICENSE.TXT> (repository-licence-file)
- **Licence statement (verbatim):** "The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:"
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** installation / dev
- **Fixture file:** `fixtures/original/llvm-getting-started-build.md`

## k8s-debug-pod-troubleshooting

- **Title:** Kubernetes: diagnosing a Pod stuck in Pending
- **Organisation:** Kubernetes Authors / Cloud Native Computing Foundation
- **Source URL:** <https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/debug/debug-application/debug-pods.md>
- **Retrieved:** 2026-07-26
- **Licence:** CC-BY-4.0
- **Licence evidence URL:** <https://raw.githubusercontent.com/kubernetes/website/main/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** "Subject to the terms and conditions of this Public License, the Licensor hereby grants You a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable license to exercise the Licensed Rights in the Licensed Material"
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** CC-BY-4.0
- **Category / split:** troubleshooting / dev
- **Fixture file:** `fixtures/original/k8s-debug-pod-troubleshooting.md`

## k8s-audit-log-troubleshooting

- **Title:** Kubernetes Auditing: request stages and record lifecycle
- **Organisation:** Kubernetes Authors / Cloud Native Computing Foundation
- **Source URL:** <https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/debug/debug-cluster/audit.md>
- **Retrieved:** 2026-07-26
- **Licence:** CC-BY-4.0
- **Licence evidence URL:** <https://raw.githubusercontent.com/kubernetes/website/main/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** "Subject to the terms and conditions of this Public License, the Licensor hereby grants You a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable license to exercise the Licensed Rights in the Licensed Material"
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** CC-BY-4.0
- **Category / split:** troubleshooting / heldout
- **Fixture file:** `fixtures/original/k8s-audit-log-troubleshooting.md`

## osha-lockout-tagout-warning

- **Title:** OSHA 1910.147: hazardous energy control procedure requirements
- **Organisation:** Occupational Safety and Health Administration (U.S. Department of Labor)
- **Source URL:** <https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.147>
- **Retrieved:** 2026-07-26
- **Licence:** Public Domain (U.S. Government Work)
- **Licence evidence URL:** <https://www.copyright.gov/title17/92chap1.html> (statute)
- **Licence statement (verbatim):** "Copyright protection under this title is not available for any work of the United States Government, but the United States Government is not precluded from receiving and holding copyrights transferred to it by assignment, bequest, or otherwise."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** safety-warning / dev
- **Fixture file:** `fixtures/original/osha-lockout-tagout-warning.md`

## osha-ppe-requirements

- **Title:** OSHA 1910.132: personal protective equipment application and hazard assessment
- **Organisation:** Occupational Safety and Health Administration (U.S. Department of Labor)
- **Source URL:** <https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.132>
- **Retrieved:** 2026-07-26
- **Licence:** Public Domain (U.S. Government Work)
- **Licence evidence URL:** <https://www.copyright.gov/title17/92chap1.html> (statute)
- **Licence statement (verbatim):** "Copyright protection under this title is not available for any work of the United States Government, but the United States Government is not precluded from receiving and holding copyrights transferred to it by assignment, bequest, or otherwise."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** safety-warning / heldout
- **Fixture file:** `fixtures/original/osha-ppe-requirements.md`

## httpd-mod-ssl-overview

- **Title:** Apache mod_ssl: module summary and environment variables
- **Organisation:** The Apache Software Foundation
- **Source URL:** <https://raw.githubusercontent.com/apache/httpd/trunk/docs/manual/mod/mod_ssl.xml>
- **Retrieved:** 2026-07-26
- **Licence:** Apache-2.0
- **Licence evidence URL:** <https://raw.githubusercontent.com/apache/httpd/trunk/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** ""License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** descriptive / dev
- **Fixture file:** `fixtures/original/httpd-mod-ssl-overview.md`

## sqlite-cli-description

- **Title:** SQLite CLI: distinguishing the library from the command-line shell
- **Organisation:** SQLite Development Team
- **Source URL:** <https://sqlite.org/cli.html>
- **Retrieved:** 2026-07-26
- **Licence:** Public Domain
- **Licence evidence URL:** <https://sqlite.org/copyright.html> (licence-page)
- **Licence statement (verbatim):** "All of the code and documentation in SQLite has been dedicated to the public domain by the authors."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** descriptive / heldout
- **Fixture file:** `fixtures/original/sqlite-cli-description.md`

## django-settings-configuration

- **Title:** Django settings: module-level configuration and DJANGO_SETTINGS_MODULE
- **Organisation:** Django Software Foundation
- **Source URL:** <https://raw.githubusercontent.com/django/django/main/docs/topics/settings.txt>
- **Retrieved:** 2026-07-26
- **Licence:** BSD-3-Clause
- **Licence evidence URL:** <https://raw.githubusercontent.com/django/django/main/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:"
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** api-configuration / dev
- **Fixture file:** `fixtures/original/django-settings-configuration.md`

## httpd-mod-ssl-directive-config

- **Title:** Apache mod_ssl: SSLEngine and SSLFIPS directive reference
- **Organisation:** The Apache Software Foundation
- **Source URL:** <https://raw.githubusercontent.com/apache/httpd/trunk/docs/manual/mod/mod_ssl.xml>
- **Retrieved:** 2026-07-26
- **Licence:** Apache-2.0
- **Licence evidence URL:** <https://raw.githubusercontent.com/apache/httpd/trunk/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** ""License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** api-configuration / heldout
- **Fixture file:** `fixtures/original/httpd-mod-ssl-directive-config.md`

## curl-url-option-reference

- **Title:** curl --url option: scheme guessing and URL-list files
- **Organisation:** curl project (Daniel Stenberg and contributors)
- **Source URL:** <https://raw.githubusercontent.com/curl/curl/master/docs/cmdline-opts/url.md>
- **Retrieved:** 2026-07-26
- **Licence:** curl licence
- **Licence evidence URL:** <https://raw.githubusercontent.com/curl/curl/master/COPYING> (repository-licence-file)
- **Licence statement (verbatim):** "Permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** cli-reference / dev
- **Fixture file:** `fixtures/original/curl-url-option-reference.md`

## sqlite-cli-dot-commands

- **Title:** SQLite CLI: creating a database and terminating a session
- **Organisation:** SQLite Development Team
- **Source URL:** <https://sqlite.org/cli.html>
- **Retrieved:** 2026-07-26
- **Licence:** Public Domain
- **Licence evidence URL:** <https://sqlite.org/copyright.html> (licence-page)
- **Licence statement (verbatim):** "All of the code and documentation in SQLite has been dedicated to the public domain by the authors."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** cli-reference / dev
- **Fixture file:** `fixtures/original/sqlite-cli-dot-commands.md`

## zephyr-dependency-table

- **Title:** Zephyr Getting Started: minimum dependency versions and apt install
- **Organisation:** Zephyr Project (Linux Foundation)
- **Source URL:** <https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/doc/develop/getting_started/index.rst>
- **Retrieved:** 2026-07-26
- **Licence:** Apache-2.0
- **Licence evidence URL:** <https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** ""License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** structured-content / dev
- **Fixture file:** `fixtures/original/zephyr-dependency-table.md`

## llvm-standalone-build-table

- **Title:** LLVM: stand-alone build requirements per sub-project
- **Organisation:** LLVM Project
- **Source URL:** <https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/docs/GettingStarted.md>
- **Retrieved:** 2026-07-26
- **Licence:** Apache-2.0 WITH LLVM-exception
- **Licence evidence URL:** <https://raw.githubusercontent.com/llvm/llvm-project/main/LICENSE.TXT> (repository-licence-file)
- **Licence statement (verbatim):** "The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:"
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** structured-content / dev
- **Fixture file:** `fixtures/original/llvm-standalone-build-table.md`

## sqlite-pragma-hard-negative

- **Title:** SQLite PRAGMA index: an unbroken run of PRAGMA identifiers
- **Organisation:** SQLite Development Team
- **Source URL:** <https://sqlite.org/pragma.html>
- **Retrieved:** 2026-07-26
- **Licence:** Public Domain
- **Licence evidence URL:** <https://sqlite.org/copyright.html> (licence-page)
- **Licence statement (verbatim):** "All of the code and documentation in SQLite has been dedicated to the public domain by the authors."
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** hard-negative / dev
- **Fixture file:** `fixtures/original/sqlite-pragma-hard-negative.md`

## node-cli-hard-negative

- **Title:** Node.js CLI: program entry point resolution rules
- **Organisation:** OpenJS Foundation (Node.js)
- **Source URL:** <https://raw.githubusercontent.com/nodejs/node/main/doc/api/cli.md>
- **Retrieved:** 2026-07-26
- **Licence:** MIT
- **Licence evidence URL:** <https://raw.githubusercontent.com/nodejs/node/main/LICENSE> (repository-licence-file)
- **Licence statement (verbatim):** "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction"
- **Reproduction class:** excerpted
- **Derivative licence (this repository):** MIT (this repository)
- **Category / split:** hard-negative / heldout
- **Fixture file:** `fixtures/original/node-cli-hard-negative.md`

---

## Summary of upstream licences used

| Licence                                               | Fixtures                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Public Domain (SQLite)                                | sqlite-vacuum-space-reclaim, sqlite-cli-description, sqlite-cli-dot-commands, sqlite-pragma-hard-negative |
| PostgreSQL Licence                                    | postgres-vacuum-overview                                                                                  |
| Apache-2.0                                            | zephyr-dependency-setup, zephyr-dependency-table, httpd-mod-ssl-overview, httpd-mod-ssl-directive-config  |
| Apache-2.0 WITH LLVM-exception                        | llvm-getting-started-build, llvm-standalone-build-table                                                   |
| CC-BY-4.0                                             | k8s-debug-pod-troubleshooting, k8s-audit-log-troubleshooting                                              |
| Public Domain (U.S. Government Work, 17 U.S.C. § 105) | osha-lockout-tagout-warning, osha-ppe-requirements                                                        |
| BSD-3-Clause                                          | django-settings-configuration                                                                             |
| curl licence                                          | curl-url-option-reference                                                                                 |
| MIT                                                   | node-cli-hard-negative                                                                                    |

No GPL, LGPL, AGPL, GFDL, CC-BY-SA, or "all rights reserved" material is included in this corpus.
CC-BY-4.0 sources retain their attribution requirement in this repository's own compliant
counterparts (`derivativeLicence: "CC-BY-4.0"`); every other, permissive/public-domain source is
re-licensed here as `derivativeLicence: "MIT (this repository)"`.
