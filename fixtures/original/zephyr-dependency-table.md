<!-- fixture: zephyr-dependency-table | source: https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/doc/develop/getting_started/index.rst | licence: Apache-2.0 | retrieved: 2026-07-26 | excerpt: verbatim -->

Install dependencies
********************

Next, install the host tools Zephyr needs to configure and build applications.
The instructions below use the recommended package manager for each operating
system so the tools are available from your terminal.

The current minimum required versions for the main dependencies are:

.. list-table::
   :header-rows: 1

   * - Tool
     - Min. Version

   * - `CMake <https://cmake.org/>`_
     - 3.20.5

   * - `Python <https://www.python.org/>`_
     - 3.12

   * - `Devicetree compiler <https://www.devicetree.org/>`_
     - 1.4.6

.. note::

   Python 3.12 is strongly recommended. Using a newer Python release may fail on some systems, for
   example when installing the required packages on Windows.

.. tabs::

   .. group-tab:: Ubuntu

      .. _install_dependencies_ubuntu:

      #. Use ``apt`` to install the required dependencies:

         .. code-block:: bash

            sudo apt install --no-install-recommends git cmake ninja-build gperf \
              ccache dfu-util device-tree-compiler wget python3-dev python3-venv python3-tk \
              xz-utils file make gcc gcc-multilib g++-multilib libsdl2-dev libmagic1
