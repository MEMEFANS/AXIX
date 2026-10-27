# Hash core artwork delivery

- Provider: Kakou Media API; model: gpt-image-2, high, 2k, 3:2.
- Task: `img_fade1ad6117045058892ebebdb09faa6`; succeeded; actual charge USD 0.20.
- Source: `output/imagegen/hash-aix/hash-core-source.png`, 2496 × 1664.
- Runtime: `resources/app/public/games/hash-aix/assets/hash-core.jpg`, 1200 × 800, 171,280 bytes, JPEG quality 86.
- Prompt: `tools/hash-aix/art-jobs/hash-core-prompt.txt`.

Visual review: a faceted violet/mint crystal shell surrounds a dark empty center, with metallic gold-edged astrolabe rings and a circular observatory platform. The central result glyph should be centered around **50% horizontally / 38% vertically** in the uncropped artwork. This keeps it inside the dark aperture and above the foreground ring. The source has no game UI, result digit, logo, or readable text baked in.

The single accepted generation produced the delivered image. One earlier request was rejected before creating a task because the API requires an Idempotency-Key header; the accepted request used that header. No further image generations were requested.

The API key was read from the existing user environment and was not written to the prompt, request, submit, status, manifest, compression script, or tool output. Ephemeral signed download links were removed from the saved status file after download. `prepare-art.ps1` can reproduce the compressed runtime image without credentials.
