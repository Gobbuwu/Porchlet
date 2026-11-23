# 0011. Secure-coding standard: OWASP ASVS 5.0.0, Level 2

- Status: Accepted (2026-11-23, by Gobbu)

## Context

The project rules (NIST SSDF PW.5.1) require a named secure-coding standard. Porchlet stores other people's files and logins, which is the kind of app ASVS Level 2 is meant for.

## Decision

Follow the [OWASP Application Security Verification Standard](https://asvs.owasp.org/) version **5.0.0**, Level 2. Checked 2026-11-23 on the [ASVS releases page](https://github.com/OWASP/ASVS/releases), which says "The latest stable release is v5.0.0"; the newer "Bleeding Edge" build is marked for "testing and preview purposes only".

## Consequences

- Each milestone doc maps its feature's threat model to the ASVS chapters it touches (M1: authentication and session management).
- A move to a later ASVS version gets a new ADR.
