# Security Policy

## Reporting a vulnerability

Found a security issue? Please report it **privately**:

- Open a private GitHub security advisory (Security → Advisories → Report a vulnerability), or
- Email the maintainer.

Please do **not** open a public issue for security problems. We aim to acknowledge
reports within a few business days.

## Supported versions

The latest published version on npm receives security fixes.

## Scope

This CLI scaffolds projects, checks your environment, and generates migrations.
It runs locally, writes only to the directory you point it at, and ships no
telemetry. Keep any secrets it reads (`.env`, connection strings) out of source
control.
