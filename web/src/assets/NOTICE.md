# NanthAi brand assets

`nanthai-monogram.webp` is a lossless WebP encoding of the NanthAi company monogram, reused at the owner's explicit direction. Copyright 2026 Ferdinando Valsecchi. All brand and trademark rights reserved; this asset is excluded from the surrounding AGPL-3.0-only code license.

Source: `thevarsek/nanthai-edge`, commit `68e23215a7fdc3a58f5c56a8408073bb4fa69166`, `web/public/edge-brand/nanthai_edge_monogram_v2_transp.png`. Git blob: `ff988529e3ee8a1b0de4bbbb6e74805aee77a206`. Also served by the owner's public website at https://nanthai.tech/edge-brand/nanthai_edge_monogram_v2_transp.png.

`nanthai-monogram-128.webp` is the same monogram resized to 128 × 128 pixels. The same rights apply. These retained company assets are not currently referenced by the application frame, which uses the Forge mark.

The WebP files replace the original PNG encodings (610,785 and 12,998 bytes). Full-size encoding: `cwebp -lossless -exact -metadata all -m 6`; 128px encoding: ImageMagick `-define webp:lossless=true -define webp:exact=true`. Both decoded images have zero RMSE against their PNG inputs. This reduces retained asset bytes, not current browser transfer bytes.

No Edge application implementation is included. Forge's UI styling is original code informed by the shared design language.

## Manrope

Self-hosted variable typeface from the Google Fonts Manrope distribution, https://github.com/google/fonts/tree/main/ofl/manrope. Copyright 2018 The Manrope Project Authors. Licensed under SIL Open Font License 1.1; see `web/public/assets/Manrope-OFL.txt` (copied to `assets/Manrope-OFL.txt` in web builds). Used for headings.

Downloaded variable font SHA-256: `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`.

`Manrope-latin.woff2` and `Manrope-extended.woff2` are subsets of that upstream TTF, produced with fontTools 4.60.1 (`Subsetter`, all layout features, WOFF2 flavor). Latin covers supported U+0000–024F, U+2000–206F, U+20AC, U+2122 and U+2212 plus common marks and symbols; extended covers every remaining original codepoint. Both subsets include common combining marks, punctuation, numbers, symbols and spacing to preserve shaping in either script. Latin is declared last so ordinary Latin text prefers its smaller face. All 678 original codepoints, the 200–800 variable weight axis and the existing SIL license are preserved. Latin is 33,004 bytes; the extended subset is 40,704 bytes, versus the original 164,700-byte font. Browsers request each subset only when its characters occur. The unused upstream TTF is not retained in the source tree.

## Atkinson Hyperlegible Next and Mono

Self-hosted variable typefaces for the public page (`web/index.html`, `web/src/landing/landing.css`), from the Google Fonts distribution: https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegiblenext and https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegiblemono. Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors and The Atkinson Hyperlegible Mono Project Authors. Licensed under SIL Open Font License 1.1; see `web/public/assets/AtkinsonHyperlegible-OFL.txt` (copied to `assets/AtkinsonHyperlegible-OFL.txt` in web builds). The two upstream license texts are identical apart from their copyright lines, which the file carries both of.

`AtkinsonHyperlegibleNext-latin.woff2` (34,024 bytes, weights 400–800, SHA-256 `1e4cea71d75ec427581d6259fc07148a2e60d60d16cabf4b4f5360487b3f9dc3`) and `AtkinsonHyperlegibleMono-latin.woff2` (17,740 bytes, weights 400–700, SHA-256 `f0230cab68ecdc96766fde00a89cf3167e668c3a8756f844cab554dc3bcfd030`) are the unmodified Latin WOFF2 subsets Google Fonts serves (font versions v7 and v8). Their unicode-range is declared in `landing.css`; characters outside it fall back to the system font.

## Forge mark

The Forge Overlap mark, badge, lockups and browser/app icons in `brand/`, `web/public/`, the inline `ui/brand.tsx` component, its state styles in `ui/mark.css`, and the mark reference set in the repository's `design/hearth/` are the owner-supplied final Forge branding from Fable’s brand asset pack. Copyright 2026 Ferdinando Valsecchi. All brand and trademark rights reserved; these assets are excluded from the surrounding AGPL-3.0-only code license.
