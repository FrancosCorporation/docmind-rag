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

// ingestão: texto puro OU pdf (pdf-parse opcional — texto tem prioridade no M1)
app.post('/api/ingest', async (req, res) => {
  const { nome, texto } = req.body;
  if (!nome || !texto || texto.length < 10) {
    return res.status(400).json({ erro: { codigo: 'dados', mensagem: 'nome e texto (>=10 chars) obrigatórios' } });
  }
  const blocos = await ingerir(texto);
  documentos.set(nome, { blocos, criadoEm: new Date().toISOString() });
  res.status(201).json({ nome, blocos: blocos.length });
});

// listagem de documentos
app.get('/api/docs', (req, res) => {
  res.json([...documentos.entries()].map(([nome, d]) => ({ nome, blocos: d.blocos.length, criadoEm: d.criadoEm })));
});

// chat: pergunta -> busca top-k -> LLM grounded com citações
app.post('/api/chat', async (req, res) => {
  const { pergunta, doc } = req.body;
  if (!pergunta || !doc || !documentos.has(doc)) {
    return res.status(400).json({ erro: { codigo: 'dados', mensagem: 'pergunta e doc (ingestido) obrigatórios' } });
  }
  const { blocos } = documentos.get(doc);
  const embeddingsConfig = { baseUrl: process.env.LLM_BASE_URL || '', apiKey: process.env.LLM_API_KEY || '' };
  const { embedLocal, criarEmbeddings, criarLLM: criarLLMFac } = await import('./src/rag.js');
  const perguntaVetor = embedLocal(pergunta);
  const relevantes = buscar(blocos, perguntaVetor, 3);
  const llm = criarLLMFac(embeddingsConfig);
  const r = await llm.responder(pergunta, relevantes);
  res.json(r);
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
