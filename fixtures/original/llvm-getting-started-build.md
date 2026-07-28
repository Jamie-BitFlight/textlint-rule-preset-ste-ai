<!-- fixture: llvm-getting-started-build | source: https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/docs/GettingStarted.md | licence: Apache-2.0 WITH LLVM-exception | retrieved: 2026-07-26 | excerpt: verbatim -->

## Getting the Source Code and Building LLVM

1. Check out LLVM (including subprojects like Clang):

   * `git clone https://github.com/llvm/llvm-project.git`
   * Or, on Windows:

     `git clone --config core.autocrlf=false https://github.com/llvm/llvm-project.git`
   * To save storage and speed up the checkout time, you may want to do a
     [shallow clone](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---depthltdepthgt).
     For example, to get the latest revision of the LLVM project, use

     `git clone --depth 1 https://github.com/llvm/llvm-project.git`

   * You are likely not interested in the user branches in the repo (used for
     stacked pull requests and reverts), you can filter them from your
     `git fetch` (or `git pull`) with this configuration:

   ```console
   git config --add remote.origin.fetch '^refs/heads/users/*'
   git config --add remote.origin.fetch '^refs/heads/revert-*'
   ```
1. Configure and build LLVM and Clang:

   * `cd llvm-project`
   * `cmake -S llvm -B build -G <generator> [options]`
