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
  return /^(?:\d{4}[-/. ]\d{1,2}[-/. ]\d{1,2}|\d{1,2}[-/. ]\d{1,2}[-/. ]\d{4})$/.test(
    value,
  );
}

// Spaces and dashes (hyphen, en/em dash, minus) people put between digits.
const digitGap = String.raw`[ \t‐-―−-]{1,3}`;
// Words people put between a label and the number: "number is", "me on".
const labelFiller = String.raw`(?:[ \t]{0,3}(?:number|no\.?|num|is|me|on|at|-|:|=|#)){0,4}[ \t]{0,3}`;

// An Indian mobile number, with an optional 91, 0091 or domestic 0 prefix.
const mobile = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?:00)?91(?:${digitGap})?|0(?:${digitGap})?)?[6-9](?:(?:${digitGap})?\d){9}(?![\p{L}\p{N}]|(?:${digitGap})?\d)`,
  'gu',
);
const labelledPhone = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:phone|mobile|mob|cell|ph|whatsapp|contact|call|text[ \t]+me|tel|my[ \t]+number)${labelFiller}(\+?\d(?:[ ()\t.‐-―−-]{0,3}\d){6,14})(?![\p{L}\p{N}])`,
  'giu',
);
const aadhaar = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:aadhaar|aadhar)(?:[ \t]{0,3}card)?${labelFiller}[2-9](?:[ \t-]?\d){11}(?!\d)`,
  'iu',
);
const identity = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:passport|national[ \t]*id|government[ \t]*id)${labelFiller}([a-z0-9][a-z0-9-]{5,23})`,
  'giu',
);

// "60000-80000" looks like a split phone number. It is read as a price range
// when it rises and money is mentioned just before it in the same sentence,
// or right after it. A falling pair such as 98765-43210 is still a phone.
const numberRange = /^(\d{4,7})[ \t]{0,3}[‐-―−-][ \t]{0,3}(\d{4,7})$/u;
const moneyBefore =
  /(?:(?<![a-z])(?:budget|price|cost|costs|fare|fees?|rs\.?|inr|rupees|usd|eur)(?![a-z])[^.!?\n]{0,30}|[₹$€][ \t]*)$/iu;
const moneyAfter =
  /^[ \t]*(?:inr|rupees|rs(?![a-z])|usd|eur|each|per[ \t]+(?:person|head|pax))/iu;

function isPriceRange(text: string, start: number, token: string): boolean {
  const range = numberRange.exec(token);
  if (!range || Number(range[2]) <= Number(range[1])) return false;
  const before = text.slice(Math.max(0, start - 40), start);
  const after = text.slice(start + token.length, start + token.length + 20);
  return moneyBefore.test(before) || moneyAfter.test(after);
}

// These are bounded, high-confidence disclosure patterns, not identity/phone
// verification, OCR, a universal PII classifier or a replacement for moderation.
export function containsSensitivePublicText(value: string): boolean {
  if (value.length > maximumInspectedLength) return true;
  const text = inspectionText(value);
  if (
    // The domain must end in letters, so times like "Dinner@8.30" are not
    // read as addresses.
    /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u.test(
      text,
    ) ||
    /(?<![\p{L}\p{N}])\+\d(?:[ ()\t-]{0,3}\d){7,14}(?![\p{L}\p{N}]|[ ()\t-]{0,3}\d)/u.test(
      text,
    ) ||
    /\b(?:tel|sms):\s*\+?\d(?:[ ()\t.-]{0,3}\d){6,14}/iu.test(text) ||
    /\b(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)\+?\d{7,15}\b/iu.test(
      text,
    ) ||
    /(?<![a-z0-9])[a-z]{5}\d{4}[a-z](?![a-z0-9])/iu.test(text) ||
    aadhaar.test(text) ||
    /\b(?:home|residential)\s+address\s*(?::|=|\bis\b)\s*(?:#?\d|(?:flat|house|apartment)\s*(?:(?:no\.?|number|#)\s*)?\d)/iu.test(
      text,
    ) ||
    /\b(?:live|current|private)\s+location\s*(?::|=|\bis\b)\s*(?:https?:\/\/\S+|geo:\S+|[-+]?\d{1,2}\.\d{2,}\s*[,/]\s*[-+]?\d{1,3}\.\d{2,})/iu.test(
      text,
    )
  )
    return true;

  for (const match of text.matchAll(mobile)) {
    if (!isPriceRange(text, match.index, match[0])) return true;
  }
  for (const match of text.matchAll(labelledPhone)) {
    if (!isDate(match[1]!)) return true;
  }
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
