<!-- fixture: sqlite-cli-dot-commands | source: https://sqlite.org/cli.html | licence: Public Domain | retrieved: 2026-07-26 | excerpt: verbatim -->

For example, to create a new SQLite database named "ex1.db"
with a single table named "tbl1", you might do this:

$ sqlite3 ex1.db
SQLite version 3.36.0 2021-06-18 18:36:39
Enter ".help" for usage hints.
sqlite> create table tbl1(one text, two int);
sqlite> insert into tbl1 values('hello!',10),('goodbye',20);
sqlite> select * from tbl1;
┌───────────┬─────┐
│    one    │ two │
├───────────┼─────┤
│ 'hello!'  │ 10  │
│ 'goodbye' │ 20  │
└───────────┴─────┘
sqlite>

Terminate the sqlite3 program by typing your system
End-Of-File character (usually a Control-D).  Use the interrupt
character (usually a Control-C) to stop a long-running SQL statement.

Make sure you type a semicolon at the end of each SQL command!
The sqlite3 program looks for a semicolon to know when your SQL command is
complete.  If you omit the semicolon, sqlite3 will give you a
continuation prompt and wait for you to enter more text to
complete the SQL command.  This feature allows you to
enter SQL commands that span multiple lines.
