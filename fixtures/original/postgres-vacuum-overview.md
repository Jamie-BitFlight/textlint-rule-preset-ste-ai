<!-- fixture: postgres-vacuum-overview | source: https://raw.githubusercontent.com/postgres/postgres/master/doc/src/sgml/ref/vacuum.sgml | licence: PostgreSQL Licence | retrieved: 2026-07-26 | excerpt: verbatim -->

VACUUM reclaims storage occupied by dead tuples. In normal PostgreSQL operation, tuples that are deleted or obsoleted by an update are not physically removed from their table; they remain present until a VACUUM is done. Therefore it's necessary to do VACUUM periodically, especially on frequently-updated tables.

Plain VACUUM (without FULL) simply reclaims space and makes it available for re-use. This form of the command can operate in parallel with normal reading and writing of the table, as an exclusive lock is not obtained. However, extra space is not returned to the operating system (in most cases); it's just kept available for re-use within the same table. It also allows us to leverage multiple CPUs in order to process indexes.
