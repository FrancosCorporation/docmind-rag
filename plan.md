# Plan — docmind-rag

## 1. Visão geral

- **Nome:** docmind-rag — "converse com seus documentos"
- **Descrição:** chat RAG self-hosted: ingestão de PDF/texto com chunking, embeddings plugáveis, busca vetorial e citações de fonte verificáveis; biblioteca isolada por instância com token Bearer obrigatório; persistência SQLite com cotas.
- **Problema que resolve:** Q&A sobre documentos próprios sem enviar dados a SaaS, com mitigação explícita de prompt injection (instruções em `system`, perguntas/fontes como dados).
- **Estado atual:** SEC-01..06, BUG-01..04, IMP-01..03, DEVOPS-01/02, DOC-01/02 concluídos em 2026-10-11; CI modernizada nesta sessão.

## 2. Arquitetura e tecnologias

- Node ≥ 22.13, ESM; express 4 + unpdf; SQLite local (`data/`, ignorado); SSE com cancelamento real no disconnect.
- Embeddings plugáveis (backend configurável); modo lexical disponível.
- Docker/Compose com volume persistente, token obrigatório e bind local.
- CI: 2 suítes de teste + scan de licenças; **modernizada nesta sessão**.

## 3. Funcionalidades existentes

- [x] Ingestão PDF/texto com cotas (30/h; 1.000 docs/100 MB) — implementado.
- [x] Respostas com fontes verificáveis (`docId`, `chunk`, `citation`, trecho) — implementado.
- [x] Persistência SQLite (documentos, blocos, conversas; histórico ≤100/doc) — implementado.
- [x] SSE aborta geração/escrita na desconexão — implementado.
- [x] Segregação por instância + Bearer obrigatório — implementado.
- [x] CI com testes — **modernizada nesta sessão** (Ubuntu 24.04, Actions v7, Node 22/24, `npm ci`, gate audit).

## 4. Objetivos futuros

- **OBJ-01 (P2, concluído nesta sessão):** CI previsível com gates.
- **OBJ-02 (P2, pendente TEST-01):** caso de teste dedicado a prompt injection quando testes forem liberados para adição.
- **OBJ-03 (P3, recomendação):** expor métricas de ingestão/latência no endpoint de saúde.
- **OBJ-04 (P3, recomendação):** versionar uma fixture PDF mínima gerada (ou textual via `fpdf`-style builder) para reativar os 4 testes de PDF em qualquer ambiente, removendo o skip condicional criado em 2026-10-14.

## 5. Melhorias técnicas

- **Segurança:** manter a regra "instruções no system, dados no user" em qualquer nova rota de LLM.
- **Infraestrutura:** ✅ CI endurecida.

## 6. Roadmap

- **Fase 1–3:** concluídas. **Fase 4:** OBJ-02 (P2) → OBJ-03 (P3).

## 7. Backlog priorizado

1. OBJ-02 — teste de prompt injection (P2, bloqueado pela regra de testes).
2. OBJ-03 — métricas mínimas (P3).

## 8. Riscos e pendências

- RAG depende do provedor de embeddings/LLM: prompt injection é mitigado, não eliminado — §SEC-01 do MELHORIAS declara isso; manter a honestidade no README.
- Validação comportamental completa (acesso humano à UI) segue pendente por regra.

## 9. Ideias adicionais

- Suporte a DOCX/Markdown na ingestão (unpdf cobre PDF hoje).

---
*(Gerado em 2026-10-14 pelo agente orquestrador)*
