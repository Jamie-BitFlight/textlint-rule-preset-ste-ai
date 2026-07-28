<!-- fixture: httpd-mod-ssl-directive-config | source: https://raw.githubusercontent.com/apache/httpd/trunk/docs/manual/mod/mod_ssl.xml | licence: Apache-2.0 | retrieved: 2026-07-26 | excerpt: verbatim -->

SSLEngine
SSL Engine Operation Switch
Syntax: SSLEngine on|off
Default: SSLEngine off
Context: server config, virtual host

Support for the "optional" argument was removed in 2.4.64. It enabled
RFC 2817 (TLS Upgrade) support.

This directive toggles the usage of the SSL/TLS Protocol Engine. This
is should be used inside a VirtualHost section to enable SSL/TLS for a
that virtual host. By default the SSL/TLS Protocol Engine is
disabled for both the main server and all configured virtual hosts.

Example:

<VirtualHost _default_:443>
SSLEngine on
#...
</VirtualHost>

SSLFIPS
SSL FIPS mode Switch
Syntax: SSLFIPS on|off
Default: SSLFIPS off
Context: server config

This directive toggles the usage of the SSL library FIPS_mode flag.
It must be set in the global server context and cannot be configured
with conflicting settings (SSLFIPS on followed by SSLFIPS off or
similar). The mode applies to all SSL library operations.

If httpd was compiled against an SSL library which did not support
the FIPS_mode flag, SSLFIPS on will fail. Refer to the
FIPS 140-2 Security Policy document of the SSL provider library for
specific requirements to use mod_ssl in a FIPS 140-2 approved mode
of operation; note that mod_ssl itself is not validated, but may be
described as using FIPS 140-2 validated cryptographic module, when
all components are assembled and operated under the guidelines imposed
by the applicable Security Policy.
