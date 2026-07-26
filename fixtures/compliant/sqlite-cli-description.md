<!-- fixture: sqlite-cli-description (rewritten counterpart) | source: https://sqlite.org/cli.html | licence: Public Domain | derivative-licence: MIT (this repository) | note: prose simplified by this project; literals unchanged -->

The SQLite library is code that implements an SQL database engine. The "sqlite3" command-line program or "CLI" is an application that accepts user input and passes it down into the SQLite library for evaluation. Understand that these are two different things. When somebody says "SQLite" or "sqlite3" they might be referring to either the SQLite library itself, or the CLI. The CLI provides a human interface to the library. You will often need to use context to figure out exactly which of these two things the speaker is referring to.

This document is about the CLI, not the underlying SQLite library.

The sqlite3 program is written by and for the core SQLite developers and is the officially supported way to accessing SQLite database files interactively. However, some users might prefer a Graphical User Interface (GUI). Several such programs are available from third-parties.
