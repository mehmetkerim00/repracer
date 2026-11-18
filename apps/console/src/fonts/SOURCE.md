# Fonts of the seller console

Theme «Spruce Hybrid» (step 167). The files are vendored, so the console loads no font from a CDN at run time.

| File | Font | Weight | License | SHA-256 |
|---|---|---|---|---|
| `inter-latin-400-normal.woff2` | Inter | 400 | SIL OFL 1.1 (`OFL-Inter.txt`) | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` |
| `inter-latin-500-normal.woff2` | Inter | 500 | SIL OFL 1.1 (`OFL-Inter.txt`) | `f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f` |
| `inter-latin-600-normal.woff2` | Inter | 600 | SIL OFL 1.1 (`OFL-Inter.txt`) | `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a` |
| `schibsted-grotesk-latin-600-normal.woff2` | Schibsted Grotesk | 600 | SIL OFL 1.1 (`OFL-SchibstedGrotesk.txt`) | `d00ac8735bf6b96cc4cfbfb22576c4168645547a264bd22d127c46519cab3250` |

## Source

The files come unchanged from the Fontsource npm packages. The license files are the packages' `LICENSE`.

- `@fontsource/inter@5.3.0`, published 2026-07-19. Tarball SHA-256: `02034af8d41dcc67ac8eab88f642e129bb8a2e8922abf30229c32725f54d8fd6`. Upstream: https://github.com/rsms/inter.
- `@fontsource/schibsted-grotesk@5.3.0`, published 2026-07-19. Tarball SHA-256: `2dd3c8fc0a5f5731bf5e01904fef6ce67aad9b00873ca7a1b4c731c46d003acd`. Upstream: https://github.com/schibsted/schibsted-grotesk.

## Subset

Only the `latin` subset is vendored: Latin-1 plus punctuation, which covers the letters of English, German, Spanish and French. The `unicode-range` in `fonts.css` is the one from the packages. Other characters fall back to the system font.
