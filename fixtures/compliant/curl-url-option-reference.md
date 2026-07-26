<!-- fixture: curl-url-option-reference (rewritten counterpart) | source: https://raw.githubusercontent.com/curl/curl/master/docs/cmdline-opts/url.md | licence: curl licence | derivative-licence: MIT (this repository) | note: prose simplified by this project; literals unchanged -->

---
c: Copyright (C) Daniel Stenberg, <daniel@haxx.se>, et al.
SPDX-License-Identifier: curl
Long: url
Arg: <url/file>
Help: URL(s) to work with
Category: curl
Added: 7.5
Multi: append
See-also:
  - next
  - config
  - path-as-is
  - disallow-username-in-url
Example:
  - --url $URL
  - --url @file
---

# `--url`

Specify a URL to fetch or send data to.

If the given URL is missing a scheme (such as `http://` or `ftp://` etc) curl
guesses which scheme to use based on the hostname. If the outermost subdomain
name matches one of the following case insensitively, that protocol is used:

- DICT
- FTP
- IMAP
- LDAP
- POP3
- SMTP

Otherwise, curl assumes HTTP. Scheme guessing can be avoided by
providing a full URL including the scheme, or disabled by setting a default
protocol, see --proto-default for details.

To control where the contents of a retrieved URL is written instead of the
default stdout, use the --output or the --remote-name options. When retrieving
multiple URLs in a single invoke, each provided URL needs its own dedicated
destination option unless --remote-name-all is used.

On Windows, `file://` accesses can be converted to network accesses by the
operating system.

Starting in curl 8.13.0, curl can be told to download URLs provided in a text
file, one URL per line. It is done with `--url @filename`: so instead of a
URL, you specify a filename prefixed with the `@` symbol. It can be told to
load the list of URLs from stdin by providing an argument like `@-`.
