# Como contribuir com a Empresa.ia

Obrigado por querer contribuir! Este guia explica como participar do projeto.

---

## Configuração de desenvolvimento

```bash
git clone https://github.com/seu-usuario/empresa-ia-oss.git
cd empresa-ia-oss
./setup.sh
```

Depois de rodar o setup, o projeto está pronto para desenvolvimento local. Você não precisa de uma instância WhatsApp real para rodar os testes — o `test/empresaia.test.js` usa um servidor uazapi fake.

---

## Rodando os testes

```bash
npm test
```

16 testes cobrindo: roteamento de mensagens, carrosséis, usage tracking, health check, comandos. Todos devem passar antes de abrir um PR.

---

## Fluxo de trabalho com branches

1. Faça fork do repositório
2. Crie uma branch a partir de `main`:
   ```bash
   git checkout -b feat/nome-da-funcionalidade
   # ou
   git checkout -b fix/descricao-do-bug
   ```
3. Faça suas alterações com commits pequenos e descritivos
4. Abra um Pull Request contra `main`

### Formato de commits

```
<tipo>: <descrição curta em português ou inglês>

<corpo opcional explicando o porquê>
```

Tipos: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

Exemplos:
- `feat: adiciona suporte a vídeos maiores que 50MB`
- `fix: corrige deduplicação de mensagens SSE em reconexão`
- `docs: atualiza passo de instalação do LiveKit`

---

## O que contribuir

### Boas primeiras contribuições

- Melhorias nos comentários do `.env.example`
- Novos testes para casos de borda em `test/empresaia.test.js`
- Correções na documentação em `docs/`
- Melhorias no `setup.sh` para mais sistemas operacionais

### Funcionalidades novas

Para funcionalidades maiores, abra uma **issue** primeiro descrevendo o que você quer fazer. Isso evita trabalho duplicado e alinha expectativas antes de codar.

### Novas personas

As personas vivem em `voz-agente.py` (dict `PERSONAS`) e em `gen-audios.py` (dict `ROTEIROS`). Se quiser adicionar ou ajustar uma persona:
1. Adicione/edite a entrada em `PERSONAS` com `voice`, `nome`, `setor`, `sotaque`, `jeito`
2. Adicione o roteiro correspondente em `ROTEIROS`
3. Certifique-se de que a voz Gemini escolhida existe (consulte a [lista de vozes do Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation))
4. Atualize `FLUXO-EXPERIENCIA.md` se a persona aparecer na equipe principal

---

## Estilo de código

**JavaScript (bridge.js e scripts):**
- `'use strict'` em todos os arquivos Node.js
- `const` por padrão, `let` quando necessário, nunca `var`
- Funções pequenas com responsabilidade única
- Sem `console.log` de debug (use a função `log()` do bridge que inclui timestamp)
- Comentários em português para lógica de negócio, inglês para termos técnicos

**Python (voz-agente.py, gen-audios.py):**
- PEP 8
- Type hints nas assinaturas de funções novas
- Docstrings em português para funções públicas

**Geral:**
- Máximo 800 linhas por arquivo
- Trate todos os erros explicitamente — sem `catch` vazio
- Nunca commite chaves, tokens ou dados reais

---

## Segurança

Se você encontrar uma vulnerabilidade de segurança, **não abra uma issue pública**. Entre em contato pelo email listado no perfil do repositório.

Antes de qualquer commit, verifique:
- Nenhum segredo, token ou chave real no código
- Nenhum dado de usuário real nos testes
- O `.env` continua listado no `.gitignore`

---

## Usando Claude Code

Este projeto inclui um `CLAUDE.md` com contexto completo da arquitetura. Se estiver contribuindo com Claude Code:

```bash
claude    # Lê CLAUDE.md automaticamente e entende o projeto completo
```

---

## Revisão de PRs

Todos os PRs passam por revisão antes de merge. O que avaliamos:

- Os testes passam (`npm test`)
- O código segue as convenções do projeto
- A mudança está documentada (se relevante)
- Nenhuma chave ou dado sensível foi incluído

---

Qualquer dúvida, abra uma issue. Obrigado por contribuir!
