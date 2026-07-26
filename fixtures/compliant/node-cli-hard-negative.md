<!-- fixture: node-cli-hard-negative (rewritten counterpart) | source: https://raw.githubusercontent.com/nodejs/node/main/doc/api/cli.md | licence: MIT | derivative-licence: MIT (this repository) | note: prose simplified by this project; literals unchanged -->

## Program entry point

The program entry point is a specifier-like string. If the string is not an
absolute path, it is resolved as a relative path from the current working
directory. That entry point string is then resolved as if it has been requested
by `require()` from the current working directory. If no corresponding file
is found, an error is thrown.

By default, the resolved path is also loaded as if it has been requested by `require()`.
However, unless one of the conditions below apply, it is instead loaded as if it has been requested
by `import()`:

* The program was started with a command-line flag that forces the entry
  point to be loaded with ECMAScript module loader, such as `--import`.
* The file has an `.mjs`, `.mts` or `.wasm` extension.
* The file does not have a `.cjs` extension, and the nearest parent
  `package.json` file contains a top-level [`"type"`][] field with a value of
  `"module"`.

See [module resolution and loading][] for more details.
