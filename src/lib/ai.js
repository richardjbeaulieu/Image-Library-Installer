// Describes and tags images with Claude so they can be found by searching.
const fsp = require('fs/promises');
const path = require('path');
const { nativeImage } = require('electron');
const Anthropic = require('@anthropic-ai/sdk');

const MAX_EDGE = 1024; // downscale before upload: plenty for tagging, far fewer input tokens
const MAX_RAW_BYTES = 3.5 * 1024 * 1024; // base64 must stay under the API's 5MB image limit
const RAW_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const SYSTEM_PROMPT = `You catalog images in a designer's asset library (photos, clipart, illustrations, patterns, textures, backgrounds, mockups, fonts previews, SVG/PNG elements) so they can be found later with a keyword search.

For each image, return:
- title: a short, specific name (3-8 words).
- description: 1-3 sentences on what is shown, including subject, composition, and anything notable (e.g. transparent background, border, seamless pattern).
- tags: 15-40 lowercase search keywords. Include the main subjects, objects, setting, holidays/seasons/occasions, themes, and likely search synonyms (e.g. "puppy" and "dog"). Single words or short phrases.
- colors: the dominant colors as plain color names.
- style: the visual style or medium (e.g. "watercolor clipart", "flat vector", "photograph", "3d render", "hand-drawn line art").
- mood: a few words on tone or feel.
- text_in_image: any legible text, verbatim, or an empty string.
- category: one broad bucket such as "clipart", "photo", "pattern", "background", "texture", "illustration", "mockup", "frame/border", "typography", "icon", "other".

The file name and folder are given as hints; use them if they help (pack names often reveal the theme), but describe what is actually in the image.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    colors: { type: 'array', items: { type: 'string' } },
    style: { type: 'string' },
    mood: { type: 'string' },
    text_in_image: { type: 'string' },
    category: { type: 'string' },
  },
  required: ['title', 'description', 'tags', 'colors', 'style', 'mood', 'text_in_image', 'category'],
  additionalProperties: false,
};

function hasTransparency(img) {
  const bitmap = img.toBitmap(); // BGRA
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] < 255) return true;
  return false;
}

// Returns { media_type, data } for the API, or null if the image can't be prepared.
async function encodeImage(file) {
  const ext = path.extname(file).toLowerCase();
  let img = nativeImage.createFromPath(file); // decodes PNG/JPEG
  if (img.isEmpty() && typeof nativeImage.createThumbnailFromPath === 'function') {
    // OS thumbnailer handles WebP, BMP, TIFF, etc.
    try {
      img = await nativeImage.createThumbnailFromPath(file, { width: MAX_EDGE, height: MAX_EDGE });
    } catch {
      img = nativeImage.createEmpty();
    }
  }
  if (!img.isEmpty()) {
    const { width, height } = img.getSize();
    if (Math.max(width, height) > MAX_EDGE) {
      img = width >= height ? img.resize({ width: MAX_EDGE, quality: 'good' }) : img.resize({ height: MAX_EDGE, quality: 'good' });
    }
    // Keep PNG for transparent images: JPEG would flatten them onto black and skew the color tags.
    if (hasTransparency(img)) return { media_type: 'image/png', data: img.toPNG().toString('base64') };
    return { media_type: 'image/jpeg', data: img.toJPEG(85).toString('base64') };
  }
  if (RAW_TYPES[ext]) {
    const buf = await fsp.readFile(file);
    if (buf.length <= MAX_RAW_BYTES) return { media_type: RAW_TYPES[ext], data: buf.toString('base64') };
  }
  return null;
}

function createClient(apiKey) {
  // With no saved key, the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
  return new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 4 });
}

// Model-specific request options: Haiku 4.5 does not take `effort`; server-side refusal
// fallbacks are only offered on the frontier models.
function modelOptions(model) {
  const opts = {};
  if (!model.startsWith('claude-haiku')) opts.output_config = { effort: 'low' };
  if (model === 'claude-opus-5' || model.startsWith('claude-fable')) {
    opts.betas = ['server-side-fallback-2026-07-01'];
    opts.fallbacks = 'default';
  }
  return opts;
}

class SkipError extends Error {}

async function analyzeImage(client, model, file, root) {
  const image = await encodeImage(file);
  if (!image) throw new SkipError('Format not supported for AI analysis (still searchable by name)');

  const rel = path.relative(root, file);
  const { output_config, ...opts } = modelOptions(model);
  const response = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    ...opts,
    output_config: { ...output_config, format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', ...image } },
          { type: 'text', text: `File: ${path.basename(file)}\nFolder: ${path.dirname(rel) === '.' ? '(top level)' : path.dirname(rel)}` },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new SkipError('The model declined to describe this image');
  if (response.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens)');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const result = JSON.parse(text);
  result.tags = [...new Set(result.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))];
  return { ...result, model: response.model, analyzedAt: Date.now() };
}

module.exports = { createClient, analyzeImage, SkipError, Anthropic };
