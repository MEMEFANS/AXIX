// Reuse the user's authorized Kakou Media API. Credentials stay in environment.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const dir = new URL('./lobby-art/', import.meta.url);
await mkdir(dir, { recursive: true });
const base = process.env.KAKOU_MEDIA_BASE_URL || 'https://api.kakouai.com';
const key = process.env.KAKOU_MEDIA_API_KEY;
if (!key) throw new Error('Saved image API key is unavailable.');
const prompt = `Use case: stylized-concept.
Asset type: original wide hero illustration for the AIX PLAY game lobby, landscape 16:9. This illustration is the atmosphere behind a real HTML interface, not a mockup.
Primary request: a premium space-fantasy arcade destination, a floating midnight-blue observatory island with a beautiful circular lavender portal, a short luminous mint runway leading into it, and a small faceted violet crystal floating beside the entrance. In the distance, a second elevated trail curves towards tiny floating futuristic structures. The scene should feel like the entrance to a coherent world of casual games and cosmic adventures.
Composition: the hero UI places its heading and two buttons on the LEFT 45 percent, so this area must remain dark, quiet, mostly clean indigo atmosphere with only sparse stars. Compose the beautifully crafted portal and floating island on the RIGHT 55 percent. The subject fits comfortably within the right two-thirds, and the crystal stays clear of the far edges. No giant planet in the left copy area. The lower right runway is visible in perspective. Keep scene legible at mobile width with a crop of the right half.
Style: polished original 3D mobile adventure game key art, refined shapes, high material quality, soft bevels and optical crystal, controlled luminous edges, attractive cinematic atmosphere. Dark navy, violet, periwinkle and a small amount of mint light, restrained warm gold accents. Detailed but uncluttered. Deep shadowed architecture, soft ambient light and subtle floating dust. Visually consistent with a premium cosmic crystal observatory, inviting and calm.
Constraints: no text, no letters, no numbers, no logos, no watermark, no interface, no borders, no coins, no currency symbols, no casino chips, no people, no weapons. No lens flare over the left area, no white sky, no busy neon wireframe. Original artwork, no recognizable copyrighted game environment.`;
const mode = process.argv[2] || 'submit';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
if (mode === 'submit') {
  const payload = { type: 'image', model: 'gpt-image-2', input: { resolution: '2k', output_format: 'png', aspect_ratio: '16:9', prompt, quality: 'high', output_count: 1 } };
  const requestPath = new URL('request.json', dir);
  let previous; try { previous = JSON.parse(await readFile(new URL('job.json', dir), 'utf8')); } catch {}
  if (previous?.id) { console.log(JSON.stringify({ status: 'already-submitted', id: previous.id })); process.exit(0); }
  await writeFile(new URL('prompt.txt', dir), prompt);
  await writeFile(requestPath, JSON.stringify(payload, null, 2));
  const response = await fetch(`${base}/v1/media/tasks`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `aix-lobby-20261027-${randomUUID()}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
  const result = await response.json();
  if (!response.ok || !result.data?.id) throw new Error(`Image submission failed (${response.status}, ${result.code ?? 'unknown'}).`);
  await writeFile(new URL('job.json', dir), JSON.stringify({ id: result.data.id, status: result.data.status, model: payload.model }, null, 2));
  console.log(JSON.stringify({ id: result.data.id, status: result.data.status }));
} else if (mode === 'poll') {
  const job = JSON.parse(await readFile(new URL('job.json', dir), 'utf8'));
  const response = await fetch(`${base}/v1/media/tasks/${job.id}`, { headers, signal: AbortSignal.timeout(25000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Image status failed (${response.status}).`);
  const data = result.data;
  if (data.status === 'succeeded') {
    const output = data.result?.outputs?.[0];
    const download = output?.url || output?.download_url || output?.file_url;
    if (!download) throw new Error(`No image URL; output keys: ${Object.keys(output || {}).join(',')}`);
    const file = await fetch(download, { signal: AbortSignal.timeout(45000) });
    if (!file.ok) throw new Error('Image download failed.');
    const source = new URL('../../output/imagegen/lobby/lobby-source.png', import.meta.url);
    await mkdir(new URL('.', source), { recursive: true });
    const bytes = Buffer.from(await file.arrayBuffer()); await writeFile(source, bytes);
    const manifest = { id: job.id, status: data.status, provider: 'Kakou Media API', model: 'gpt-image-2', chargedUsd: data.billing?.charged_amount, dimensions: { width: output.width, height: output.height }, source: 'output/imagegen/lobby/lobby-source.png', runtime: 'resources/app/public/games/lobby/assets/lobby-hero.jpg', prompt: 'tools/hash-aix/lobby-art/prompt.txt' };
    await writeFile(new URL('manifest.json', dir), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ ...manifest, bytes: bytes.length }));
  } else console.log(JSON.stringify({ id: job.id, status: data.status, error: data.error?.code }));
}
