# DocMind

Aplicação web para conversar com documentos PDF ou texto, encontrar trechos relacionados e conferir as fontes usadas na resposta. A interface e a API usam o mesmo token de acesso; documentos, trechos e conversas ficam em SQLite.

## Requisitos

- Node.js 22.13 ou superior
- Docker Compose (opcional)
- Um token aleatório de pelo menos 32 caracteres

## Iniciar com Docker Compose

Copie o exemplo, gere um token e cole o resultado em `DOCMIND_API_TOKEN`:

```bash
cp .env.example .env
openssl rand -hex 32
```

O arquivo `.env` fica assim:

```dotenv
DOCMIND_API_TOKEN=
# Opcional: endpoint OpenAI-compatible para respostas do modelo
LLM_BASE_URL=
LLM_API_KEY=
```

Inicie a aplicação:

```bash
docker compose up --build
```

Abra `http://localhost:3300` e informe o token. A porta do host fica limitada a `127.0.0.1`. O volume `docmind-data` mantém os documentos e conversas após reiniciar ou atualizar o contêiner.

## Iniciar localmente

```bash
npm install
DOCMIND_API_TOKEN="$(openssl rand -hex 32)" npm start
```

Por padrão, o banco fica em `data/docmind.sqlite`. Use `DOCMIND_DB_PATH` para escolher outro caminho. A API retorna `503` até receber um `DOCMIND_API_TOKEN` válido de pelo menos 32 caracteres.

## Usar

1. Conecte-se com o token configurado pelo operador.
2. Adicione um PDF ou cole o texto de um documento.
3. Selecione o documento e faça perguntas.
4. Abra as fontes exibidas abaixo da resposta para conferir os trechos originais.

Cada envio recebe um identificador próprio, mesmo que outro documento tenha o mesmo nome. Os endpoints de ingestão aceitam até 20 MB por PDF e 500 mil caracteres por documento. A instância limita a 1.000 documentos e 100 MB de texto por biblioteca; ingestão fica limitada a 30 envios por hora por biblioteca e o chat a 120 perguntas por hora por origem.

### API

Envie `Authorization: Bearer <DOCMIND_API_TOKEN>` em todas as rotas `/api`.

```http
POST /api/ingest
Authorization: Bearer <DOCMIND_API_TOKEN>
Content-Type: application/json

{"nome":"Contrato","texto":"Texto do documento com pelo menos dez caracteres."}
```

A resposta inclui o `id`, que deve ser usado nas próximas chamadas:

```http
POST /api/chat
Authorization: Bearer <DOCMIND_API_TOKEN>
Content-Type: application/json

{"doc":"<id devolvido na ingestão>","pergunta":"Qual é o prazo?"}
```

`GET /api/docs` lista somente a biblioteca da instância autenticada. `GET /api/conversa/:docId` devolve o histórico do documento. Adicione `?stream=1` ao chat para receber eventos SSE.

## Privacidade e limites

- O token é compartilhado por uma biblioteca de instância única. Qualquer pessoa que o possua pode acessar os mesmos documentos. Para separar clientes, use instâncias e tokens diferentes.
- A recuperação de trechos usa busca lexical local em todas as configurações. Sem `LLM_BASE_URL` e `LLM_API_KEY`, a resposta também fica no modo local e apresenta trechos que compartilham palavras com a pergunta. Esse modo não entende sinônimos ou significado como um modelo semântico.
- Com um provedor configurado, a pergunta e até três trechos selecionados (limitados a 400 caracteres cada) são enviados ao endpoint `LLM_BASE_URL`. O documento completo não é enviado pelo chat. Verifique as regras de retenção e privacidade do provedor antes de usar conteúdo sensível.
- O conteúdo de documentos é tratado como dado não confiável: o prompt do sistema é separado, instrui o modelo a ignorar comandos encontrados nas fontes e exige citações identificáveis. Prompt injection continua sendo uma limitação dos modelos; as citações e trechos permitem conferência, mas não provam que uma resposta esteja correta.
- O banco SQLite não é criptografado pela aplicação. Restrinja o acesso ao volume e proteja suas cópias de segurança.
- PDFs sem camada de texto (por exemplo, digitalizações sem OCR) não são processados.

## Desenvolvimento

O núcleo está em `src/rag.js`; persistência e limites em `src/store.js`; API e autenticação em `server.js`; interface em `public/`. O projeto contém testes existentes que podem ser executados com `npm test`.

## Licença

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation)).
