# Asset provenance

## Red Hat font family

The six font files in `fonts/` were copied without modification from the local
Red Hat deck skill at:

```text
~/repos/harness/.agents/skills/redhat-deck/assets/fonts/
```

Upstream project: <https://github.com/RedHatOfficial/RedHatFont>

License: SIL Open Font License 1.1. See `fonts/OFL.txt`.

<!-- markdownlint-disable MD013 -->

| File | SHA-256 |
|---|---|
| `RedHatDisplay-Bold.ttf` | `dbf47040aad17293d8fe9df3294fa386da564d9ec241a48768f2a28b48127ab6` |
| `RedHatDisplay-Regular.ttf` | `aaa611b2c2310ad27de56d32b45da18f94e2943e9574ef4cc92b0d3694bb39f9` |
| `RedHatMono-Bold.ttf` | `a26bc53cf7864b424ea4877132f06fcb1faa1cadd269fd507e2394852ae59c4e` |
| `RedHatMono-Regular.ttf` | `a4cdaf35cd6550139f239c5d89df2e90a7f9e36b790ad2b6e258cf39085a29bf` |
| `RedHatText-Bold.ttf` | `829d4eee18636c63e0927015cecc42a37da45e0b8474f0ec3eec1b016b476622` |
| `RedHatText-Regular.ttf` | `1d0ff44ea65d2673a9030a4ce50df4286e79d44d98fb3704a9a07c40181be3af` |

<!-- markdownlint-enable MD013 -->

## ACP robot logo and Lucide Bot icon

`branding/acp-logo.svg` was copied without modification from this repository:

```text
components/manifests/overlays/kind/keycloak-theme/acp-logo.svg
```

Source commit: `4eced21608e936bc7545569dc0749dc1300886ce`

SHA-256: `c66e8dc4fc664d04e4b17886bda4253d15552d4a6aca34daccdf9635095b9bb9`

The robot paths are the Lucide `bot` icon, adapted in the repository asset with
ACP coral stroke, fixed dimensions, and ACP title/label text.

Upstream project: <https://github.com/lucide-icons/lucide>

License: ISC. See `branding/LUCIDE-ISC-LICENSE.txt` for the full license from
the upstream Lucide repository. The upstream license does not list Bot among
the Feather-derived icons.
The ACP presentation and name remain subject to the repository's project
license and trademark policy. Vendoring the asset avoids a network dependency
and keeps generated cards reproducible.

## Android capture binary exceptions

The Android SDK command-line tools, Android SDK Platform-Tools package that
provides ADB, Android Emulator, and Android system images are not vendored in
this skill. Android capture uses only locally installed packages after
`demo doctor <scenario>` identifies the exact versions and confirms the
scenario-selected system-image package is installed.

These packages are explicit reviewed binary exceptions to the otherwise
free/open-source production toolchain. They are used under the applicable
Android SDK or package-specific Google terms and are not represented as open
source. In particular, a `google_apis` system image may contain Google
components with additional package-specific terms. Review the license displayed
for each selected package before use and do not infer redistribution rights from
local SDK installation.
