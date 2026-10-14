# mcp-gpt-image

[English](README.md)

Servidor MCP e skill que deixam o Claude Code gerar e editar imagens com o GPT Image usando o Codex CLI instalado no seu computador. Usa o login do ChatGPT. Sem chave de API da OpenAI.

O Claude escreve o prompt. O Codex o repassa à ferramenta `image_gen` dele. A imagem é salva em disco e volta para o Claude na própria resposta. A skill faz o Claude revisar cada imagem com um checklist rigoroso e gerar de novo (até 3 tentativas) até ela passar.

## Requisitos

- Node.js 20 ou mais novo
- git (o npx baixa este pacote do GitHub)
- Claude Code
- Codex CLI logado com um plano do ChatGPT que inclua geração de imagem:

```bash
npm install -g @openai/codex
```

```bash
codex login
```

## Instalação

```bash
npx -y github:Monayzera/mcp-gpt-image setup
```

O comando faz três coisas:

1. Copia a skill para `~/.claude/skills/gpt-image/SKILL.md` (ou `$CLAUDE_CONFIG_DIR/skills/...`).
2. Registra o servidor MCP no Claude Code no escopo de usuário, como `npx -y github:Monayzera/mcp-gpt-image` (no Windows, dentro de `cmd /c`). Se `CODEX_PATH` estiver definido, ele é repassado ao servidor. Um `gpt-image` já registrado no escopo de usuário não é alterado; se estiver em outro escopo, o setup avisa para você removê-lo.
3. Confere se o Codex está instalado e logado.

Depois, reinicie o Claude Code. O `claude mcp list` deve mostrar o `gpt-image` como conectado.

Rodar o `setup` de novo substitui a skill pela versão mais recente, inclusive edições locais. O npx busca o commit mais novo a cada início, então o servidor se atualiza sozinho.

Para registrar só o servidor MCP, sem a skill:

```bash
claude mcp add --scope user gpt-image -- npx -y github:Monayzera/mcp-gpt-image
```

## Desinstalação

```bash
npx -y github:Monayzera/mcp-gpt-image uninstall
```

Remove a skill e roda `claude mcp remove gpt-image --scope user`.

## Uso

Peça a imagem ao Claude. A skill cuida do resto: briefing, prompt, geração, revisão e novas tentativas.

> Faça uma imagem 16:9 para o topo da landing page: um moedor de café preto fosco numa bancada de concreto, luz suave de janela.

> Edite assets/logo.png: mantenha o formato e deixe o fundo transparente.

Tamanho e proporção não são parâmetros. Eles vão no prompt: "16:9" gerou 1672x941 nos testes.

## Ferramentas

### generate_image

| Parâmetro | Padrão | Descrição |
| --- | --- | --- |
| `prompt` | obrigatório | O prompt da imagem. |
| `count` | `1` | Imagens do mesmo prompt, de 1 a 4. Cada uma consome seu limite. O Codex pode devolver menos. |
| `transparent_background` | `false` | Pede fundo transparente. O resultado informa se o PNG tem canal alpha. |
| `reference_images` | nenhuma | Até 16 imagens locais para editar ou usar como referência (PNG, JPEG, WebP, GIF). Caminho absoluto, relativo ao projeto ou começando com `~`. Não coloque esses caminhos no `prompt`. |
| `prompt_mode` | `exact` | `exact`: o Codex recebe a instrução de passar o prompt ao GPT Image sem alteração; o resultado informa qualquer diferença. `enhance`: o modelo do Codex reescreve antes. |
| `model` | config do Codex | Modelo de chat do Codex que faz a ponte. Não escolhe o modelo de imagem. |
| `reasoning_effort` | `low` no modo exact, se o modelo aceitar | Esforço de raciocínio desse modelo. |
| `output_path` | `<projeto>/generated-images/` | Pasta ou caminho de arquivo. O nome é mantido; a extensão segue o formato devolvido (PNG). |

O resultado lista cada caminho salvo com o tamanho, o prompt que chegou ao GPT Image (quando o Codex o informa), a checagem de alpha quando houve pedido de transparência e os limites de uso informados pelo Codex (janela de 5 horas e semanal).

### codex_status

Mostra caminho e versão do Codex, status do login, limites de uso com horário de renovação, o modelo padrão da config do Codex, os modelos com os esforços de raciocínio que cada um aceita e a pasta onde as imagens são salvas.

## Modos de prompt

No modo `exact` o Codex recebe a instrução de chamar o `image_gen` com o seu texto, caractere por caractere. O prompt que chegou ao GPT Image é comparado com o seu, e o resultado informa se são iguais.

O modelo do Codex e o esforço de raciocínio não desenham a imagem. O modelo faz mais diferença no modo `enhance`, em que ele escreve o prompt final.

## Arquivos

- `<projeto>`: `CLAUDE_PROJECT_DIR`, se definido; senão, a raiz do workspace informada pelo Claude Code; senão, o diretório atual.
- Nome padrão: data, hora e as seis primeiras palavras do prompt, por exemplo `generated-images/2026-10-14_120030_a-minimalist-flat-illustration-of-a.png`.
- Várias imagens recebem `_1`, `_2`, ...
- Arquivos existentes nunca são sobrescritos. Um sufixo `-2`, `-3`, ... é acrescentado.
- O Codex também guarda uma cópia em `~/.codex/generated_images/`.

## Configuração

| Variável | Uso |
| --- | --- |
| `CODEX_PATH` | Caminho completo do executável `codex`. Substitui a busca automática. |

A busca automática olha o `PATH` e depois as pastas comuns de instalação: a do instalador oficial (`~/.local/bin`, ou `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` no Windows), npm global, nvm, pnpm, Volta, Bun, asdf e Homebrew.

```bash
claude mcp add --scope user gpt-image -e CODEX_PATH=/opt/codex/bin/codex -- npx -y github:Monayzera/mcp-gpt-image
```

## Problemas comuns

| Mensagem | Solução |
| --- | --- |
| `Codex CLI was not found` | Instale o Codex ou defina `CODEX_PATH`. |
| `CODEX_PATH is set but no executable file exists at:` | Corrija o caminho ou remova `CODEX_PATH` para usar a busca automática. |
| `Codex is not signed in` | Rode `codex login`. |
| `Your ChatGPT/Codex usage limit was reached.` ou `Image generation usage limit reached` | Aguarde o horário de renovação mostrado pelo `codex_status`. |
| `Codex finished without generating an image.` | As linhas seguintes trazem o motivo. |
| `spawn git ENOENT` na instalação | Instale o git. |
| Chamada foi para segundo plano | Normal. O Claude Code pode mandar chamadas MCP longas para segundo plano e entrega o resultado quando terminam. |

## Como funciona

1. Na primeira chamada o servidor inicia o `codex app-server` (JSON-RPC via stdio) e o mantém aberto.
2. Cada pedido abre uma thread do Codex efêmera e somente leitura, instruída a chamar o `image_gen` com o prompt.
3. O Codex informa cada item `imageGeneration`. O servidor grava cada imagem no disco e a devolve junto com os limites de uso que o Codex informa.

## Licença

MIT
