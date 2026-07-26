<!-- fixture: httpd-mod-ssl-overview (rewritten counterpart) | source: https://raw.githubusercontent.com/apache/httpd/trunk/docs/manual/mod/mod_ssl.xml | licence: Apache-2.0 | derivative-licence: MIT (this repository) | note: prose simplified by this project; literals unchanged -->

This module provides SSL v3 and TLS v1.x support for the Apache
HTTP Server. SSL v2 is no longer supported.

This module relies on OpenSSL to provide the cryptographic engine.

Further details, discussion, and examples are provided in the
SSL documentation.

This module can be configured to provide several items of SSL information
as more environment variables. These are added to the Server Side Includes (SSI) and Common Gateway Interface (CGI) namespace. Except for
HTTPS and SSL_TLS_SNI which are always defined, this
information is not provided by default for performance reasons. (See
SSLOptions StdEnvVars, below)
The generated variables
are listed in the table below. For backward compatibility the information can
be made available under different names, too. Look in the Compatibility
chapter for details on the
compatibility variables.
