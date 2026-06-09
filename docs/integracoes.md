# Integrações — Gmail, Agenda, Sheets, Drive

A Empresa.ia se conecta ao Google Workspace do dono via **Composio**, sem sair do WhatsApp.

## Como funciona

O agente OpenClaw usa as ferramentas Composio via SDK. Quando o dono pede algo que envolve Gmail, Agenda, Sheets ou Drive, a Sofia (ou a especialista certa) acessa direto.

Exemplos:
- *"Me manda um resumo dos emails de hoje"* → Helena vai ao Gmail
- *"Quais são meus compromissos de amanhã?"* → Nina consulta o Agenda
- *"Atualiza a planilha de leads com esse contato"* → Clara escreve no Sheets

## Configuração

### 1. Criar conta Composio

1. Acesse [app.composio.dev](https://app.composio.dev)
2. Crie uma conta e pegue sua API key
3. Adicione no `.env`:
   ```bash
   COMPOSIO_API_KEY=sua-chave-composio
   COMPOSIO_USER_ID=seu-user-id
   ```

### 2. Conectar as contas Google

No painel Composio, conecte as ferramentas que você quer usar:
- Gmail
- Google Calendar
- Google Sheets
- Google Drive

Composio gerencia o OAuth e o refresh de tokens. Você conecta uma vez e a Empresa.ia usa sempre que precisar.

### 3. Ativar no agente

O OpenClaw precisa ter as ferramentas Composio habilitadas no seu workspace. Consulte a documentação do OpenClaw para adicionar ferramentas externas via `COMPOSIO_API_KEY`.

## Comando @conectar

No WhatsApp, o dono pode digitar `@conectar` para iniciar o fluxo de conexão de integrações. A Sofia guia o processo dentro do próprio chat.

## Integrações disponíveis

| Integração | O que faz | Quem usa mais |
|------------|-----------|---------------|
| Gmail | Ler, resumir, rascunhar e-mails | Helena (financeiro), Sofia |
| Google Calendar | Ver, criar, editar eventos | Nina (rotina) |
| Google Sheets | Ler e escrever dados | Clara (vendas/CRM), Helena |
| Google Drive | Buscar e acessar arquivos | Lara (operação) |

## Segurança

- Os tokens OAuth ficam armazenados no Composio (não no servidor da Empresa.ia)
- `COMPOSIO_API_KEY` é a única credencial necessária no lado da Empresa.ia
- Nunca commite `COMPOSIO_API_KEY` no repositório
