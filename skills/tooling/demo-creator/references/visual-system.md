# ACP visual system

## Canvas and layout

| Profile | Canvas | Content | Caption band | Extension | Gap |
|---|---:|---:|---:|---:|---:|
| 1080p | 1920x1080 | 1920x936 | 1920x144 | 630 px | 24 px |
| 720p | 1280x720 | 1280x624 | 1280x96 | 420 px | 16 px |

Keep captions in the dedicated bottom band so they never obscure product UI.
Use a black caption background and white text. For generic splits, keep each
cell between 30% and 70% of the content width. Preserve aspect ratios and use
padding instead of distortion.

For `mobile-full`, reserve the complete content region as the aspect-fit canvas.
Center and pad the entire portrait source at both profiles; never stretch, crop,
zoom, or project it through hard-coded device coordinates.

## Palette

| Role | Value |
|---|---|
| ACP dark background | `#292929` |
| ACP robot coral | `#F56E6E` |
| Red Hat red | `#EE0000` |
| Primary text | `#FFFFFF` |
| Paper/light surface | `#F7F7F7` |
| Caption background | `#000000` |

Use Red Hat red as a focused accent, not as a large reading surface. A subtle
dot grid may add depth to title/end cards but must not compete with text.

## Typography

- Red Hat Display: titles and major headings.
- Red Hat Text: body copy and captions.
- Red Hat Mono: commands, labels, paths, and technical metadata.

Render caption text once at exactly 44 px in the 1080p master. Derive 720p only
by the required two-thirds Lanczos scale of the complete master, yielding a
nominal 29 px caption (44 x 2/3), never a separately rendered 720p caption. Use
bold only when it improves hierarchy. Fit no more than two short lines, use
comfortable line spacing, and validate both profiles with the conservative Red
Hat Text glyph-width model, whose 29 px derivative profile is intentionally
conservative. Character count alone is not a fit guarantee; the contact-sheet
review remains the visual backstop.

Mobile captions remain visible for at least 2.5 seconds and contain no more than
3 words per second. They must communicate the complete story without narration.

Use the vendored files in `assets/fonts/`; do not depend on host font install.

## Cards and transitions

- Title card: 3 seconds by default, one clear promise, optional short subtitle.
- End card: 3 seconds by default, concise result or next action.
- Use the coral ACP robot from `assets/branding/acp-logo.svg` at a deliberate,
  uncluttered scale.
- Use restrained 300 ms crossfades by default. Avoid decorative motion that
  competes with the workflow.

## Accessibility review

- Verify text/background contrast meets WCAG AA for normal text; target 7:1 for
  captions where practical.
- Do not encode meaning by color alone.
- Use a large white standard arrow pointer with a thick black outline. Do not
  use decorative tracking shapes or click rings.
- For Android, disable show-touches and recorder cursor effects. Render one
  composed pointer/click treatment from normalized event data; never stack a
  device halo with the composed pointer.
- Keep click feedback visible for exactly 18 frames, clamped only at the end of
  the video, and identify the press with a restrained scale pulse rather than
  color alone.
- Avoid flashing, rapid zooms, and surprise camera movement.
- Leave enough dwell time to read every caption without audio.
- Inspect the 720p derivative at actual size; legibility at 1080p is not proof.
