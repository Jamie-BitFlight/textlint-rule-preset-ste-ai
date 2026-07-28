#!/usr/bin/env node
// Plain Node 22 ESM, no dependencies.
// Fetches raw bytes for each source descriptor, caches them under .cache/sources/<key>,
// and writes fixtures/provenance.lock.json recording real HTTP status, sha256, timestamp.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CACHE_DIR = join(REPO_ROOT, '.cache', 'sources');
const LOCK_PATH = join(REPO_ROOT, 'fixtures', 'provenance.lock.json');

/** @type {{key: string, url: string}[]} */
const SOURCES = [
  // SQLite docs — public domain
  { key: 'sqlite-copyright', url: 'https://sqlite.org/copyright.html' },
  { key: 'sqlite-pragma', url: 'https://sqlite.org/pragma.html' },
  { key: 'sqlite-lang-vacuum', url: 'https://sqlite.org/lang_vacuum.html' },
  { key: 'sqlite-cli', url: 'https://sqlite.org/cli.html' },

  // curl — curl licence (MIT/X derivate)
  { key: 'curl-license-raw', url: 'https://raw.githubusercontent.com/curl/curl/master/COPYING' },
  {
    key: 'curl-cmdline-url-raw',
    url: 'https://raw.githubusercontent.com/curl/curl/master/docs/cmdline-opts/url.md',
  },
  {
    key: 'curl-cmdline-retry-raw',
    url: 'https://raw.githubusercontent.com/curl/curl/master/docs/cmdline-opts/retry.md',
  },

  // PostgreSQL docs — PostgreSQL Licence
  {
    key: 'postgres-license-raw',
    url: 'https://raw.githubusercontent.com/postgres/postgres/master/COPYRIGHT',
  },
  {
    key: 'postgres-vacuum-sgml-raw',
    url: 'https://raw.githubusercontent.com/postgres/postgres/master/doc/src/sgml/ref/vacuum.sgml',
  },

  // Apache HTTP Server docs — Apache-2.0
  { key: 'httpd-license-raw', url: 'https://raw.githubusercontent.com/apache/httpd/trunk/LICENSE' },
  {
    key: 'httpd-mod-ssl-xml-raw',
    url: 'https://raw.githubusercontent.com/apache/httpd/trunk/docs/manual/mod/mod_ssl.xml',
  },

  // Zephyr RTOS docs — Apache-2.0
  {
    key: 'zephyr-license-raw',
    url: 'https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/LICENSE',
  },
  {
    key: 'zephyr-getting-started-raw',
    url: 'https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/doc/develop/getting_started/index.rst',
  },

  // Kubernetes website — CC-BY-4.0
  {
    key: 'k8s-website-license-raw',
    url: 'https://raw.githubusercontent.com/kubernetes/website/main/LICENSE',
  },
  {
    key: 'k8s-debug-pods-raw',
    url: 'https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/debug/debug-application/debug-pods.md',
  },
  {
    key: 'k8s-audit-raw',
    url: 'https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/debug/debug-cluster/audit.md',
  },

  // Django docs — BSD-3-Clause
  {
    key: 'django-license-raw',
    url: 'https://raw.githubusercontent.com/django/django/main/LICENSE',
  },
  {
    key: 'django-settings-doc-raw',
    url: 'https://raw.githubusercontent.com/django/django/main/docs/topics/settings.txt',
  },

  // Node.js docs — MIT
  { key: 'node-license-raw', url: 'https://raw.githubusercontent.com/nodejs/node/main/LICENSE' },
  {
    key: 'node-cli-doc-raw',
    url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/cli.md',
  },

  // OpenSSL docs — Apache-2.0
  {
    key: 'openssl-license-raw',
    url: 'https://raw.githubusercontent.com/openssl/openssl/master/LICENSE.txt',
  },

  // LLVM/Clang docs — Apache-2.0 WITH LLVM-exception
  {
    key: 'llvm-license-raw',
    url: 'https://raw.githubusercontent.com/llvm/llvm-project/main/LICENSE.TXT',
  },
  {
    key: 'llvm-getting-started-raw',
    url: 'https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/docs/GettingStarted.md',
  },

  // US federal government — public domain — safety (17 U.S.C. § 105: no copyright protection
  // for works of the United States Government)
  {
    key: 'osha-1910-147-lockout-tagout',
    url: 'https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.147',
  },
  {
    key: 'osha-1910-132-ppe',
    url: 'https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.132',
  },
  {
    key: 'osha-1910-212-machine-guarding',
    url: 'https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.212',
  },
  {
    key: 'copyright-gov-title17-section105',
    url: 'https://www.copyright.gov/title17/92chap1.html',
  },
  { key: 'usa-gov-government-copyright', url: 'https://www.usa.gov/government-copyright' },
  { key: 'nist-licensing', url: 'https://www.nist.gov/director/licensing' },
];

/**
 * @param {string} url
 */
async function fetchOne(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'textlint-ASD-ai-fixture-fetcher/1.0 (+https://github.com/)' },
    redirect: 'follow',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });

  /** @type {Record<string, any>} */
  const records = {};
  let anyFailed = false;

  for (const { key, url } of SOURCES) {
    const fetchedAt = new Date().toISOString();
    try {
      const { res, buf } = await fetchOne(url);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const contentType = res.headers.get('content-type') ?? undefined;
      const httpStatus = res.status;

      await writeFile(join(CACHE_DIR, key), buf);

      records[key] = {
        url,
        httpStatus,
        fetchedAt,
        sha256,
        bytes: buf.byteLength,
        ...(contentType ? { contentType } : {}),
      };

      const ok = httpStatus === 200;
      if (!ok) anyFailed = true;
      console.log(
        `[${ok ? 'OK' : 'FAIL'}] ${key} <- ${url} status=${httpStatus} bytes=${buf.byteLength} sha256=${sha256.slice(0, 12)}...`,
      );
    } catch (err) {
      anyFailed = true;
      records[key] = {
        url,
        httpStatus: 0,
        fetchedAt,
        sha256: '',
        bytes: 0,
      };
      console.log(
        `[FAIL] ${key} <- ${url} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const lock = {
    generatedAt: new Date().toISOString(),
    records,
  };

  await mkdir(dirname(LOCK_PATH), { recursive: true });
  await writeFile(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');

  const successCount = Object.values(records).filter((r) => r.httpStatus === 200).length;
  console.log(`\n${successCount}/${SOURCES.length} sources fetched with HTTP 200.`);

  if (anyFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
