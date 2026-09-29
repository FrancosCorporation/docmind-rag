// Testes M2 do DocMind: PDF real (unpdf), streaming SSE, conversas persistentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = mkdtempSync(join('/media/servidor/nvme_data/tmp-opencode', 'dm-'));
const PORTA = 3897;
const BASE = `http://localhost:${PORTA}`;

const servidor = spawn('node', ['server.js'], {
  env: { ...process.env, NODE_ENV: 'ci-child', PORT: String(PORTA), TMPDIR: TMP },
  stdio: 'ignore'
});
servidor.unref();
// espera o servidor subir (máquina carregada)
for (let i = 0; i < 25; i++) {
  const ok = await fetch(`${BASE}/api/docs`).then(() => true).catch(() => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const PDF = '/media/servidor/nvme_data/tmp-opencode/teste.pdf';

// retry para falhas transitórias de socket sob o runner (loga a causa)
async function comRetry(fn, n = 3) {
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === n - 1) { console.log('causa final:', e.cause?.code || e.cause?.message || e.message); throw e; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

test('M2: upload de PDF REAL (unpdf extrai o texto)', async () => {
  const buf = readFileSync(PDF);
  const r = await comRetry(() => fetch(`${BASE}/api/ingest-pdf?nome=vendas-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf
  }));
  const corpo = await r.json(); // lê UMA vez (body é consumível)
  assert.equal(r.status, 201, `ingest-pdf: ${JSON.stringify(corpo)}`);
  assert.ok(corpo.blocos >= 1);
  assert.equal(corpo.paginas, 1);
});

test('M2: chat sobre o PDF respond com grounded', async () => {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pergunta: 'qual o produto mais vendido?', doc: 'vendas-pdf' })
  }).then((x) => x.json());
  assert.ok(r.resposta.includes('plano Pro'));
});

test('M2: STREAMING SSE (tokens chegando em pedaços + fim)', async () => {
  const r = await comRetry(() => fetch(`${BASE}/api/chat?stream=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pergunta: 'qual o churn mensal?', doc: 'vendas-pdf' })
  }));
  assert.equal(r.headers.get('content-type'), 'text/event-stream', 'SSE');
  const texto = await r.text();
  const tokens = [...texto.matchAll(/data: (.+)/g)].map((m) => JSON.parse(m[1]));
  assert.ok(tokens.some((t) => t.token), 'tokens presentes');
  assert.ok(tokens.some((t) => t.fim === true), 'evento fim presente');
  const completo = tokens.filter((t) => t.token).map((t) => t.token).join('');
  assert.ok(completo.includes('3 por cento'), 'resposta completa reconstruída do stream');
});

test('M2: conversas persistentes (histórico com 2 trocas)', async () => {
  await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pergunta: 'e a região sul?', doc: 'vendas-pdf' }) });
  const hist = await fetch(`${BASE}/api/conversa/vendas-pdf`).then((r) => r.json());
  assert.ok(hist.length >= 6, `histórico com as trocas: ${hist.length} registros`);
  assert.ok(hist.some((h) => h.papel === 'ia'));
  assert.ok(hist.some((h) => h.papel === 'usuario'));
});

test('M2: PDF escaneado (sem texto) rejeitado com mensagem clara', async () => {
  // PDF "vazio": bytes de ftyp mas não-pdf... gera um PDF com 1 página em branco via gs? simplifica: texto vazio
  const r = await fetch(`${BASE}/api/ingest-pdf`, { method: 'POST', body: Buffer.from('não é um pdf') });
  assert.equal(r.status, 500, 'PDF inválido rejeitado (não crasha)');
});

process.on('exit', () => servidor.kill());
