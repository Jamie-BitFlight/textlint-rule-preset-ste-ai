<!-- fixture: llvm-standalone-build-table (rewritten counterpart) | source: https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/docs/GettingStarted.md | licence: Apache-2.0 WITH LLVM-exception | derivative-licence: MIT (this repository) | note: prose simplified by this project; literals unchanged -->

Notice that:

* The stand-alone build needs to happen in a folder that is not the
  original folder where LLVM was built
  (`$builddir!=$builddir_subproj`).
* `LLVM_ROOT` should point to the prefix of your llvm installation.
  For example, if llvm is installed into `/usr/bin` and
  `/usr/lib64`, you should pass `-DLLVM_ROOT=/usr/`.
* Both the `LLVM_ROOT` and `LLVM_EXTERNAL_LIT` options are
  required to do stand-alone builds for all sub-projects.  More
  required options for each sub-project can be found in the table
  below.

The `check-$subproj` and `install` build targets are supported for the
sub-projects listed in the table below.

| Sub-Project | Required Sub-Directories | Required CMake Options |
| --- | --- | --- |
| llvm | llvm, cmake, third-party | LLVM_INSTALL_UTILS=ON |
| clang | clang, cmake | CLANG_INCLUDE_TESTS=ON (Required for check-clang only) |
| lld | lld, cmake | |

Example of building stand-alone `clang`:

```console
#!/bin/sh

build_llvm=`pwd`/build-llvm
build_clang=`pwd`/build-clang
installprefix=`pwd`/install
llvm=`pwd`/llvm-project
mkdir -p $build_llvm
mkdir -p $installprefix

cmake -G Ninja -S $llvm/llvm -B $build_llvm \
      -DLLVM_INSTALL_UTILS=ON \
      -DCMAKE_INSTALL_PREFIX=$installprefix \
      -DCMAKE_BUILD_TYPE=Release

ninja -C $build_llvm install

cmake -G Ninja -S $llvm/clang -B $build_clang \
      -DLLVM_EXTERNAL_LIT=$build_llvm/utils/lit \
      -DLLVM_ROOT=$installprefix

ninja -C $build_clang
```
