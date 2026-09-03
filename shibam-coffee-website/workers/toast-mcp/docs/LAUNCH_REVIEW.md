# Launch review checklist

This repository includes draft public privacy, terms, security, support, and deletion pages. Code generation cannot satisfy the requirement for independent review. Before any public launch, obtain and record written approval from reviewers who were not the implementer:

- Legal/privacy reviewer: Toast terms, credential custody, privacy notice, terms, subprocessors, retention, deletion, jurisdiction, and contact details.
- Security reviewer: OAuth/DCR/CIMD behavior, Auth0 tenant policy, cryptography/key rotation, D1 tenant isolation, webhook raw-body verification, SSRF and host/origin controls, R2 lifecycle, queue/DLQ, error redaction, rate limits, and dependency audit.
- Toast approval: Standard API hosted-use interpretation and, separately, partner certification.
- Operations owner: production/staging isolation, backups, alerts, incident response, key access, Resend domain, and support mailbox ownership.

Do not remove the "independent service" disclaimer or claim Toast partnership before approval. Do not enable `TOAST_BYO_MODE` or `TOAST_PARTNER_MODE` until its corresponding evidence is attached to the release record.
