// Describes and tags an image with Claude so it can be found by searching.
// Shared by the desktop app and the web server; each supplies its own image encoder.
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MAX_EDGE = 1024; // downscale before upload: plenty for tagging, far fewer input tokens

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

// image: { media_type, data (base64) } prepared by the caller, or null if the format can't be encoded.
async function describeImage(client, model, image, file, root) {
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

module.exports = { MAX_EDGE, createClient, describeImage, SkipError, Anthropic };
