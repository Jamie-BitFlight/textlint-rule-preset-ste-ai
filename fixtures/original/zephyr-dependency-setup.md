<!-- fixture: zephyr-dependency-setup | source: https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/doc/develop/getting_started/index.rst | licence: Apache-2.0 | retrieved: 2026-07-26 | excerpt: verbatim -->

.. _getting_started:

Getting Started Guide
#####################

Follow this guide to:

- Set up a command-line Zephyr development environment on Ubuntu, macOS, or
  Windows (instructions for other Linux distributions are discussed in
  :ref:`installation_linux`)
- Get the source code
- Build, flash, and run a sample application

.. _host_setup:

Select and Update OS
********************

Click the operating system you are using.

.. tabs::

   .. group-tab:: Ubuntu

      This guide covers Ubuntu version 24.04 LTS and later.
      If you are using a different Linux distribution see :ref:`installation_linux`.

      .. code-block:: bash

         sudo apt update
         sudo apt upgrade

   .. group-tab:: macOS

      Select :menuselection:`System Settings --> General --> Software Update`
      and install any available updates. See `this Apple support topic
      <https://support.apple.com/en-us/HT201541>`_ for more details.

      .. note::

         x86-64 macOS is not supported.

   .. group-tab:: Windows

      Select :menuselection:`Start --> Settings --> Update & Security --> Windows Update`.
