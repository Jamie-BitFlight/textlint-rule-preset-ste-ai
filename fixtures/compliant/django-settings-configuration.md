<!-- fixture: django-settings-configuration (rewritten counterpart) | source: https://raw.githubusercontent.com/django/django/main/docs/topics/settings.txt | licence: BSD-3-Clause | derivative-licence: MIT (this repository) | note: prose simplified by this project; literals unchanged -->

===============
Django settings
===============

A Django settings file contains all the configuration of your Django
installation. This document explains how settings work and which settings are
available.

The basics
==========

A settings file is just a Python module with module-level variables.

Here are a couple of example settings::

    ALLOWED_HOSTS = ["www.example.com"]
    DEBUG = False
    DEFAULT_FROM_EMAIL = "webmaster@example.com"

.. note::

    If you set :setting:`DEBUG` to ``False``, you also need to properly set
    the :setting:`ALLOWED_HOSTS` setting.

Because a settings file is a Python module, the following apply:

* It does not allow for Python syntax errors.
* It can assign settings dynamically using normal Python syntax.
  For example.

      MY_SETTING = [str(i) for i in range(30)]

* It can import values from other settings files.

.. _django-settings-module:

Designating the settings
========================

.. envvar:: DJANGO_SETTINGS_MODULE

When you use Django, you have to tell it which settings you are using. Do this
by using an environment variable, :envvar:`DJANGO_SETTINGS_MODULE`.
