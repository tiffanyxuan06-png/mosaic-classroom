import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

/**
 * Gemini client for Mosaic Classroom.
 *
 * The AI SDK's Google provider looks for GOOGLE_GENERATIVE_AI_API_KEY by
 * default, so we wire it explicitly to GEMINI_API_KEY instead.
 *
 * Server-only: GEMINI_API_KEY is not a NEXT_PUBLIC_ variable, so this module
 * must only be imported from route handlers, server actions, or server
 * components.
 */
const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY ?? '',
});

export const DEFAULT_MODEL = 'gemini-3.7-flash';
export const MAX_TOKENS = 2000;

/** Returned instead of throwing so callers can always parse a response. */
export const GEMINI_FALLBACK = '{"error": "classification_failed"}';

type CallGeminiOptions = {
  /** Override the default model, e.g. 'gemini-1.5-pro' for harder reasoning. */
  model?: string;
  /** System instruction prepended to the prompt. */
  system?: string;
  /** Media type of imageBase64 when it is not a data URL. */
  mediaType?: string;
};

/** Accepts either a bare base64 string or a full `data:image/png;base64,...` URL. */
function normalizeImage(imageBase64: string, fallbackMediaType: string) {
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(imageBase64.trim());

  if (dataUrl) {
    return { mediaType: dataUrl[1], data: dataUrl[2] };
  }

  return { mediaType: fallbackMediaType, data: imageBase64.trim() };
}

/**
 * Send a prompt to Gemini, optionally with an image (the Vision Scanner path).
 *
 * Never throws — on any failure it resolves to GEMINI_FALLBACK, which is valid
 * JSON that parseGeminiJSON can hand back to the caller.
 */
export async function callGemini(
  prompt: string,
  imageBase64?: string,
  options: CallGeminiOptions = {},
): Promise<string> {
  const { model = DEFAULT_MODEL, system, mediaType = 'image/jpeg' } = options;

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    const image = imageBase64 ? normalizeImage(imageBase64, mediaType) : null;

    const { text } = await generateText({
      model: google(model),
      system,
      maxOutputTokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: image
            ? [
                { type: 'text', text: prompt },
                {
                  type: 'file',
                  mediaType: image.mediaType,
                  data: { type: 'data', data: image.data },
                },
              ]
            : [{ type: 'text', text: prompt }],
        },
      ],
    });

    return text;
  } catch (error) {
    console.error('[gemini] call failed:', error);
    return GEMINI_FALLBACK;
  }
}

/**
 * Parse a Gemini response as JSON, tolerating the markdown code fences the
 * model likes to wrap structured output in. Returns null instead of throwing.
 */
export function parseGeminiJSON<T>(response: string): T | null {
  if (!response) return null;

  let cleaned = response.trim();

  // ```json ... ```  /  ``` ... ```
  const fenced = /^```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)\n?\s*```$/.exec(cleaned);
  if (fenced) {
    cleaned = fenced[1].trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the first balanced-looking object/array in the text, for
    // responses that wrap JSON in prose.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }

    return null;
  }
}
