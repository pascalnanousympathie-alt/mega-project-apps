# CI/CD policy

Pull requests and pushes to `main` run tests, secret scanning, dependency audit, Python compile checks, diff checks, and version validation. They do not deploy.

Production gating is manual-only through the `ACEP Production Gate` workflow and the protected `production` environment. An external deployment step must be added explicitly after the required production-provider credentials and approvals exist; this repository does not auto-deploy from CI.

The CI gate never prints credential values. Release signing remains optional and reports only `SET` or `ABSENT`.
