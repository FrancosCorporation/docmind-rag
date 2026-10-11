import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_DOCUMENTS = 1_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_HISTORY_ITEMS = 100;

export class StoreLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreLimitError';
    this.status = 413;
    this.code = 'limite';
  }
}

export function openStore(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS documentos (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      criado_em TEXT NOT NULL,
      tamanho_bytes INTEGER NOT NULL CHECK (tamanho_bytes >= 0)
    );
    CREATE INDEX IF NOT EXISTS documentos_tenant_criado
      ON documentos (tenant_id, criado_em DESC);

    CREATE TABLE IF NOT EXISTS blocos (
      documento_id TEXT NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
      bloco_id INTEGER NOT NULL,
      conteudo TEXT NOT NULL,
      vetor TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (documento_id, bloco_id)
    );

    CREATE TABLE IF NOT EXISTS conversas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      documento_id TEXT NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
      papel TEXT NOT NULL CHECK (papel IN ('usuario', 'ia')),
      texto TEXT NOT NULL,
      fontes TEXT NOT NULL DEFAULT '[]',
      criado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversas_doc_id
      ON conversas (tenant_id, documento_id, id DESC);
  `);

  const conta = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(tamanho_bytes), 0) AS bytes FROM documentos WHERE tenant_id = ?');
  const inserirDocumento = db.prepare('INSERT INTO documentos (id, tenant_id, nome, criado_em, tamanho_bytes) VALUES (?, ?, ?, ?, ?)');
  const inserirBloco = db.prepare('INSERT INTO blocos (documento_id, bloco_id, conteudo, vetor, hash) VALUES (?, ?, ?, ?, ?)');

  function createDocument({ id, tenantId, nome, texto, blocos, criadoEm }) {
    const tamanhoBytes = Buffer.byteLength(texto, 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      const usage = conta.get(tenantId);
      if (usage.total >= MAX_DOCUMENTS) throw new StoreLimitError('O limite de documentos desta conta foi atingido.');
      if (usage.bytes + tamanhoBytes > MAX_TOTAL_BYTES) throw new StoreLimitError('O limite de armazenamento desta conta foi atingido.');
      inserirDocumento.run(id, tenantId, nome, criadoEm, tamanhoBytes);
      for (const bloco of blocos) {
        inserirBloco.run(id, bloco.id, bloco.conteudo, JSON.stringify(bloco.vetor), bloco.hash);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { id, nome, blocos: blocos.length, criadoEm };
  }

  function listDocuments(tenantId) {
    return db.prepare(`
      SELECT d.id, d.nome, d.criado_em AS criadoEm, COUNT(b.bloco_id) AS blocos
      FROM documentos d LEFT JOIN blocos b ON b.documento_id = d.id
      WHERE d.tenant_id = ?
      GROUP BY d.id
      ORDER BY d.criado_em DESC
    `).all(tenantId).map((row) => ({ ...row, blocos: Number(row.blocos) }));
  }

  function getDocument(tenantId, id) {
    const document = db.prepare('SELECT id, nome, criado_em AS criadoEm FROM documentos WHERE tenant_id = ? AND id = ?').get(tenantId, id);
    if (!document) return null;
    const blocos = db.prepare(`
      SELECT bloco_id AS id, conteudo, vetor, hash
      FROM blocos WHERE documento_id = ? ORDER BY bloco_id
    `).all(id).map((row) => ({ ...row, id: Number(row.id), vetor: JSON.parse(row.vetor) }));
    return { ...document, blocos };
  }

  function addConversation({ tenantId, documentId, pergunta, resposta }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare(`
        INSERT INTO conversas (tenant_id, documento_id, papel, texto, fontes, criado_em)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const agora = new Date().toISOString();
      insert.run(tenantId, documentId, 'usuario', pergunta, '[]', agora);
      insert.run(tenantId, documentId, 'ia', resposta.resposta, JSON.stringify(resposta.fontes || []), agora);
      db.prepare(`
        DELETE FROM conversas
        WHERE tenant_id = ? AND documento_id = ? AND id NOT IN (
          SELECT id FROM conversas
          WHERE tenant_id = ? AND documento_id = ?
          ORDER BY id DESC LIMIT ?
        )
      `).run(tenantId, documentId, tenantId, documentId, MAX_HISTORY_ITEMS);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getConversation(tenantId, documentId) {
    return db.prepare(`
      SELECT papel, texto, fontes AS fontesJson, criado_em AS criadoEm
      FROM conversas WHERE tenant_id = ? AND documento_id = ? ORDER BY id
    `).all(tenantId, documentId).map((row) => ({
      papel: row.papel,
      texto: row.texto,
      fontes: JSON.parse(row.fontesJson),
      criadoEm: row.criadoEm
    }));
  }

  return { db, createDocument, listDocuments, getDocument, addConversation, getConversation };
}
