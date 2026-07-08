import { google } from 'googleapis';
import type { GoogleAuth, JWT } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

/**
 * Service-account auth. Credentials come from environment only:
 *  - GOOGLE_APPLICATION_CREDENTIALS: path to a JSON key file, or
 *  - GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY inline.
 * Nothing is ever hardcoded.
 */
export function createGoogleAuth(): GoogleAuth | JWT {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && email && key) {
    return new google.auth.JWT({
      email,
      key: key.replace(/\\n/g, '\n'),
      scopes: SCOPES,
    });
  }
  return new google.auth.GoogleAuth({ scopes: SCOPES });
}
