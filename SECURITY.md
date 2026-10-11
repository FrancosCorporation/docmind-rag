# Segurança

## Reportar uma vulnerabilidade

Não publique detalhes de uma falha ainda não corrigida. Use o [formulário privado de vulnerabilidades do GitHub](https://github.com/FrancosCorporation/docmind-rag/security/advisories/new), se estiver habilitado para o repositório. Se a opção não estiver disponível, abra uma issue pedindo um canal privado, sem incluir os detalhes da falha. No relato privado, inclua passos para reproduzir e o impacto observado; evite anexar documentos ou segredos reais.

## Limites de segurança

- Toda rota `/api` exige o token configurado em `DOCMIND_API_TOKEN`. O token dá acesso à biblioteca inteira da instância; use instâncias separadas para clientes distintos e não compartilhe o segredo publicamente.
- Texto de documento é dado não confiável, nunca instrução. O prompt mantém as instruções em uma mensagem `system` separada e pede para ignorar comandos encontrados nos documentos. Isso reduz a superfície de prompt injection, mas não elimina a possibilidade de uma resposta incorreta. Confira o trecho citado.
- Quando um provedor LLM está configurado, a pergunta e os trechos recuperados são enviados a ele. Revise as regras de privacidade e retenção do provedor.
- O banco não é criptografado pela aplicação. Proteja o diretório `data/`, o volume Docker e os backups.

## Configuração

Use um token aleatório com pelo menos 32 caracteres, não o inclua no código ou em logs e limite o acesso de rede à instância. O Compose publicado localmente usa `127.0.0.1`; configure um proxy reverso com TLS caso precise de acesso remoto.
