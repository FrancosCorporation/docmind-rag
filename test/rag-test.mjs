// Testes do DocMind RAG — chunking, embeddings locais, busca com citações, pipeline, API real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { chunk, embedLocal, similaridadeCosseno, buscar, criarLLM, ingerir } from '../src/rag.js';

const TEXTO = `Relatório de vendas 2025.

O primeiro trimestre cresceu 20% comparado ao ano anterior. A região Sul liderou com 45% das vendas totais.

O produto mais vendido foi o plano Pro, responsável por 60% da receita recorrente. Churn ficou em 3% mensal.

A região Nordeste apresentou o maior crescimento proporcional: 80% em relação ao trimestre anterior. A meta do segundo trimestre é expandir a equipe comercial em 4 pessoas.`;

test('chunking: separa em blocos com overlap e hash', () => {
  const blocos = chunk(TEXTO, { tamanho: 200 });
  assert.ok(blocos.length >= 2, `texto de ~500 chars virou ${blocos.length} blocos`);
  for (const b of blocos) assert.ok(b.conteudo.length <= 260, 'limite respeitado com overlap');
  assert.ok(blocos.every((b) => b.hash.length === 8));
});

test('embedding local: determinístico e normalizado', () => {
  const v1 = embedLocal('vendas região sul');
  const v2 = embedLocal('vendas região sul');
  assert.deepEqual(v1, v2, 'determinístico');
  assert.equal(v1.length, 64);
  const norma = Math.sqrt(v1.reduce((t, x) => t + x * x, 0));
  assert.ok(Math.abs(norma - 1) < 1e-9, 'normalizado');
});

test('similaridade: texto igual > texto diferente', () => {
  const a = embedLocal('o produto mais vendido foi o plano Pro');
  const b = embedLocal('o produto mais vendido foi o plano Pro e a receita');
  const c = embedLocal('a meta do segundo trimestre é expandir a equipe');
  assert.ok(similaridadeCosseno(a, b) > similaridadeCosseno(a, c), 'relevância ordena certo');
});

test('busca: top-k com score ordenado', async () => {
  const blocos = await ingerir(TEXTO, { chunkOpts: { tamanho: 200 } });
  const pergunta = embedLocal('como foi a região Sul?');
  const top = buscar(blocos, pergunta, 2);
  assert.equal(top.length, 2);
  assert.ok(top[0].score >= top[1].score);
  assert.ok(top.some((t) => t.conteudo.includes('Sul')), 'achou o trecho da região Sul');
});

test('LLM local (mock grounded): responde com citação [doc N]', async () => {
  const blocos = await ingerir(TEXTO, { chunkOpts: { tamanho: 200 } });
  const llm = criarLLM({}); // sem baseUrl => local/mock
  const perguntaVetor = embedLocal('qual o produto mais vendido?');
  const contexto = buscar(blocos, perguntaVetor, 2);
  const r = await llm.responder('qual o produto mais vendido?', contexto);
  assert.ok(r.resposta.includes('[doc'), 'citação presente');
  assert.ok(r.resposta.includes('plano Pro'), 'conteúdo correto');
});

test('LLM local: pergunta fora do doc => "não encontrei"', async () => {
  const llm = criarLLM({});
  const r = await llm.responder('qual o clima de marte em 1999?', [
    { id: 1, conteudo: 'o plano Pro responde por 60% da receita' }
  ]);
  assert.ok(r.resposta.includes('Não encontrei'), 'não alucina');
  assert.deepEqual(r.fontes, []);
});

// ---- API real (servidor em porta de teste) ----
const PORTA = 3895;
const BASE = `http://localhost:${PORTA}`;
const servidor = spawn('node', ['server.js'], {
  env: { ...process.env, NODE_ENV: 'ci-child', PORT: String(PORTA), TMPDIR: '/media/servidor/nvme_data/tmp-opencode' },
  stdio: 'ignore'
});
servidor.unref();
await new Promise((r) => setTimeout(r, 1500));

// espera o servidor subir (máquina carregada pode demorar)
for (let i = 0; i < 20; i++) {
  const ok = await fetch(`${BASE}/api/docs`).then(() => true).catch(() => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const chamar = (metodo, rota, corpo) =>
  fetch(BASE + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined
  }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }));

test('API: ingest cria documento (201) e lista', async () => {
  const r = await chamar('POST', '/api/ingest', { nome: 'relatorio-vendas', texto: TEXTO });
  assert.equal(r.status, 201);
  assert.ok(r.corpo.blocos >= 1);
  const lista = await chamar('GET', '/api/docs');
  assert.ok(lista.corpo.some((d) => d.nome === 'relatorio-vendas'));
});

test('API: chat responde com citações ao vivo', async () => {
  const r = await chamar('POST', '/api/chat', { pergunta: 'como foi o churn?', doc: 'relatorio-vendas' });
  assert.equal(r.status, 200);
  assert.ok(r.corpo.resposta.includes('3%'), 'resposta grounded correta');
  assert.ok(Array.isArray(r.corpo.fontes));
});

test('API: ingest sem texto rejeitado (400)', async () => {
  const r = await chamar('POST', '/api/ingest', { nome: 'x' });
  assert.equal(r.status, 400);
});

process.on('exit', () => servidor.kill());
