import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  endpoint: getEnvVar('CLOUD_ENDPOINT'),
  accessKeyId: getEnvVar('CLOUD_ACCESKEY'),
  secretAccessKey: getEnvVar('CLOUD_SECRETKEY'),
  publicUrl: getEnvVar('R2_PUBLIC_URL'),
  bucket: getEnvVar('R2_BUCKET'),
};

const UPLOAD_TIMEOUT_MS = 90_000; // 1.5 minutes
const MAX_RETRY_ATTEMPTS = 1; // Only retry once (2 total attempts)

function getSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function getHmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hexEncode(data: Buffer): string {
  return data.toString('hex');
}

function getAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function getCanonicalUri(key: string): string {
  return key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function _getCanonicalQueryString(searchParams: URLSearchParams): string {
  const sortedKeys = Array.from(searchParams.keys()).sort();
  return sortedKeys
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(searchParams.get(key) ?? '')}`,
    )
    .join('&');
}

function getCanonicalHeaders(headers: Record<string, string>): string {
  const _signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(';');
  const canonicalHeaders = Object.entries(headers)
    .map(([key, value]) => `${key.toLowerCase().trim()}:${value.trim()}`)
    .sort()
    .join('\n');
  return `${canonicalHeaders}\n`;
}

function createSignatureV4(
  method: string,
  path: string,
  query: string,
  headers: Record<string, string>,
  payloadHash: string,
  date: Date,
  region: string,
  service: string,
): { signature: string; authorizationHeader: string; signedHeaders: string } {
  const amzDate = getAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = getCanonicalUri(path);
  const canonicalQueryString = query;
  const canonicalHeaders = getCanonicalHeaders(headers);
  const signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const canonicalRequestHash = getSha256(Buffer.from(canonicalRequest));

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  const kDate = getHmac(
    Buffer.from(`AWS4${config.secretAccessKey}`),
    dateStamp,
  );
  const kRegion = getHmac(kDate, region);
  const kService = getHmac(kRegion, service);
  const kSigning = getHmac(kService, 'aws4_request');

  const signature = hexEncode(getHmac(kSigning, stringToSign));

  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope},` +
    `SignedHeaders=${signedHeaders},Signature=${signature}`;

  return { signature, authorizationHeader, signedHeaders };
}

export async function uploadVideoToR2(
  filePath: string,
  fileName: string,
): Promise<string | null> {
  const startTime = Date.now();
  const fileSize = statSync(filePath).size;

  console.log(
    `[R2 Upload] Starting upload: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`,
  );

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS + 1; attempt++) {
    try {
      console.log(`[R2 Upload] Attempt ${attempt}/${MAX_RETRY_ATTEMPTS + 1}`);
      const result = await uploadAttempt(filePath, fileName, fileSize);
      const duration = Date.now() - startTime;
      console.log(
        `[R2 Upload] Upload completed in ${(duration / 1000).toFixed(2)}s`,
      );
      return result;
    } catch (error) {
      console.error(
        `[R2 Upload] Attempt ${attempt} failed:`,
        error instanceof Error ? error.message : String(error),
      );

      if (attempt <= MAX_RETRY_ATTEMPTS) {
        console.log(`[R2 Upload] Retrying in 2 seconds...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        console.error(`[R2 Upload] All attempts failed for ${fileName}`);
        return null;
      }
    }
  }

  return null;
}

async function uploadAttempt(
  filePath: string,
  fileName: string,
  fileSize: number,
): Promise<string> {
  const attemptStartTime = Date.now();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(
      `[R2 Upload] Upload timeout after ${UPLOAD_TIMEOUT_MS}ms, aborting...`,
    );
    abortController.abort();
  }, UPLOAD_TIMEOUT_MS);

  try {
    const url = new URL(config.endpoint);
    const host = url.host;
    const path = `/${config.bucket}/${fileName}`;

    const date = new Date();
    const amzDate = getAmzDate(date);

    const headersForSignature: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'content-type': 'video/mp4',
      'cache-control': 'public, max-age=604800',
    };

    const { authorizationHeader } = createSignatureV4(
      'PUT',
      path,
      '',
      headersForSignature,
      'UNSIGNED-PAYLOAD',
      date,
      'auto',
      's3',
    );

    const headersForFetch: Record<string, string> = {
      ...headersForSignature,
      authorization: authorizationHeader,
      'content-length': String(fileSize),
    };

    const uploadUrl = `${config.endpoint}${path}`;
    console.log(`[R2 Upload] PUT request to: ${uploadUrl}`);
    console.log(
      `[R2 Upload] Headers:`,
      JSON.stringify(headersForFetch, null, 2),
    );

    console.log(`[R2 Upload] Reading file into buffer...`);
    const fileBuffer = readFileSync(filePath);
    console.log(`[R2 Upload] File read, starting upload...`);

    const uploadPromise = fetch(uploadUrl, {
      method: 'PUT',
      headers: headersForFetch,
      body: fileBuffer,
      signal: abortController.signal,
    });

    let lastProgress = 0;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - attemptStartTime;
      if (elapsed > lastProgress + 5000) {
        lastProgress = elapsed;
        console.log(
          `[R2 Upload] Still uploading... (${elapsed / 1000}s elapsed)`,
        );
      }
    }, 5000);

    try {
      const response = await uploadPromise;

      clearInterval(progressInterval);

      console.log(
        `[R2 Upload] Response status: ${response.status} ${response.statusText}`,
      );
      console.log(
        `[R2 Upload] Response headers:`,
        JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2),
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[R2 Upload] Server response:`, errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      console.log(`[R2 Upload] Upload successful`);
      return `${config.publicUrl}/${fileName}`;
    } catch (uploadError) {
      clearInterval(progressInterval);
      throw uploadError;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
