# iOS 1.15.1 source investigation — 17 November 2026

The actual exported iPhone `app.js` has now been supplied and inspected privately. Its SHA-256 is `ffd620f9ee985cc4eb93ab25ba5871a33c9460b68035f2d74c8d4ddc2d43ef91`. It differs from the desktop 1.15.1 archive. The supplied `cm-addons.js` is editor support code and did not expose an additional Sync/account interface in this inspection.

**Historical outcome at the first inspection: native mobile account integration was blocked.** This is a finding about the inspected interfaces, not proof that every possible private hook is impossible. No mobile Sync activation, account mutation, real HTTP request, or app launch was performed as part of these source checks.

**Update — plugin 0.1.2:** A strictly fingerprinted, synchronous fresh-account capture and per-instance custom-session binding now pass the isolated native-engine proof. See [current mobile implementation and installation](MOBILE-STATUS.md) and [proof report](ios-sync-proof.json). The findings below describe the earlier investigation; actual iPhone qualification remains pending. No proprietary engine code is redistributed.

## What the source establishes

The app is wrapped in an immediately invoked function. Its account singleton (`be` in this fingerprint) is constructed inside that closure. The Obsidian SDK export table has no direct export of that singleton or its class. Looking for an `account` property on the exposed app object therefore cannot by itself locate this binding.

The native community-plugin loader calls `window.eval` to create a module function. That is global-scope evaluation: plugin code does not inherit the account closure simply because the loader is part of the app. A development harness that extracts functions and explicitly returns an account facade can exercise them, but that facade is not a usable integration present in the shipped app.

Both `_sync()` and `asyncGetServer()` require the private account token. The transport connector separately rejects a custom hostname outside `.obsidian.md`. Replacing `getHost()` or the transport connection bootstrap addresses only the socket restriction, not the account dependency.

The account object reads the `obsidian-account` localStorage item during construction. Later storage writes do not refresh its in-memory fields. Native login and account refresh update that exact instance, but their HTTP helper uses an early-captured `fetch` and the fixed official account origin. Merely obtaining a custom token through `requestUrl` in another plugin does not perform native login.

### Why the tempting workarounds do not establish a working adapter

| Attempt | Observed/verified result |
| --- | --- |
| Change `getHost` | The native connector still applies its hostname restriction |
| Replace `connect` | Native file-engine/account checks remain |
| Store a plugin-owned token | The native account singleton does not read that plugin state |
| Write native account storage after startup | The existing account instance remains unchanged |
| Restart with a custom token in native account storage | The account instance reads it, but native refresh would send it to the official account origin and an invalid-session response clears it |
| Replace global fetch after app initialization | Native account calls continue using the captured reference |
| Refer to `be` from plugin code | The original plugin loader evaluates that code outside the app's account closure |
| Require the account directly from the SDK | No direct account object/class export was found |
| Depend on an existing official login | Violates the agreed custom-account design; not used |
| Replace/copy the complete file engine or alter app resources | Outside the agreed plan; not used |

The persisted-token/refresh case was tested only with synthetic credentials and mocked HTTP. No actual credential was sent to an official or custom service by this investigation.

## Capacitor network-bridge lead

Capacitor can optionally patch `fetch`/XHR to route HTTP through its native request bridge. In that configuration, a verified bridge-level interceptor might work below a captured JavaScript fetch wrapper. See the [Capacitor native-bridge implementation](https://github.com/ionic-team/capacitor/blob/main/core/native-bridge.ts) and [HTTP configuration](https://next.capacitorjs.com/docs/v4/apis/http). These describe Capacitor generally; they do not establish the configuration of this exact Obsidian build.

The user's read-only Web Inspector check returned:

```json
{
  "fetchIsNative": true,
  "fetchMentionsCapacitorHttp": false,
  "fetchMentionsNativePromise": false,
  "hasSavedBrowserFetch": true,
  "hasNativeBridge": true
}
```

This shows that the current global fetch is the WebView-native function, not an identifiable CapacitorHttp JavaScript wrapper. The presence of a saved browser-fetch function and `Capacitor.nativePromise` does not show that native account fetch calls travel through that bridge. Replacing nativePromise alone is therefore not an established account interceptor.

The private captured reference is not exposed, so this runtime check cannot mathematically prove its identity with the current global function if another script changed fetch between initialization and inspection. No evidence of a usable captured-wrapper route was established. Do not enable credential routing based on bridge availability alone, or change native HTTP configuration inside the installed app as a workaround.

## Reproducible source contracts

[`inspect-ios-account.cjs`](../tools/inspect-ios-account.cjs) reads a separately supplied source file, verifies its fingerprint, parses selected definitions, and executes only the relevant original account/request/file-engine/plugin-loader functions in an isolated VM. HTTP and localStorage are synthetic in-memory mocks. There is no Obsidian/Electron launch, local server, filesystem access from the evaluated functions, or real request.

```sh
OBSIDIAN_IOS_SOURCE=/absolute/private/path/to/app.js \
SYNC_IOS_INSPECTION_REPORT=/absolute/private/path/to/report.json \
node tools/inspect-ios-account.cjs
```

The tool rejects unqualified source hashes and installed-app paths. Its public output contains method/source offsets, fingerprints and check results, not proprietary source or request bodies. The test-only facade is explicitly injected into the isolated VM and is never presented as an API available to a real plugin.

Thirteen checks passed. They cover fingerprint/shape validation, lack of a direct SDK export, account closure isolation, the original plugin loader's global scope, the unchanged `_sync` gate, separate/plugin storage, later native-storage writes, reconstruction from persisted state, the wrong-origin refresh risk, captured-fetch behavior, native login updating the actual instance, invalid-session clearing, and native logout. See the [redacted report](ios-account-inspection.json).

Source positions are zero-based UTF-16 offsets in this exact fingerprint:

| Area | Offset |
| --- | ---: |
| Captured fetch binding | 159313 |
| Native account request helper | 159499 |
| Account class declaration | 163848 |
| Account singleton creation | 165269 |
| Plugin module loader | 2566313 |
| Native file-engine method | 3222617 |

These are source positions, not native machine addresses. No original function bodies are included in the repository or plugin artifacts.

## Consequence for the implementation plan

The source-file prerequisite is now satisfied. The remaining blocker is an actual callable and reversible way to bind a custom account session to the native engine, or an iOS account-network interception layer that operates beneath the captured fetch and can be installed early enough. Neither was established here.

The existing 0.1.1 mobile build remains diagnostic-only. No additional source/diagnostic prerelease is needed just to repeat the same token/host probes. Server origin changes and mobile login/transfer work remain deferred until the account gate passes. Existing desktop behavior and unrelated deployment work are unchanged.

Continuing private-interface research may discover another route, but it should be treated as research rather than a near-complete mobile port. An independent cross-platform synchronization engine is a different, larger design and would require changing the agreed native-engine constraint; it is not an automatic fallback.
