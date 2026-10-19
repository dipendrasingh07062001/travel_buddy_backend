import { describe, expect, it } from 'vitest';
import {
  containsSensitivePublicText,
  hiddenPublicText,
  publicText,
  requireSafePublicText,
} from '../src/privacy/public-text.js';
import { normalizeProfileUpdate } from '../src/modules/profiles/profile.service.js';
import {
  cleanCreateMetadata,
  cleanMetadataPatch,
} from '../src/modules/communities/community-admin.service.js';

const disclosures = [
  'Please email traveller@example.invalid about the trek.',
  'traveller+trip@sub.example.invalid',
  'traveller＠example．invalid',
  'traveller@exam\u200bple.invalid',
  'Contact +91 98765 43210 for this trip.',
  '+1 (202) 555-0123',
  'Phone: +1.202.555.0123',
  '9876543210',
  '98765-43210',
  '919876543210',
  '0091 9876543210',
  '९८७६५४३२१०',
  '٩٨٧٦٥٤٣٢١٠',
  'Call me: 020 7946 0958',
  'tel:+442079460958',
  'sms:9876543210',
  'https://wa.me/919876543210',
  'https://api.whatsapp.com/send?phone=919876543210',
  'ABCDE1234F',
  'Aadhaar: 2345 6789 0123',
  'Passport number: A1234567',
  'National ID: AA12345678',
  'Government ID: 123456789',
  'Home address: 42 Example Lane, Sample City.',
  'Residential address is Flat 42, Example Building.',
  'My live location: https://maps.example.invalid/private-location',
  'Current location is 12.9716, 77.5946',
  'Private location: geo:12.9716,77.5946',
  // Common ways of writing numbers that earlier rules missed.
  'Call me on 09876543210',
  'Mob: 09876543210',
  '98765  43210',
  '98765–43210',
  'My number is 415 555 0123',
  'whatsapp me on 0412 345 678',
  'phone - 09876543210',
  'my aadhaar is 2345 6789 0123',
  'my passport number is K1234567',
  'Budget 5000. Call 98765-43210',
];

const travelText = [
  'Delhi to Manali from 2026-10-17 to 2026-10-22.',
  'Weekend trek for 3 people and 5 nights.',
  'Budget INR 12000-18000 per person.',
  'Budget 60000-80000 INR for the longer trip.',
  'Price: 60000-80000',
  'Budget ₹60000-80000 for the group.',
  'Cost $60000-80000 for the full expedition.',
  'We can plan for ₹15,000 or ₹20,000 and split costs.',
  'Train 12009 leaves at 10:30. Flight AI123 is another option.',
  'Meet at Gate 4, New Delhi Railway Station.',
  'Visit https://example.invalid/trails for the public itinerary.',
  'Public meeting point: https://maps.example.invalid/station',
  'The trail starts near 12.9716, 77.5946.',
  'Public meeting point: 77.12345678, 28.12345678',
  'Public meeting point: +77.12345678, +28.12345678',
  'Budget INR 60000000.00',
  'Do not share your home address or passport here.',
  'A passport is required for this route.',
  'Passport valid until 2027-10-17.',
  'Phone: 2026-10-17 is a date, not a phone number.',
  'Home address: private; meet at the station instead.',
  'Home address: house rules apply, no private address provided.',
  'हिंदी और English में यात्रा की योजना बनाएं।',
  'दिल्ली से मनाली, ३ लोग और ५ दिन।',
  // Times and price ranges that earlier rules wrongly rejected.
  'Dinner@8.30 near the ghats',
  'Bus leaves@6.45 from Manali',
  'Budget INR 60000-80000 per person.',
  'Rs. 60000-80000 each',
  'Budget is 70000-85000',
  'Budget around 60000-90000',
  'Call on 26 10 2026 to confirm the plan.',
];

describe('public-text disclosure safeguards', () => {
  it.each(disclosures)(
    'rejects a supported disclosure without echoing it: %s',
    (value) => {
      expect(containsSensitivePublicText(value)).toBe(true);
      expect(publicText(value)).toBe(hiddenPublicText);
      try {
        requireSafePublicText(value);
        throw new Error('Expected a privacy rejection');
      } catch (error) {
        expect(error).toMatchObject({
          statusCode: 400,
          code: 'PUBLIC_TEXT_PRIVACY_VIOLATION',
        });
        expect((error as Error).message).not.toContain(value);
      }
    },
  );

  it.each(travelText)(
    'preserves ordinary travel text byte-for-byte: %s',
    (value) => {
      expect(containsSensitivePublicText(value)).toBe(false);
      expect(() => requireSafePublicText(value)).not.toThrow();
      expect(publicText(value)).toBe(value);
    },
  );

  it('preserves null/undefined and does not change safe Unicode text', () => {
    expect(publicText(null)).toBeNull();
    expect(publicText(undefined)).toBeNull();
    expect(() => requireSafePublicText(null)).not.toThrow();
    expect(() => requireSafePublicText(undefined)).not.toThrow();
    expect(publicText('क्\u200dष यात्रा')).toBe('क्\u200dष यात्रा');
  });

  it('bounds inspection and fails closed for oversized legacy values', () => {
    expect(publicText('x'.repeat(20_001))).toBe(hiddenPublicText);
    expect(containsSensitivePublicText('x'.repeat(5000))).toBe(false);
    expect(containsSensitivePublicText('a@' + 'x'.repeat(4997))).toBe(false);
  });

  it.each([
    { displayName: 'traveller@example.invalid' },
    { homeCity: '9876543210' },
    { homeRegion: 'Home address: 42 Example Lane' },
    { biography: 'Email traveller@example.invalid for details.' },
    { languages: ['English', '9876543210'] },
    { travelInterests: ['hiking', 'traveller@example.invalid'] },
  ])('validates every public profile field', (body) => {
    expect(() => normalizeProfileUpdate(body)).toThrowError(
      expect.objectContaining({ code: 'PUBLIC_TEXT_PRIVACY_VIOLATION' }),
    );
  });

  it('allows clearing a field and changing privacy without rewriting legacy text', () => {
    expect(
      normalizeProfileUpdate({
        biography: null,
        communityActivityVisibility: 'PRIVATE',
      }),
    ).toEqual({ biography: null, communityActivityVisibility: 'PRIVATE' });
  });

  it('applies the same rule to public staff-managed metadata, not private review reasons', () => {
    expect(() =>
      cleanCreateMetadata({
        slug: 'safe-hub',
        name: 'Email traveller@example.invalid',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'PUBLIC_TEXT_PRIVACY_VIOLATION' }),
    );
    expect(() =>
      cleanMetadataPatch({ description: 'Call +91 98765 43210 for details.' }),
    ).toThrowError(
      expect.objectContaining({ code: 'PUBLIC_TEXT_PRIVACY_VIOLATION' }),
    );
  });
});
