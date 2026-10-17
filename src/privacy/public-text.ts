import { AppError } from '../errors/app-error.js';

export const hiddenPublicText = '[Hidden for privacy]';
const maximumInspectedLength = 20_000;

// Inspect a normalized copy only. Never silently rewrite the author's text.
function inspectionText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f]/gu, (digit) => {
      const point = digit.codePointAt(0)!;
      const zero = point >= 0x966 ? 0x966 : point >= 0x6f0 ? 0x6f0 : 0x660;
      return String(point - zero);
    });
}

function isDate(value: string): boolean {
  return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})$/.test(
    value,
  );
}

// These are bounded, high-confidence disclosure patterns, not identity/phone
// verification, OCR, a universal PII classifier or a replacement for moderation.
export function containsSensitivePublicText(value: string): boolean {
  if (value.length > maximumInspectedLength) return true;
  const text = inspectionText(value);
  if (
    /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u.test(text) ||
    /(?<![\p{L}\p{N}])\+\d(?:[ ()\t-]{0,3}\d){7,14}(?![\p{L}\p{N}]|[ ()\t-]{0,3}\d)/u.test(
      text,
    ) ||
    /\b(?:tel|sms):\s*\+?\d(?:[ ()\t.-]{0,3}\d){6,14}/iu.test(text) ||
    /\b(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)\+?\d{7,15}\b/iu.test(
      text,
    ) ||
    /(?<![a-z0-9])[a-z]{5}\d{4}[a-z](?![a-z0-9])/iu.test(text) ||
    /\b(?:aadhaar|aadhar)\s*(?:(?:number|no\.?)\s*)?[:#=-]?\s*[2-9](?:[ -]?\d){11}(?!\d)/iu.test(
      text,
    ) ||
    /\b(?:home|residential)\s+address\s*(?::|=|\bis\b)\s*(?:#?\d|(?:flat|house|apartment)\s*(?:(?:no\.?|number|#)\s*)?\d)/iu.test(
      text,
    ) ||
    /\b(?:live|current|private)\s+location\s*(?::|=|\bis\b)\s*(?:https?:\/\/\S+|geo:\S+|[-+]?\d{1,2}\.\d{2,}\s*[,/]\s*[-+]?\d{1,3}\.\d{2,})/iu.test(
      text,
    )
  )
    return true;

  const mobile =
    /(?<![\p{L}\p{N}])(?:(?:00)?91[ -]?)?[6-9](?:[ -]?\d){9}(?![\p{L}\p{N}]|[ -]?\d)/gu;
  for (const match of text.matchAll(mobile)) {
    const token = match[0];
    const before = text.slice(Math.max(0, match.index - 32), match.index);
    const after = text.slice(
      match.index + token.length,
      match.index + token.length + 12,
    );
    // A clearly labeled price range is ambiguous, not automatically a phone.
    if (
      /^\d{4,7}-\d{4,7}$/.test(token) &&
      (/\b(?:budget|price|cost)\s*[:=]?\s*$/iu.test(before) ||
        /[₹$€]\s*$/u.test(before) ||
        /^\s*(?:INR|rupees|USD|EUR)\b/iu.test(after))
    )
      continue;
    return true;
  }

  const phone =
    /\b(?:phone|mobile|whatsapp|contact|call(?:\s+me)?|tel)\s*(?:(?:number|no\.?)\s*)?[:=]?\s*(\+?\d(?:[ ()\t.-]{0,3}\d){6,14})(?![\p{L}\p{N}])/giu;
  for (const match of text.matchAll(phone)) {
    if (!isDate(match[1]!)) return true;
  }
  const identity =
    /\b(?:passport|national\s*id|government\s*id)\s*(?:(?:number|no\.?)\s*)?[:#=-]?\s*([a-z0-9][a-z0-9-]{5,23})/giu;
  for (const match of text.matchAll(identity)) {
    const token = match[1]!;
    if (!isDate(token) && (token.match(/\d/g)?.length ?? 0) >= 4) return true;
  }
  return false;
}

export function requireSafePublicText(value: string | null | undefined): void {
  if (value != null && containsSensitivePublicText(value)) {
    throw new AppError(
      400,
      'PUBLIC_TEXT_PRIVACY_VIOLATION',
      'Remove contact details, identity numbers, precise home addresses or live private location details from public text before saving.',
    );
  }
}

export function publicText(value: string): string;
export function publicText(value: string | null | undefined): string | null;
export function publicText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return containsSensitivePublicText(value) ? hiddenPublicText : value;
}
