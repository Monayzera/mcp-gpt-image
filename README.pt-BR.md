# mcp-gpt-image

[English](README.md)

Servidor MCP que deixa o Claude Code gerar e editar imagens com o GPT Image usando o Codex CLI instalado no seu PC. Usa o login do ChatGPT, sem chave de API da OpenAI.

O Claude escreve o prompt, o Codex repassa para a ferramenta `image_gen` dele, e a imagem é salva no projeto e volta para o Claude na própria resposta.

## Requisitos

- Node.js 18.17 ou mais novo
- git (o npx baixa este pacote do GitHub)
- Codex CLI logado com um plano do ChatGPT que inclua geração de imagem:

```bash
npm install -g @openai/codex
```

```bash
codex login
```

## Instalação

```bash
claude mcp add --scope user gpt-image -- npx -y github:Monayzera/mcp-gpt-image
```

Mesmo comando no macOS, Linux, WSL e Windows. Rode `claude mcp list` e confira se aparece `gpt-image: ... Connected`.

Se o Claude Code no Windows nativo não conseguir iniciar o servidor, adicione via `cmd /c`:

```bash
claude mcp add --scope user gpt-image -- cmd /c npx -y github:Monayzera/mcp-gpt-image
```

## Uso

Peça a imagem ao Claude:

> Gere com o gpt-image uma foto de produto 3:2 de um moedor de café preto fosco numa bancada de concreto, luz suave de janela.

> Edite `assets/logo.png`: mantenha o formato e deixe o fundo transparente.

## Ferramentas

### generate_image

| Parâmetro | Padrão | Descrição |
| --- | --- | --- |
| `prompt` | obrigatório | O prompt da imagem. |
| `count` | `1` | Imagens do mesmo prompt, de 1 a 4. Cada uma consome seu limite. |
| `transparent_background` | `false` | PNG com fundo transparente. |
| `reference_images` | nenhuma | Imagens locais para editar ou usar como referência (PNG, JPEG, WebP, GIF). Caminho absoluto ou relativo ao projeto. |
| `prompt_mode` | `exact` | `exact`: o prompt chega ao GPT Image sem alteração. `enhance`: o modelo do Codex reescreve antes. |
| `model` | config do Codex | Modelo do Codex que faz a ponte. |
| `reasoning_effort` | `low` no modo exact | Esforço de raciocínio desse modelo. |
| `output_path` | `<projeto>/generated-images/` | Caminho de arquivo `.png` ou pasta. |

O resultado traz o caminho salvo, o tamanho da imagem, o prompt que realmente chegou ao GPT Image e quanto resta do seu limite de 5 horas e semanal.

### codex_status

Mostra caminho e versão do Codex, status do login, limites de uso com horário de reset e os modelos com os esforços de raciocínio que cada um aceita.

## Modos de prompt

No modo `exact` o Codex recebe a instrução de chamar o `image_gen` com o seu texto, caractere por caractere. O prompt que chegou ao GPT Image é comparado com o seu e o resultado informa se são iguais.

O modelo do Codex e o esforço de raciocínio não desenham a imagem. Eles só fazem diferença no modo `enhance`, em que o modelo escreve o prompt final. Para cenas complexas, use um modelo mais forte e esforço maior nesse modo.

## Arquivos

- Nome padrão: `generated-images/2026-10-14_120030_a-minimalist-flat-illustration-of-a.png`
- Várias imagens recebem `_1`, `_2`, ...
- Arquivos existentes nunca são sobrescritos. É adicionado `-2`, `-3`, ...
- O Codex também guarda uma cópia em `~/.codex/generated_images/`.

## Configuração

| Variável | Uso |
| --- | --- |
| `CODEX_PATH` | Caminho completo do executável `codex` quando ele não está no `PATH`. |

Exemplo:

```bash
claude mcp add --scope user gpt-image -e CODEX_PATH=/opt/codex/bin/codex -- npx -y github:Monayzera/mcp-gpt-image
```

## Problemas comuns

| Mensagem | Solução |
| --- | --- |
| `Codex CLI was not found` | Instale o Codex ou defina `CODEX_PATH`. |
| `Codex is not signed in` | Rode `codex login`. |
| `usage limit reached` | Espere o horário de reset mostrado pelo `codex_status`. |
| Chamada foi para segundo plano | Normal. O Claude Code manda chamadas MCP com mais de 2 minutos para segundo plano e entrega o resultado quando termina. |

## Como funciona

1. Na primeira chamada o servidor inicia o `codex app-server` (JSON-RPC via stdio) e o mantém aberto.
2. Cada pedido abre uma thread do Codex efêmera e somente leitura, instruída a chamar o `image_gen` com o prompt.
3. O Codex informa cada item `imageGeneration`. O servidor grava o PNG no disco e devolve junto com os limites de uso que o Codex reporta.

## Licença

MIT
