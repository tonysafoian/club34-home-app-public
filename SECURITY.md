# Security Policy

## Supported Versions

Household OS receives security patches on the latest major/minor release.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of smart homes and private residential estates extremely seriously. If you discover a vulnerability or security flaw in Household OS, please report it responsibly so we can remediate it before public disclosure.

### How to Report

1. **GitHub Private Vulnerability Reporting (Preferred)**:
   Navigate to the [Security Advisory tab](https://github.com/tonysafoian/club34-home-app-public/security/advisories) on GitHub and click **"Report a vulnerability"**. This opens an encrypted, private thread directly with the maintainers.

2. **Direct Email**:
   If you prefer email or cannot use GitHub advisories, send an encrypted or plaintext report to:
   **`tony@safoian.com`** with the subject line `[SECURITY] Household OS Vulnerability Report`.

### What to Include

Please provide:
- A description of the issue and potential impact (e.g. authentication bypass, privilege escalation, SSRF, remote code execution).
- Step-by-step instructions or proof-of-concept (PoC) to reproduce the vulnerability.
- Affected components (e.g. backend API route, Home Assistant bridge, WebSocket hub, database migration).
- Any suggested mitigations or patches if available.

### Response & Disclosure Process

- **Acknowledgment**: We aim to acknowledge receipt of security reports within **48 hours**.
- **Investigation**: We will triage and assess the severity using CVSS v3 standards.
- **Remediation**: Patches will be developed in a private security fork.
- **Coordination**: We will coordinate with the reporter on a timeline before publishing a security advisory and release notes. Credit will be given to the reporter (unless anonymity is requested).

## Security Architecture & Defenses

Household OS is engineered with defense-in-depth principles:
- **Local-First IoT**: Hardware telemetry stays on your local network. No third-party cloud data broker is required.
- **Outbound SSRF Guards**: All user-configured outbound endpoints (e.g. Home Assistant URLs) are validated through strict SSRF filters blocking RFC1918 private IP ranges, loopback (`127.0.0.1`), link-local, and cloud metadata (`169.254.169.254`).
- **Gitleaks CI Enforcement**: Automated pre-commit hooks and GitHub Actions CI actively scan every commit for secrets, API tokens, and confidential material.
- **Role-Based Access Control (RBAC)**: Strict separation of privileges across `admin`, `family`, `guest`, and `staff` access levels.
