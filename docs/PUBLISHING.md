# Publishing the normal Community plugins installation

Repository: https://github.com/ama156/native-vault-sync

Plugin identity:

- ID: `vault-sync-bridge`
- Name: `Vault Sync Bridge`
- Author: `ama156`
- Desktop only; minimum app version `1.8.7`
- Explicit adapters: `1.8.7` and `1.15.1`; other versions stay inactive

The root `manifest.json` is the directory's source of release metadata. The GitHub release tag must be exactly `0.1.0`, matching its version. Attach `main.js` and `manifest.json` as individual release assets, not only inside a ZIP. The same release can hold the Linux server archives, source archive, and `SHA256SUMS`.

## Directory submission

Follow the official process: https://docs.obsidian.md/plugins/releasing/submit-plugin

1. Sign into https://community.obsidian.md using the maintainer's Obsidian account.
2. Link the GitHub account that owns `ama156/native-vault-sync`. The account owner must approve the linking/authorization step.
3. Add the repository as a plugin entry. Use the root manifest and the already published matching release.
4. Disclose the private-server account requirement, network use, embedded loopback listener, main-process connection adapter, private Sync APIs, and debugger/Developer Tools interaction. These are described in the README.
5. Resolve scanner/reviewer feedback and publish when eligible.

Suggested listing summary: “Connect native Sync to a personal compatible server through an embedded connection adapter.”

There is no guarantee that a private-API/native Sync adapter will be accepted. The maintainer must monitor compatibility with new desktop releases and qualify each new adapter before changing the supported version set.

## Installation status

A GitHub release is available independently of directory approval. The plugin becomes searchable/installable under **Settings → Community plugins → Browse** only after directory publication. Developer sideloading or BRAT is not the normal-browser installation requested for the final product.

Do not describe the plugin as already listed until its public entry is actually visible. The release README and compatibility matrix must retain experimental status and list remaining platform/deployment limitations.
