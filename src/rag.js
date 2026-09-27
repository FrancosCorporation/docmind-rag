// DocMind M1 — núcleo RAG: chunking + embeddings plugáveis + busca vetorial + citações.
// Adapter plugável (padrão validado): real (OpenAI-compat) + mock determinístico (TF-IDF local).
import { createHash } from 'node:crypto';

// ---- chunker: separa o texto em blocos com overlap ----
export function chunk(texto, { tamanho = 500, overlap = 50 } = {}) {
  const paragrafos = texto.split(/\n\s*\n/).filter((p) => p.trim());
  const blocos = [];
  let atual = '';
  for (const p of paragrafos) {
    if ((atual + '\n\n' + p).length > tamanho && atual) {
      blocos.push(atual.trim());
      // overlap: mantém as últimas palavras do bloco anterior
      const palavras = atual.split(/\s+/).slice(-Math.ceil(overlap / 6));
      atual = palavras.join(' ') + '\n\n' + p;
    } else {
      atual = atual ? atual + '\n\n' + p : p;
    }
  }
  if (atual.trim()) blocos.push(atual.trim());
  return blocos.map((conteudo, i) => ({ id: i, conteudo, hash: createHash('md5').update(conteudo).digest('hex').slice(0, 8) }));
}

// ---- adapter de EMBEDDINGS: real (OpenAI-compat) ou local (TF-IDF determinístico) ----
export function criarEmbeddings({ baseUrl = '', apiKey = '', modelo = 'text-embedding-3-small', tentativas = 3 } = {}) {
  const local = !baseUrl || !apiKey;

  async function embed(textos) {
    if (local) return textos.map((t) => embedLocal(t));
    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
      try {
        const r = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: modelo, input: textos })
        });
        if (!r.ok) throw new Error(`embeddings ${r.status}`);
        const dados = await r.json();
        return dados.data.map((d) => d.embedding);
      } catch {
        if (tentativa === tentativas - 1) return textos.map((t) => embedLocal(t)); // fallback local
        await new Promise((r2) => setTimeout(r2, 1000 * 2 ** tentativa));
      }
    }
  }

  return { embed, local };
}

// embedding local DETERMINÍSTICO: vetor de 64 dimensões por hashing de palavras (TF-like)
export function embedLocal(texto) {
  const vetor = new Array(64).fill(0);
  const palavras = texto.toLowerCase().split(/\W+/).filter(Boolean);
  for (const p of palavras) {
    const h = createHash('sha1').update(p).digest();
    const idx = (h[0] << 8 | h[1]) % 64;
    vetor[idx] += 1;
  }
  // normaliza
  const norma = Math.sqrt(vetor.reduce((t, v) => t + v * v, 0)) || 1;
  return vetor.map((v) => v / norma);
}

// ---- busca: cosseno entre a pergunta e os blocos ----
export function similaridadeCosseno(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function buscar(blocos, perguntaVetor, topK = 3) {
  return blocos
    .map((b) => ({ ...b, score: similaridadeCosseno(b.vetor, perguntaVetor) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ---- adapter de LLM: real (OpenAI-compat) ou mock local (resposta grounded simples) ----
export function criarLLM({ baseUrl = '', apiKey = '', modelo = 'llama-3.1-70b-instruct' } = {}) {
  const local = !baseUrl || !apiKey;

  async function responder(pergunta, contexto) {
    if (local) return responderLocal(pergunta, contexto);
    const prompt = `Responda APENAS com base nos TRECHOS abaixo, citando [doc ${id}] de onde veio cada afirmação. Se a resposta não estiver nos trechos, diga "não encontrei no documento".
PERGUNTA: ${pergunta}
TRECHOS:\n${contexto.map((c) => `[doc ${c.id}] ${c.conteudo.slice(0, 400)}`).join('\n\n')}`;
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelo, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 800 })
    });
    if (!r.ok) throw new Error(`LLM ${r.status}`);
    const dados = await r.json();
    return { resposta: dados.choices?.[0]?.message?.content || '(sem resposta)', fontes: contexto.map((c) => c.id) };
  }

  // mock local GROUNDED: devolve os trechos mais relevantes como resposta (sem rede)
  function responderLocal(pergunta, contexto) {
    const palavras = pergunta.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const relevantes = contexto.filter((c) => palavras.some((p) => c.conteudo.toLowerCase().includes(p)));
    if (!relevantes.length) {
      return { resposta: 'Não encontrei essa informação no documento. Tente reformular ou verifique se o trecho existe.', fontes: [] };
    }
    const resposta = relevantes.map((c) => `[doc ${c.id}] ${c.conteudo.slice(0, 250)}${c.conteudo.length > 250 ? '…' : ''}`).join('\n\n');
    return { resposta, fontes: relevantes.map((c) => c.id) };
  }

  return { responder, local };
}

// ---- pipeline completo RAG: documento -> blocos com vetores ----
export async function ingerir(texto, { chunkOpts = {}, ...cfgEmbeddings } = {}) {
  const embeddings = criarEmbeddings(cfgEmbeddings);
  const blocos = chunk(texto, chunkOpts);
  const vetores = await embeddings.embed(blocos.map((b) => b.conteudo));
  return blocos.map((b, i) => ({ ...b, vetor: vetores[i] }));
}
