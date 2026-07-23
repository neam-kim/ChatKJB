# Third-Party Notices — ChatKJB Terminal

This notice is for recipients of the `ChatKJB Terminal.dmg` release. It is an index to the exact legal materials included in the released application; it does not replace or duplicate their license texts.

## Project license

ChatKJB is licensed under the MIT License. The complete project license is [LICENSE](LICENSE).

## Bundled third-party materials

Each built `ChatKJB Terminal.app` contains its own traceable record of the Node.js runtime and npm packages actually bundled into that particular app version:

```text
ChatKJB Terminal.app/Contents/Resources/Licenses/manifest.json
ChatKJB Terminal.app/Contents/Resources/Licenses/Node/LICENSE
ChatKJB Terminal.app/Contents/Resources/Licenses/Packages/
```

`manifest.json` records the bundled Node.js version, the app backend hash, and every bundled npm package's name, version, declared license identifier, legal-file path, and SHA-256 hash. The matching license or notice text is stored at the recorded path under `Licenses/`; `Node/LICENSE` contains the Node.js runtime license. `esbuild-metafile.json` in the same directory records which package inputs formed the bundled backend.

After installing the DMG to `/Applications`, inspect these files with:

```bash
open "/Applications/ChatKJB Terminal.app/Contents/Resources/Licenses"
```

The manifest is generated from the actual bundle, so this notice intentionally does not maintain a hand-copied dependency list or duplicate license texts that could become stale.

## Release packaging status and required follow-up

The current macOS build embeds the dependency license record above inside `ChatKJB Terminal.app`. It does **not** currently copy this notice or the project-level `LICENSE` into the DMG root. Until packaging is extended, a release distributor must provide this `THIRD-PARTY-NOTICES.md` and `LICENSE` alongside the DMG.

To embed them in a future app/DMG release, update the macOS packaging path (`scripts/build-macos-app.mjs` for app resources and/or `scripts/build-macos-dmg.mjs` for DMG staging) and extend the corresponding bundle audit. This is documented here as a required release follow-up; no packaging script is changed by this notice.
