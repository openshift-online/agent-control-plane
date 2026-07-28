# Production toolchain licensing

Use a locally runnable production toolchain built from free/open-source tools
plus explicit reviewed binary exceptions. Chrome for Testing is free to use
under the Chrome terms but is not open-source software. Native Chrome extension
behavior requires its real toolbar, pinned extension icon, and side-panel
implementation, so an open-source browser substitute cannot satisfy the capture
contract.

Android capture adds four reviewed, locally installed binary exceptions: the
Android SDK command-line tools, Android SDK Platform-Tools package that provides
ADB, Android Emulator, and the exact selected Android system-image package. They
are used under their applicable Android SDK/package terms and are not described
as open source. A `google_apis` image may include Google components with
package-specific terms. Record each exact installed package and version, review
its displayed license before use, and do not assume redistribution rights. These
exceptions do not require a paid editor, hosted service, or subscription.

Do not require a cloud video service, hosted test dashboard, paid editor, or
proprietary production SDK. Do not add another non-open-source dependency
without an explicit design and license review.

<!-- markdownlint-disable MD013 -->

| Purpose | Tool | License family |
|---|---|---|
| Browser automation | Playwright | Apache-2.0 |
| Browser build | Chrome for Testing | Chrome terms; free-to-use, non-open-source binary exception |
| Android SDK tooling | Android SDK command-line tools | Android SDK terms; reviewed locally installed binary exception |
| Android device bridge | Android SDK Platform-Tools (ADB) | Android SDK terms; reviewed locally installed binary exception |
| Android device runtime | Android Emulator | Android SDK terms; reviewed locally installed binary exception |
| Android device image | Selected installed system-image package | Package-specific Android/Google terms; reviewed binary exception |
| Composition/encoding | FFmpeg | LGPL/GPL depending on build configuration |
| Local visual secret scan | Tesseract OCR | Apache-2.0 |
| macOS capture | OBS Studio ScreenCaptureKit source | GPL-2.0-or-later |
| macOS native automation | Hammerspoon | MIT |
| Linux virtual display | Xvfb | X11/MIT family |
| Linux native automation | xdotool and AT-SPI | BSD/GPL and LGPL families |
| Slides | Presenterm | BSD-2-Clause |
| Terminal capture | VHS | MIT |
| Typography | Red Hat font family | SIL Open Font License 1.1 |
| Robot icon geometry | Lucide Bot | ISC |

<!-- markdownlint-enable MD013 -->

Record exact versions plus the selected Android system-image package and its
installed revision in `manifest.lock.json`. Check the license of every new
dependency before adding it. The repository may use a tool whose license varies
by build options or package only after the selected local build/package is
reviewed and documented.

The vendored font and icon licenses and asset provenance are in
`assets/fonts/OFL.txt`, `assets/branding/LUCIDE-ISC-LICENSE.txt`, and
`assets/THIRD_PARTY_NOTICES.md`.
