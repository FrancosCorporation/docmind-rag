const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = 'docmind-access-token';
let documents = [];
let activeDocumentId = null;
let sending = false;

function setStatus(text, kind = '') {
  const status = $('#estado');
  status.textContent = text;
  status.className = `status${kind ? ` ${kind}` : ''}`;
}

function tokenAtual() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = tokenAtual();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.json);
    delete options.json;
  }
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.erro?.mensagem || `Solicitação falhou (${response.status}).`);
  return body;
}

function renderDocumentList() {
  const list = $('#lista-docs');
  list.replaceChildren();
  $('#contador-docs').textContent = String(documents.length);
  for (const document of documents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `doc-button${document.id === activeDocumentId ? ' active' : ''}`;
    button.setAttribute('aria-current', document.id === activeDocumentId ? 'true' : 'false');
    button.addEventListener('click', () => selectDocument(document.id));

    const icon = document.createElement('span');
    icon.className = 'doc-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'DOC';
    const copy = document.createElement('span');
    copy.className = 'doc-copy';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = document.nome;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = `${document.blocos} ${document.blocos === 1 ? 'trecho' : 'trechos'}`;
    copy.append(name, meta);
    button.append(icon, copy);
    list.append(button);
  }
}

function setChatEnabled(enabled) {
  $('#pergunta').disabled = !enabled;
  $('#perguntar').disabled = !enabled || sending;
  $('#pergunta').placeholder = enabled ? 'Pergunte sobre este documento…' : 'Selecione um documento para perguntar';
}

function appendMessage(role, text, sources = []) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${role === 'usuario' ? 'user' : 'assistant'}`;
  const label = document.createElement('p');
  label.className = 'message-label';
  label.textContent = role === 'usuario' ? 'Você' : 'DocMind';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  wrapper.append(label, bubble);

  if (sources.length) {
    const sourceList = document.createElement('div');
    sourceList.className = 'sources';
    for (const source of sources) {
      const card = document.createElement('details');
      card.className = 'source-card';
      const title = document.createElement('summary');
      title.textContent = `Fonte ${source.citation || `${source.docId}#${source.chunk}`}`;
      const excerpt = document.createElement('p');
      excerpt.textContent = source.trecho || '';
      card.append(title, excerpt);
      sourceList.append(card);
    }
    wrapper.append(sourceList);
  }
  $('#mensagens').append(wrapper);
  wrapper.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return wrapper;
}

async function selectDocument(id) {
  const document = documents.find((item) => item.id === id);
  if (!document) return;
  activeDocumentId = id;
  renderDocumentList();
  $('#chat-vazio').hidden = true;
  $('#chat-cabecalho').hidden = false;
  $('#doc-ativo').textContent = document.nome;
  $('#backend').textContent = 'Busca lexical local';
  $('#mensagens').replaceChildren();
  setChatEnabled(true);
  try {
    const history = await api(`/api/conversa/${encodeURIComponent(id)}`);
    for (const entry of history) appendMessage(entry.papel, entry.texto, entry.papel === 'ia' ? entry.fontes : []);
  } catch (error) {
    setStatus(error.message, 'error');
  }
  $('#pergunta').focus();
}

async function atualizarDocumentos({ selectFirst = true } = {}) {
  documents = await api('/api/docs');
  if (!documents.some((document) => document.id === activeDocumentId)) activeDocumentId = null;
  renderDocumentList();
  if (activeDocumentId) await selectDocument(activeDocumentId);
  else if (selectFirst && documents.length) await selectDocument(documents[0].id);
  else {
    $('#chat-vazio').hidden = false;
    $('#chat-cabecalho').hidden = true;
    setChatEnabled(false);
  }
}

$('#conectar').addEventListener('click', async () => {
  const token = $('#token').value.trim();
  if (!token) {
    sessionStorage.removeItem(TOKEN_KEY);
    documents = [];
    activeDocumentId = null;
    renderDocumentList();
    setChatEnabled(false);
    setStatus('Cole o token de acesso configurado pelo administrador.', 'error');
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  $('#conectar').disabled = true;
  setStatus('Conectando à sua biblioteca…');
  try {
    await atualizarDocumentos();
    setStatus(`${documents.length} ${documents.length === 1 ? 'documento disponível' : 'documentos disponíveis'}.`, 'success');
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY);
    documents = [];
    activeDocumentId = null;
    renderDocumentList();
    setChatEnabled(false);
    setStatus(error.message, 'error');
  } finally {
    $('#conectar').disabled = false;
  }
});

$('#ingerir').addEventListener('click', async () => {
  if (!tokenAtual()) return setStatus('Conecte-se com seu token antes de adicionar documentos.', 'error');
  const nome = $('#nome-doc').value.trim();
  const arquivo = $('#arquivo-doc').files[0];
  const texto = $('#texto-doc').value.trim();
  if (!nome) return setStatus('Informe um nome para o documento.', 'error');
  if (Boolean(arquivo) === Boolean(texto)) return setStatus('Escolha um PDF ou cole o texto do documento.', 'error');

  const button = $('#ingerir');
  button.disabled = true;
  button.textContent = 'Adicionando…';
  setStatus('Preparando o documento e seus trechos…');
  try {
    let document;
    if (arquivo) {
      const query = new URLSearchParams({ nome });
      document = await api(`/api/ingest-pdf?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: arquivo
      });
    } else {
      document = await api('/api/ingest', { method: 'POST', json: { nome, texto } });
    }
    $('#nome-doc').value = '';
    $('#arquivo-doc').value = '';
    $('#texto-doc').value = '';
    await atualizarDocumentos({ selectFirst: false });
    await selectDocument(document.id);
    setStatus(`“${document.nome}” foi adicionado à biblioteca.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Adicionar à biblioteca';
  }
});

$('#form-chat').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pergunta = $('#pergunta').value.trim();
  if (!pergunta || !activeDocumentId || sending) return;
  $('#pergunta').value = '';
  appendMessage('usuario', pergunta);
  const pending = appendMessage('ia', 'Consultando os trechos relevantes…');
  sending = true;
  setChatEnabled(Boolean(activeDocumentId));
  try {
    const answer = await api('/api/chat', { method: 'POST', json: { pergunta, doc: activeDocumentId } });
    pending.remove();
    appendMessage('ia', answer.resposta, answer.fontes || []);
    $('#backend').textContent = answer.backend === 'local-lexical'
      ? 'Resposta local · busca lexical'
      : 'LLM configurado · busca lexical local';
  } catch (error) {
    pending.remove();
    appendMessage('ia', error.message);
  } finally {
    sending = false;
    setChatEnabled(Boolean(activeDocumentId));
    $('#pergunta').focus();
  }
});

$('#pergunta').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#form-chat').requestSubmit();
  }
});

$('#token').value = tokenAtual();
setChatEnabled(false);
if (tokenAtual()) $('#conectar').click();
