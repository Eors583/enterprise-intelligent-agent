# Operations scheduling samples

`enterprise-agent.crontab.example` is a fail-visible scheduling reference for a Linux host that already has PowerShell, Docker access, repository scripts, and protected directories. It is not installed automatically and contains no credentials.

Windows deployments should continue to use `Register-EnterpriseWindowsOperations.ps1`, which creates separate backup, isolated restore, and monitoring tasks. Linux hosts can translate the reference into `systemd` timers or a controlled scheduler. Kubernetes deployments should package the same one-shot operations into a pinned, signed image and connect directly to managed PostgreSQL/object-storage APIs; mounting a host Docker socket into a CronJob is not an accepted production design.

Before enabling either scheduler:

1. validate `infra/config/enterprise-continuity.production.example.json` after replacing placeholders;
2. inject alert, database, object-store, and KMS credentials from the host secret manager;
3. prove the service account can write only the intended backup, monitoring, and textfile directories;
4. run one backup, isolated restore, metric export, and webhook test manually;
5. capture a disaster-recovery report and record the boundaries that remain unverified.
