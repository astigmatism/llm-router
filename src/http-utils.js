import fs from 'node:fs/promises';
import path from 'node:path';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host'
]);

export async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (maxBytes > 0 && total > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBuffer(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const text = buffer.toString('utf8');
  if (!text.trim()) return null;
  return JSON.parse(text);
}

export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

export function sendText(response, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(String(body), 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    ...extraHeaders
  });
  response.end(payload);
}

export function methodAllowsBody(method) {
  return !['GET', 'HEAD'].includes(String(method).toUpperCase());
}

export function filterRequestHeaders(headers, overrides = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-admin-token')) continue;
    if (Array.isArray(value)) result[key] = value.join(', ');
    else if (value !== undefined) result[key] = String(value);
  }
  return { ...result, ...overrides };
}

export function copyUpstreamHeaders(upstreamHeaders, response, streaming = false) {
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (streaming && lower === 'content-length') continue;
    response.setHeader(key, value);
  }
  response.setHeader('x-ollama-router', 'llm-router');
  response.setHeader('cache-control', 'no-store');
}

export function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress || 'unknown';
}

export function getClientIdentity(request) {
  const explicit = request.headers['x-client-name'] || request.headers['x-router-client'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const userAgent = request.headers['user-agent'];
  if (typeof userAgent === 'string' && userAgent.trim()) return userAgent.trim().slice(0, 120);
  return getClientIp(request);
}

export function hasAdminAuth(request, config) {
  if (!config.adminToken) return true;
  const headerName = String(config.adminSessionHeader || 'X-Admin-Token').toLowerCase();
  const tokenHeader = request.headers[headerName] || request.headers['x-admin-token'];
  if (typeof tokenHeader === 'string' && tokenHeader === config.adminToken) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.trim() === `Bearer ${config.adminToken}`) return true;
  return false;
}

export function requireAdmin(request, response, config) {
  if (hasAdminAuth(request, config)) return true;
  sendJson(response, 401, {
    error: {
      code: 'ADMIN_AUTH_REQUIRED',
      message: 'Admin API requires Authorization: Bearer <token> or X-Admin-Token.'
    }
  });
  return false;
}

export function summarizeBody(body, mode = 'metadata') {
  if (!body || typeof body !== 'object') return null;
  if (mode === 'off') return null;
  if (mode === 'full') return body;

  const summary = {};
  const countImages = (value) => {
    if (Array.isArray(value)) return value.reduce((total, item) => total + countImages(item), 0);
    if (!value || typeof value !== 'object') return 0;
    let total = ['image', 'image_url', 'input_image'].includes(value.type) ? 1 : 0;
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'images' && Array.isArray(nested)) total += nested.length;
      else if (key !== 'image_url') total += countImages(nested);
    }
    return total;
  };
  if (typeof body.prompt === 'string') summary.promptChars = body.prompt.length;
  if (typeof body.system === 'string') summary.systemChars = body.system.length;
  if (Array.isArray(body.messages)) {
    summary.messageCount = body.messages.length;
    summary.messageRoles = body.messages.map((message) => typeof message?.role === 'string' ? message.role : 'unknown');
    summary.messageContentChars = body.messages.reduce((total, message) => {
      const content = message?.content;
      if (typeof content === 'string') return total + content.length;
      if (Array.isArray(content)) return total + JSON.stringify(content).length;
      return total;
    }, 0);
    const messageImageCount = countImages(body.messages);
    if (messageImageCount > 0) summary.messageImageCount = messageImageCount;
  }
  if (Array.isArray(body.images)) summary.imageCount = body.images.length;
  if (Array.isArray(body.input)) {
    summary.inputCount = body.input.length;
    const inputImageCount = countImages(body.input);
    if (inputImageCount > 0) summary.inputImageCount = inputImageCount;
  }
  if (typeof body.input === 'string') summary.inputChars = body.input.length;
  if (typeof body.stream === 'boolean') summary.stream = body.stream;
  if (body.options && typeof body.options === 'object') summary.optionKeys = Object.keys(body.options).sort();
  if (body.format) summary.hasFormat = true;
  return summary;
}

export async function serveStaticFile(response, rootDir, relativePath) {
  const safeRelative = relativePath.replace(/^\/+/, '').replace(/\.\.+/g, '');
  const filePath = path.join(rootDir, safeRelative || 'index.html');
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': contentTypes[ext] || 'application/octet-stream',
      'content-length': content.length,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendText(response, 404, 'Not found\n');
      return;
    }
    throw error;
  }
}
