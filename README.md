# FIRE board for specs.md (plugin do Orca)

Plugin do [Orca ADE](https://orca.dev) que mostra um projeto [specs.md](https://specs.md) no fluxo FIRE
(`.specs-fire/`) num painel da barra lateral direita, no estilo da
[extensão do specs.md para VS Code](https://specs.md/getting-started/ide-extension).

> Projeto independente, **não oficial**: não é mantido nem endossado pelo specs.md nem pelo Orca.

| Aba | O que mostra |
| --- | --- |
| Runs | Runs ativas: work items, fase, checkpoint (aviso em `awaiting_approval`) e arquivos da run. Runs concluídas, recolhidas. |
| Intents | Árvore de intents → arquivos e work items, com status, modo, complexidade e progresso. Busca e filtro (abertos, em andamento, concluídos, todos). Clicar num arquivo mostra o conteúdo no próprio painel; **Abrir no editor** só funciona no app desktop. |
| Visão geral | Progresso total, contagem por status, dados do projeto, divergências entre `state.yaml` e as pastas de `intents/`. |

Na barra de status aparece o work item em execução e a fase (`FIRE W-DEMO-01 · plan`), em amarelo
quando está esperando aprovação. Clicar nele recarrega.

Só lê. Não escreve no `.specs-fire` nem no Orca. Sem rastreamento nem rede: o worker lê arquivos e,
no modo remoto, chama o CLI do próprio Orca.

## Requisitos

- Orca **1.4.248** ou mais novo.
- Com `orca serve`: o servidor em modo Electron (`ORCA_SERVE_RUNTIME=electron` no ambiente do serviço).
  Desde a 1.4.257 o padrão é o `orcad` (Node), que responde `Plugin service is not available on this runtime`.
- O projeto aberto no Orca como workspace, ou a pasta informada em **Pasta do projeto**.

## Instalar (pasta de desenvolvimento)

```sh
git clone https://github.com/ctodarealpro/orca-specsmd.git
cd orca-specsmd
orca plugin validate plugin
orca plugin dev load plugin    # pede aprovação
# ou: Settings → Plugins → Development folders… → adicionar a pasta plugin/
```

O plugin fica em `plugin/`, porque o Orca recusa link simbólico dentro da pasta do plugin (e o
`node_modules` do desenvolvimento tem links).

O plugin é `trusted-worker`: o worker roda em Node, fora do sandbox, para ler os arquivos. Ele pede:

| Capacidade | Para quê |
| --- | --- |
| `workspace:read` | Achar o workspace em foco (`workspace.readContext`, `workspace.list`) e ouvir `workspace.changed`. |
| `workspace:write` | Abrir arquivos no editor do Orca (`editor.open`, só no app desktop). |
| `settings:own` | Ler e gravar as configurações do próprio plugin. |

## Como acha o projeto

1. **Pasta do projeto**, se preenchida.
2. Senão, o workspace em foco: sobe até 6 pastas procurando `.specs-fire/state.yaml`.
3. Senão, o primeiro workspace do Orca que estiver dentro de um projeto FIRE.

`fs.watch` falha em pasta de rede e no WSL, então o worker confere a cada **Intervalo de leitura** (5 s)
o `mtime` do `state.yaml` e dos arquivos de `runs/`, e só relê quando algo mudou.

## App desktop ligado a um servidor Orca

Cada Orca lê do seu disco. Se o workspace em foco existe neste computador, o worker lê daqui. Se ele é
de um servidor Orca pareado (por exemplo o app no Windows ligado a um `orca serve` no Linux), o worker
pede a leitura à cópia do plugin instalada no servidor, pelo CLI do Orca
(`orca plugin dev request --environment <servidor> local.specsmd-fire …`). Por isso o plugin fica
instalado **nos dois** Orcas.

- O servidor é achado pelo host do workspace ou pelos servidores salvos em `orca environment list`;
  **Servidor Orca** força um.
- Quando o mesmo nome e branch existem nos dois lados, **Quando o workspace existe nos dois** (ou o
  botão "Ler de" no painel) decide.
- Diagnóstico: `orca plugin dev request local.specsmd-fire specs.where --json` mostra o que o worker vê
  e onde decidiu ler.

**Limite atual:** esse modo usa `orca plugin dev request` e a chave `local.specsmd-fire`, então o plugin
precisa estar carregado como pasta de desenvolvimento no servidor. Numa instalação a partir do
GitHub a chave muda e o modo remoto ainda não funciona.

## Desenvolvimento

```sh
npm install
npm test                                   # node:test, sem Orca
FIRE_ROOT=/caminho/do/projeto npm test     # inclui um state.yaml real e confere os limites do Orca
npm run build:yaml                         # regenera plugin/worker/vendor/yaml.mjs
```

- `plugin/worker/model.mjs`: Node puro, lê e resume o `.specs-fire`.
- `plugin/worker/main.mjs`: liga isso ao Orca e responde ao painel (`specs.snapshot`, `specs.status`,
  `specs.read` só dentro do `.specs-fire`, `specs.open`, `specs.prefer`, `specs.where`).
- `plugin/worker/remote.mjs`: chama a cópia do plugin num servidor pareado pelo CLI do Orca.
- `plugin/panel/index.html`: o painel, HTML com script e estilo embutidos, sem build (painel de
  componentes não aparece no navegador do `orca serve`).
- `plugin/src/protocol.ts`: tipos do contrato entre painel e worker.
- `plugin/worker/vendor/yaml.mjs`: [yaml](https://github.com/eemeli/yaml) 2.x (ISC) empacotado com
  esbuild a partir de `build/yaml-entry.mjs`; veja `NOTICE`.

## Licença

MIT. Veja `LICENSE` e `NOTICE`.
