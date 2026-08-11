# Controle de Contas — Contexto do Projeto

> Leia este arquivo inteiro antes de mexer em qualquer coisa. Ele existe pra
> qualquer sessão de IA (Claude ou outro motor) retomar o projeto sem precisar
> o Yuri reexplicar tudo do zero. Foi escrito logo antes da pasta ser movida
> de `ClaudeInterface\ControleContas` pra virar projeto próprio em `Projects\`.

## O que é

App pessoal de controle financeiro mensal (contas a pagar, vencimentos,
histórico por mês) pro Yuri usar **de verdade**, não é exercício. Multi-usuário
de verdade — hoje já tem 2 contas reais cadastradas (`Yuri`, a principal, e
`Alyssu`, criada pra testar isolamento entre usuários).

Objetivo declarado do Yuri: manter isso simples, **sem dependências
externas** (zero `npm install`), portátil (a pasta inteira pode ser movida ou
copiada pra qualquer lugar e continua funcionando), e eventualmente virar
também um app mobile com notificação de vencimento — mas isso é passo futuro,
ver seção "Pendência conhecida" mais abaixo.

## ⛔ Regra crítica e absoluta: NUNCA escrever código de migração

**O produto ainda não tem v1.** Ainda está em construção ativa com o Yuri.
Enquanto isso for verdade, esta regra não se negocia:

**Nunca escreva código pensando em "e se já tiver rodado antes" / "quando
rodar pela primeira vez".** Isso inclui, sem exceção: `ALTER TABLE`,
`PRAGMA table_info` pra checar se uma coluna já existe, `UPDATE` de
backfill guardado por `if (coluna nao existe)`, e qualquer comentário tipo
"essa coluna foi adicionada depois" ou "isso é pra manter compatibilidade
com bancos antigos". Nada de baboseira desse tipo no código.

Todo `CREATE TABLE` (dentro de `criarSchemaNovo()`, em `server.js`) nasce
**direto na forma final e completa** — todas as colunas, `NOT NULL`,
`REFERENCES`, tudo — como se sempre tivesse sido assim desde sempre.
`CREATE TABLE IF NOT EXISTS` já resolve sozinho o "roda uma vez só": quando
um cliente pegar esse código e rodar contra um banco zerado, tudo é criado
certo de primeira, sem etapa extra, sem versão, sem migração.

**Se uma mudança de schema precisar ser aplicada num banco que já existe
com dado real** (hoje isso só existe na máquina do Yuri,
`data/controle.sqlite`, com os usuários `Yuri`/`Alyssu`):
1. Aplique a mudança direto nesse arquivo físico, na hora, via um script
   avulso rodado no terminal (ex: `node -e "..."` usando `node:sqlite`) —
   **nunca** dentro do `server.js`.
2. Depois, edite o `CREATE TABLE` em `criarSchemaNovo()` pra já refletir a
   forma final, como se sempre tivesse sido assim.
3. Não deixe **nenhum** `ALTER TABLE`, checagem de coluna, `UPDATE` de
   backfill ou comentário contando essa história no código depois disso.
   Esse tipo de histórico é assunto de commit/conversa, nunca de comentário
   permanente no arquivo.

Essa regra vale **enquanto o produto não tiver v1**. O dia que isso virar
produto entregue rodando em produção de verdade com dado que precisa
sobreviver entre versões, aí sim entra em jogo migração de verdade — mas
essa é uma decisão futura e explícita, não a postura padrão de hoje.

## Como rodar

```
node server.js
```
ou dá duplo-clique em `iniciar.bat` (abre o navegador sozinho). Porta padrão
`5602` (configurável via `PORT`). Não precisa `npm install` — tudo é módulo
nativo do Node (`http`, `fs`, `path`, `crypto`, `node:sqlite`). Requer **Node
22.5+** (por causa do `node:sqlite`).

Ao subir, o servidor:
1. Abre/cria `data/controle.sqlite`.
2. Roda `criarSchemaNovo()` — cria as tabelas que faltarem (`CREATE TABLE IF
   NOT EXISTS`).
3. Escuta em `http://localhost:5602`.

**Quem roda/para o servidor é o Yuri, no terminal dele — nunca a IA por
conta própria.** Se for preciso validar algo com o servidor no ar, peça pro
Yuri rodar (`node server.js`) ou parar, e espere ele confirmar antes de
seguir. Scripts avulsos e rápidos de checagem direta no banco (`node -e
"..."`, sem subir o servidor) continuam OK fazer sozinho quando fizer
sentido — a restrição é sobre a aplicação em si (`node server.js` rodando
escutando porta).

## Stack e por quê

| Escolha | Motivo |
|---|---|
| `node:sqlite` (nativo do Node) em vez de `better-sqlite3`/Postgres/etc | Zero instalação, zero compilação nativa, um arquivo só, portátil |
| `http` puro, sem Express | Zero dependência; roteamento manual dentro de um `if/else` gigante no `createServer` |
| HTML/CSS/JS vanilla, sem build step, sem framework de front | Abre o `.html` e funciona, sem bundler, sem `npm install` no front também |
| Sessão por cookie HttpOnly, sem JWT | Mais simples de implementar certo (sem se preocupar com expiração de token no client, refresh, etc.) |
| Senha com `scrypt` do módulo `crypto` nativo | Sem instalar `bcrypt`, ainda assim seguro (hash lento + salt) |

**Regra geral do projeto: antes de puxar uma lib externa, pergunte "dá pra
fazer só com o que o Node já tem?".** Foi assim até agora e o Yuri gosta
assim.

## Estrutura de arquivos

```
ControleContas/
  server.js          — TUDO do backend: schema, auth, API, static file server (~800 linhas, 1 arquivo só)
  package.json        — so metadata, sem dependencies
  iniciar.bat          — atalho Windows: abre o navegador + roda o servidor
  README.md            — guia de uso voltado pro usuário final (não-técnico)
  CLAUDE.md            — este arquivo
  public/
    index.html          — app principal de Contas (exige login), CSS+JS embutido
    gastos.html          — tela de Gastos avulsos (exige login), CSS+JS embutido — ver seção "Duas telas" abaixo
    login.html           — tela de login
    cadastro.html         — wizard de criação de conta (uma pergunta por vez, mobile-first)
  data/
    controle.sqlite       — o banco (criado automaticamente, não versionar)
    controle.sqlite-wal/-shm — arquivos do modo WAL do SQLite (normal existirem)
    backups/                 — backups manuais do banco
```

Cada página HTML é autocontida (`<style>` e `<script>` embutidos no próprio
arquivo) — não tem CSS/JS compartilhado entre elas ainda. As três usam a
mesma paleta de cores (tema escuro) mas repetida em cada arquivo. Se um dia
crescer mais, vale extrair pra um `estilo-comum.css`, mas por enquanto foi
mantido simples de propósito.

## Modelo de dados

Cadeia de posse (quem pertence a quem) — **o ponto mais importante do projeto
inteiro pra não introduzir bug de segurança**:

```
usuarios (1) ---- (N) agrupamentos      [tem usuario_id direto]
usuarios (1) ---- (N) meses             [tem usuario_id direto]
usuarios (1) ---- (N) lancamentos       [tem usuario_id direto, alem de mes_id]
usuarios (1) ---- (N) categorias_gasto  [tem usuario_id direto]
usuarios (1) ---- (N) gastos            [tem usuario_id direto, alem de mes_id]
usuarios (1) ---- (1) pessoas           [perfil: nome, nascimento, país, estado...]
usuarios (1) ---- (N) sessoes           [tokens de login ativos]
```

**`meses` é compartilhado entre Contas e Gastos** — não existe um "mês de
Contas" e um "mês de Gastos" separados, é o mesmo registro (`ano`/`mês`) pros
dois. `lancamentos` (Contas) e `gastos` (Gastos) têm `usuario_id` **direto**
(não precisam de `JOIN` com `meses` pra descobrir o dono — é uma coluna de
conveniência preenchida no `INSERT` a partir do usuário já autenticado na
rota). Ainda assim, **toda rota que lê/edita/apaga um lançamento ou gasto
precisa filtrar por `usuario_id`.** Esquecer disso é a forma mais fácil de
vazar dado de um usuário pro outro (ver `exigirUsuario()` e os handlers de
`/api/lancamentos/:id` e `/api/gastos/:id` no `server.js` pra ver o padrão
certo — hoje é um filtro direto `WHERE id = ? AND usuario_id = ?`, sem JOIN).

### Tabelas

| Tabela | Campos principais | Observação |
|---|---|---|
| `usuarios` | `usuario`, `email` (ambos UNIQUE case-insensitive), `senha_hash`, `senha_salt` | Credenciais. Nunca guarda senha em texto puro. |
| `pessoas` | `usuario_id` (UNIQUE), `nome`, `sobrenome`, `data_nascimento`, `pais`, `estado`, `gasto_bobo` | Perfil, preenchido no wizard de cadastro. Separado de `usuarios` de propósito. |
| `sessoes` | `token` (PK), `usuario_id`, `expira_em` | Uma linha por login. Expira em 30 dias (`SESSAO_DURACAO_MS`). |
| `agrupamentos` | `usuario_id`, `nome`, `ordem` | Categorias de Contas ("Contas Fixas", "Bancos"...). `UNIQUE(usuario_id, nome)` — nome só precisa ser único dentro do mesmo usuário. |
| `meses` | `usuario_id`, `ano`, `mes` | Um mês de controle, **compartilhado entre Contas e Gastos**. `UNIQUE(usuario_id, ano, mes)`. `ano` só aceita 2026/2027 hoje (`ANOS_PERMITIDOS`, decisão deliberada do Yuri — "ninguém faz conta pro passado"). |
| `lancamentos` | `usuario_id`, `mes_id`, `agrupamento_id`, `descricao`, `valor`, `detalhe`, `data_limite`, `ok`, `fixo`, `ordem` | A conta em si (tela Contas). `data_limite` é `TEXT` formato `YYYY-MM-DD`, opcional. |
| `categorias_gasto` | `usuario_id`, `nome`, `ordem` | Categorias de Gastos ("Mercado", "Cinema", "Besteira"...). Lista própria, separada de `agrupamentos`. `UNIQUE(usuario_id, nome)`. |
| `gastos` | `usuario_id`, `mes_id`, `categoria_gasto_id`, `nome`, `descricao`, `valor`, `data_compra`, `ordem` | Compra avulsa (tela Gastos), no mesmo `mes_id` de `meses`. Sem `ok`/`fixo` — gasto já é consumado, não repete. `nome` é o título curto e **obrigatório** (ex: "Compras do dia a dia"); `descricao` é texto livre **opcional** pra detalhar (ex: "Frutas, carne e produtos de limpeza"). |

### Comportamento "fixo" (importante, é sutil)

**`fixo` NÃO é um cadastro de "contas fixas" separado.** É uma flag booleana
em cada linha de `lancamentos`, específica daquele mês. Quando um mês novo é
criado (`POST /api/meses`):
1. O servidor acha o mês existente mais recente **cronologicamente anterior**
   ao que está sendo criado (`mesReferenciaAnterior`).
2. Copia pro mês novo só os lançamentos daquele mês de referência que
   estavam com `fixo = 1`.
3. Se a conta copiada tinha `data_limite`, o **dia** é preservado mas
   ajustado pro mês novo via `ajustarDiaParaMes()` — ex: vencimento dia 31 de
   janeiro vira dia 28 (ou 29, se bissexto) em fevereiro.
4. Os itens copiados entram com `ok = 0` (ninguém nasce pago).

Se o usuário desmarcar `fixo` num lançamento, isso não afeta o histórico
daquele mês — só impede que ele seja copiado da próxima vez que um mês novo
for criado.

## Referência da API

Todas as rotas de dados (tudo exceto `/api/auth/*`) exigem sessão válida —
chamam `exigirUsuario(req)` no início, que devolve 401 se não tiver cookie
de sessão válido. Toda query já filtra pelo `usuario.id` retornado.

### Autenticação (`/api/auth/*` — não exige login, exceto onde marcado)

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/auth/verificar-disponibilidade` | Checa se usuário/e-mail já existem (usado no wizard de cadastro antes de avançar) |
| POST | `/api/auth/registrar` | Cria usuário + pessoa, abre sessão, seta cookie |
| POST | `/api/auth/login` | Aceita usuário OU e-mail + senha, abre sessão |
| POST | `/api/auth/logout` | Apaga a sessão, limpa cookie |
| GET | `/api/auth/eu` | **Exige login.** Devolve dados do usuário logado + perfil |
| DELETE | `/api/auth/conta` | **Exige login.** Apaga a conta inteira (usuário + pessoa + sessões + agrupamentos + categorias_gasto + meses + lançamentos + gastos, nessa ordem, numa transação) |

### Agrupamentos

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/agrupamentos` | Lista os agrupamentos do usuário, com flag `emUso` |
| POST | `/api/agrupamentos` | Cria um novo (`{ nome }`) |
| PATCH | `/api/agrupamentos/:id` | Renomeia |
| PATCH | `/api/agrupamentos/:id/mover` | Reordena (`{ direcao: 'up' \| 'down' }`) |
| DELETE | `/api/agrupamentos/:id` | Apaga — só se `emUso` for 0 (senão 409) |

### Meses

`meses` é **compartilhado entre Contas e Gastos** — só existe esse conjunto
de rotas, não há um "criar mês" duplicado pra Gastos.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/meses` | Lista os meses do usuário (resumido, com totais de Contas) |
| GET | `/api/meses/sugestao` | Sugere o próximo ano/mês (baseado no mais recente que existe) |
| GET | `/api/meses/buscar?ano=&mes=` | Busca um mês específico com os itens de Contas; `{ existe: false }` se não achar |
| POST | `/api/meses` | Cria mês novo (`{ ano, mes }`), copia os fixos de Contas do mês anterior (ver seção acima); mês fica disponível pros dois lados |
| GET | `/api/meses/:id` | Mês específico por id, com itens de Contas |
| DELETE | `/api/meses/:id` | Apaga o mês inteiro + seus lançamentos **e gastos** (transação) — é destrutivo pros dois lados |

### Lançamentos (Contas)

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/lancamentos` | Cria (`{ mes_id, descricao, valor, detalhe?, data_limite?, fixo?, agrupamento_id \| agrupamento_nome }`) |
| PATCH | `/api/lancamentos/:id` | Edita descrição/valor/detalhe/data_limite/ok (campos parciais) |
| PATCH | `/api/lancamentos/:id/fixo` | Liga/desliga a flag fixo (`{ fixo: bool }`) |
| DELETE | `/api/lancamentos/:id` | Apaga só aquele lançamento (não mexe no resto do histórico) |

Toda resposta de mutação em lançamento devolve o **mês inteiro atualizado**
(`mesComItens`), não só o item — o front sempre re-renderiza a partir disso.

### Categorias de Gasto

Mesmo padrão de `agrupamentos`, mas lista própria pra Gastos.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/categorias-gasto` | Lista as categorias do usuário, com flag `emUso` |
| POST | `/api/categorias-gasto` | Cria uma nova (`{ nome }`) |
| PATCH | `/api/categorias-gasto/:id` | Renomeia |
| PATCH | `/api/categorias-gasto/:id/mover` | Reordena (`{ direcao: 'up' \| 'down' }`) |
| DELETE | `/api/categorias-gasto/:id` | Apaga — só se `emUso` for 0 (senão 409) |

### Gastos

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/gastos/buscar?ano=&mes=` | Busca a MESMA linha de `meses` de Contas, mas devolve os itens de Gastos; `{ existe: false }` se o mês não existir |
| POST | `/api/gastos` | Cria (`{ mes_id, nome, descricao?, valor, data_compra?, categoria_gasto_id \| categoria_gasto_nome }`) — `nome` obrigatório, `descricao` opcional |
| PATCH | `/api/gastos/:id` | Edita nome/descrição/valor/data_compra (campos parciais) |
| DELETE | `/api/gastos/:id` | Apaga só aquele gasto |

Toda resposta de mutação em gasto devolve o **mês inteiro atualizado**
(`mesComItensGasto`), mesmo padrão de `lancamentos`.

## Decisões de segurança (não regredir nisso)

- **IDOR**: toda rota que busca um registro por ID já filtra por
  `usuario_id` na própria query (direto, já que `lancamentos` e `gastos` têm
  `usuario_id` na própria tabela — ver "Modelo de dados"). Se não achar —
  seja porque não existe, seja porque é de outro usuário — a resposta é
  sempre **404**, nunca 403. Isso evita confirmar pra quem está adivinhando
  IDs se aquele registro existe.
- **SQL Injection**: impossível por construção — toda query usa
  `db.prepare('... WHERE x = ?').get(valor)`, nunca concatenação de string.
  Não existe NENHUM lugar no código que monta SQL colando texto do usuário.
- **Senha**: `scrypt` com salt aleatório por usuário, comparação com
  `crypto.timingSafeEqual` (evita vazar por tempo de resposta).
- **Path traversal no `serveStatic`**: `path.normalize` + checagem de que o
  caminho final começa com `PUBLIC_DIR`, pra bloquear `../../server.js` via
  URL.
- **Cookie de sessão**: `HttpOnly` (JS do navegador não consegue ler),
  `SameSite=Lax`. Não é `Secure` porque hoje roda em `http://localhost` puro
  — **se algum dia for pra produção com HTTPS, adicionar `Secure` no
  `definirCookieSessao`**.

## Front-end — as 4 páginas

- **`public/index.html`** — app principal de **Contas**. Exige login
  (redirect automático pro `/login.html` se não autenticado, feito no
  `server.js`). Tem: seletor Ano/Mês, cards de resumo (Total/Pago/Pendente/
  Selecionado), tabela agrupada de lançamentos, edição inline por linha
  (ícone lápis, não é contenteditable direto), checkbox de seleção múltipla
  pra somar subconjuntos, botão de "ocultar valores" (máscara visual, não
  criptografia, só CSS + classe), painel de gerenciar agrupamentos, botão de
  navegação pra `/gastos.html`, logout.
- **`public/gastos.html`** — tela de **Gastos** avulsos (mercado, besteira,
  compra picada). Exige login (mesmo gate de `/index.html`, ver
  "Modelo de dados"). Espelha a estrutura visual de `index.html` quase 1:1
  (mesma paleta, mesmo layout de seletor Ano/Mês — que é o MESMO mês
  compartilhado com Contas), mas mais simples: sem status pago/pendente, sem
  flag fixo, categoria em vez de agrupamento, e dois campos por item (`nome`
  obrigatório + `descricao` opcional, em vez do par `descricao`/`detalhe` de
  Contas). Botão de navegação de volta pra `/index.html`. Ver seção
  "Duas telas" abaixo pro porquê da separação.
- **`public/login.html`** — usuário-ou-email + senha, simples.
- **`public/cadastro.html`** — wizard: 1ª tela com usuário/e-mail/senha/
  confirmação juntos, depois uma pergunta por vez (nome, sobrenome,
  nascimento, país, estado, e uma bônus opcional de texto livre), com barra
  de progresso e transição suave entre telas. **Essas duas páginas (login e
  cadastro) já foram construídas mobile-first.**

## Duas telas: Contas × Gastos

O app tem duas telas de lançamento **de propósito separadas**, decisão do
Yuri: "Contas" (`index.html`, `lancamentos`) é conta com vencimento —
aluguel, cartão, coisas que têm status pago/pendente e podem repetir todo
mês (`fixo`). "Gastos" (`gastos.html`, `gastos`) é compra avulsa do dia a
dia — mercado, besteira, cinema — sem vencimento, sem status, sem repetição,
categorizado (`categorias_gasto`) pra saber quanto está saindo em cada tipo
de gasto por mês.

As duas telas **compartilham o mesmo `meses`** (mesmo `ano`/`mês` por
usuário) — criar ou excluir um mês afeta os dois lados ao mesmo tempo (por
isso os dois botões "Excluir mês" avisam no `confirm()` que apagam Contas E
Gastos). Fora isso, as listas de categoria (`agrupamentos` vs
`categorias_gasto`) e os itens (`lancamentos` vs `gastos`) são
completamente independentes entre si.

Se um dia crescer mais categorias de lançamento (ex: investimentos,
recebimentos), o padrão a seguir é o mesmo: tela própria + tabela de
categoria própria + tabela de item próprio, todas com `usuario_id` direto,
compartilhando `meses` se fizer sentido conceitualmente o mesmo período.

## ⚠️ Pendência conhecida: `index.html` e `gastos.html` NÃO são responsivos ainda

Confirmado (sem `overflow-x`, sem media query pra tabela): a tabela de Contas
(`index.html`) tem 8 colunas com `min-width` somados passando de 600px, e a
de Gastos (`gastos.html`, 5 colunas) tem o mesmo problema em menor escala —
em tela de celular (≈375px) isso vai estourar horizontalmente. **Isso é a
próxima tarefa combinada com o Yuri, pras duas telas de uma vez só**,
decidida assim:

- **Não** vai virar dois códigos separados (um mobile, um desktop) — decisão
  explícita do Yuri após discutirmos o trade-off (manter dois códigos = toda
  mudança visual feita duas vezes).
- **Vai** virar **um código só, responsivo** (tabela vira cards empilhados
  em tela estreita), depois transformado em **PWA** pra ganhar notificação
  push (pelo menos Android) sem precisar de loja de app.
- Se um dia quiser um APK "de verdade": embrulhar esse MESMO código com
  **Capacitor** (baixo esforço, reaproveita tudo) em vez de reescrever nativo
  (React Native/Flutter — alto esforço, foi descartado).
- Pré-requisito antes de qualquer notificação funcionar de fato: hospedar o
  backend em algo sempre ligado (hoje só roda enquanto o Yuri liga o PC e
  roda `node server.js` manualmente) + HTTPS + Firebase Cloud Messaging +
  um job diário checando `data_limite`.

## Estado atual do banco (no momento em que este arquivo foi escrito)

- 2 usuários reais: `Yuri` (conta principal) e `Alyssu` (conta criada pelo
  próprio Yuri pra testar isolamento multi-tenant).
- Cada um já tem seu próprio mês de Julho/2026 com lançamentos.

## Convenções do projeto

- Identificadores, comentários e mensagens de erro em **português**.
- `camelCase` em JS, `snake_case` nas colunas do banco.
- Sem emoji em código/commit — emoji só aparece na UI (ícones tipo 💰, 🔁,
  📅) porque o Yuri gosta desse estilo visual.
- Zero dependência externa é regra do projeto, não sugestão — sempre checar
  se dá pra resolver só com módulo nativo do Node antes de considerar uma
  lib.
- Antes de qualquer mudança de schema, fazer backup manual do
  `data/controle.sqlite`.
