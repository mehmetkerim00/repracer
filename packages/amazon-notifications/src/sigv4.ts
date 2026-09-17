import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 для запросов к Amazon SQS — по странице «Create a signed AWS API request»
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html, SHA-256 — vendor/aws/SOURCE.md):
 * канонический запрос → строка для подписи → производный ключ (дата, регион, сервис, aws4_request) → подпись HMAC-SHA256.
 * Подписываются host, content-type и все x-amz-*; hop-by-hop заголовки (user-agent, connection) не подписываются, как требует страница.
 * Секретный ключ и подпись не логируются и не попадают в ошибки.
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Временные учётные данные: заголовок x-amz-security-token подписывается */
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** 20130524T000000Z */
export function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 3986: всё, кроме A-Z a-z 0-9 - _ . ~ */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalRequest(req: SignableRequest, signedHeaderNames: readonly string[]): string {
  const url = new URL(req.url);
  const path = url.pathname === '' ? '/' : url.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/');
  const query = [...url.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const lower = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${lower[h] ?? ''}\n`).join('');
  return [req.method.toUpperCase(), path, query, canonicalHeaders, signedHeaderNames.join(';'), sha256(req.body)].join('\n');
}

/**
 * Подписывает запрос: возвращает заголовки с host, x-amz-date, x-amz-security-token (если есть) и Authorization.
 * service для SQS — «sqs»; region — регион очереди (из её адреса).
 */
export function signRequest(req: SignableRequest, credentials: AwsCredentials, region: string, service: string, at: Date): Record<string, string> {
  const url = new URL(req.url);
  const date = amzDate(at);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...req.headers, host: url.host, 'x-amz-date': date };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const signed = Object.keys(headers).map((h) => h.toLowerCase())
    .filter((h) => h === 'host' || h === 'content-type' || h.startsWith('x-amz-')).sort();
  const canonical = canonicalRequest({ ...req, headers }, signed);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` };
}
