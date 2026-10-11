// DocMind — documentos privados com armazenamento persistente e respostas citadas.
import express from 'express';
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buscar, criarLLM, embedLocal, ingerir } from './src/rag.js';
import { openStore, StoreLimitError } from './src/store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_ROOT = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3300);
const MAX_DOCUMENT_CHARS = 500_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 1_000;
const MAX_QUESTION_CHARS = 2_000;
const API_TOKEN = (process.env.DOCMIND_API_TOKEN || '').trim();
const TOKEN_BUFFER = Buffer.from(API_TOKEN);
const TENANT_ID = 'default';
const DATABASE_PATH = process.env.DOCMIND_DB_PATH || join(ROOT, 'data', 'docmind.sqlite');

const { db, createDocument, listDocuments, getDocument, addConversation, getConversation } = openStore(DATABASE_PATH);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});

function erroHttp(status, codigo, mensagem) {
  const error = new Error(mensagem);
  error.status = status;
  error.code = codigo;
  error.publicError = true;
  return error;
}

function autenticar(req, res, next) {
  if (TOKEN_BUFFER.length < 32) {
    return res.status(503).json({ erro: { codigo: 'configuracao', mensagem: 'Configure DOCMIND_API_TOKEN com pelo menos 32 caracteres.' } });
  }
  const authorization = req.get('authorization') || '';
  const correspondencia = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!correspondencia) {
    return res.status(401).json({ erro: { codigo: 'autenticacao', mensagem: 'Informe um token de acesso válido.' } });
  }
  const recebido = Buffer.from(correspondencia[1]);
  if (recebido.length !== TOKEN_BUFFER.length || !timingSafeEqual(recebido, TOKEN_BUFFER)) {
    return res.status(401).json({ erro: { codigo: 'autenticacao', mensagem: 'Informe um token de acesso válido.' } });
  }
  req.tenantId = TENANT_ID;
  next();
}

function limitarRequisicoes({ limite, janelaMs, nome, chave = (req) => `${req.tenantId}:${req.ip}` }) {
  const buckets = new Map();
  const maxBuckets = 10_000;
  return (req, res, next) => {
    const agora = Date.now();
    const idBucket = `${chave(req)}:${nome}`;
    let bucket = buckets.get(idBucket);
    if (!bucket || bucket.expiraEm <= agora) {
      if (buckets.size >= maxBuckets) {
        for (const [key, entry] of buckets) if (entry.expiraEm <= agora) buckets.delete(key);
        if (buckets.size >= maxBuckets) {
          return res.status(429).json({ erro: { codigo: 'limite', mensagem: 'Muitas origens ativas. Tente novamente em alguns minutos.' } });
        }
      }
      bucket = { total: 0, expiraEm: agora + janelaMs };
      buckets.set(idBucket, bucket);
    }
    bucket.total += 1;
    if (bucket.total > limite) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.expiraEm - agora) / 1000))));
      return res.status(429).json({ erro: { codigo: 'limite', mensagem: 'Limite de requisições atingido. Tente novamente mais tarde.' } });
    }
    next();
  };
}

const limiteApi = limitarRequisicoes({ limite: 300, janelaMs: 60_000, nome: 'api' });
const limiteIngestao = limitarRequisicoes({ limite: 30, janelaMs: 60 * 60_000, nome: 'ingestao', chave: (req) => req.tenantId });
const limiteChat = limitarRequisicoes({ limite: 120, janelaMs: 60 * 60_000, nome: 'chat' });
app.use('/api', autenticar, limiteApi);
app.use(express.json({ limit: '3mb', strict: true }));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validarNome(nome) {
  if (typeof nome !== 'string') throw erroHttp(400, 'dados', 'Informe um nome para o documento.');
  const valor = nome.trim();
  if (!valor || valor.length > 120 || /[\u0000-\u001f\u007f]/.test(valor)) {
    throw erroHttp(400, 'dados', 'O nome deve ter entre 1 e 120 caracteres válidos.');
  }
  return valor;
}

async function salvarDocumento({ tenantId, nome, texto }) {
  if (typeof texto !== 'string' || texto.trim().length < 10) {
    throw erroHttp(400, 'dados', 'O documento precisa conter pelo menos 10 caracteres de texto.');
  }
  if (texto.length > MAX_DOCUMENT_CHARS) {
    throw erroHttp(413, 'limite', 'O documento excede o limite de 500 mil caracteres.');
  }
  const blocos = await ingerir(texto);
  if (blocos.length > 1_000) throw erroHttp(413, 'limite', 'O documento excede o limite de 1.000 trechos.');
  const documento = createDocument({
    id: randomUUID(),
    tenantId,
    nome,
    texto,
    blocos,
    criadoEm: new Date().toISOString()
  });
  return { ...documento, embedding: 'local-lexical' };
}

app.post('/api/ingest', limiteIngestao, asyncRoute(async (req, res) => {
  const corpo = req.body || {};
  const documento = await salvarDocumento({
    tenantId: req.tenantId,
    nome: validarNome(corpo.nome),
    texto: corpo.texto
  });
  res.status(201).json(documento);
}));

app.post('/api/ingest-pdf', limiteIngestao, express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: MAX_PDF_BYTES }), asyncRoute(async (req, res) => {
  const nome = validarNome(typeof req.query.nome === 'string' && req.query.nome ? req.query.nome : `Documento PDF ${new Date().toLocaleDateString('pt-BR')}`);
  const arquivo = req.body;
  if (!Buffer.isBuffer(arquivo) || arquivo.length === 0) {
    throw erroHttp(415, 'formato', 'Envie o PDF com Content-Type application/pdf ou application/octet-stream.');
  }
  if (!arquivo.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw erroHttp(400, 'pdf', 'Não foi possível ler o arquivo. Confira se ele é um PDF válido.');
  }
  let pdf;
  let text;
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    pdf = await getDocumentProxy(new Uint8Array(arquivo));
    if (pdf.numPages > MAX_PDF_PAGES) throw erroHttp(413, 'limite', 'O PDF excede o limite de 1.000 páginas.');
    ({ text } = await extractText(pdf, { mergePages: true }));
  } catch (error) {
    if (error.publicError) throw error;
    console.error('[docmind] Falha ao extrair PDF:', error);
    throw erroHttp(400, 'pdf', 'Não foi possível ler o arquivo. Confira se ele é um PDF válido.');
  }
  if (!text || text.trim().length < 10) {
    throw erroHttp(400, 'vazio', 'O PDF não contém texto extraível. PDFs digitalizados sem camada de texto não são compatíveis.');
  }
  const documento = await salvarDocumento({ tenantId: req.tenantId, nome, texto });
  res.status(201).json({ ...documento, paginas: pdf.numPages });
}));

async function responderChat(req, document, pergunta) {
  const perguntaVetor = embedLocal(pergunta);
  const relevantes = buscar(document.blocos, perguntaVetor, 3);
  const llm = criarLLM({ baseUrl: process.env.LLM_BASE_URL || '', apiKey: process.env.LLM_API_KEY || '' });
  const resposta = await llm.responder(pergunta, relevantes, { docId: document.id, signal: req.abortController.signal });
  return { ...resposta, retrievalBackend: 'local-lexical' };
}

app.post('/api/chat', limiteChat, asyncRoute(async (req, res) => {
  const { pergunta, doc: documentId } = req.body || {};
  if (typeof pergunta !== 'string' || !pergunta.trim() || pergunta.trim().length > MAX_QUESTION_CHARS) {
    throw erroHttp(400, 'dados', 'A pergunta deve ter entre 1 e 2.000 caracteres.');
  }
  if (typeof documentId !== 'string' || documentId.length > 64) throw erroHttp(400, 'dados', 'Informe o identificador do documento.');
  const document = getDocument(req.tenantId, documentId);
  if (!document) throw erroHttp(404, 'documento', 'Documento não encontrado.');

  const controller = new AbortController();
  req.abortController = controller;
  if (req.query.stream === '1') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  }

  const resposta = await responderChat(req, document, pergunta.trim());
  if (req.query.stream !== '1') {
    addConversation({ tenantId: req.tenantId, documentId, pergunta: pergunta.trim(), resposta });
    return res.json(resposta);
  }
  const fatias = resposta.resposta.match(/.{1,40}(?:\s|$)/gu) || [resposta.resposta];
  for (const fatia of fatias) {
    if (controller.signal.aborted || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify({ token: fatia })}\n\n`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 60));
  }
  if (controller.signal.aborted || res.writableEnded || res.destroyed) return;
  addConversation({ tenantId: req.tenantId, documentId, pergunta: pergunta.trim(), resposta });
  res.write(`data: ${JSON.stringify({ fim: true, fontes: resposta.fontes, backend: resposta.backend, retrievalBackend: resposta.retrievalBackend })}\n\n`);
  res.end();
}));

app.get('/api/conversa/:docId', (req, res) => {
  if (!getDocument(req.tenantId, req.params.docId)) {
    return res.status(404).json({ erro: { codigo: 'documento', mensagem: 'Documento não encontrado.' } });
  }
  res.json(getConversation(req.tenantId, req.params.docId));
});

app.get('/api/docs', (req, res) => res.json(listDocuments(req.tenantId)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};
app.use(asyncRoute(async (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erro: { codigo: 'rota', mensagem: 'Rota não encontrada.' } });
  }
  const caminho = resolve(PUBLIC_ROOT, `.${req.path === '/' ? '/index.html' : req.path}`);
  const relativo = relative(PUBLIC_ROOT, caminho);
  if (relativo.startsWith('..') || isAbsolute(relativo)) throw erroHttp(404, 'rota', 'Arquivo não encontrado.');
  try {
    const dados = await readFile(caminho);
    res.setHeader('Content-Type', MIME[extname(caminho)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(dados);
  } catch {
    throw erroHttp(404, 'rota', 'Arquivo não encontrado.');
  }
}));

app.use((error, req, res, _next) => {
  if (req.abortController?.signal.aborted || res.destroyed) return;
  const status = error instanceof StoreLimitError ? error.status : error.status || error.statusCode || 500;
  if (status >= 500) console.error('[docmind] Erro na requisição:', error);
  if (res.headersSent) return res.end();
  const mensagem = status === 413 && error.type === 'entity.too.large'
    ? 'O arquivo excede o limite de 20 MB.'
    : status === 400 && error.type === 'entity.parse.failed'
      ? 'O corpo JSON é inválido.'
      : status >= 500
        ? 'Não foi possível concluir a solicitação.'
        : error.message;
  res.status(status).json({ erro: { codigo: error.code || (status === 413 ? 'limite' : 'requisicao'), mensagem } });
});

const server = http.createServer(app);
server.once('close', () => db.close());
export { server, db };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log(`DocMind RAG em http://localhost:${PORT}`));
}
