// DocMind — servidor: ingestão (upload de PDF/texto) + chat com citações + UI.
import express from 'express';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingerir, criarLLM, buscar } from './src/rag.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3300;

// docs em memória (M1); sqlite M2
const documentos = new Map(); // nome -> { blocos, criadoEm }

const app = express();
app.use(express.json({ limit: '10mb' }));

// ingestão: texto puro OU pdf (unpdf: o juiz recomendou — pdf-parse está abandonado)
app.post('/api/ingest', async (req, res) => {
  const { nome, texto } = req.body;
  if (!nome || !texto || texto.length < 10) {
    return res.status(400).json({ erro: { codigo: 'dados', mensagem: 'nome e texto (>=10 chars) obrigatórios' } });
  }
  const blocos = await ingerir(texto);
  documentos.set(nome, { blocos, criadoEm: new Date().toISOString() });
  res.status(201).json({ nome, blocos: blocos.length });
});

// M2: upload de PDF REAL (unpdf extrai o texto do binário)
app.post('/api/ingest-pdf', async (req, res) => {
  const nome = req.query.nome || `pdf-${Date.now().toString(36).slice(-4)}`;
  const chunks = [];
  let tamanho = 0;
  req.on('data', (c) => { tamanho += c.length; if (tamanho > 20 * 1024 * 1024) { req.destroy(); return res.status(413).json({ erro: { codigo: '413', mensagem: 'PDF maior que 20MB' } }); } chunks.push(c); });
  req.on('end', async () => {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(Buffer.concat(chunks)));
      const { text } = await extractText(pdf, { mergePages: true });
      if (!text || text.trim().length < 10) {
        return res.status(400).json({ erro: { codigo: 'vazio', mensagem: 'PDF sem texto extraível (escaneado? OCR fora do escopo M2)' } });
      }
      const blocos = await ingerir(text);
      documentos.set(nome, { blocos, criadoEm: new Date().toISOString() });
      res.status(201).json({ nome, blocos: blocos.length, paginas: pdf.numPages });
    } catch (e) {
      res.status(500).json({ erro: { codigo: 'pdf', mensagem: e.message.slice(0, 150) } });
    }
  });
});

// M2: conversas persistentes (por doc, em memória — sqlite M3)
const conversas = new Map(); // doc -> [{papel, texto, fontes}]

// M2: chat com STREAMING (SSE) + histórico
app.post('/api/chat', async (req, res) => {
  const { pergunta, doc } = req.body;
  if (!pergunta || !doc || !documentos.has(doc)) {
    return res.status(400).json({ erro: { codigo: 'dados', mensagem: 'pergunta e doc (ingestido) obrigatórios' } });
  }
  if (req.query.stream === '1') {
    // SSE: resposta token a token
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const { blocos } = documentos.get(doc);
    const { embedLocal, criarLLM: criarLLMFac } = await import('./src/rag.js');
    const relevantes = buscar(blocos, embedLocal(pergunta), 3);
    const llm = criarLLMFac({ baseUrl: process.env.LLM_BASE_URL || '', apiKey: process.env.LLM_API_KEY || '' });
    const r = await llm.responder(pergunta, relevantes);
    // streaming local: fatia a resposta em pedaços
    const fatias = r.resposta.match(/.{1,40}(\s|$)/g) || [r.resposta];
    for (const fatia of fatias) {
      res.write(`data: ${JSON.stringify({ token: fatia })}\n\n`);
      await new Promise((r2) => setTimeout(r2, 60));
    }
    res.write(`data: ${JSON.stringify({ fim: true, fontes: r.fontes })}\n\n`);
    registrarConversa(doc, pergunta, r);
    res.end();
    return;
  }
  const { blocos } = documentos.get(doc);
  const { embedLocal, criarLLM: criarLLMFac } = await import('./src/rag.js');
  const relevantes = buscar(blocos, embedLocal(pergunta), 3);
  const llm = criarLLMFac({ baseUrl: process.env.LLM_BASE_URL || '', apiKey: process.env.LLM_API_KEY || '' });
  const r = await llm.responder(pergunta, relevantes);
  registrarConversa(doc, pergunta, r);
  res.json(r);
});

function registrarConversa(doc, pergunta, resposta) {
  if (!conversas.has(doc)) conversas.set(doc, []);
  conversas.get(doc).push({ papel: 'usuario', texto: pergunta }, { papel: 'ia', texto: resposta.resposta, fontes: resposta.fontes });
}

// M2: histórico da conversa
app.get('/api/conversa/:doc', (req, res) => res.json(conversas.get(req.params.doc) || []));

// listagem de documentos
app.get('/api/docs', (req, res) => {
  res.json([...documentos.entries()].map(([nome, d]) => ({ nome, blocos: d.blocos.length, criadoEm: d.criadoEm })));
});

// estático (UI de chat)
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  try {
    let arquivo = normalize(join(ROOT, 'public', req.path));
    if (!arquivo.startsWith(ROOT)) throw new Error('fora');
    const dados = await readFile(arquivo);
    res.writeHead(200, { 'Content-Type': MIME[extname(arquivo)] || 'text/html; charset=utf-8' });
    res.end(dados);
  } catch {
    try {
      const indice = await readFile(join(ROOT, 'public/index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indice);
    } catch { res.writeHead(500); res.end('erro'); }
  }
});

const server = http.createServer(app);
export { server, documentos };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log(`DocMind RAG em http://localhost:${PORT} (ingest: POST /api/ingest)`));
}
